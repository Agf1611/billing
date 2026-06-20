const express = require('express');
const router = express.Router();
const customerDevice = require('../services/customerDeviceService');
const { getSettingsWithCache } = require('../config/settingsManager');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const customerSvc = require('../services/customerService');
const whatsappGateway = require('../services/whatsappGatewayService');
const whatsappTemplateMedia = require('../services/whatsappTemplateMediaService');
const packageChangeSvc = require('../services/packageChangeService');
const mikrotikService = require('../services/mikrotikService');
const customerDetailSvc = require('../services/customerDetailService');
const { logger } = require('../config/logger');
const ticketSvc = require('../services/ticketService');
const techSvc = require('../services/techService');
const usageSvc = require('../services/usageService');
const crypto = require('crypto');
const db = require('../config/database');
const { isStrongXenditCallbackToken } = require('../config/security');
const { normalizePhoneDigits } = require('../services/phoneService');
const {
  resolveCustomerLookup,
  parsePublicInvoiceCode,
  parseShortInvoiceCheckCode,
  resolveRequestBaseUrl,
  buildCustomerCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  formatInvoiceDueDate,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine
} = require('../services/publicLinkService');
const {
  buildDynamicQrisPayload,
  buildDynamicQrisDataUrl,
  hasStaticQrisEnabled: resolveStaticQrisEnabled
} = require('../services/qrisService');
const {
  notifyApprovalRequired,
  notifyTicketCreated
} = require('../services/adminPaymentNotificationService');
const { registerPublicPortalRoutes } = require('./customer/registerPublicPortalRoutes');
const CUSTOMER_PERSISTENT_SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const LOGIN_GENIE_PREFETCH_MAX_WAIT_MS = 1200;
const LOGIN_GENIE_PREFETCH_INTERVAL_MS = 500;
const LOGIN_GENIE_PREFETCH_REQUEST_TIMEOUT_MS = 900;
const INITIAL_GENIE_SYNC_MAX_WAIT_MS = 10000;
const INITIAL_GENIE_SYNC_INTERVAL_MS = 2500;
const INITIAL_GENIE_SYNC_REQUEST_TIMEOUT_MS = 5000;
const DASHBOARD_GENIE_FOLLOWUP_MAX_WAIT_MS = 3000;
const DASHBOARD_GENIE_FOLLOWUP_INTERVAL_MS = 1200;
const DASHBOARD_GENIE_FOLLOWUP_REQUEST_TIMEOUT_MS = 3000;
const DASHBOARD_PPPOE_SNAPSHOT_CACHE_MAX_AGE_MS = 60 * 1000;
const DASHBOARD_PAYMENT_CHANNELS_TIMEOUT_MS = 1800;
const CUSTOMER_PAYMENT_CHANNELS_CACHE_TTL_MS = 5 * 60 * 1000;
let customerPaymentChannelsCache = {
  key: '',
  expiresAt: 0,
  value: []
};
const packageChangeAttemptStore = new Map();
const PACKAGE_CHANGE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PACKAGE_CHANGE_RATE_LIMIT_MAX_ATTEMPTS = 6;

router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/** Cocokkan session login (tag GenieACS / PPPoE / nomor) ke baris customers */
function findCustomerProfileByLoginId(loginId) {
  if (!loginId) return null;
  const cleanLogin = String(loginId).replace(/\D/g, '');
  return customerSvc.getAllCustomers().find((c) => {
    const cleanDb = String(c.phone || '').replace(/\D/g, '');
    return (
      cleanDb === cleanLogin ||
      c.phone === loginId ||
      c.genieacs_tag === loginId ||
      c.pppoe_username === loginId
    );
  }) || null;
}

function resolveCustomerSessionLoginId(customer) {
  if (!customer) return '';
  return String(customer.pppoe_username || customer.genieacs_tag || customer.phone || customer.id || '').trim();
}

function getSessionCustomer(req) {
  const customerId = Number(req.session && req.session.customerId);
  if (Number.isFinite(customerId) && customerId > 0) {
    const byId = customerSvc.getCustomerById(customerId);
    if (byId) return byId;
  }

  const loginId = req.session && req.session.phone;
  return findCustomerProfileByLoginId(loginId);
}

function keepCustomerSessionPersistent(req) {
  if (!req?.session) return;
  req.session.rememberMe = true;
  req.session.customerPersistentLogin = true;
  if (req.session.cookie) {
    req.session.cookie.maxAge = CUSTOMER_PERSISTENT_SESSION_MAX_AGE_MS;
  }
}

function normalizePortalAccountStatus(status) {
  const normalized = String(status || 'active').trim().toLowerCase();
  if (normalized === 'suspended') return 'suspended';
  if (normalized === 'inactive') return 'inactive';
  return 'active';
}

function isPortalRestrictedStatus(status) {
  const normalized = normalizePortalAccountStatus(status);
  return normalized === 'suspended' || normalized === 'inactive';
}

function isPortalServiceActionRestricted(profile) {
  return profile && isPortalRestrictedStatus(profile.status);
}

function blockInactiveServiceAction(req, res, actionLabel = 'Aksi ini', targetHash = 'settings') {
  req.session._msg = {
    type: 'warning',
    text: `${actionLabel} hanya bisa digunakan saat akun pelanggan aktif. Silakan lunasi tagihan atau hubungi admin.`
  };
  return res.redirect(`/customer/dashboard#${targetHash || 'settings'}`);
}

function getPortalAccountState(status) {
  const normalized = normalizePortalAccountStatus(status);
  if (normalized === 'suspended') {
    return {
      kind: 'suspended',
      label: 'Isolir',
      heroLabel: 'Isolir',
      notice: 'Layanan internet Anda sedang diisolir sementara karena masih ada tagihan yang belum lunas.'
    };
  }
  if (normalized === 'inactive') {
    return {
      kind: 'inactive',
      label: 'Nonaktif',
      heroLabel: 'Nonaktif',
      notice: 'Akun pelanggan Anda sedang nonaktif. Silakan hubungi admin untuk aktivasi atau informasi lanjutan.'
    };
  }
  return {
    kind: 'active',
    label: 'Aktif',
    heroLabel: 'Aktif',
    notice: ''
  };
}

/** Rute yang tetap aman diakses tanpa dashboard penuh / dari link publik. */
function isSuspendedPortalExemptPath(reqPath) {
  const p = String(reqPath || '');
  if (
    p === '/login' ||
    p === '/register' ||
    p === '/login-otp' ||
    p === '/logout'
  ) return true;
  if (p.startsWith('/public/')) return true;
  if (p.startsWith('/payment/')) return true;
  const staticPages = ['/tos', '/privacy', '/about', '/contact', '/check-billing', '/voucher'];
  if (staticPages.includes(p)) return true;
  return false;
}

function dashboardNotif(message, type = 'success') {
  if (!message) return null;
  return { text: message, type };
}

function buildPaidWhatsappMessage(customer, invoice, gateway, settings, baseUrl) {
  const template = String(
    settings?.whatsapp_paid_message ||
    defaultPaidWhatsappTemplate(settings?.company_header || 'ISP')
  ).trim();
  const billingLink = buildCustomerCheckBillingLink(customer, { baseUrl });
  const invoiceLink = buildPublicInvoicePrintLink(invoice, customer, 48 * 60 * 60 * 1000, { baseUrl });
  const receiptLink = buildPublicInvoiceReceiptLink(invoice, customer, 48 * 60 * 60 * 1000, { baseUrl });
  const paymentProofLink = receiptLink || invoiceLink || billingLink;
  const dueDateText = formatInvoiceDueDate(invoice, customer);
  return ensureDueDateLine(fillWhatsappTemplate(template, {
    nama: customer?.name || 'Pelanggan',
    paket: String(customer?.package_name || invoice?.package_name || '-').trim() || '-',
    tagihan: Number(invoice?.amount || 0).toLocaleString('id-ID'),
    rincian: `${invoice?.period_month || '-'}/${invoice?.period_year || '-'}`,
    jatuh_tempo: dueDateText,
    link: paymentProofLink,
    billing_link: billingLink,
    portal_link: buildCustomerPortalLoginLink({ baseUrl }),
    invoice_link: invoiceLink || billingLink,
    receipt_link: receiptLink || invoiceLink || billingLink,
    invoice_no: invoice?.id ? `INV-${invoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: String(settings?.whatsapp_group_invite_link || '').trim(),
    group_line: String(settings?.whatsapp_group_invite_link || '').trim() ? `Grup pelanggan: ${String(settings.whatsapp_group_invite_link).trim()}` : '',
    company: settings?.company_header || 'ISP',
    paid_by: String(gateway || '-').trim() || '-',
    paid_at: new Date().toLocaleString('id-ID')
  }), dueDateText);
}

async function trySendGatewayPaidWhatsapp(req, customer, invoice, gatewayLabel, settings) {
  try {
    if (!settings?.whatsapp_enabled) return false;
    if (!customer?.phone || !invoice) return false;
    const ready = await whatsappGateway.ensureReady(15000);
    if (!ready) throw new Error('WhatsApp belum siap');
    const ok = await whatsappTemplateMedia.sendTemplateMessage(
      customer.phone,
      buildPaidWhatsappMessage(customer, invoice, gatewayLabel, settings, resolveRequestBaseUrl(req)),
      'paid',
      { baseUrl: resolveRequestBaseUrl(req) }
    );
    if (!ok) throw new Error('Gateway WhatsApp mengembalikan gagal');
    return true;
  } catch (error) {
    logger.error(`[Webhook] Gagal kirim notif WA lunas (${gatewayLabel}): ${error.message || String(error)}`);
    return false;
  }
}

async function withTimeout(promise, timeoutMs, label, fallbackValue = null) {
  const timeout = Math.max(250, Number(timeoutMs) || 0);
  if (!timeout) return promise;

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timedOut: true }), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function guardExternalCall(promiseFactory, timeoutMs, label, fallbackValue = null) {
  try {
    const result = await withTimeout(Promise.resolve().then(promiseFactory), timeoutMs, label, fallbackValue);
    if (result && result.__timedOut) {
      logger.warn(`[CustomerPortal] ${label} timeout setelah ${timeoutMs}ms.`);
      return fallbackValue;
    }
    return result;
  } catch (error) {
    logger.warn(`[CustomerPortal] ${label} gagal: ${error.message}`);
    return fallbackValue;
  }
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecodeToString(input) {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPublicToken(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyPublicToken(token, secret) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeInvoiceIdList(value) {
  const rawList = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const ids = [];
  for (const item of rawList) {
    const id = Number(item || 0);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function sortInvoicesForBulkPayment(invoices = []) {
  return [...(Array.isArray(invoices) ? invoices : [])].sort((a, b) => {
    const ay = Number(a?.period_year || 0);
    const by = Number(b?.period_year || 0);
    if (ay !== by) return ay - by;
    const am = Number(a?.period_month || 0);
    const bm = Number(b?.period_month || 0);
    if (am !== bm) return am - bm;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function formatBulkInvoicePeriods(invoices = []) {
  return sortInvoicesForBulkPayment(invoices)
    .map((inv) => `${String(inv.period_month || '').padStart(2, '0')}/${inv.period_year}`)
    .filter(Boolean)
    .join(', ');
}

function buildBulkPaymentMetadata(customer, invoices = [], totalAmount = 0) {
  const sortedInvoices = sortInvoicesForBulkPayment(invoices);
  return {
    billing_bulk: true,
    billing_customer_id: Number(customer?.id || sortedInvoices[0]?.customer_id || 0) || 0,
    billing_invoice_ids: sortedInvoices.map((inv) => Number(inv.id)).filter(Boolean),
    billing_total_amount: Number(totalAmount || 0) || 0,
    billing_periods: formatBulkInvoicePeriods(sortedInvoices),
    billing_created_at: new Date().toISOString()
  };
}

function extractBulkPaymentMetadata(payload) {
  if (!payload) return null;
  let parsed = payload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const source = parsed.billing_bulk ? parsed : (parsed.billing_meta && typeof parsed.billing_meta === 'object' ? parsed.billing_meta : null);
  if (!source || !source.billing_bulk) return null;
  const invoiceIds = normalizeInvoiceIdList(source.billing_invoice_ids);
  if (!invoiceIds.length) return null;
  return {
    customerId: Number(source.billing_customer_id || 0) || 0,
    invoiceIds,
    totalAmount: Number(source.billing_total_amount || 0) || 0,
    periods: String(source.billing_periods || '').trim()
  };
}

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const m = String(script).match(/\",rem,.*?,(.*?),(.*?),.*?\"/);
  if (!m) return null;
  const validity = String(m[1] || '').trim();
  const price = Number(String(m[2] || '').replace(/[^\d]/g, '')) || 0;
  return { validity, price };
}

function normalizeBuyerPhone(input) {
  const digits = normalizePhoneDigits(input);
  return digits.length < 8 ? '' : digits;
}

function genRandomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isEnabledFlag(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function isTripayEnabled(settings = {}) {
  return isEnabledFlag(settings.tripay_enabled);
}

function hasTripayCredentials(settings = {}) {
  return Boolean(
    String(settings.tripay_api_key || '').trim() &&
    String(settings.tripay_private_key || '').trim() &&
    String(settings.tripay_merchant_code || '').trim()
  );
}

function resolveTripayFallbackQrisCode(settings = {}) {
  return String(settings.tripay_qris_method || settings.tripay_default_qris_method || process.env.TRIPAY_QRIS_METHOD || 'QRIS2')
    .trim()
    .toUpperCase() || 'QRIS2';
}

function buildTripayQrisFallbackChannel(settings = {}, note = '') {
  return {
    code: resolveTripayFallbackQrisCode(settings),
    name: 'Bayar Online Tripay',
    group: 'QRIS',
    active: true,
    source: 'tripay',
    fallback: true,
    note: note || 'Bayar online dari Tripay'
  };
}

function isQrisPaymentCode(code) {
  return String(code || '').trim().toUpperCase().startsWith('QRIS');
}

function getPaymentChannelRank(channel = {}) {
  const code = String(channel.code || '').toUpperCase();
  const source = String(channel.source || '').toLowerCase();
  const group = String(channel.group || '').trim();

  if (source === 'tripay' && isQrisPaymentCode(code)) return 1;
  if (isQrisPaymentCode(code)) return 2;
  if (group === 'E-Wallet') return 10;
  if (group === 'Virtual Account') return 20;
  if (group === 'Convenience Store') return 30;
  if (code === 'STATICQRIS') return 90;
  return 80;
}

function sortCustomerPaymentChannels(channels = []) {
  return [...channels].sort((a, b) => {
    const ra = getPaymentChannelRank(a);
    const rb = getPaymentChannelRank(b);
    if (ra !== rb) return ra - rb;
    return normalizePaymentMethodLabel(a).localeCompare(normalizePaymentMethodLabel(b), 'id');
  });
}

function choosePreferredCustomerPaymentMethod(channels = [], settings = {}) {
  const activeChannels = (Array.isArray(channels) ? channels : []).filter((channel) => channel && channel.active);
  const tripayQris = activeChannels.find((channel) => (
    String(channel.source || '').toLowerCase() === 'tripay' &&
    isQrisPaymentCode(channel.code)
  ));
  if (tripayQris) return String(tripayQris.code || 'QRIS').toUpperCase();
  if (isTripayEnabled(settings) && hasTripayCredentials(settings)) return resolveTripayFallbackQrisCode(settings);
  return String(activeChannels[0]?.code || (hasStaticQrisEnabled(settings) ? 'STATICQRIS' : 'QRIS')).toUpperCase();
}

function canFallbackToStaticQris(gateway, method, settings = {}) {
  return (
    String(gateway || '').toLowerCase() === 'tripay' &&
    isQrisPaymentCode(method) &&
    hasStaticQrisEnabled(settings)
  );
}

function resolvePaymentExpiresAt(gateway, result) {
  const g = String(gateway || '').toLowerCase();
  const p = result && result.payload ? result.payload : null;

  const tryDate = (v) => {
    const t = new Date(v);
    const ms = t.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return t.toISOString();
  };

  const tryUnix = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    const out = d.getTime();
    if (!Number.isFinite(out) || out <= 0) return null;
    return d.toISOString();
  };

  if (p && g === 'tripay') {
    return (
      tryUnix(p.expired_time ?? p.expiredTime) ||
      tryDate(p.expired_at ?? p.expiredAt) ||
      tryDate(p.expiry_date ?? p.expiryDate) ||
      null
    );
  }

  if (p && g === 'xendit') {
    return (
      tryDate(p.expiry_date ?? p.expiryDate) ||
      tryDate(p.expiration_date ?? p.expirationDate) ||
      null
    );
  }

  if (p && g === 'duitku') {
    return (
      tryDate(p.expiry_date ?? p.expiryDate) ||
      tryUnix(p.expired_time ?? p.expiredTime) ||
      null
    );
  }

  if (p && g === 'midtrans') {
    return (
      tryDate(p.expiry_time ?? p.expiryTime) ||
      tryDate(p.expired_at ?? p.expiredAt) ||
      null
    );
  }

  return null;
}

function gatewayDefaultExpiresAtIso(gateway, nowMs = Date.now()) {
  const g = String(gateway || '').toLowerCase();
  const base = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  if (g === 'xendit') return new Date(base + 86400 * 1000).toISOString();
  if (g === 'duitku') return new Date(base + 1440 * 60 * 1000).toISOString();
  return null;
}

function normalizePaymentSelectionMethod(value) {
  return String(value || '').trim().toUpperCase();
}

function canReuseInvoicePaymentLink(invoice = {}, gateway = '', method = '') {
  const requestedGateway = String(gateway || '').trim().toLowerCase();
  const storedGateway = String(invoice.payment_gateway || '').trim().toLowerCase();
  const requestedMethod = normalizePaymentSelectionMethod(method);
  const storedMethod = normalizePaymentSelectionMethod(invoice.payment_method || '');
  if (!invoice.payment_link || !requestedGateway || !requestedMethod) return false;
  return storedGateway === requestedGateway && storedMethod === requestedMethod;
}

function hasStaticQrisEnabled(settings) {
  return resolveStaticQrisEnabled(settings);
}

function normalizePaymentMethodLabel(channel = {}) {
  const code = String(channel.code || '').toUpperCase();
  const rawName = String(channel.name || '').trim();
  const map = {
    STATICQRIS: 'Bayar Online Cadangan',
    QRIS: 'Bayar Online Tripay',
    QRIS2: 'Bayar Online Tripay',
    BCAVA: 'BCA Virtual Account',
    BNIVA: 'BNI Virtual Account',
    BRIVA: 'BRI Virtual Account',
    MANDIRIVA: 'Mandiri Virtual Account',
    PERMATAVA: 'Permata Virtual Account',
    CIMBVA: 'CIMB Virtual Account',
    DANAMONVA: 'Danamon Virtual Account'
  };
  return map[code] || rawName || code;
}

function getCustomerPaymentChannelsCacheKey(settings = {}) {
  return JSON.stringify({
    staticQris: hasStaticQrisEnabled(settings),
    tripayEnabled: isTripayEnabled(settings),
    tripayReady: hasTripayCredentials(settings),
    tripayMode: String(settings.tripay_mode || '').trim().toLowerCase()
  });
}

function getCachedCustomerPaymentChannels(settings = {}) {
  const cacheKey = getCustomerPaymentChannelsCacheKey(settings);
  if (customerPaymentChannelsCache.key !== cacheKey) return null;
  if (Date.now() >= Number(customerPaymentChannelsCache.expiresAt || 0)) return null;
  return Array.isArray(customerPaymentChannelsCache.value)
    ? customerPaymentChannelsCache.value.map((channel) => ({ ...channel }))
    : null;
}

function setCachedCustomerPaymentChannels(settings = {}, channels = []) {
  customerPaymentChannelsCache = {
    key: getCustomerPaymentChannelsCacheKey(settings),
    expiresAt: Date.now() + CUSTOMER_PAYMENT_CHANNELS_CACHE_TTL_MS,
    value: Array.isArray(channels) ? channels.map((channel) => ({ ...channel })) : []
  };
}

function prunePackageChangeAttemptStore(now = Date.now()) {
  for (const [key, entry] of packageChangeAttemptStore.entries()) {
    const resetAt = Number(entry?.resetAt || 0);
    if (!resetAt || resetAt <= now) packageChangeAttemptStore.delete(key);
  }
}

function checkPackageChangeRateLimit(req, customerId) {
  const cid = Number(customerId || 0);
  if (!Number.isFinite(cid) || cid <= 0) return { allowed: false, retryAt: new Date(Date.now() + PACKAGE_CHANGE_RATE_LIMIT_WINDOW_MS) };

  const now = Date.now();
  prunePackageChangeAttemptStore(now);
  const key = `${cid}:${String(req.ip || '').trim()}`;
  const existing = packageChangeAttemptStore.get(key);
  if (!existing || Number(existing.resetAt || 0) <= now) {
    const fresh = { count: 1, resetAt: now + PACKAGE_CHANGE_RATE_LIMIT_WINDOW_MS };
    packageChangeAttemptStore.set(key, fresh);
    return { allowed: true, retryAt: new Date(fresh.resetAt), remaining: PACKAGE_CHANGE_RATE_LIMIT_MAX_ATTEMPTS - 1 };
  }
  if (Number(existing.count || 0) >= PACKAGE_CHANGE_RATE_LIMIT_MAX_ATTEMPTS) {
    return { allowed: false, retryAt: new Date(existing.resetAt), remaining: 0 };
  }
  existing.count += 1;
  packageChangeAttemptStore.set(key, existing);
  return { allowed: true, retryAt: new Date(existing.resetAt), remaining: Math.max(0, PACKAGE_CHANGE_RATE_LIMIT_MAX_ATTEMPTS - existing.count) };
}

function buildPortalPackageChangeViewState(profile) {
  if (!profile?.id) {
    return {
      activeRequest: null,
      latestRequest: null,
      nextEligibleAtText: '',
      canRequestNow: false,
      reason: 'Data pelanggan belum siap.',
      canRequestNowByDate: false
    };
  }

  const state = packageChangeSvc.getPortalPackageChangeState(profile.id);
  return {
    ...state,
    nextEligibleAtText: state.nextEligibleAt
      ? state.nextEligibleAt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
    canRequestNowByDate: !state.nextEligibleAt || state.nextEligibleAt.getTime() <= Date.now()
  };
}

function getCustomerProfileChangeState(customerId) {
  const cid = Number(customerId || 0);
  if (!Number.isFinite(cid) || cid <= 0) {
    return { activeRequest: null, latestRequest: null };
  }
  const activeRequest = db.prepare(`
    SELECT *
    FROM customer_profile_change_requests
    WHERE customer_id = ? AND status = 'pending'
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(cid) || null;
  const latestRequest = db.prepare(`
    SELECT *
    FROM customer_profile_change_requests
    WHERE customer_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(cid) || null;
  return { activeRequest, latestRequest };
}

function normalizeCustomerProfileChangeInput(body = {}) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const phoneDigits = normalizePhoneDigits(body.phone || '');
  const nik = String(body.nik || '').trim().replace(/[^\dA-Za-z]/g, '').slice(0, 32);
  const address = String(body.address || '').trim().replace(/\s+/g, ' ').slice(0, 260);
  return { name, phone: phoneDigits, nik, address };
}

async function getCustomerPaymentChannels(settings = {}) {
  const cached = getCachedCustomerPaymentChannels(settings);
  if (cached) return cached;

  const channels = [];
  const tripayReady = isTripayEnabled(settings) && hasTripayCredentials(settings);

  if (tripayReady) {
    let tripayActiveChannels = [];
    try {
      const tripayChannels = await paymentSvc.getTripayChannels();
      tripayActiveChannels = (Array.isArray(tripayChannels) ? tripayChannels : [])
        .filter((channel) => channel && channel.active)
        .map((channel) => ({
          ...channel,
          name: normalizePaymentMethodLabel(channel),
          source: 'tripay'
        }));
      tripayActiveChannels.forEach((channel) => channels.push(channel));
    } catch (error) {
      logger.warn(`[Payment] Gagal menyiapkan channel Tripay: ${error.message}`);
    }

    const hasTripayQris = tripayActiveChannels.some((channel) => isQrisPaymentCode(channel.code));
    if (!tripayActiveChannels.length || !hasTripayQris) {
      channels.push(buildTripayQrisFallbackChannel(settings,
        tripayActiveChannels.length
          ? 'Bayar Online Tripay dijadikan default pembayaran'
          : 'Daftar channel Tripay belum terbaca, Bayar Online tetap disiapkan'
      ));
    }
  }

  if (hasStaticQrisEnabled(settings)) {
    channels.push({
      code: 'STATICQRIS',
      name: 'Bayar Online Cadangan',
      group: 'QRIS',
      active: true,
      source: 'internal',
      note: 'Cadangan bayar online internal dengan nominal otomatis'
    });
  }

  const seen = new Set();
  const priority = {
    STATICQRIS: 1,
    QRIS: 2,
    DANA: 3,
    OVO: 4,
    SHOPEEPAY: 5,
    GOPAY: 6,
    LINKAJA: 7
  };

  const normalizedChannels = channels
    .filter((channel) => {
      const key = String(channel.code || '').toUpperCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const ra = getPaymentChannelRank(a);
      const rb = getPaymentChannelRank(b);
      if (ra !== rb) return ra - rb;
      const codeA = String(a.code || '').toUpperCase();
      const codeB = String(b.code || '').toUpperCase();
      const pa = priority[codeA] || 99;
      const pb = priority[codeB] || 99;
      if (pa !== pb) return pa - pb;
      return normalizePaymentMethodLabel(a).localeCompare(normalizePaymentMethodLabel(b), 'id');
    });
  setCachedCustomerPaymentChannels(settings, normalizedChannels);
  return normalizedChannels;
}

async function resolveCustomerPaymentGateway(settings, method) {
  const chosen = String(method || '').trim().toUpperCase();
  if (chosen === 'STATICQRIS') return 'static';
  if (isTripayEnabled(settings) && hasTripayCredentials(settings)) {
    if (isQrisPaymentCode(chosen)) return 'tripay';
    try {
      const channels = await paymentSvc.getTripayChannels();
      const allowed = new Set((Array.isArray(channels) ? channels : []).filter((c) => c && c.active).map((c) => String(c.code || '').toUpperCase()));
      if (allowed.has(chosen)) return 'tripay';
    } catch {
      // ignore and fallback
    }
  }
  return String(settings.default_gateway || 'tripay').toLowerCase();
}

function ensureStaticQrisInvoice(invoiceId) {
  return billingSvc.assignUniqueQrisForInvoice(invoiceId);
}

const pppoeTrafficSamples = new Map();

function prunePppoeTrafficSamples(now) {
  const maxAgeMs = 3 * 60 * 1000;
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || now - v.t > maxAgeMs) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  for (const k of keys) {
    const v = obj && (obj[k] ?? obj[String(k)]);
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function strField(obj, keys) {
  for (const k of keys) {
    const v = obj && (obj[k] ?? obj[String(k)]);
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

function hasUsableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  const raw = String(value).trim();
  return raw !== '' && raw !== '-' && raw.toLowerCase() !== 'n/a';
}

function pickFirstUsable(...values) {
  for (const value of values) {
    if (hasUsableValue(value)) return value;
  }
  return values.length ? values[values.length - 1] : undefined;
}

function mergeCustomerDashboardData(baseCustomer, pppoeSnapshot) {
  const base = baseCustomer || {};
  if (!pppoeSnapshot) return base;

  return {
    ...base,
    pppoeUsername: pickFirstUsable(base.pppoeUsername, pppoeSnapshot.username, '-'),
    pppoeIP: pickFirstUsable(base.pppoeIP, pppoeSnapshot.pppoeIp, base.pppoeIP, '-'),
    pppoeProfile: pickFirstUsable(base.pppoeProfile, pppoeSnapshot.profile, '-'),
    pppoeService: pickFirstUsable(base.pppoeService, pppoeSnapshot.service, '-'),
    pppoeCallerId: pickFirstUsable(base.pppoeCallerId, pppoeSnapshot.callerId, '-'),
    pppoeComment: pickFirstUsable(base.pppoeComment, pppoeSnapshot.comment, '-'),
    pppoeRateLimit: pickFirstUsable(base.pppoeRateLimit, pppoeSnapshot.rateLimit, '-'),
    pppoeLocalAddress: pickFirstUsable(base.pppoeLocalAddress, pppoeSnapshot.localAddress, '-'),
    pppoeRemoteAddress: pickFirstUsable(base.pppoeRemoteAddress, pppoeSnapshot.remoteAddress, '-'),
    pppoeInterface: pickFirstUsable(base.pppoeInterface, pppoeSnapshot.interface, '-'),
    pppoeUptime: pickFirstUsable(base.pppoeUptime, pppoeSnapshot.uptime, base.uptime, '-'),
    pppoeSessionId: pickFirstUsable(base.pppoeSessionId, pppoeSnapshot.sessionId, '-'),
    pppoeDisabled: Boolean(pppoeSnapshot.disabled),
    pppoeOnline: Boolean(pppoeSnapshot.online),
    pppoeStatusText: pickFirstUsable(base.pppoeStatusText, pppoeSnapshot.statusText, '-')
  };
}

function buildPortalCustomerViewModel(profile, deviceData, pppoeSnapshot) {
  const profileBase = profile || {};
  const deviceBase = deviceData || {};

  const mergedBase = {
    ...deviceBase,
    ...profileBase,
    id: pickFirstUsable(profileBase.id, deviceBase.id, null),
    name: pickFirstUsable(profileBase.name, deviceBase.name, 'Pelanggan'),
    phone: pickFirstUsable(profileBase.phone, deviceBase.phone, '-'),
    nik: pickFirstUsable(profileBase.nik, deviceBase.nik, ''),
    address: pickFirstUsable(profileBase.address, deviceBase.address, deviceBase.lokasi, '-'),
    lokasi: pickFirstUsable(profileBase.address, profileBase.lokasi, deviceBase.lokasi, '-'),
    package_name: pickFirstUsable(profileBase.package_name, deviceBase.package_name, '-'),
    package_price: Number(profileBase.package_price || deviceBase.package_price || 0) || 0,
    genieacs_tag: pickFirstUsable(profileBase.genieacs_tag, deviceBase.genieacs_tag, deviceBase.tag, ''),
    pppoe_username: pickFirstUsable(profileBase.pppoe_username, deviceBase.pppoeUsername, deviceBase.pppoe_username, ''),
    pppoeUsername: pickFirstUsable(profileBase.pppoe_username, deviceBase.pppoeUsername, deviceBase.pppoe_username, '-'),
    pppoeIP: pickFirstUsable(profileBase.static_ip, deviceBase.pppoeIP, deviceBase.pppoeIp, '-'),
    router_name: pickFirstUsable(profileBase.router_name, deviceBase.router_name, deviceBase.routerName, '-'),
    odp_name: pickFirstUsable(profileBase.odp_name, deviceBase.odp_name, deviceBase.odpName, '-'),
    status: pickFirstUsable(profileBase.status, deviceBase.status, 'active'),
    bytes_in: Number(profileBase.bytes_in || 0) || 0,
    bytes_out: Number(profileBase.bytes_out || 0) || 0,
    connectedUsers: Array.isArray(deviceBase.connectedUsers) ? deviceBase.connectedUsers : [],
    model: pickFirstUsable(deviceBase.model, deviceBase.productClass, profileBase.router_name, '-'),
    productClass: pickFirstUsable(deviceBase.productClass, deviceBase.model, '-'),
    ssid: pickFirstUsable(deviceBase.ssid, '-'),
    serialNumber: pickFirstUsable(deviceBase.serialNumber, '-'),
    rxPower: pickFirstUsable(deviceBase.rxPower, '-'),
    uptime: pickFirstUsable(deviceBase.uptime, '-'),
    softwareVersion: pickFirstUsable(deviceBase.softwareVersion, '-'),
    totalAssociations: pickFirstUsable(deviceBase.totalAssociations, '-')
  };

  return mergeCustomerDashboardData(mergedBase, pppoeSnapshot);
}

function syncPortalSessionProfile(req, profile, customerView = null) {
  if (!req?.session || !profile || !profile.id) return;
  req.session.customerId = Number(profile.id);

  const routerId = Number(profile.router_id || customerView?.router_id || 0);
  if (Number.isFinite(routerId) && routerId > 0) {
    req.session.router_id = routerId;
  }

  const pppoeUsername = String(
    profile.pppoe_username ||
    customerView?.pppoeUsername ||
    customerView?.pppoe_username ||
    req.session.pppoe_username ||
    ''
  ).trim();
  if (pppoeUsername) {
    req.session.pppoe_username = pppoeUsername;
  }
}

function parsePortalNotificationPayload(item) {
  const raw = item?.payload_json ?? item?.payload ?? {};
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function defaultPortalNotificationSender(kind) {
  const normalized = String(kind || 'system').trim();
  if (normalized === 'announcement') return { name: 'Admin', role: 'Pengumuman' };
  if (normalized === 'invoice' || normalized === 'due-reminder') return { name: 'Billing', role: 'Tagihan' };
  if (normalized === 'ticket') return { name: 'Bantuan Pelanggan', role: 'Tiket' };
  if (normalized === 'password') return { name: 'Sistem Router', role: 'Router WiFi' };
  if (normalized === 'suspension' || normalized === 'reactivation') return { name: 'Sistem Layanan', role: 'Status Layanan' };
  return { name: 'Sistem', role: 'Info Pelanggan' };
}

function pickPortalNotificationImage(payload) {
  const value = payload?.image_url || payload?.imageUrl || payload?.image || payload?.media_url || payload?.mediaUrl || '';
  return String(value || '').trim();
}

function parsePortalNotificationTime(value, fallback = Date.now()) {
  if (!value) return Number(fallback || Date.now());
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number(fallback || Date.now());
  const raw = String(value || '').trim();
  if (!raw) return Number(fallback || Date.now());
  const looksLikeSqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw);
  const normalized = looksLikeSqliteUtc ? `${raw.replace(' ', 'T')}Z` : raw;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : Number(fallback || Date.now());
}

function enrichPortalNotification(item, fallback = {}) {
  const kind = String(item?.kind || fallback.kind || 'system').trim() || 'system';
  const payload = parsePortalNotificationPayload(item);
  const sender = defaultPortalNotificationSender(kind);
  const sourceId = Number(item?.id || 0) || null;
  const rawCreatedMs = item?.created_at ? parsePortalNotificationTime(item.created_at, fallback.time || Date.now()) : Number(fallback.time || Date.now());
  const createdMs = Number.isFinite(rawCreatedMs) ? rawCreatedMs : Date.now();
  return {
    id: sourceId ? `inbox-${sourceId}` : String(fallback.id || `${kind}-${createdMs || Date.now()}`),
    sourceId,
    kind,
    payload,
    senderName: String(payload.sender_name || payload.senderName || payload.sender || fallback.senderName || sender.name || 'Sistem').trim() || sender.name,
    senderRole: String(payload.sender_role || payload.senderRole || fallback.senderRole || sender.role || 'Info Pelanggan').trim() || sender.role,
    imageUrl: pickPortalNotificationImage(payload) || String(fallback.imageUrl || '').trim(),
    tab: String(item?.tab || fallback.tab || 'home').trim() || 'home',
    title: String(item?.title || fallback.title || 'Info pelanggan').trim() || 'Info pelanggan',
    body: String(item?.body || fallback.body || '').trim(),
    time: createdMs
  };
}

function buildCustomerNotifications({ invoices = [], tickets = [], appNotif = null, seenAt = null, profile = null, inboxItems = [] } = {}) {
  const notifications = [];
  const seenMs = seenAt ? parsePortalNotificationTime(seenAt, 0) : 0;

  if (appNotif && appNotif.text) {
    notifications.push({
      ...enrichPortalNotification(null, {
        id: 'session-info',
        kind: 'system',
        tab: 'home',
        title: 'Info sistem',
        body: appNotif.text,
        time: Date.now() - 1
      }),
      unread: false
    });
  }

  const hasIsolationInbox = inboxItems.some((item) => ['suspension', 'reactivation'].includes(String(item?.kind || '').trim()));
  if (profile && String(profile.status || '').toLowerCase() === 'suspended' && !hasIsolationInbox) {
    notifications.push({
      ...enrichPortalNotification(null, {
        id: 'status-suspension',
        kind: 'suspension',
        tab: 'billing',
        title: 'Layanan dinonaktifkan sementara',
        body: 'Masih ada tagihan yang belum lunas. Silakan cek tagihan atau hubungi admin.',
        time: Date.now()
      }),
      unread: true
    });
  }

  inboxItems
    .filter((item) => String(item?.kind || '').trim() !== 'wifi-offline')
    .forEach((item) => {
      const enriched = enrichPortalNotification(item);
      notifications.push({
        ...enriched,
        unread: Number(enriched.time || 0) > seenMs
      });
    });

  notifications.sort((a, b) => Number(b.time || 0) - Number(a.time || 0));

  return {
    items: notifications,
    unreadCount: notifications.filter((item) => item.unread).length
  };
}

function getCustomerNotificationPayload(profile, { appNotif = null } = {}) {
  if (!profile?.id) return { items: [], unreadCount: 0 };
  const invoices = billingSvc.getInvoicesByAny(resolveCustomerSessionLoginId(profile) || String(profile.id));
  const tickets = ticketSvc.getTicketsByCustomerId(profile.id);
  const inboxItems = customerSvc.getPortalNotifications(profile.id, 24);
  return buildCustomerNotifications({
    invoices: invoices || [],
    tickets: tickets || [],
    appNotif,
    seenAt: profile.portal_notifications_seen_at || null,
    profile,
    inboxItems
  });
}

function getPortalAccountStateLabel(status) {
  const normalized = normalizePortalAccountStatus(status);
  if (normalized === 'suspended') return 'Isolir';
  if (normalized === 'inactive') return 'Nonaktif';
  return 'Aktif';
}

function maybeCreatePortalOfflineAlert(profile, dashboardCustomer) {
  return;
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

const {
  findDeviceByTag,
  findDeviceByPppoe,
  getCustomerDeviceData,
  waitForCustomerDeviceData,
  fallbackCustomer,
  updateSSID,
  updatePassword,
  requestReboot,
  updateCustomerTag
} = customerDevice;
const {
  resolveCandidateRouterIds,
  resolvePppoeTrafficLive
} = customerDetailSvc;

function getPortalDeviceCache(req) {
  const cached = req?.session?.portalDeviceCache;
  return cached && typeof cached === 'object' ? cached : null;
}

function getPortalPppoeSnapshotCache(req, maxAgeMs = DASHBOARD_PPPOE_SNAPSHOT_CACHE_MAX_AGE_MS) {
  const cached = req?.session?.portalPppoeSnapshotCache;
  const cachedAt = Number(req?.session?.portalPppoeSnapshotCachedAt || 0);
  if (!cached || typeof cached !== 'object' || !cachedAt) return null;
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && (Date.now() - cachedAt) > maxAgeMs) return null;
  return cached;
}

function setPortalDeviceCache(req, deviceData) {
  if (!req?.session) return;
  req.session.portalDeviceCache = deviceData && typeof deviceData === 'object' ? deviceData : null;
  req.session.portalDeviceCachedAt = Date.now();
}

function setPortalPppoeSnapshotCache(req, snapshot) {
  if (!req?.session) return;
  req.session.portalPppoeSnapshotCache = snapshot && typeof snapshot === 'object' ? snapshot : null;
  req.session.portalPppoeSnapshotCachedAt = Date.now();
}

function patchPortalDeviceCache(req, partialData = {}) {
  if (!req?.session) return;
  const current = getPortalDeviceCache(req) || {};
  setPortalDeviceCache(req, { ...current, ...partialData });
}

async function primePortalDeviceCache(req, loginId) {
  if (!req?.session || !loginId) return null;
  try {
    const genieResult = await waitForCustomerDeviceData(loginId, {
      maxWaitMs: LOGIN_GENIE_PREFETCH_MAX_WAIT_MS,
      intervalMs: LOGIN_GENIE_PREFETCH_INTERVAL_MS,
      timeoutMs: LOGIN_GENIE_PREFETCH_REQUEST_TIMEOUT_MS,
      requestRefresh: true
    });
    const deviceData = genieResult?.data || null;
    if (deviceData) setPortalDeviceCache(req, deviceData);
    req.session.genieSyncPending = false;
    req.session.genieSyncLastAttemptAt = Date.now();
    return deviceData;
  } catch {
    req.session.genieSyncPending = false;
    req.session.genieSyncLastAttemptAt = Date.now();
    return null;
  }
}

registerPublicPortalRoutes(router, {
  getSettingsWithCache,
  customerSvc,
  billingSvc,
  getCustomerPaymentChannels,
  signPublicToken,
  verifyPublicToken
});

router.get('/voucher', async (req, res) => {
  const settings = getSettingsWithCache();
  const error = String(req.query.err || '').trim() || null;
  const info = String(req.query.info || '').trim() || null;

  let profiles = [];
  try {
    const raw = await mikrotikService.getHotspotUserProfiles(null);
    profiles = (Array.isArray(raw) ? raw : [])
      .map(p => {
        const meta = parseMikhmonOnLogin(p.onLogin || p['on-login']);
        if (!meta || !meta.validity) return null;
        const price = Number(meta.price || 0) || 0;
        if (price <= 0) return null;
        return { name: p.name, validity: meta.validity, price };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  } catch {
    profiles = [];
  }

  let paymentChannels = await getCustomerPaymentChannels(settings);

  let order = null;
  const orderId = Number(req.query.order || 0);
  if (orderId) {
    const secret = settings.session_secret || '';
    const payload = verifyPublicToken(req.query.t, secret);
    if (payload && Number(payload.voucherOrderId) === orderId) {
      order = db.prepare('SELECT * FROM public_voucher_orders WHERE id = ?').get(orderId) || null;
    }
  }

  res.render('public_voucher', {
    settings,
    profiles,
    paymentChannels,
    order,
    error,
    info
  });
});

router.post('/public/voucher/create-payment', async (req, res) => {
  const settings = getSettingsWithCache();

  const buyerPhone = normalizeBuyerPhone(req.body.buyer_phone);
  const profileName = String(req.body.profile_name || '').trim();
  const tosChecked = req.body.tos === 'on' || req.body.tos === '1' || req.body.tos === true || req.body.tos === 'true';

  if (!buyerPhone) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Nomor WhatsApp tidak valid'));
  if (!profileName) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Pilih paket voucher terlebih dahulu'));
  if (!tosChecked) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Harap centang persetujuan Syarat & Ketentuan (TOS) untuk melanjutkan.'));

  let selected = null;
  try {
    const raw = await mikrotikService.getHotspotUserProfiles(null);
    const list = Array.isArray(raw) ? raw : [];
    const found = list.find(p => String(p.name || '') === profileName);
    if (found) {
      const meta = parseMikhmonOnLogin(found.onLogin || found['on-login']);
      if (meta && meta.validity) {
        const price = Number(meta.price || 0) || 0;
        if (price > 0) {
          selected = { name: profileName, validity: meta.validity, price };
        }
      }
    }
  } catch {
    selected = null;
  }

  if (!selected) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Profile voucher tidak ditemukan'));
  if (!Number.isFinite(selected.price) || selected.price <= 0) return res.redirect('/customer/voucher?err=' + encodeURIComponent('Harga voucher tidak valid'));

  try {
    const ins = db.prepare(`
      INSERT INTO public_voucher_orders (router_id, profile_name, validity, price, buyer_phone, status)
      VALUES (NULL, ?, ?, ?, ?, 'pending')
    `).run(selected.name, selected.validity || '', Math.floor(selected.price), buyerPhone);
    const orderId = Number(ins.lastInsertRowid);

    const appUrl = resolveRequestBaseUrl(req);

    const enabled = {
      tripay: isEnabledFlag(settings.tripay_enabled),
      midtrans: isEnabledFlag(settings.midtrans_enabled),
      xendit: isEnabledFlag(settings.xendit_enabled),
      duitku: isEnabledFlag(settings.duitku_enabled)
    };
    let gateway = String(settings.default_gateway || 'tripay').toLowerCase();
    if (!enabled[gateway]) {
      gateway =
        enabled.tripay ? 'tripay' :
        enabled.midtrans ? 'midtrans' :
        enabled.xendit ? 'xendit' :
        enabled.duitku ? 'duitku' :
        'tripay';
    }

    const paymentChannels = await getCustomerPaymentChannels(settings);
    let method = String(req.body.method || choosePreferredCustomerPaymentMethod(paymentChannels, settings)).trim().toUpperCase();
    if (!method) method = choosePreferredCustomerPaymentMethod(paymentChannels, settings);
    gateway = await resolveCustomerPaymentGateway(settings, method);
    if (method === 'STATICQRIS' && hasStaticQrisEnabled(settings)) {
      return res.redirect(`/customer/public/payment/static/${encodeURIComponent(String(inv.id))}?t=${encodeURIComponent(String(req.body.token || ''))}`);
    }
    if (gateway === 'tripay') {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).filter((c) => c && c.active).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) method = 'QRIS';
      } catch {
        method = 'QRIS';
      }
    }

    const invoiceLike = {
      id: orderId,
      amount: Math.floor(selected.price),
      item_name: `Voucher Hotspot ${selected.name} (${selected.validity})`,
      sku: `VOUCHER-${orderId}`
    };
    const buyer = { name: 'Pembeli Voucher', phone: buyerPhone, email: '' };

    const secret = settings.session_secret || '';
    const token = signPublicToken({ voucherOrderId: orderId, exp: Date.now() + 24 * 60 * 60 * 1000 }, secret);
    const returnPath = `/customer/voucher?order=${encodeURIComponent(String(orderId))}&t=${encodeURIComponent(token)}`;

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(invoiceLike, buyer, 'snap', appUrl, { returnPath });
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(invoiceLike, buyer, 'xendit', appUrl, { returnPath, description: invoiceLike.item_name });
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(invoiceLike, buyer, method, appUrl, { returnPath, itemName: invoiceLike.item_name });
    } else {
      try {
        result = await paymentSvc.createTripayTransaction(invoiceLike, buyer, method, appUrl, { returnPath, itemName: invoiceLike.item_name, sku: invoiceLike.sku });
      } catch (error) {
        if (isQrisPaymentCode(method)) {
          return res.redirect('/customer/voucher?err=' + encodeURIComponent('Tripay sedang gangguan. Silakan coba lagi beberapa saat lagi atau hubungi admin.'));
        }
        throw error;
      }
    }

    if (!result.success) throw new Error(result.message || 'Gagal membuat transaksi');

    db.prepare(`
      UPDATE public_voucher_orders SET
        payment_gateway = ?,
        payment_order_id = ?,
        payment_link = ?,
        payment_reference = ?,
        payment_payload = ?,
        payment_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      gateway,
      result.order_id || '',
      result.link || '',
      result.reference || '',
      result.payload ? JSON.stringify(result.payload) : null,
      resolvePaymentExpiresAt(gateway, result) || gatewayDefaultExpiresAtIso(gateway),
      orderId
    );

    return res.redirect(result.link);
  } catch (e) {
    logger.error('[PublicVoucher] Create payment error: ' + (e?.message || e));
    return res.redirect('/customer/voucher?err=' + encodeURIComponent('Gagal membuat pembayaran. Silakan coba lagi.'));
  }
});

// â”€â”€â”€ REGISTRATION / PENDAFTARAN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/register', (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  res.render('register', { error: null, success: null, settings, packages });
});

router.post('/register', async (req, res) => {
  const settings = getSettingsWithCache();
  const packages = customerSvc.getAllPackages().filter(p => p.is_active !== 0);
  const { name, phone, email, address, package_id, lat, lng } = req.body;

  try {
    if (!name || !phone || !address || !package_id) {
      throw new Error('Semua field wajib diisi.');
    }

    // Buat pelanggan dengan status inactive (menunggu survei/pemasangan)
    customerSvc.createCustomer({
      name,
      phone,
      email,
      address,
      package_id,
      lat: String(lat || '').trim(),
      lng: String(lng || '').trim(),
      status: 'inactive',
      notes: 'Pendaftar Baru via Online'
    });

    // Kirim notifikasi ke Admin
    if (settings.whatsapp_enabled && settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
      const selectedPkg = packages.find(p => p.id.toString() === package_id.toString());
      const pkgName = selectedPkg ? selectedPkg.name : 'Tidak diketahui';
      
      const adminMsg = `ðŸ”” *PENDAFTARAN BARU*\n\nAda calon pelanggan baru yang mendaftar via web:\n\nðŸ‘¤ *Nama:* ${name}\nðŸ“ž *WA:* ${phone}\nðŸ“ *Alamat:* ${address}\nðŸ“¦ *Paket:* ${pkgName}\n\nSilakan cek di panel Admin untuk menindaklanjuti.`;
      const latStr = String(lat || '').trim();
      const lngStr = String(lng || '').trim();
      const mapLine = (latStr && lngStr) ? `\nðŸ—ºï¸ *Lokasi:* https://maps.google.com/?q=${encodeURIComponent(latStr)},${encodeURIComponent(lngStr)}` : '';
      const finalAdminMsg = adminMsg + mapLine;
      
      const seen = new Set();
      for (const adminPhone of settings.whatsapp_admin_numbers) {
        let digits = String(adminPhone || '').replace(/\D/g, '');
        if (!digits) continue;
        if (digits.startsWith('0')) digits = '62' + digits.slice(1);
        if (seen.has(digits)) continue;
        seen.add(digits);
        try { await whatsappGateway.sendText(digits, finalAdminMsg); } catch(e) { /* ignore */ }
      }
    }

    res.render('register', { 
      error: null, 
      success: 'Pendaftaran berhasil! Tim kami akan segera menghubungi Anda melalui WhatsApp.', 
      settings, packages 
    });
  } catch (err) {
    res.render('register', { error: err.message, success: null, settings, packages });
  }
});

router.post('/login', async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const settings = getSettingsWithCache();
  const rememberMe = true;

  function renderLoginError(message) {
    return res.render('login', {
      error: message,
      settings,
      form: { phone, rememberMe }
    });
  }

  if (!phone) {
    return renderLoginError('ID pelanggan wajib diisi.');
  }

  const matchedCustomer = customerSvc.findCustomerByAny(phone);
  if (!matchedCustomer) {
    logger.warn('[Login] Gagal: pelanggan tidak ditemukan di billing DB.');
    return renderLoginError('Data pelanggan tidak ditemukan. Pastikan nomor WhatsApp sudah benar.');
  }

  const loginTag = resolveCustomerSessionLoginId(matchedCustomer);
  if (!loginTag) {
    return renderLoginError('Data login pelanggan belum lengkap. Silakan hubungi admin.');
  }

  if (!settings.login_otp_enabled) {
    req.session.phone = loginTag;
    req.session.customerId = Number(matchedCustomer.id);
    keepCustomerSessionPersistent(req);
    req.session.genieSyncPending = true;
    req.session.genieSyncStartedAt = Date.now();
    await primePortalDeviceCache(req, loginTag);
    logger.info(`[Login] Login biasa berhasil untuk customerId=${matchedCustomer.id || '-'}.`);
    return req.session.save(() => {
      return res.redirect('/customer/dashboard');
    });
  }

  const deliveryPhone = normalizeBuyerPhone(matchedCustomer.phone);
  if (!deliveryPhone) {
    logger.warn(`[Login] Gagal: pelanggan ${matchedCustomer.id || '-'} belum memiliki nomor WhatsApp terdaftar.`);
    return renderLoginError('Nomor WhatsApp pelanggan belum terdaftar. Silakan hubungi admin.');
  }

  if (!settings.whatsapp_enabled) {
    return renderLoginError('Login pelanggan sekarang mewajibkan OTP WhatsApp. Aktifkan WhatsApp bot terlebih dahulu.');
  }

  const loginOtp = Math.floor(1000 + Math.random() * 9000).toString();
  const loginExpiry = Date.now() + 5 * 60 * 1000;

  req.session.pending_login = {
    customerId: Number(matchedCustomer.id),
    phone: deliveryPhone,
    effectiveTag: loginTag,
    rememberMe: true,
    otp: loginOtp,
    expiry: loginExpiry
  };

  logger.info(`[Login] OTP dibuat untuk customerId=${matchedCustomer.id || '-'}.`);

  try {
    const ready = await whatsappGateway.ensureReady(15000);

    if (!ready) {
      throw new Error('Sistem WhatsApp sedang tidak aktif. Silakan hubungi Admin.');
    }

    const msg = `*KODE VERIFIKASI (OTP)*\n\nKode Anda adalah: *${loginOtp}*\n\nJangan berikan kode ini kepada siapapun. Kode berlaku selama 5 menit.`;
    const sent = await whatsappGateway.sendText(deliveryPhone, msg);

    if (!sent) {
      throw new Error('Gagal mengirim kode OTP melalui WhatsApp. Pastikan nomor Anda terdaftar di WhatsApp.');
    }

    logger.info('[Login] OTP dikirim via WhatsApp.');
    return res.redirect('/customer/login-otp');
  } catch (e) {
    logger.error(`[Login] Gagal kirim OTP via WhatsApp: ${e.message}`);
    delete req.session.pending_login;
    return renderLoginError(e.message);
  }

  // 3. Tahap 3: Verifikasi Akhir
  if (!device && !customer) {
    logger.warn('[Login] Gagal: pelanggan tidak ditemukan.');
    return res.render('login', { 
      error: 'Data pelanggan tidak ditemukan. Pastikan nomor WhatsApp sudah benar.', 
      settings 
    });
  }

  if (!device) {
    logger.warn('[Login] Login dilanjutkan tanpa data ONU (device tidak ditemukan).');
  }

  // --- OTP LOGIC --- (Hanya jika perangkat ditemukan)
  if (settings.login_otp_enabled) {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 5 * 60 * 1000; // 5 menit
    
    // Simpan ke session sementara
    req.session.pending_login = {
      phone: phone,
      effectiveTag: effectiveTag,
      otp: otp,
      expiry: expiry
    };

    logger.info('[Login] OTP dibuat.');

    // Kirim via WhatsApp
    if (settings.whatsapp_enabled) {
      try {
        const ready = await whatsappGateway.ensureReady(15000);
        
        if (!ready) {
          throw new Error('Sistem WhatsApp sedang tidak aktif. Silakan hubungi Admin.');
        }

        const msg = `*KODE VERIFIKASI (OTP)*\n\nKode Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapapun. Kode berlaku selama 5 menit.`;
        const sent = await whatsappGateway.sendText(phone, msg);
        
        if (!sent) {
          throw new Error('Gagal mengirim kode OTP melalui WhatsApp. Pastikan nomor Anda terdaftar di WhatsApp.');
        }

        logger.info('[Login] OTP dikirim via WhatsApp.');
      } catch (e) {
        logger.error(`[Login] Gagal kirim OTP via WhatsApp: ${e.message}`);
        return res.render('login', { error: e.message, settings });
      }
    }

    return res.redirect('/customer/login-otp');
  }

  // --- DIRECT LOGIN ---
  logger.info('[Login] Login direct berhasil.');
  req.session.phone = effectiveTag;
  return res.redirect('/customer/dashboard');
});

router.get('/login-otp', (req, res) => {
  const settings = getSettingsWithCache();
  if (!req.session.pending_login) return res.redirect('/customer/login');
  res.render('login_otp', { error: null, settings, phone: req.session.pending_login.phone });
});

router.post('/login-otp', async (req, res) => {
  const { otp } = req.body;
  const settings = getSettingsWithCache();
  const pending = req.session.pending_login;

  if (!pending) return res.redirect('/customer/login');

  if (Date.now() > pending.expiry) {
    delete req.session.pending_login;
    return res.render('login', { error: 'Kode OTP telah kadaluarsa. Silakan login kembali.', settings });
  }

  if (otp === pending.otp) {
    logger.info('[Login] OTP berhasil diverifikasi.');
    const customer = customerSvc.getCustomerById(pending.customerId);
    if (!customer) {
      delete req.session.pending_login;
      return res.render('login', { error: 'Data pelanggan tidak ditemukan. Silakan login kembali.', settings });
    }

    req.session.phone = pending.effectiveTag;
    req.session.customerId = Number(customer.id);
    keepCustomerSessionPersistent(req);
    req.session.genieSyncPending = true;
    req.session.genieSyncStartedAt = Date.now();
    await primePortalDeviceCache(req, pending.effectiveTag);
    delete req.session.pending_login;
    return req.session.save(() => {
      return res.redirect('/customer/dashboard');
    });
  } else {
    return res.render('login_otp', { error: 'Kode OTP salah. Silakan coba lagi.', settings, phone: pending.phone });
  }
});

// Pelanggan nonaktif / terisolir tetap boleh masuk portal untuk melihat tagihan dan melakukan pembayaran.
router.use((req, res, next) => {
  next();
});

router.get('/invoices/:id/print', (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.redirect('/customer/login');

  const invoice = billingSvc.getInvoiceById(req.params.id);
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');
  if (Number(invoice.customer_id) !== Number(profile.id)) return res.status(403).send('Invoice tidak valid untuk akun ini');

  const customer = customerSvc.getCustomerById(invoice.customer_id) || profile;
  const settings = getSettingsWithCache();
  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';

  return res.render('admin/print_invoice', {
    invoice,
    customer,
    company: settings.company_header || 'PT Media Solusi Sukses',
    settings,
    printStyle,
    viewerRole: 'customer',
    printBasePath: `/customer/invoices/${invoice.id}/print`
  });
});

router.get('/public/invoices/:id/print', (req, res) => {
  const settings = getSettingsWithCache();
  const secret = String(settings.session_secret || '').trim();
  const payload = verifyPublicToken(req.query.t, secret);
  const invoiceId = Number(req.params.id || 0);
  if (!payload || Number(payload.invoiceId || 0) !== invoiceId) {
    return res.status(403).send('Link invoice tidak valid atau sudah kedaluwarsa');
  }

  const invoice = billingSvc.getInvoiceById(invoiceId);
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');
  if (Number(payload.customerId || 0) !== Number(invoice.customer_id || 0)) {
    return res.status(403).send('Invoice tidak valid');
  }

  const customer = customerSvc.getCustomerById(invoice.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');
  const payloadLookup = String(payload.lookup || '').trim();
  const allowedLookups = new Set([
    resolveCustomerLookup(customer),
    customer.customer_code,
    customer.pppoe_username,
    customer.genieacs_tag,
    customer.hotspot_username,
    customer.phone,
    customer.id,
    customer.customer_id
  ].map((item) => String(item || '').trim()).filter(Boolean));
  if (payloadLookup && !allowedLookups.has(payloadLookup)) {
    return res.status(403).send('Data invoice tidak cocok');
  }

  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
  return res.render('admin/print_invoice', {
    invoice,
    customer,
    company: settings.company_header || 'PT Media Solusi Sukses',
    settings,
    printStyle,
    viewerRole: 'public',
    printBasePath: `${req.path}?t=${encodeURIComponent(String(req.query.t || ''))}`
  });
});

router.get('/i/:code', (req, res) => {
  const settings = getSettingsWithCache();
  const secret = String(settings.session_secret || '').trim();
  const parsed = parsePublicInvoiceCode(req.params.code, secret);
  if (!parsed || !Number(parsed.invoiceId || 0)) {
    return res.status(403).send('Link invoice tidak valid atau sudah kedaluwarsa');
  }

  const invoice = billingSvc.getInvoiceById(parsed.invoiceId);
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');

  const customer = customerSvc.getCustomerById(invoice.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const verified = parsePublicInvoiceCode(req.params.code, secret, invoice.customer_id);
  if (!verified) {
    return res.status(403).send('Link invoice tidak valid atau sudah kedaluwarsa');
  }

  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
  return res.render('admin/print_invoice', {
    invoice,
    customer,
    company: settings.company_header || 'PT Media Solusi Sukses',
    settings,
    printStyle,
    viewerRole: 'public',
    printBasePath: req.path
  });
});

function renderPublicShortInvoice(req, res, code) {
  const settings = getSettingsWithCache();
  const secret = String(settings.session_secret || '').trim();
  const parsed = parseShortInvoiceCheckCode(code, secret);
  if (!parsed || !Number(parsed.invoiceId || 0)) {
    return res.status(403).send('Link invoice tidak valid');
  }

  const invoice = billingSvc.getInvoiceById(parsed.invoiceId);
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');
  if (Number(invoice.customer_id || 0) !== Number(parsed.customerId || 0)) {
    return res.status(403).send('Invoice tidak valid');
  }

  const customer = customerSvc.getCustomerById(invoice.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
  return res.render('admin/print_invoice', {
    invoice,
    customer,
    company: settings.company_header || 'PT Media Solusi Sukses',
    settings,
    printStyle,
    viewerRole: 'public',
    printBasePath: req.path
  });
}

function redirectPublicShortInvoiceBilling(req, res, code) {
  const settings = getSettingsWithCache();
  const secret = String(settings.session_secret || '').trim();
  const parsed = parseShortInvoiceCheckCode(code, secret);
  if (!parsed || !Number(parsed.invoiceId || 0)) {
    return res.redirect('/customer/check-billing?err=' + encodeURIComponent('Link tagihan tidak valid.'));
  }

  const invoice = billingSvc.getInvoiceById(parsed.invoiceId);
  if (!invoice) {
    return res.redirect('/customer/check-billing?err=' + encodeURIComponent('Tagihan tidak ditemukan.'));
  }

  const customer = customerSvc.getCustomerById(invoice.customer_id);
  if (!customer || Number(customer.id || 0) !== Number(parsed.customerId || 0)) {
    return res.redirect('/customer/check-billing?err=' + encodeURIComponent('Data tagihan tidak valid.'));
  }

  const lookup = resolveCustomerLookup(customer);
  const token = signPublicToken({
    invoiceId: Number(invoice.id),
    customerId: Number(invoice.customer_id),
    lookup,
    exp: Date.now() + 15 * 60 * 1000
  }, secret);

  return res.redirect(`/customer/check-billing?t=${encodeURIComponent(token)}`);
}

router.get(/^\/inv(\d+[a-f0-9]{8})\/print$/i, (req, res) => {
  return renderPublicShortInvoice(req, res, req.params[0]);
});

router.get(/^\/inv\/(\d+[a-f0-9]{8})\/print$/i, (req, res) => {
  return renderPublicShortInvoice(req, res, req.params[0]);
});

router.get(/^\/inv(\d+[a-f0-9]{8})$/i, (req, res) => {
  return redirectPublicShortInvoiceBilling(req, res, req.params[0]);
});

router.get(/^\/inv\/(\d+[a-f0-9]{8})$/i, (req, res) => {
  return redirectPublicShortInvoiceBilling(req, res, req.params[0]);
});

router.get('/dashboard', async (req, res) => {
  const profile = getSessionCustomer(req);
  const loginId = (req.session && req.session.phone) || resolveCustomerSessionLoginId(profile);
  if (!loginId || !profile) return res.redirect('/customer/login');
  
  // Flash message
  let msgNotif = null;
  let settingsActionNotif = null;
  let profileActionNotif = null;
  if (req.session._msg) {
    const target = String(req.session._msg.target || '').trim().toLowerCase();
    if (target === 'ssid' || target === 'password') {
      settingsActionNotif = {
        target,
        text: req.session._msg.text,
        type: req.session._msg.type || 'success'
      };
    } else if (target === 'profile') {
      profileActionNotif = {
        text: req.session._msg.text,
        type: req.session._msg.type || 'success'
      };
    } else {
      msgNotif = dashboardNotif(req.session._msg.text, req.session._msg.type);
    }
    delete req.session._msg;
  }
  
  const deviceData = getPortalDeviceCache(req);
  if (req.session) {
    req.session.genieSyncPending = false;
    if (!req.session.genieSyncLastAttemptAt) {
      req.session.genieSyncLastAttemptAt = Date.now();
    }
  }
  const routerId = profile && profile.router_id ? Number(profile.router_id) : null;
  const pppoeSnapshot = getPortalPppoeSnapshotCache(req);
  const refreshedProfile = profile?.id ? (customerSvc.getCustomerById(profile.id) || profile) : profile;
  const dashboardCustomer = buildPortalCustomerViewModel(
    refreshedProfile || fallbackCustomer(loginId),
    deviceData || null,
    pppoeSnapshot
  );
  maybeCreatePortalOfflineAlert(refreshedProfile, dashboardCustomer);
  syncPortalSessionProfile(req, refreshedProfile, dashboardCustomer);
  
  // Data dari Billing DB (Coba cari pakai loginId atau pppoeUsername)
  let searchToken = resolveCustomerSessionLoginId(refreshedProfile) || loginId;
  if (dashboardCustomer && dashboardCustomer.pppoeUsername && hasUsableValue(dashboardCustomer.pppoeUsername)) {
    searchToken = dashboardCustomer.pppoeUsername;
  }

  let reactivationInvoiceResult = null;
  if (refreshedProfile && ['suspended', 'inactive'].includes(String(refreshedProfile.status || '').toLowerCase())) {
    try {
      reactivationInvoiceResult = billingSvc.ensurePortalReactivationInvoice(refreshedProfile.id);
    } catch (error) {
      logger.warn(`[Portal] Gagal menyiapkan tagihan aktivasi untuk customerId=${refreshedProfile.id}: ${error.message}`);
    }
  }

  const invoices = billingSvc.getInvoicesByAny(searchToken);
  if (reactivationInvoiceResult?.created && !msgNotif) {
    msgNotif = dashboardNotif('Tagihan aktivasi sudah disiapkan. Silakan lanjutkan pembayaran agar layanan bisa aktif kembali.', 'info');
  }
  
  // Ambil tiket keluhan pelanggan
  let tickets = [];
  if (refreshedProfile) {
    tickets = ticketSvc.getTicketsByCustomerId(refreshedProfile.id);
  }

  if (routerId) {
    req.session.router_id = routerId;
  }
  const pppoeFromProfile = refreshedProfile && String(refreshedProfile.pppoe_username || '').trim();
  const pppoeFromDevice = dashboardCustomer && String(dashboardCustomer.pppoeUsername || '').trim();
  if (pppoeFromProfile) req.session.pppoe_username = pppoeFromProfile;
  else if (pppoeFromDevice) req.session.pppoe_username = pppoeFromDevice;

  const settings = getSettingsWithCache();
  let paymentChannels = await guardExternalCall(
    () => getCustomerPaymentChannels(settings),
    DASHBOARD_PAYMENT_CHANNELS_TIMEOUT_MS,
    'payment channels customer dashboard',
    getCachedCustomerPaymentChannels(settings) || []
  );

  let trafficMaxDownMbps = 10;
  let trafficMaxUpMbps = 10;
  if (refreshedProfile) {
    const downKbps = Number(refreshedProfile.speed_down || 0);
    const upKbps = Number(refreshedProfile.speed_up || 0);
    if (Number.isFinite(downKbps) && downKbps > 0) trafficMaxDownMbps = Math.max(1, Math.round(downKbps / 1000));
    if (Number.isFinite(upKbps) && upKbps > 0) trafficMaxUpMbps = Math.max(1, Math.round(upKbps / 1000));
  }

  const genieSyncWarning = null;
  const baseNotif = msgNotif || null;
  const notificationSummary = getCustomerNotificationPayload(refreshedProfile || null, { appNotif: baseNotif });
  const portalPackages = refreshedProfile
    ? customerSvc.getPortalPackages(refreshedProfile.package_id).filter((pkg) => Number(pkg.id || 0) !== Number(refreshedProfile.package_id || 0))
    : [];
  const packageChangeState = refreshedProfile ? buildPortalPackageChangeViewState(refreshedProfile) : buildPortalPackageChangeViewState(null);
  const profileChangeState = refreshedProfile ? getCustomerProfileChangeState(refreshedProfile.id) : getCustomerProfileChangeState(null);

  res.render('dashboard', {
    customer: dashboardCustomer,
    profile: refreshedProfile || null,
    invoices: invoices || [],
    tickets: tickets || [],
    settings,
    paymentChannels,
    trafficMaxDownMbps,
    trafficMaxUpMbps,
    connectedUsers: Array.isArray(dashboardCustomer?.connectedUsers) ? dashboardCustomer.connectedUsers : [],
    isLoggedIn: true,
    notif: baseNotif,
    settingsActionNotif,
    profileActionNotif,
    notifications: notificationSummary.items,
    notificationUnreadCount: notificationSummary.unreadCount,
    portalPackages,
    packageChangeState,
    profileChangeState
  });
});

router.get('/api/pppoe-traffic', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  let routerId = req.session && req.session.router_id ? Number(req.session.router_id) : null;
  let username = String((req.session && req.session.pppoe_username) || '').trim();
  const profile = getSessionCustomer(req) || findCustomerProfileByLoginId(loginId);
  const getFreshUsageProfile = () => {
    if (!profile?.id) return profile;
    return customerSvc.getCustomerById(profile.id) || profile;
  };
  const getUsagePayload = (usageMeta = null) => {
    const refreshed = getFreshUsageProfile();
    const usageRow = usageMeta?.usage || null;
    const storedUploadBytes = Math.max(0, Number(usageRow?.bytes_in ?? refreshed?.bytes_in ?? 0) || 0);
    const storedDownloadBytes = Math.max(0, Number(usageRow?.bytes_out ?? refreshed?.bytes_out ?? 0) || 0);
    const usagePayload = {
      storedUploadBytes,
      storedDownloadBytes,
      storedTotalBytes: storedUploadBytes + storedDownloadBytes,
      updatedAt: usageMeta?.updatedAt || usageRow?.updated_at || '',
      freshnessSeconds: Number.isFinite(Number(usageMeta?.freshnessSeconds)) ? Number(usageMeta.freshnessSeconds) : null,
      usageLagSeconds: Number.isFinite(Number(usageMeta?.usageLagSeconds)) ? Number(usageMeta.usageLagSeconds) : null,
      usageSource: String(usageMeta?.usageSource || 'customer_usage').trim() || 'customer_usage',
      isAuthoritative: usageMeta?.isAuthoritative !== false,
      usageWritable: Boolean(profile?.id)
    };
    return {
      usage: usagePayload,
      usageBytesIn: usagePayload.storedUploadBytes,
      usageBytesOut: usagePayload.storedDownloadBytes,
      usageUploadBytes: usagePayload.storedUploadBytes,
      usageDownloadBytes: usagePayload.storedDownloadBytes,
      usageLagSeconds: usagePayload.usageLagSeconds,
      usageSource: usagePayload.usageSource,
      usageWritable: usagePayload.usageWritable
    };
  };
  const buildSafePayload = (partial = {}, usageMeta = null) => {
    const usagePayload = getUsagePayload(usageMeta);
    const live = {
      online: false,
      interface: null,
      source: 'snapshot',
      uptime: null,
      rxMbps: 0,
      txMbps: 0,
      uploadMbps: 0,
      downloadMbps: 0,
      ...(partial.live || {})
    };
    return {
      ok: true,
      available: partial.available !== undefined ? Boolean(partial.available) : true,
      username: partial.username !== undefined ? partial.username : (username || null),
      live,
      ...usagePayload,
      online: live.online,
      warmup: Boolean(live.warmup),
      iface: live.interface,
      source: live.source,
      uptime: live.uptime,
      rxMbps: live.rxMbps,
      txMbps: live.txMbps,
      uploadMbps: live.uploadMbps,
      downloadMbps: live.downloadMbps
    };
  };

  if (!username || !routerId) {
    if (!routerId && profile && profile.router_id) {
      routerId = Number(profile.router_id);
      req.session.router_id = routerId;
    }
    if (!username) {
      const pppoeFromProfile = profile && String(profile.pppoe_username || '').trim();
      if (pppoeFromProfile) {
        username = pppoeFromProfile;
        req.session.pppoe_username = username;
      } else if (/[a-zA-Z]/.test(String(loginId))) {
        username = String(loginId).trim();
      }
    }
  }

  if (!username) {
    const usageMeta = profile?.id ? usageSvc.getUsageSnapshotMeta(profile.id, new Date()) : null;
    return res.json(buildSafePayload({ available: false, username: null }, usageMeta));
  }
  try {
    const sessionProfile = profile || findCustomerProfileByLoginId(loginId);
    const candidateRouterIds = resolveCandidateRouterIds(
      routerId,
      [sessionProfile?.router_id, req.session?.router_id],
      3
    );
    const live = await withTimeout(
      resolvePppoeTrafficLive(username, routerId, candidateRouterIds),
      4200,
      'customer portal pppoe traffic',
      null
    );

    if (live?.routerId && Number(live.routerId) > 0) {
      routerId = Number(live.routerId);
      req.session.router_id = routerId;
    }

    if (!live) {
      const cachedSnapshot = getPortalPppoeSnapshotCache(req);
      const usageMeta = profile?.id ? usageSvc.getUsageSnapshotMeta(profile.id, new Date()) : null;
      if (cachedSnapshot) {
        return res.json(buildSafePayload({
          username,
          live: {
            online: Boolean(cachedSnapshot.online),
            interface: cachedSnapshot.interface || null,
            source: 'snapshot-cache',
            uptime: cachedSnapshot.uptime || null
          }
        }, usageMeta));
      }
      return res.json(buildSafePayload({
        username,
        available: true,
        live: {
          online: false,
          source: 'fallback'
        }
      }, usageMeta));
    }

    if (!live.online) {
      setPortalPppoeSnapshotCache(req, {
        username,
        online: false,
        statusText: 'Offline'
      });
      const usageMeta = profile?.id ? usageSvc.getUsageSnapshotMeta(profile.id, new Date()) : null;
      return res.json(buildSafePayload({
        username,
        live: {
          online: false,
          source: live.source || 'ppp-active'
        }
      }, usageMeta));
    }

    let usageMeta = profile?.id ? usageSvc.getUsageSnapshotMeta(profile.id, new Date()) : null;
    if (profile?.id && ((Number(live.bytesIn || 0) > 0) || (Number(live.bytesOut || 0) > 0))) {
      const syncResult = usageSvc.syncUsageTotalsSemiLive(
        profile.id,
        Number(live.bytesIn || 0) || 0,
        Number(live.bytesOut || 0) || 0,
        new Date(),
        {
          sessionId: live.sessionId || '',
          uptime: live.uptime || '',
          source: live.source || 'portal-pppoe-traffic'
        }
      );
      usageMeta = syncResult?.usageMeta || usageSvc.getUsageSnapshotMeta(profile.id, new Date());
    }
    setPortalPppoeSnapshotCache(req, {
      username,
      interface: live.iface || null,
      uptime: live.uptime || null,
      online: true,
      statusText: 'Online',
      bytesIn: Number(live.bytesIn || 0) || 0,
      bytesOut: Number(live.bytesOut || 0) || 0
    });

    return res.json(buildSafePayload({
      username,
      live: {
        online: true,
        interface: live.iface || null,
        source: live.source || 'ppp-active',
        uptime: live.uptime || null,
        bytesIn: Number(live.bytesIn || 0) || 0,
        bytesOut: Number(live.bytesOut || 0) || 0,
        rxMbps: Number(live.rxMbps || 0) || 0,
        txMbps: Number(live.txMbps || 0) || 0,
        uploadMbps: Number(live.rxMbps || 0) || 0,
        downloadMbps: Number(live.txMbps || 0) || 0
      }
    }, usageMeta));
  } catch (e) {
    const cachedSnapshot = getPortalPppoeSnapshotCache(req);
    const usageMeta = profile?.id ? usageSvc.getUsageSnapshotMeta(profile.id, new Date()) : null;
    return res.json(buildSafePayload({
      username,
      live: {
        online: Boolean(cachedSnapshot?.online),
        interface: cachedSnapshot?.interface || null,
        source: cachedSnapshot ? 'snapshot-cache' : 'fallback-error',
        uptime: cachedSnapshot?.uptime || null
      }
    }, usageMeta));
  }
});

router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const profile = getSessionCustomer(req);
  if (isPortalServiceActionRestricted(profile)) {
    return blockInactiveServiceAction(req, res, 'Ubah nama WiFi');
  }
  const ssid = String(req.body.ssid || '').trim();
  const ok = await updateSSID(phone, ssid);
  if (ok && ssid) {
    patchPortalDeviceCache(req, { ssid });
  }
  req.session._msg = ok 
    ? { type: 'success', text: 'Nama WiFi (SSID) berhasil diubah.', target: 'ssid' }
    : { type: 'danger', text: 'Gagal mengubah SSID.', target: 'ssid' };

  res.redirect('/customer/dashboard#settings');
});

router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const profile = getSessionCustomer(req);
  if (isPortalServiceActionRestricted(profile)) {
    return blockInactiveServiceAction(req, res, 'Ubah password WiFi');
  }
  const ok = await updatePassword(phone, password);

  if (ok && profile?.id) {
    customerSvc.addPortalNotification(profile.id, {
      kind: 'password',
      tab: 'settings',
      title: 'Password WiFi berhasil diubah',
      body: `Password WiFi baru Anda: ${password}. Jika password belum berubah di perangkat, coba restart modem / router Anda.`
    }, { dedupeWindowMs: 60 * 1000 });
  }

  req.session._msg = ok
    ? { type: 'success', text: 'Password WiFi berhasil diubah. Jika perangkat belum ikut berubah, coba restart modem / router Anda.', target: 'password' }
    : { type: 'danger', text: 'Gagal mengubah password. Pastikan minimal 8 karakter.', target: 'password' };

  res.redirect('/customer/dashboard#settings');
});

router.post('/reboot', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const profile = getSessionCustomer(req);
  if (isPortalServiceActionRestricted(profile)) {
    return blockInactiveServiceAction(req, res, 'Reboot perangkat');
  }
  const r = await requestReboot(phone);
  
  req.session._msg = r.ok
    ? { type: 'success', text: 'Perangkat berhasil direboot. Silakan tunggu beberapa menit.' }
    : { type: 'danger', text: r.message || 'Gagal reboot.' };

  res.redirect('/customer/dashboard');
});

router.post('/change-tag', async (req, res) => {
  const oldTag = req.session && req.session.phone;
  const newTag = (req.body.newTag || '').trim();
  if (!oldTag) return res.redirect('/customer/login');
  const settings = getSettingsWithCache();

  if (!newTag || newTag === oldTag) {
    const data = await getCustomerDeviceData(oldTag);
    const profile = findCustomerProfileByLoginId(oldTag);
    const invoices = billingSvc.getInvoicesByAny(resolveCustomerSessionLoginId(profile) || oldTag);
    const dashboardCustomer = buildPortalCustomerViewModel(
      profile || fallbackCustomer(oldTag),
      data || null,
      getPortalPppoeSnapshotCache(req)
    );
    syncPortalSessionProfile(req, profile, dashboardCustomer);
    return res.render('dashboard', {
      customer: dashboardCustomer,
      profile: profile || null,
      invoices: invoices || [],
      tickets: profile ? ticketSvc.getTicketsByCustomerId(profile.id) : [],
      settings,
      paymentChannels: [],
      connectedUsers: Array.isArray(dashboardCustomer?.connectedUsers) ? dashboardCustomer.connectedUsers : [],
      notif: dashboardNotif('ID/Tag baru tidak boleh kosong atau sama dengan yang lama.', 'warning'),
      portalPackages: profile ? customerSvc.getPortalPackages(profile.package_id).filter((pkg) => Number(pkg.id || 0) !== Number(profile.package_id || 0)) : [],
      packageChangeState: profile ? buildPortalPackageChangeViewState(profile) : buildPortalPackageChangeViewState(null),
      profileChangeState: profile ? getCustomerProfileChangeState(profile.id) : getCustomerProfileChangeState(null)
    });
  }
  const tagResult = await updateCustomerTag(oldTag, newTag);
  let notif = null;
  let resolvedPhone = oldTag;
  
  if (tagResult.ok) {
    req.session.phone = newTag;
    resolvedPhone = newTag;
    notif = dashboardNotif('ID/Tag berhasil diubah.', 'success');
    
    // UPDATE DATABASE SQLITE IF MATCHING PROFILE FOUND
    const profileToUpdate = customerSvc.getAllCustomers().find(c => {
      const cleanLogin = oldTag.replace(/\D/g, '');
      const cleanDb = (c.phone || '').replace(/\D/g, '');
      return cleanDb === cleanLogin || c.phone === oldTag || c.genieacs_tag === oldTag;
    });
    
    if (profileToUpdate) {
      try {
        customerSvc.updateCustomer(profileToUpdate.id, { 
          ...profileToUpdate, 
          genieacs_tag: newTag 
        });
        logger.info(`[Portal] Database updated for tag change: ${oldTag} -> ${newTag}`);
      } catch (dbErr) {
        logger.error(`[Portal] Failed to update DB tag: ${dbErr.message}`);
      }
    }
  } else {
    notif = dashboardNotif(tagResult.message || 'Gagal mengubah ID/Tag pelanggan.', 'danger');
  }
  const deviceData = await getCustomerDeviceData(resolvedPhone);
  let searchToken = resolvedPhone;
  if (deviceData && deviceData.pppoeUsername) {
    searchToken = deviceData.pppoeUsername;
  }
  const invoices = billingSvc.getInvoicesByAny(searchToken);
  const profile = customerSvc.getAllCustomers().find(c => {
    const cleanLogin = resolvedPhone.replace(/\D/g, '');
    const cleanDb = (c.phone || '').replace(/\D/g, '');
    return cleanDb === cleanLogin || c.phone === resolvedPhone || c.pppoe_username === (deviceData ? deviceData.pppoeUsername : null);
  });
  const tickets = profile ? ticketSvc.getTicketsByCustomerId(profile.id) : [];
  const dashboardCustomer = buildPortalCustomerViewModel(
    profile || fallbackCustomer(resolvedPhone),
    deviceData || null,
    getPortalPppoeSnapshotCache(req)
  );
  syncPortalSessionProfile(req, profile, dashboardCustomer);

  res.render('dashboard', {
    customer: dashboardCustomer,
    profile: profile || null,
    invoices: invoices || [],
    tickets,
    settings,
    paymentChannels: [],
    connectedUsers: Array.isArray(dashboardCustomer?.connectedUsers) ? dashboardCustomer.connectedUsers : [],
    notif,
    portalPackages: profile ? customerSvc.getPortalPackages(profile.package_id).filter((pkg) => Number(pkg.id || 0) !== Number(profile.package_id || 0)) : [],
    packageChangeState: profile ? buildPortalPackageChangeViewState(profile) : buildPortalPackageChangeViewState(null),
    profileChangeState: profile ? getCustomerProfileChangeState(profile.id) : getCustomerProfileChangeState(null)
  });
});

router.post('/profile/change', async (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) throw new Error('Sesi pelanggan tidak ditemukan');

    const requested = normalizeCustomerProfileChangeInput(req.body || {});
    if (!requested.name) throw new Error('Nama tidak boleh kosong');
    if (!requested.phone) throw new Error('Nomor HP tidak valid');
    if (!requested.address) throw new Error('Alamat tidak boleh kosong');

    const current = {
      name: String(profile.name || '').trim(),
      phone: normalizePhoneDigits(profile.phone || ''),
      nik: String(profile.nik || '').trim(),
      address: String(profile.address || '').trim()
    };
    const changed = current.name !== requested.name
      || current.phone !== requested.phone
      || current.nik !== requested.nik
      || current.address !== requested.address;
    if (!changed) throw new Error('Tidak ada data yang berubah');

    const pending = db.prepare(`
      SELECT id
      FROM customer_profile_change_requests
      WHERE customer_id = ? AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `).get(profile.id);
    if (pending) throw new Error('Masih ada pengajuan profil yang menunggu approval admin');

    const result = db.prepare(`
      INSERT INTO customer_profile_change_requests (
        customer_id, current_name, current_phone, current_address, current_nik,
        requested_name, requested_phone, requested_address, requested_nik,
        status, request_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      profile.id,
      current.name,
      current.phone,
      current.address,
      current.nik,
      requested.name,
      requested.phone,
      requested.address,
      requested.nik,
      String(req.body.note || '').trim().slice(0, 240)
    );

    customerSvc.addPortalNotification(profile.id, {
      kind: 'profile',
      tab: 'profile',
      title: 'Perubahan profil diajukan',
      body: 'Data profil baru sudah dikirim dan menunggu approval admin.'
    }, { dedupeWindowMs: 60 * 1000 });

    const requestId = Number(result.lastInsertRowid || 0) || '-';
    setImmediate(() => {
      notifyApprovalRequired({
        type: 'profile_change_request',
        title: 'Approval Perubahan Profil',
        requester: profile.name || profile.phone || `Pelanggan #${profile.id}`,
        subject: `Perubahan profil ${profile.name || profile.phone || profile.id}`,
        detail: `Request #${requestId} - nama/no HP/NIK/alamat`,
        targetUrl: '/admin/customer-requests?status=pending'
      }).catch((error) => logger.warn(`[ProfileApproval] Gagal kirim notif admin: ${error.message || String(error)}`));
    });

    req.session._msg = { type: 'success', text: 'Pengajuan perubahan profil dikirim.', target: 'profile' };
  } catch (error) {
    req.session._msg = { type: 'danger', text: error.message || 'Gagal mengajukan perubahan profil.', target: 'profile' };
  }
  return res.redirect('/customer/dashboard#profile');
});

router.post('/packages/change', async (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) throw new Error('Sesi pelanggan tidak ditemukan');
    if (isPortalServiceActionRestricted(profile)) {
      return blockInactiveServiceAction(req, res, 'Perubahan paket', 'packages');
    }
    const rateLimit = checkPackageChangeRateLimit(req, profile.id);
    if (!rateLimit.allowed) {
      throw new Error(`Terlalu sering mencoba mengajukan perubahan paket. Silakan coba lagi setelah ${rateLimit.retryAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}.`);
    }

    const targetPackageId = Number(req.body.package_id || 0);
    const createdRequest = packageChangeSvc.createRequest(profile.id, targetPackageId, {
      requestSource: 'portal',
      requestNote: ''
    });
    const isDowngrade = String(createdRequest.change_kind || '') === 'downgrade';
    const targetName = createdRequest.target_package_name || 'paket baru';
    const nextStep = isDowngrade
      ? `Jika disetujui, paket baru akan mulai berlaku pada siklus tagihan berikutnya (${createdRequest.effective_at ? new Date(createdRequest.effective_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : 'jadwal berikutnya'}).`
      : 'Jika disetujui admin, paket baru bisa langsung diproses dan profil internet Anda ikut menyesuaikan.';

    req.session._msg = {
      type: 'success',
      text: `Pengajuan perubahan paket ke ${targetName} sudah dikirim. ${nextStep}`
    };

    setImmediate(() => {
      notifyApprovalRequired({
        type: 'package_change_request',
        title: 'Approval Pindah Paket',
        requester: profile.name || profile.phone || `Pelanggan #${profile.id}`,
        subject: `${profile.name || 'Pelanggan'} ke ${targetName}`,
        detail: `Request #${Number(createdRequest.id || 0) || '-'}${createdRequest.current_package_name ? ` dari ${createdRequest.current_package_name}` : ''}`,
        targetUrl: '/admin/customer-requests?status=pending'
      }).catch((error) => logger.warn(`[PackageApproval] Gagal kirim notif admin: ${error.message || String(error)}`));
    });
  } catch (error) {
    req.session._msg = { type: 'danger', text: 'Gagal mengubah paket: ' + (error.message || 'Terjadi kesalahan') };
  }
  return res.redirect('/customer/dashboard#packages');
});

router.post('/notifications/read', (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) return res.status(401).json({ ok: false, error: 'unauthorized' });
    customerSvc.markPortalNotificationsSeen(profile.id);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'failed' });
  }
});

router.post('/notifications/:id/delete', (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const notificationId = Number(req.params.id || 0);
    customerSvc.deletePortalNotification(profile.id, notificationId);
    const wantsJson = String(req.headers['x-requested-with'] || '').toLowerCase() === 'fetch'
      || String(req.headers.accept || '').includes('application/json');
    if (wantsJson) return res.json({ ok: true });
    return res.redirect('/customer/dashboard#notifications');
  } catch (error) {
    const wantsJson = String(req.headers['x-requested-with'] || '').toLowerCase() === 'fetch'
      || String(req.headers.accept || '').includes('application/json');
    if (wantsJson) return res.status(500).json({ ok: false, error: error.message || 'failed' });
    req.session._msg = { type: 'danger', text: error.message || 'Gagal menghapus pesan.', target: 'profile' };
    return res.redirect('/customer/dashboard#profile');
  }
});

router.get('/api/notifications', (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const refreshedProfile = customerSvc.getCustomerById(profile.id) || profile;
    const summary = getCustomerNotificationPayload(refreshedProfile || null, { appNotif: null });
    return res.json({
      ok: true,
      items: summary.items,
      unreadCount: summary.unreadCount
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/customer/login');
  });
});

router.post('/public/payment/create/:invoiceId', async (req, res) => {
  const settings = getSettingsWithCache();
  const secret = settings.session_secret || '';
  const currentToken = String(req.body.token || '').trim();
  const payload = verifyPublicToken(currentToken, secret);

  const redirectBack = (lookup, err, info, token = currentToken) => {
    const t = token ? `t=${encodeURIComponent(String(token))}` : '';
    const q = lookup ? `q=${encodeURIComponent(String(lookup))}` : '';
    const e = err ? `err=${encodeURIComponent(String(err))}` : '';
    const i = info ? `info=${encodeURIComponent(String(info))}` : '';
    const qs = [t, q, e, i].filter(Boolean).join('&');
    return res.redirect(`/customer/check-billing${qs ? `?${qs}` : ''}`);
  };

  if (!payload) {
    return redirectBack('', 'Link pembayaran tidak valid atau sudah kadaluarsa.', '', '');
  }

  const requestedPaymentId = String(req.params.invoiceId || '').trim().toLowerCase();
  const isBulkPayment = requestedPaymentId === 'bulk' || requestedPaymentId === 'all' || requestedPaymentId === 'semua';
  if (!isBulkPayment && String(req.params.invoiceId) !== String(payload.invoiceId)) {
    return redirectBack(payload.lookup, 'Link pembayaran tidak valid.');
  }
  if (isBulkPayment && !normalizeInvoiceIdList(payload.invoiceIds).length) {
    return redirectBack(payload.lookup, 'Link pembayaran gabungan tidak valid.');
  }

  const tosChecked = req.body.tos === 'on' || req.body.tos === '1' || req.body.tos === true || req.body.tos === 'true';
  if (!tosChecked) {
    return redirectBack(payload.lookup, 'Harap centang persetujuan Syarat & Ketentuan (TOS) untuk melanjutkan.');
  }

  try {
    const payloadCustomerId = Number(payload.customerId || 0);
    const payloadInvoiceIds = normalizeInvoiceIdList(payload.invoiceIds);
    let invoicesToPay = [];
    if (isBulkPayment) {
      invoicesToPay = sortInvoicesForBulkPayment(payloadInvoiceIds
        .map((id) => billingSvc.getInvoiceById(id))
        .filter(Boolean)
        .filter((invoice) => Number(invoice.customer_id || 0) === payloadCustomerId)
        .filter((invoice) => String(invoice.status || '').toLowerCase() === 'unpaid'));
      if (!invoicesToPay.length) return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
      if (invoicesToPay.length !== payloadInvoiceIds.length) {
        return redirectBack(payload.lookup, 'Sebagian tagihan sudah berubah. Silakan cek ulang tagihan.');
      }
    } else {
      const inv = billingSvc.getInvoiceById(req.params.invoiceId);
      if (!inv) throw new Error('Tagihan tidak ditemukan');
      if (Number(inv.customer_id) !== payloadCustomerId) throw new Error('Tagihan tidak valid');
      if (inv.status === 'paid') {
        return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
      }
      invoicesToPay = [inv];
    }
    const inv = invoicesToPay[0];
    const paymentTotalAmount = invoicesToPay.reduce((sum, invoice) => sum + (Number(invoice.amount || 0) || 0), 0);

    const paymentChannels = await getCustomerPaymentChannels(settings);
    const rawMethod = String(req.body.method || choosePreferredCustomerPaymentMethod(paymentChannels, settings)).trim().toUpperCase().slice(0, 40);
    let method = rawMethod || choosePreferredCustomerPaymentMethod(paymentChannels, settings);
    let gateway = await resolveCustomerPaymentGateway(settings, method);
    if (isBulkPayment && method === 'STATICQRIS') {
      return redirectBack(payload.lookup, 'Bayar semua hanya mendukung payment gateway otomatis. Pilih e-wallet atau virtual account.');
    }
    if (method === 'STATICQRIS' && hasStaticQrisEnabled(settings)) {
      return res.redirect(`/customer/public/payment/static/${encodeURIComponent(String(inv.id))}?t=${encodeURIComponent(String(req.body.token || ''))}`);
    }
    if (gateway === 'tripay') {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).filter((c) => c && c.active).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) method = 'QRIS';
      } catch {
        method = 'QRIS';
      }
    }

    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    if (!isBulkPayment && !force && canReuseInvoicePaymentLink(inv, gateway, method)) {
      let expiresAtMs = inv.payment_expires_at ? new Date(inv.payment_expires_at).getTime() : 0;
      let payloadExpiresAt = null;
      if (inv.payment_payload) {
        try {
          const parsedPayload = typeof inv.payment_payload === 'string' ? JSON.parse(inv.payment_payload) : inv.payment_payload;
          payloadExpiresAt = resolvePaymentExpiresAt(inv.payment_gateway, { payload: parsedPayload });
          const ms = payloadExpiresAt ? new Date(payloadExpiresAt).getTime() : 0;
          if (Number.isFinite(ms) && ms > 0) expiresAtMs = ms;
        } catch {}
      }

      if (payloadExpiresAt && payloadExpiresAt !== inv.payment_expires_at) {
        try {
          billingSvc.updatePaymentInfo(inv.id, {
            gateway: inv.payment_gateway,
            method: inv.payment_method || method,
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id} via ${gateway}/${method} (public)`);
        return res.redirect(inv.payment_link);
      }
    }

    const cust = customerSvc.getCustomerById(inv.customer_id);

    const appUrl = resolveRequestBaseUrl(req);
    const bulkMetadata = isBulkPayment ? buildBulkPaymentMetadata(cust, invoicesToPay, paymentTotalAmount) : null;
    const returnLookup = resolveCustomerLookup(cust || {});
    const paymentReturnPayload = isBulkPayment
      ? {
          customerId: Number(cust?.id || inv.customer_id || 0),
          invoiceIds: invoicesToPay.map((invoice) => Number(invoice.id)).filter(Boolean),
          lookup: returnLookup,
          exp: Date.now() + 24 * 60 * 60 * 1000
        }
      : {
          invoiceId: Number(inv.id),
          customerId: Number(cust?.id || inv.customer_id || 0),
          lookup: returnLookup,
          exp: Date.now() + 24 * 60 * 60 * 1000
        };
    const paymentReturnToken = signPublicToken(paymentReturnPayload, secret);
    const paymentReturnPath = `/customer/check-billing?t=${encodeURIComponent(paymentReturnToken)}`;
    const gatewayReturnOptions = isBulkPayment ? {
      orderPrefix: 'BULK',
      itemName: null,
      description: null,
      sku: null,
      returnPath: paymentReturnPath
    } : {
      returnPath: paymentReturnPath
    };
    const invoiceForGateway = isBulkPayment
      ? {
          ...inv,
          amount: paymentTotalAmount,
          item_name: `Tagihan Internet ${invoicesToPay.length} bulan (${bulkMetadata.periods})`,
          description: `Pembayaran gabungan tagihan ${bulkMetadata.periods}`,
          sku: `BULK-${Number(cust?.id || inv.customer_id || 0)}-${invoicesToPay.map((invoice) => invoice.id).join('_')}`
        }
      : inv;
    if (isBulkPayment) {
      gatewayReturnOptions.itemName = invoiceForGateway.item_name;
      gatewayReturnOptions.description = invoiceForGateway.description;
      gatewayReturnOptions.sku = invoiceForGateway.sku;
    }

    if (gateway === 'tripay' && settings.tripay_enabled) {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) method = 'QRIS';
      } catch {
        method = 'QRIS';
      }
    }

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(invoiceForGateway, cust, method, appUrl, gatewayReturnOptions);
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(invoiceForGateway, cust, method, appUrl, gatewayReturnOptions);
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(invoiceForGateway, cust, method, appUrl, gatewayReturnOptions);
    } else {
      try {
        result = await paymentSvc.createTripayTransaction(invoiceForGateway, cust, method, appUrl, gatewayReturnOptions);
      } catch (error) {
        if (canFallbackToStaticQris(gateway, method, settings)) {
          if (isBulkPayment) {
            logger.warn(`[Payment] Tripay bulk gagal untuk ${invoicesToPay.map((invoice) => `INV-${invoice.id}`).join(', ')}: ${error.message}`);
            return redirectBack(payload.lookup, 'Payment gateway sedang gangguan. Untuk sementara bayar 1 tagihan atau coba lagi beberapa saat.');
          }
          logger.warn(`[Payment] Tripay scan online gagal untuk INV-${inv.id} (public), fallback ke pembayaran cadangan: ${error.message}`);
          return res.redirect(`/customer/public/payment/static/${encodeURIComponent(String(inv.id))}?t=${encodeURIComponent(String(req.body.token || ''))}`);
        }
        throw error;
      }
    }

    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      const storedPayload = isBulkPayment
        ? {
            gateway_payload: result.payload || null,
            billing_meta: bulkMetadata
          }
        : result.payload;
      const paidInvoiceIds = isBulkPayment ? invoicesToPay.map((invoice) => Number(invoice.id)).filter(Boolean) : [Number(inv.id)];
      paidInvoiceIds.forEach((invoiceId) => {
        billingSvc.updatePaymentInfo(invoiceId, {
          gateway: gateway,
          method,
          order_id: result.order_id,
          link: result.link,
          reference: result.reference,
          payload: storedPayload,
          expires_at: resolvedExpiresAt
        });
      });

      logger.info(`[Payment] New link created for ${isBulkPayment ? `BULK ${paidInvoiceIds.join(',')}` : `INV-${inv.id}`} via ${gateway}/${method} (public)`);
      return res.redirect(result.link);
    }

    throw new Error(result.message || 'Gagal membuat transaksi');
  } catch (error) {
    logger.error(`[Payment] Create Error (public): ${error.message}`);
    return redirectBack(payload.lookup, 'Terjadi kesalahan saat membuat transaksi pembayaran. Silakan coba lagi.');
  }
});

router.get('/public/payment/static/:invoiceId', async (req, res) => {
  const settings = getSettingsWithCache();
  const secret = settings.session_secret || '';
  const currentToken = String(req.query.t || '').trim();
  const payload = verifyPublicToken(currentToken, secret);
  const redirectBack = (lookup, err, info, token = currentToken) => {
    const t = token ? `t=${encodeURIComponent(String(token))}` : '';
    const q = lookup ? `q=${encodeURIComponent(String(lookup))}` : '';
    const e = err ? `err=${encodeURIComponent(String(err))}` : '';
    const i = info ? `info=${encodeURIComponent(String(info))}` : '';
    const qs = [t, q, e, i].filter(Boolean).join('&');
    return res.redirect(`/customer/check-billing${qs ? `?${qs}` : ''}`);
  };

  if (!payload) return redirectBack('', 'Link pembayaran cadangan tidak valid atau sudah kadaluarsa.', '', '');
  if (String(req.params.invoiceId) !== String(payload.invoiceId)) return redirectBack(payload.lookup, 'Tagihan pembayaran cadangan tidak valid.');
  if (!hasStaticQrisEnabled(settings)) return redirectBack(payload.lookup, 'Pembayaran online cadangan belum dikonfigurasi admin.');

  try {
    let invoice = ensureStaticQrisInvoice(req.params.invoiceId);
    if (!invoice) throw new Error('Tagihan tidak ditemukan');
    if (Number(invoice.customer_id) !== Number(payload.customerId)) throw new Error('Tagihan tidak valid');
    if (String(invoice.status || '').toLowerCase() === 'paid') {
      return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
    }
    const customer = customerSvc.getCustomerById(invoice.customer_id);
    const exactAmount = Number(invoice.qris_amount_unique || invoice.amount || 0) || 0;
    const qrisPayload = buildDynamicQrisPayload(String(settings.qris_static_payload || '').trim(), exactAmount);
    const qrisDataUrl = await buildDynamicQrisDataUrl(qrisPayload);
    res.render('static_qris_payment', {
      settings,
      invoice,
      customer,
      qrisUrl: String(settings.qris_static_qr_url || '').trim(),
      qrisPayload,
      qrisDataUrl,
      exactAmount,
      qrisCode: Number(invoice.qris_unique_code || 0) || 0,
      statusUrl: `/customer/public/payment/static/${encodeURIComponent(String(invoice.id))}/status?t=${encodeURIComponent(String(req.query.t || ''))}`,
      isLoggedIn: false,
      backUrl: `/customer/check-billing?t=${encodeURIComponent(String(req.query.t || ''))}`,
      pageTitle: 'Bayar Online Cadangan'
    });
  } catch (error) {
    logger.error(`[QRIS Static][Public] ${error.message}`);
    return redirectBack(payload.lookup, error.message || 'Gagal membuka pembayaran online cadangan.');
  }
});

router.get('/public/payment/static/:invoiceId/status', async (req, res) => {
  const settings = getSettingsWithCache();
  const secret = settings.session_secret || '';
  const payload = verifyPublicToken(req.query.t, secret);
  if (!payload) return res.status(403).json({ ok: false, message: 'Token tidak valid.' });
  if (String(req.params.invoiceId) !== String(payload.invoiceId)) return res.status(403).json({ ok: false, message: 'Tagihan tidak valid.' });

  try {
    const invoice = billingSvc.getInvoiceById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ ok: false, message: 'Tagihan tidak ditemukan.' });
    if (Number(invoice.customer_id) !== Number(payload.customerId)) return res.status(403).json({ ok: false, message: 'Tagihan tidak valid.' });
    return res.json({
      ok: true,
      invoiceId: Number(invoice.id || 0) || 0,
      status: String(invoice.status || '').toLowerCase(),
      paid: String(invoice.status || '').toLowerCase() === 'paid',
      paidAt: invoice.paid_at || null,
      amount: Number(invoice.amount || 0) || 0
    });
  } catch (error) {
    logger.error(`[QRIS Static][Public Status] ${error.message}`);
    return res.status(500).json({ ok: false, message: 'Gagal cek status pembayaran.' });
  }
});

// â”€â”€â”€ TICKETS / KELUHAN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/tickets/create', async (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.redirect('/customer/login');
  
  const { subject, message, customerId } = req.body;
  if (!subject || !message || !customerId) {
    req.session._msg = { type: 'danger', text: 'Semua field harus diisi.' };
    return res.redirect('/customer/dashboard');
  }

  if (Number(customerId) !== Number(profile.id)) {
    req.session._msg = { type: 'danger', text: 'Data pelanggan tidak valid.' };
    return res.redirect('/customer/dashboard');
  }

  try {
    const result = ticketSvc.createTicket(customerId, subject, message);
    const ticketId = result.lastInsertRowid;
    customerSvc.addPortalNotification(profile.id, {
      kind: 'ticket',
      tab: 'ticketing',
      title: `Tiket #${ticketId} berhasil dikirim`,
      body: 'Keluhan Anda sudah kami terima. Tim kami akan segera menindaklanjutinya.'
    }, { dedupeWindowMs: 60 * 1000 });

    notifyTicketCreated({
      ticketId,
      baseUrl: resolveRequestBaseUrl(req)
    }).catch((notifyErr) => {
      logger.warn(`[Ticket] Notifikasi tiket gagal: ${notifyErr.message || notifyErr}`);
    });
    
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dikirim. Tim teknisi akan segera mengeceknya.' };

    /*
    // Legacy ticket notification is handled by notifyTicketCreated().
    // --- WHATSAPP NOTIFICATION FOR NEW TICKET ---
    try {
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const customer = customerSvc.getCustomerById(customerId);
        
        const waMsg = `ðŸŽ« *TIKET KELUHAN BARU*\n\n` +
                     `ðŸ‘¤ *Pelanggan:* ${customer ? customer.name : 'Unknown'}\n` +
                     `ðŸ“ž *WhatsApp:* ${customer ? customer.phone : '-'}\n` +
                     `ðŸ“ *Alamat:* ${customer ? customer.address : '-'}\n` +
                     `ðŸ“ *Subjek:* ${subject}\n` +
                     `ðŸ’¬ *Pesan:* ${message}\n\n` +
                     `Silakan cek di panel Admin/Teknisi untuk menindaklanjuti.`;

        // Kirim ke Admin
        if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
          const seen = new Set();
          for (const adminPhone of settings.whatsapp_admin_numbers) {
            let digits = String(adminPhone || '').replace(/\D/g, '');
            if (!digits) continue;
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            if (seen.has(digits)) continue;
            seen.add(digits);
            await whatsappGateway.sendText(digits, waMsg);
          }
        }

        // Kirim ke semua Teknisi Aktif
        const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
        const seenTech = new Set();
        for (const tech of technicians) {
          if (tech.phone) {
            let digits = String(tech.phone || '').replace(/\D/g, '');
            if (!digits) continue;
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            if (seenTech.has(digits)) continue;
            seenTech.add(digits);
            await whatsappGateway.sendText(digits, waMsg);
          }
        }
      }
    } catch (waErr) {
      logger.error(`[Ticket] WA Notification Error: ${waErr.message}`);
    }
    // --------------------------------------------
    */

  } catch (error) {
    req.session._msg = { type: 'danger', text: 'Gagal mengirim keluhan: ' + error.message };
  }
  res.redirect('/customer/dashboard');
});

// â”€â”€â”€ PAYMENT ROUTES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/payment/create/:invoiceId', async (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.redirect('/customer/login');
  
  try {
    const settings = getSettingsWithCache();
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);
    
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (inv.status === 'paid') throw new Error('Tagihan ini sudah lunas.');
    if (Number(inv.customer_id) !== Number(profile.id)) throw new Error('Tagihan tidak valid untuk akun ini.');

    const paymentChannels = await getCustomerPaymentChannels(settings);
    const activeChannels = (Array.isArray(paymentChannels) ? paymentChannels : []).filter((channel) => channel && channel.active);
    const defaultMethod = choosePreferredCustomerPaymentMethod(activeChannels, settings);
    let method = String(req.query.method || defaultMethod).trim().toUpperCase();
    let gateway = await resolveCustomerPaymentGateway(settings, method);

    if (method === 'STATICQRIS' && hasStaticQrisEnabled(settings)) {
      return res.redirect(`/customer/payment/static/${encodeURIComponent(String(inv.id))}`);
    }

    if (gateway === 'tripay') {
      try {
        const channels = await paymentSvc.getTripayChannels();
        const allowed = new Set((channels || []).filter((c) => c && c.active).map(c => String(c.code || '').toUpperCase()));
        if (!allowed.has(method)) {
          method = 'QRIS';
          gateway = await resolveCustomerPaymentGateway(settings, method);
        }
      } catch {
        method = 'QRIS';
        gateway = await resolveCustomerPaymentGateway(settings, method);
      }
    }

    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    if (!force && canReuseInvoicePaymentLink(inv, gateway, method)) {
      let expiresAtMs = inv.payment_expires_at ? new Date(inv.payment_expires_at).getTime() : 0;
      let payloadExpiresAt = null;
      if (inv.payment_payload) {
        try {
          const parsedPayload = typeof inv.payment_payload === 'string' ? JSON.parse(inv.payment_payload) : inv.payment_payload;
          payloadExpiresAt = resolvePaymentExpiresAt(inv.payment_gateway, { payload: parsedPayload });
          const ms = payloadExpiresAt ? new Date(payloadExpiresAt).getTime() : 0;
          if (Number.isFinite(ms) && ms > 0) expiresAtMs = ms;
        } catch {}
      }

      if (payloadExpiresAt && payloadExpiresAt !== inv.payment_expires_at) {
        try {
          billingSvc.updatePaymentInfo(inv.id, {
            gateway: inv.payment_gateway,
            method: inv.payment_method || method,
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id} via ${gateway}/${method}`);
        return res.redirect(inv.payment_link);
      }
    }

    const cust = customerSvc.getCustomerById(inv.customer_id);
    
    // Tentukan base URL aplikasi untuk callback
    const appUrl = resolveRequestBaseUrl(req);

    let result;
    if (gateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, cust, method, appUrl);
    } else {
      // Default ke Tripay
      try {
        result = await paymentSvc.createTripayTransaction(inv, cust, method, appUrl);
      } catch (error) {
        if (canFallbackToStaticQris(gateway, method, settings)) {
          logger.warn(`[Payment] Tripay scan online gagal untuk INV-${inv.id}, fallback ke pembayaran cadangan: ${error.message}`);
          req.session._msg = { type: 'warning', text: 'Tripay sedang gangguan. Sistem mengalihkan ke pembayaran online cadangan agar pembayaran tetap bisa dilakukan.' };
          return res.redirect(`/customer/payment/static/${encodeURIComponent(String(inv.id))}`);
        }
        throw error;
      }
    }
    
    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      // Simpan info pembayaran ke database
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        method,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: resolvedExpiresAt
      });

      logger.info(`[Payment] New link created for INV-${inv.id} via ${gateway}/${method}`);
      res.redirect(result.link);
    } else {
      throw new Error(result.message || 'Gagal membuat transaksi');
    }
  } catch (error) {
    logger.error(`[Payment] Create Error: ${error.message}`);
    res.status(500).send(`Terjadi kesalahan: ${error.message}`);
  }
});

router.get('/payment/select/:invoiceId', async (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.redirect('/customer/login');

  try {
    const settings = getSettingsWithCache();
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);

    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status || '').toLowerCase() === 'paid') throw new Error('Tagihan ini sudah lunas.');
    if (Number(inv.customer_id) !== Number(profile.id)) throw new Error('Tagihan tidak valid untuk akun ini.');

    const customer = customerSvc.getCustomerById(inv.customer_id);
    const paymentChannels = await getCustomerPaymentChannels(settings);
    const activeChannels = (Array.isArray(paymentChannels) ? paymentChannels : []).filter((channel) => channel && channel.active);

    if (activeChannels.length === 0) {
      return res.redirect(`/customer/payment/create/${encodeURIComponent(String(inv.id))}`);
    }

    res.render('customer_payment_methods', {
      settings,
      invoice: inv,
      customer: customer || profile,
      paymentChannels: activeChannels
    });
  } catch (error) {
    logger.error(`[Payment] Select method error: ${error.message}`);
    if (req.session) req.session._msg = { type: 'danger', text: error.message };
    res.redirect('/customer/dashboard#billing');
  }
});

router.get('/payment/static/:invoiceId', async (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.redirect('/customer/login');

  const settings = getSettingsWithCache();
  if (!hasStaticQrisEnabled(settings)) {
    req.session._msg = { type: 'warning', text: 'Pembayaran online cadangan belum dikonfigurasi admin.' };
    return res.redirect('/customer/dashboard');
  }

  try {
    let invoice = ensureStaticQrisInvoice(req.params.invoiceId);
    if (!invoice) throw new Error('Tagihan tidak ditemukan');
    if (String(invoice.status || '').toLowerCase() === 'paid') throw new Error('Tagihan ini sudah lunas.');
    if (Number(invoice.customer_id) !== Number(profile.id)) throw new Error('Tagihan tidak valid untuk akun ini.');

    const customer = customerSvc.getCustomerById(invoice.customer_id);
    const exactAmount = Number(invoice.qris_amount_unique || invoice.amount || 0) || 0;
    const qrisPayload = buildDynamicQrisPayload(String(settings.qris_static_payload || '').trim(), exactAmount);
    const qrisDataUrl = await buildDynamicQrisDataUrl(qrisPayload);
    res.render('static_qris_payment', {
      settings,
      invoice,
      customer,
      qrisUrl: String(settings.qris_static_qr_url || '').trim(),
      qrisPayload,
      qrisDataUrl,
      exactAmount,
      qrisCode: Number(invoice.qris_unique_code || 0) || 0,
      statusUrl: `/customer/payment/static/${encodeURIComponent(String(invoice.id))}/status`,
      isLoggedIn: true,
      backUrl: '/customer/dashboard#billing-section',
      pageTitle: 'Bayar Online Cadangan'
    });
  } catch (error) {
    req.session._msg = { type: 'danger', text: error.message || 'Gagal membuka pembayaran online cadangan.' };
    return res.redirect('/customer/dashboard#billing-section');
  }
});

router.get('/payment/static/:invoiceId/status', async (req, res) => {
  const profile = getSessionCustomer(req);
  if (!profile) return res.status(401).json({ ok: false, message: 'Sesi pelanggan berakhir.' });

  try {
    const invoice = billingSvc.getInvoiceById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ ok: false, message: 'Tagihan tidak ditemukan.' });
    if (Number(invoice.customer_id) !== Number(profile.id)) return res.status(403).json({ ok: false, message: 'Tagihan tidak valid untuk akun ini.' });
    return res.json({
      ok: true,
      invoiceId: Number(invoice.id || 0) || 0,
      status: String(invoice.status || '').toLowerCase(),
      paid: String(invoice.status || '').toLowerCase() === 'paid',
      paidAt: invoice.paid_at || null,
      amount: Number(invoice.amount || 0) || 0
    });
  } catch (error) {
    logger.error(`[QRIS Static][Status] ${error.message}`);
    return res.status(500).json({ ok: false, message: 'Gagal cek status pembayaran.' });
  }
});

/**
 * Webhook Callback (Multi-Gateway)
 */
router.get('/payment/callback', (req, res) => {
  res.json({ success: true, message: 'OK. Use POST for gateway notifications.' });
});
router.head('/payment/callback', (req, res) => res.status(200).end());
router.post('/payment/callback', express.json(), async (req, res) => {
  const settings = getSettingsWithCache();
  const tripaySignature = req.headers['x-callback-signature'];
  const midtransSignature = req.headers['x-callback-token']; // Midtrans usually uses Basic Auth or IP whitelist, but let's check payload
  
  const jsonBody = JSON.stringify(req.body);
  let gatewayOrderId = null;
  let invoiceIdCandidate = null;
  let status = null;
  let gateway = null;

  // --- DETEKSI TRIPAY ---
  if (tripaySignature) {
    if (paymentSvc.verifyTripayWebhook(jsonBody, tripaySignature, settings.tripay_private_key)) {
      const { merchant_ref, status: tpStatus } = req.body;
      const parts = String(merchant_ref || '').split('-');
      gatewayOrderId = String(merchant_ref || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = tpStatus === 'PAID' ? 'paid' : tpStatus;
      gateway = 'Tripay';
    } else {
      logger.error('[Webhook] Signature Tripay tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  } 
  // --- DETEKSI MIDTRANS ---
  else if (req.body.transaction_status && req.body.order_id) {
    const serverKey = settings.midtrans_server_key;
    if (paymentSvc.verifyMidtransWebhook(req.body, serverKey)) {
      const { order_id, transaction_status } = req.body;
      const parts = String(order_id || '').split('-');
      gatewayOrderId = String(order_id || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = (transaction_status === 'settlement' || transaction_status === 'capture') ? 'paid' : transaction_status;
      gateway = 'Midtrans';
    } else {
      logger.error('[Webhook] Signature Midtrans tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  }
  // --- DETEKSI XENDIT ---
  else if (req.body.external_id && req.body.status && !tripaySignature) {
    // Xendit callback usually includes x-callback-token in headers
    if (!isStrongXenditCallbackToken(settings.xendit_callback_token)) {
      logger.error('[Webhook] Xendit callback token belum dikonfigurasi dengan aman');
      return res.status(503).json({ success: false, message: 'Xendit callback token not configured' });
    }
    const xenditToken = req.headers['x-callback-token'];
    if (xenditToken === settings.xendit_callback_token) {
      const { external_id, status: xStatus } = req.body;
      const parts = String(external_id || '').split('-');
      gatewayOrderId = String(external_id || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = xStatus === 'PAID' ? 'paid' : xStatus;
      gateway = 'Xendit';
    } else {
      logger.error('[Webhook] Callback Token Xendit tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
  }
  // --- DETEKSI DUITKU ---
  else if (req.body.merchantCode && req.body.merchantOrderId && req.body.resultCode) {
    if (paymentSvc.verifyDuitkuWebhook(req.body, settings.duitku_api_key)) {
      const { merchantOrderId, resultCode } = req.body;
      const parts = String(merchantOrderId || '').split('-');
      gatewayOrderId = String(merchantOrderId || '') || null;
      invoiceIdCandidate = parts[1] || null;
      status = resultCode === '00' ? 'paid' : resultCode;
      gateway = 'Duitku';
    } else {
      logger.error('[Webhook] Signature Duitku tidak valid');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
  }

  if (gatewayOrderId && status === 'paid') {
    const order = db.prepare('SELECT * FROM public_voucher_orders WHERE payment_order_id = ?').get(gatewayOrderId);
    if (order) {
      const orderId = Number(order.id || 0);
      if (!Number.isFinite(orderId) || orderId <= 0) return res.json({ success: true });

      logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Voucher Order ID: ${orderId}`);

      if (String(order.status) !== 'paid' && String(order.status) !== 'fulfilled') {
        db.prepare(`
          UPDATE public_voucher_orders
          SET status='paid', paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(orderId);
      }

      const fresh = db.prepare('SELECT * FROM public_voucher_orders WHERE id = ?').get(orderId);
      if (!fresh) return res.json({ success: true });
      if (String(fresh.status) === 'fulfilled' && fresh.voucher_code) return res.json({ success: true });

      try {
        let created = null;
        let attempt = 0;
        while (attempt < 10) {
          attempt++;
          const code = genRandomCode(6);
          const pass = code;
          const comment = `pub-${orderId}-${code}-${fresh.profile_name}`;
          const userData = {
            server: 'all',
            name: code,
            password: pass,
            profile: fresh.profile_name,
            comment
          };
          if (fresh.validity) userData['limit-uptime'] = fresh.validity;

          try {
            await mikrotikService.addHotspotUser(userData, fresh.router_id ?? null);
            created = { code, pass, comment };
            break;
          } catch (e) {
            const msg = String(e?.message || e || '').toLowerCase();
            const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
            if (isDup) continue;
            throw e;
          }
        }
        if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');

        db.prepare(`
          UPDATE public_voucher_orders
          SET status='fulfilled',
              fulfilled_at=CURRENT_TIMESTAMP,
              voucher_code=?,
              voucher_password=?,
              voucher_comment=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(created.code, created.pass, created.comment, orderId);

        if (settings.whatsapp_enabled) {
          try {
            const ready = await whatsappGateway.ensureReady(15000);
            if (!ready) throw new Error('WhatsApp belum terhubung');
            if (!fresh.buyer_phone) throw new Error('Nomor WhatsApp pembeli kosong');
            const msg =
              `ðŸŽ« *VOUCHER HOTSPOT*\n\n` +
              `âœ… Pembayaran diterima via *${gateway}*\n` +
              `ðŸ“¦ Paket: *${fresh.profile_name}* (${fresh.validity || '-'})\n` +
              `ðŸ’° Harga: Rp ${Number(fresh.price || 0).toLocaleString('id-ID')}\n\n` +
              `ðŸ‘¤ User: *${created.code}*\n` +
              `ðŸ”‘ Pass: *${created.pass}*\n\n` +
              `Terima kasih.`;
            await whatsappGateway.sendText(fresh.buyer_phone, msg);
            db.prepare(`
              UPDATE public_voucher_orders
              SET wa_sent=1, wa_sent_at=CURRENT_TIMESTAMP, wa_error='', updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).run(orderId);
          } catch (waErr) {
            db.prepare(`
              UPDATE public_voucher_orders
              SET wa_sent=0, wa_error=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).run(String(waErr?.message || waErr || ''), orderId);
          }
        }
      } catch (e) {
        logger.error(`[Webhook] Voucher fulfill gagal (order=${orderId}): ${e.message}`);
      }

      return res.json({ success: true });
    }

    const paymentInfoInvoice = db.prepare(`
      SELECT *
      FROM invoices
      WHERE payment_order_id = ? OR payment_reference = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(gatewayOrderId, gatewayOrderId);
    const bulkMeta = extractBulkPaymentMetadata(paymentInfoInvoice?.payment_payload);
    if (bulkMeta && bulkMeta.invoiceIds.length > 1) {
      const bulkInvoices = sortInvoicesForBulkPayment(bulkMeta.invoiceIds
        .map((invoiceId) => billingSvc.getInvoiceById(invoiceId))
        .filter(Boolean)
        .filter((invoice) => Number(invoice.customer_id || 0) === Number(bulkMeta.customerId || invoice.customer_id || 0)));
      if (!bulkInvoices.length) return res.json({ success: true });

      logger.info(`[Webhook] Pembayaran gabungan diterima via ${gateway}: ${bulkInvoices.map((invoice) => `INV-${invoice.id}`).join(', ')}`);
      const paidNow = [];
      for (const invoice of bulkInvoices) {
        if (String(invoice.status || '').toLowerCase() === 'paid') continue;
        billingSvc.markAsPaid(invoice.id, gateway, `Otomatis via Webhook ${gateway} - bayar gabungan ${bulkInvoices.length} tagihan`, {
          type: 'system',
          id: null,
          name: `Webhook ${gateway}`,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || ''
        });
        paidNow.push(invoice);
      }

      const firstInvoice = bulkInvoices[0];
      const customer = customerSvc.getCustomerById(firstInvoice.customer_id);
      if (customer && ['suspended', 'inactive'].includes(String(customer.status || '').toLowerCase())) {
        const unpaidCount = billingSvc.getUnpaidInvoicesByCustomerId(customer.id).length;
        if (unpaidCount === 0) {
          logger.info(`[Webhook] Mengaktifkan kembali pelanggan ${customer.name} secara otomatis setelah bayar gabungan.`);
          await customerSvc.activateCustomer(customer.id);
        }
      }

      try {
        if (customer && paidNow.length > 0) {
          const ready = await whatsappGateway.ensureReady(15000);
          if (!ready) throw new Error('WhatsApp belum siap');
          if (!customer.phone) throw new Error('Nomor WhatsApp pelanggan kosong');
          const totalPaid = bulkInvoices.reduce((sum, invoice) => sum + (Number(invoice.amount || 0) || 0), 0);
          const periods = formatBulkInvoicePeriods(bulkInvoices);
          const msg = `âœ… *PEMBAYARAN BERHASIL*\n\nTerima kasih Kak *${customer.name}*,\n\nPembayaran gabungan tagihan internet periode *${periods}* telah kami terima via *${gateway}*.\n\nðŸ’° *Total:* Rp ${totalPaid.toLocaleString('id-ID')}\nðŸ•’ *Waktu:* ${new Date().toLocaleString('id-ID')}\n\nStatus tagihan yang dibayar sudah lunas.`;
          await whatsappGateway.sendText(customer.phone, msg);
        }
      } catch (waErr) {
        logger.error(`[Webhook] Gagal kirim notif WA gabungan: ${waErr.message}`);
      }

      return res.json({ success: true });
    }

    const idNum = Number(invoiceIdCandidate || 0);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.json({ success: true });
    }

    logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Invoice ID: ${idNum}`);

    const checkInv = billingSvc.getInvoiceById(idNum);
    if (checkInv && checkInv.status !== 'paid') {
      billingSvc.markAsPaid(idNum, gateway, `Otomatis via Webhook ${gateway}`, {
        type: 'system',
        id: null,
        name: `Webhook ${gateway}`,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || ''
      });

      const customer = customerSvc.getCustomerById(checkInv.customer_id);
      
      try {
        const ready = await whatsappGateway.ensureReady(15000);
        if (!ready) {
          throw new Error('WhatsApp belum siap');
        }
        if (!customer.phone) {
          throw new Error('Nomor WhatsApp pelanggan kosong');
        }
        const msg = `âœ… *PEMBAYARAN BERHASIL*\n\nTerima kasih Kak *${customer.name}*,\n\nPembayaran tagihan internet periode *${checkInv.period_month}/${checkInv.period_year}* telah kami terima via *${gateway}*.\n\nðŸ’° *Total:* Rp ${checkInv.amount.toLocaleString('id-ID')}\nðŸ“… *Waktu:* ${new Date().toLocaleString('id-ID')}\n\nStatus layanan Anda kini telah aktif. Selamat berinternet kembali! ðŸš€`;
        const sent = await whatsappTemplateMedia.sendTemplateMessage(
          customer.phone,
          buildPaidWhatsappMessage(customer, checkInv, gateway, settings, resolveRequestBaseUrl(req)),
          'paid',
          { baseUrl: resolveRequestBaseUrl(req) }
        );
        if (!sent) {
          throw new Error('sendWA mengembalikan gagal');
        }
      } catch (waErr) {
        logger.error(`[Webhook] Gagal kirim notif WA: ${waErr.message}`);
      }

      if (customer && ['suspended', 'inactive'].includes(String(customer.status || '').toLowerCase())) {
        const unpaidCount = billingSvc.getUnpaidInvoicesByCustomerId(customer.id).length;
        if (unpaidCount === 0) {
          logger.info(`[Webhook] Mengaktifkan kembali pelanggan ${customer.name} secara otomatis.`);
          await customerSvc.activateCustomer(customer.id);
        }
      }
    }
  }

  res.json({ success: true });
});

module.exports = router;
