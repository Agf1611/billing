const express = require('express');
const router = express.Router();
const customerDevice = require('../services/customerDeviceService');
const { getSettingsWithCache } = require('../config/settingsManager');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const customerSvc = require('../services/customerService');
const mikrotikService = require('../services/mikrotikService');
const { logger } = require('../config/logger');
const ticketSvc = require('../services/ticketService');
const usageSvc = require('../services/usageService');
const crypto = require('crypto');
const db = require('../config/database');
const { isStrongXenditCallbackToken } = require('../config/security');
const { normalizePhoneDigits } = require('../services/phoneService');
const {
  resolveCustomerLookup,
  parsePublicInvoiceCode,
  resolveRequestBaseUrl,
  buildCustomerCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate
} = require('../services/publicLinkService');
const { buildDynamicQrisPayload } = require('../services/qrisService');
const { registerPublicPortalRoutes } = require('./customer/registerPublicPortalRoutes');
const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const LOGIN_GENIE_PREFETCH_MAX_WAIT_MS = 3500;
const LOGIN_GENIE_PREFETCH_INTERVAL_MS = 1200;
const LOGIN_GENIE_PREFETCH_REQUEST_TIMEOUT_MS = 2200;
const INITIAL_GENIE_SYNC_MAX_WAIT_MS = 10000;
const INITIAL_GENIE_SYNC_INTERVAL_MS = 2500;
const INITIAL_GENIE_SYNC_REQUEST_TIMEOUT_MS = 5000;
const DASHBOARD_GENIE_FOLLOWUP_MAX_WAIT_MS = 3000;
const DASHBOARD_GENIE_FOLLOWUP_INTERVAL_MS = 1200;
const DASHBOARD_GENIE_FOLLOWUP_REQUEST_TIMEOUT_MS = 3000;
const DASHBOARD_PPPOE_SNAPSHOT_TIMEOUT_MS = 6000;

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

/** Rute portal yang boleh diakses saat status suspended (bayar publik, logout, dll.) */
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
  const invoiceLink = buildPublicInvoicePrintLink(invoice, customer, 48 * 60 * 60 * 1000, { baseUrl });
  const receiptLink = buildPublicInvoiceReceiptLink(invoice, customer, 48 * 60 * 60 * 1000, { baseUrl });
  return fillWhatsappTemplate(template, {
    nama: customer?.name || 'Pelanggan',
    paket: String(customer?.package_name || invoice?.package_name || '-').trim() || '-',
    tagihan: Number(invoice?.amount || 0).toLocaleString('id-ID'),
    rincian: `${invoice?.period_month || '-'}/${invoice?.period_year || '-'}`,
    link: buildCustomerCheckBillingLink(customer, { baseUrl }),
    portal_link: buildCustomerPortalLoginLink({ baseUrl }),
    invoice_link: invoiceLink || buildCustomerCheckBillingLink(customer, { baseUrl }),
    receipt_link: receiptLink || invoiceLink || buildCustomerCheckBillingLink(customer, { baseUrl }),
    invoice_no: invoice?.id ? `INV-${invoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: String(settings?.whatsapp_group_invite_link || '').trim(),
    group_line: String(settings?.whatsapp_group_invite_link || '').trim() ? `Grup pelanggan: ${String(settings.whatsapp_group_invite_link).trim()}` : '',
    company: settings?.company_header || 'ISP',
    paid_by: String(gateway || '-').trim() || '-',
    paid_at: new Date().toLocaleString('id-ID')
  });
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

function hasStaticQrisEnabled(settings) {
  return Boolean(
    String(settings?.qris_static_qr_url || '').trim() ||
    String(settings?.qris_static_payload || '').trim()
  );
}

function normalizePaymentMethodLabel(channel = {}) {
  const code = String(channel.code || '').toUpperCase();
  const rawName = String(channel.name || '').trim();
  const map = {
    STATICQRIS: 'QRIS Instan',
    QRIS: 'QRIS Gateway',
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

async function getCustomerPaymentChannels(settings = {}) {
  const channels = [];
  if (hasStaticQrisEnabled(settings)) {
    channels.push({
      code: 'STATICQRIS',
      name: 'QRIS Instan',
      group: 'QRIS',
      active: true,
      source: 'internal',
      note: 'Scan langsung dengan nominal otomatis'
    });
  }

  if (settings.tripay_enabled) {
    try {
      const tripayChannels = await paymentSvc.getTripayChannels();
      (Array.isArray(tripayChannels) ? tripayChannels : [])
        .filter((channel) => channel && channel.active)
        .forEach((channel) => {
          channels.push({
            ...channel,
            name: normalizePaymentMethodLabel(channel),
            source: 'tripay'
          });
        });
    } catch {
      // ignore, fallback ke channel internal/manual
    }
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

  return channels
    .filter((channel) => {
      const key = String(channel.code || '').toUpperCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const codeA = String(a.code || '').toUpperCase();
      const codeB = String(b.code || '').toUpperCase();
      const groupOrder = { QRIS: 1, 'E-Wallet': 2, 'Virtual Account': 3, 'Convenience Store': 4 };
      const ga = groupOrder[String(a.group || '')] || 99;
      const gb = groupOrder[String(b.group || '')] || 99;
      if (ga !== gb) return ga - gb;
      const pa = priority[codeA] || 99;
      const pb = priority[codeB] || 99;
      if (pa !== pb) return pa - pb;
      return normalizePaymentMethodLabel(a).localeCompare(normalizePaymentMethodLabel(b), 'id');
    });
}

async function resolveCustomerPaymentGateway(settings, method) {
  const chosen = String(method || '').trim().toUpperCase();
  if (chosen === 'STATICQRIS') return 'static';
  if (settings.tripay_enabled) {
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
  const invId = Number(invoiceId || 0);
  if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

  const current = db.prepare(`
    SELECT id, customer_id, status, amount, qris_unique_code, qris_amount_unique, qris_assigned_at
    FROM invoices
    WHERE id = ?
  `).get(invId);
  if (!current) throw new Error('Tagihan tidak ditemukan');
  if (String(current.status || '').toLowerCase() !== 'unpaid') throw new Error('Hanya tagihan belum bayar yang bisa dibuat QRIS statik.');

  if (Number(current.qris_amount_unique || 0) > 0 && Number(current.qris_unique_code || 0) > 0) {
    return billingSvc.getInvoiceById(invId);
  }

  const baseAmount = Number(current.amount || 0);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

  const exists = db.prepare('SELECT id FROM invoices WHERE status = ? AND qris_amount_unique = ? AND id != ? LIMIT 1');
  const update = db.prepare(`
    UPDATE invoices
    SET qris_unique_code = ?, qris_amount_unique = ?, qris_assigned_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let chosenCode = 0;
  let chosenAmount = 0;

  for (let i = 0; i < 50; i++) {
    const code = 1 + Math.floor(Math.random() * 999);
    const amount = baseAmount + code;
    if (!exists.get('unpaid', amount, invId)) {
      chosenCode = code;
      chosenAmount = amount;
      break;
    }
  }

  if (!chosenAmount) {
    for (let code = 1; code <= 999; code++) {
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }
  }

  if (!chosenAmount) throw new Error('Gagal membuat nominal unik QRIS untuk tagihan ini.');
  update.run(chosenCode, chosenAmount, invId);
  return billingSvc.getInvoiceById(invId);
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

function buildCustomerNotifications({ invoices = [], tickets = [], appNotif = null, seenAt = null, profile = null } = {}) {
  const notifications = [];
  const seenMs = seenAt ? new Date(seenAt).getTime() : 0;

  (Array.isArray(invoices) ? invoices : [])
    .filter((inv) => String(inv.status || '').toLowerCase() !== 'paid')
    .forEach((inv) => {
      const dueDate = new Date(Number(inv.period_year), Number(inv.period_month) - 1, 1).getTime() || Date.now();
      notifications.push({
        kind: 'invoice',
        unread: true,
        tab: 'billing',
        title: `Tagihan INV-${inv.id} belum dibayar`,
        body: `Periode ${inv.period_month}/${inv.period_year} • Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}`,
        time: dueDate
      });
    });

  (Array.isArray(tickets) ? tickets : []).forEach((ticket) => {
    const createdMs = ticket.created_at ? new Date(ticket.created_at).getTime() : 0;
    const updatedMs = ticket.updated_at ? new Date(ticket.updated_at).getTime() : createdMs;
    const hasUpdate = updatedMs > createdMs || String(ticket.status || '').toLowerCase() !== 'open';
    if (!hasUpdate) return;
    notifications.push({
      kind: 'ticket',
      unread: updatedMs > seenMs,
      tab: 'ticketing',
      title: `Update tiket #${ticket.id}`,
      body: `${ticket.subject || 'Keluhan pelanggan'} • Status ${String(ticket.status || 'open').toUpperCase()}`,
      time: updatedMs || createdMs || Date.now()
    });
  });

  if (appNotif && appNotif.text) {
    notifications.push({
      kind: 'system',
      unread: false,
      tab: 'home',
      title: 'Info sistem',
      body: appNotif.text,
      time: Date.now() - 1
    });
  }

  if (profile && String(profile.status || '').toLowerCase() === 'suspended') {
    notifications.push({
      kind: 'suspension',
      unread: true,
      tab: 'billing',
      title: 'Layanan dinonaktifkan sementara',
      body: 'Masih ada tagihan yang belum lunas. Silakan cek tagihan atau hubungi admin.',
      time: Date.now()
    });
  }

  notifications.sort((a, b) => Number(b.time || 0) - Number(a.time || 0));

  return {
    items: notifications,
    unreadCount: notifications.filter((item) => item.unread).length
  };
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

function getPortalDeviceCache(req) {
  const cached = req?.session?.portalDeviceCache;
  return cached && typeof cached === 'object' ? cached : null;
}

function setPortalDeviceCache(req, deviceData) {
  if (!req?.session) return;
  req.session.portalDeviceCache = deviceData && typeof deviceData === 'object' ? deviceData : null;
  req.session.portalDeviceCachedAt = Date.now();
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
  signPublicToken
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

    let method = String(req.body.method || 'STATICQRIS').trim().toUpperCase();
    if (!method) method = 'STATICQRIS';
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
      result = await paymentSvc.createTripayTransaction(invoiceLike, buyer, method, appUrl, { returnPath, itemName: invoiceLike.item_name, sku: invoiceLike.sku });
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

// ─── REGISTRATION / PENDAFTARAN ─────────────────────────────────────────────
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
      const { sendWA } = await import('../services/whatsappBot.mjs');
      const selectedPkg = packages.find(p => p.id.toString() === package_id.toString());
      const pkgName = selectedPkg ? selectedPkg.name : 'Tidak diketahui';
      
      const adminMsg = `🔔 *PENDAFTARAN BARU*\n\nAda calon pelanggan baru yang mendaftar via web:\n\n👤 *Nama:* ${name}\n📞 *WA:* ${phone}\n📍 *Alamat:* ${address}\n📦 *Paket:* ${pkgName}\n\nSilakan cek di panel Admin untuk menindaklanjuti.`;
      const latStr = String(lat || '').trim();
      const lngStr = String(lng || '').trim();
      const mapLine = (latStr && lngStr) ? `\n🗺️ *Lokasi:* https://maps.google.com/?q=${encodeURIComponent(latStr)},${encodeURIComponent(lngStr)}` : '';
      const finalAdminMsg = adminMsg + mapLine;
      
      const seen = new Set();
      for (const adminPhone of settings.whatsapp_admin_numbers) {
        let digits = String(adminPhone || '').replace(/\D/g, '');
        if (!digits) continue;
        if (digits.startsWith('0')) digits = '62' + digits.slice(1);
        if (seen.has(digits)) continue;
        seen.add(digits);
        try { await sendWA(digits, finalAdminMsg); } catch(e) { /* ignore */ }
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
  const rememberMe = req.body.remember_me === 'on' || req.body.remember_me === '1' || req.body.remember_me === true || req.body.remember_me === 'true';

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
    req.session.rememberMe = rememberMe;
    req.session.genieSyncPending = true;
    req.session.genieSyncStartedAt = Date.now();
    req.session.cookie.maxAge = rememberMe ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
    await primePortalDeviceCache(req, loginTag);
    logger.info(`[Login] Login biasa berhasil untuk customerId=${matchedCustomer.id || '-'}.`);
    return req.session.save(() => {
      if (matchedCustomer.status === 'suspended') {
        return res.redirect('/isolated');
      }
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
    rememberMe,
    otp: loginOtp,
    expiry: loginExpiry
  };

  logger.info(`[Login] OTP dibuat untuk customerId=${matchedCustomer.id || '-'}.`);

  try {
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');

    if (whatsappStatus.connection !== 'open') {
      throw new Error('Sistem WhatsApp sedang tidak aktif. Silakan hubungi Admin.');
    }

    const msg = `ðŸ›¡ï¸ *KODE VERIFIKASI (OTP)*\n\nKode Anda adalah: *${loginOtp}*\n\nJangan berikan kode ini kepada siapapun. Kode berlaku selama 5 menit.`;
    const sent = await sendWA(deliveryPhone, msg);

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
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        
        if (whatsappStatus.connection !== 'open') {
          throw new Error('Sistem WhatsApp sedang tidak aktif. Silakan hubungi Admin.');
        }

        const msg = `🛡️ *KODE VERIFIKASI (OTP)*\n\nKode Anda adalah: *${otp}*\n\nJangan berikan kode ini kepada siapapun. Kode berlaku selama 5 menit.`;
        const sent = await sendWA(phone, msg);
        
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
  if (customer && customer.status === 'suspended') {
    return res.redirect('/isolated');
  }
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
    req.session.rememberMe = Boolean(pending.rememberMe);
    req.session.genieSyncPending = true;
    req.session.genieSyncStartedAt = Date.now();
    req.session.cookie.maxAge = pending.rememberMe ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
    await primePortalDeviceCache(req, pending.effectiveTag);
    delete req.session.pending_login;
    return req.session.save(() => {
      if (customer.status === 'suspended') {
        return res.redirect('/isolated');
      }
      return res.redirect('/customer/dashboard');
    });
  } else {
    return res.render('login_otp', { error: 'Kode OTP salah. Silakan coba lagi.', settings, phone: pending.phone });
  }
});

// Pelanggan terisolir: paksa halaman /isolated, kecuali cek tagihan / bayar / logout
router.use((req, res, next) => {
  if (isSuspendedPortalExemptPath(req.path)) return next();
  const profile = getSessionCustomer(req);
  if (!profile) return next();
  if (profile && profile.status === 'suspended') {
    return res.redirect('/isolated');
  }
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
    company: settings.company_header || 'Billing ISP',
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
  if (String(payload.lookup || '').trim() !== resolveCustomerLookup(customer)) {
    return res.status(403).send('Data invoice tidak cocok');
  }

  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
  return res.render('admin/print_invoice', {
    invoice,
    customer,
    company: settings.company_header || 'Billing ISP',
    settings,
    printStyle,
    viewerRole: 'public',
    printBasePath: req.path
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
    company: settings.company_header || 'Billing ISP',
    settings,
    printStyle,
    viewerRole: 'public',
    printBasePath: req.path
  });
});

router.get('/dashboard', async (req, res) => {
  const profile = getSessionCustomer(req);
  const loginId = (req.session && req.session.phone) || resolveCustomerSessionLoginId(profile);
  if (!loginId || !profile) return res.redirect('/customer/login');
  
  // Flash message
  let msgNotif = null;
  if (req.session._msg) {
    msgNotif = dashboardNotif(req.session._msg.text, req.session._msg.type);
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
  const pppoeLookup = String(
    profile?.pppoe_username ||
    deviceData?.pppoeUsername ||
    (/[a-zA-Z]/.test(String(loginId || '')) ? loginId : '')
  ).trim();
  const pppoeSnapshot = (routerId && pppoeLookup)
    ? await guardExternalCall(
        () => mikrotikService.getPppoeCustomerSnapshot(pppoeLookup, routerId),
        DASHBOARD_PPPOE_SNAPSHOT_TIMEOUT_MS,
        `snapshot PPPoE ${pppoeLookup}`,
        null
      )
    : null;
  if (profile?.id && pppoeSnapshot && (pppoeSnapshot.bytesIn > 0 || pppoeSnapshot.bytesOut > 0)) {
    usageSvc.syncUsageTotals(profile.id, pppoeSnapshot.bytesIn, pppoeSnapshot.bytesOut);
  }
  const refreshedProfile = profile?.id ? (customerSvc.getCustomerById(profile.id) || profile) : profile;
  const dashboardCustomer = mergeCustomerDashboardData(deviceData || fallbackCustomer(loginId), pppoeSnapshot);
  
  // Data dari Billing DB (Coba cari pakai loginId atau pppoeUsername)
  let searchToken = resolveCustomerSessionLoginId(refreshedProfile) || loginId;
  if (dashboardCustomer && dashboardCustomer.pppoeUsername && hasUsableValue(dashboardCustomer.pppoeUsername)) {
    searchToken = dashboardCustomer.pppoeUsername;
  }
  
  const invoices = billingSvc.getInvoicesByAny(searchToken);
  
  // Ambil tiket keluhan pelanggan
  let tickets = [];
  if (refreshedProfile) {
    tickets = ticketSvc.getTicketsByCustomerId(refreshedProfile.id);
  }

  if (routerId) {
    req.session.router_id = routerId;
  }
  const pppoeFromProfile = profile && String(profile.pppoe_username || '').trim();
  const pppoeFromDevice = dashboardCustomer && String(dashboardCustomer.pppoeUsername || '').trim();
  if (pppoeFromProfile) req.session.pppoe_username = pppoeFromProfile;
  else if (pppoeFromDevice) req.session.pppoe_username = pppoeFromDevice;

  const settings = getSettingsWithCache();
  let paymentChannels = await getCustomerPaymentChannels(settings);

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
  const notificationSummary = buildCustomerNotifications({
    invoices: invoices || [],
    tickets: tickets || [],
    appNotif: baseNotif,
    seenAt: refreshedProfile?.portal_notifications_seen_at || null,
    profile: refreshedProfile || null
  });
  const portalPackages = refreshedProfile
    ? customerSvc.getPortalPackages(refreshedProfile.package_id).filter((pkg) => Number(pkg.id || 0) !== Number(refreshedProfile.package_id || 0))
    : [];

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
    notifications: notificationSummary.items,
    notificationUnreadCount: notificationSummary.unreadCount,
    portalPackages
  });
});

router.get('/api/pppoe-traffic', async (req, res) => {
  const loginId = req.session && req.session.phone;
  if (!loginId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  let routerId = req.session && req.session.router_id ? Number(req.session.router_id) : null;
  let username = String((req.session && req.session.pppoe_username) || '').trim();
  const profile = getSessionCustomer(req);
  const getUsagePayload = () => {
    const refreshed = profile?.id ? (customerSvc.getCustomerById(profile.id) || profile) : profile;
    return {
      usageBytesIn: Number(refreshed?.bytes_in || 0) || 0,
      usageBytesOut: Number(refreshed?.bytes_out || 0) || 0,
      usageDownloadBytes: Number(refreshed?.bytes_in || 0) || 0,
      usageUploadBytes: Number(refreshed?.bytes_out || 0) || 0
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

  if (!username) return res.json({ ok: true, available: false, online: false, ...getUsagePayload() });

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    let sessions = await mikrotikService.getPppoeActive(routerId).catch(() => []);
    sessions = (Array.isArray(sessions) ? sessions : []).filter((row) => String(row?.name || '').trim() === username);
    if (!sessions.length) {
      sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    }
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, online: false, username, rxMbps: 0, txMbps: 0, ...getUsagePayload() });
    }

    const s = sessions[0];
    let iface = strField(s, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(s, ['.id', 'id', 'sessionId', 'session-id']) || `${username}`;
    const bytesIn = numField(s, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(s, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(s, ['uptime']) || null;

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', username).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find(r => String(r.user || r['user'] || '').trim() === username);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;

    const key = `${routerId || 'default'}:${username}`;
    const prev = pppoeTrafficSamples.get(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';

    if (iface) {
      const ifMenu = conn.client.menu('/interface');
      if (ifMenu) {
        try {
          const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
          const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
          const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second', 'rx-bits-per-second']);
          const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second', 'tx-bits-per-second']);
          if (rxBps || txBps) {
            const routerRxMbps = (Number(rxBps) || 0) / 1e6;
            const routerTxMbps = (Number(txBps) || 0) / 1e6;
            return res.json({
              ok: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              rxMbps: routerRxMbps,
              txMbps: routerTxMbps,
              uploadMbps: routerTxMbps,
              downloadMbps: routerRxMbps,
              ...getUsagePayload()
            });
          }
        } catch {}
      }
    }

    if (iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    pppoeTrafficSamples.set(key, { t: now, sessionId, rxBytes, txBytes, source });

    if (profile?.id && (rxBytes > 0 || txBytes > 0)) {
      usageSvc.syncUsageTotals(profile.id, rxBytes, txBytes);
    }

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0,
        ...getUsagePayload()
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0,
        ...getUsagePayload()
      });
    }

    const rxMbps = (dIn * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dOut * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      bytesIn,
      bytesOut,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0,
      uploadMbps: Number.isFinite(txMbps) ? txMbps : 0,
      downloadMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      ...getUsagePayload()
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/change-ssid', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const ssid = String(req.body.ssid || '').trim();
  const ok = await updateSSID(phone, ssid);
  if (ok && ssid) {
    patchPortalDeviceCache(req, { ssid });
  }
  req.session._msg = ok 
    ? { type: 'success', text: 'Nama WiFi (SSID) berhasil diubah.' }
    : { type: 'danger', text: 'Gagal mengubah SSID.' };

  res.redirect('/customer/dashboard#settings');
});

router.post('/change-password', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
  const { password } = req.body;
  const ok = await updatePassword(phone, password);
  
  req.session._msg = ok
    ? { type: 'success', text: 'Password WiFi berhasil diubah.' }
    : { type: 'danger', text: 'Gagal mengubah password. Pastikan minimal 8 karakter.' };

  res.redirect('/customer/dashboard#settings');
});

router.post('/reboot', async (req, res) => {
  const phone = req.session && req.session.phone;
  if (!phone) return res.redirect('/customer/login');
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
    const invoices = billingSvc.getInvoicesByAny(oldTag);
    return res.render('dashboard', {
      customer: data || fallbackCustomer(oldTag),
      profile: null,
      invoices: invoices || [],
      tickets: [],
      settings,
      paymentChannels: [],
      connectedUsers: data ? data.connectedUsers : [],
      notif: dashboardNotif('ID/Tag baru tidak boleh kosong atau sama dengan yang lama.', 'warning'),
      portalPackages: []
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

  res.render('dashboard', {
    customer: deviceData || fallbackCustomer(resolvedPhone),
    profile: profile || null,
    invoices: invoices || [],
    tickets,
    settings,
    paymentChannels: [],
    connectedUsers: deviceData ? deviceData.connectedUsers : [],
    notif,
    portalPackages: profile ? customerSvc.getPortalPackages(profile.package_id).filter((pkg) => Number(pkg.id || 0) !== Number(profile.package_id || 0)) : []
  });
});

router.post('/packages/change', async (req, res) => {
  try {
    const profile = getSessionCustomer(req);
    if (!profile || !profile.id) throw new Error('Sesi pelanggan tidak ditemukan');
    const targetPackageId = Number(req.body.package_id || 0);
    const result = customerSvc.applyPortalPackageChange(profile.id, targetPackageId);
    const targetName = result?.targetPackage?.name || 'paket baru';
    const previousName = result?.currentPackage?.name || 'paket lama';
    try {
      ticketSvc.createTicket(
        profile.id,
        `Upgrade paket ke ${targetName}`,
        `Perubahan paket via portal pelanggan dari ${previousName} ke ${targetName} telah diproses otomatis. Tagihan belum lunas yang terkait ikut diperbarui.`
      );
    } catch {}
    req.session._msg = {
      type: 'success',
      text: `Paket berhasil diubah ke ${targetName}. ${Number(result.updatedInvoiceCount || 0) > 0 ? `Tagihan aktif ikut diperbarui (${result.updatedInvoiceCount} tagihan).` : 'Tagihan berikutnya akan mengikuti paket baru.'}`
    };
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

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/customer/login');
  });
});

router.post('/public/payment/create/:invoiceId', async (req, res) => {
  const settings = getSettingsWithCache();
  const secret = settings.session_secret || '';
  const payload = verifyPublicToken(req.body.token, secret);

  const redirectBack = (lookup, err, info) => {
    const q = lookup ? `q=${encodeURIComponent(String(lookup))}` : '';
    const e = err ? `err=${encodeURIComponent(String(err))}` : '';
    const i = info ? `info=${encodeURIComponent(String(info))}` : '';
    const qs = [q, e, i].filter(Boolean).join('&');
    return res.redirect(`/customer/check-billing${qs ? `?${qs}` : ''}`);
  };

  if (!payload) {
    return redirectBack('', 'Link pembayaran tidak valid atau sudah kadaluarsa.');
  }

  if (String(req.params.invoiceId) !== String(payload.invoiceId)) {
    return redirectBack(payload.lookup, 'Link pembayaran tidak valid.');
  }

  const tosChecked = req.body.tos === 'on' || req.body.tos === '1' || req.body.tos === true || req.body.tos === 'true';
  if (!tosChecked) {
    return redirectBack(payload.lookup, 'Harap centang persetujuan Syarat & Ketentuan (TOS) untuk melanjutkan.');
  }

  try {
    const inv = billingSvc.getInvoiceById(req.params.invoiceId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (Number(inv.customer_id) !== Number(payload.customerId)) throw new Error('Tagihan tidak valid');
    if (inv.status === 'paid') {
      return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
    }

    const rawMethod = String(req.body.method || 'STATICQRIS').trim().toUpperCase().slice(0, 40);
    let method = rawMethod || 'STATICQRIS';
    let gateway = await resolveCustomerPaymentGateway(settings, method);
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
    if (!force && inv.payment_link) {
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
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id} (public)`);
        return res.redirect(inv.payment_link);
      }
    }

    const cust = customerSvc.getCustomerById(inv.customer_id);

    const appUrl = resolveRequestBaseUrl(req);

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
      result = await paymentSvc.createMidtransTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, cust, method, appUrl);
    } else if (gateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, cust, method, appUrl);
    } else {
      result = await paymentSvc.createTripayTransaction(inv, cust, method, appUrl);
    }

    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: resolvedExpiresAt
      });

      logger.info(`[Payment] New link created for INV-${inv.id} via ${gateway} (public)`);
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
  const payload = verifyPublicToken(req.query.t, secret);
  const redirectBack = (lookup, err, info) => {
    const q = lookup ? `q=${encodeURIComponent(String(lookup))}` : '';
    const e = err ? `err=${encodeURIComponent(String(err))}` : '';
    const i = info ? `info=${encodeURIComponent(String(info))}` : '';
    const qs = [q, e, i].filter(Boolean).join('&');
    return res.redirect(`/customer/check-billing${qs ? `?${qs}` : ''}`);
  };

  if (!payload) return redirectBack('', 'Link QRIS statik tidak valid atau sudah kadaluarsa.');
  if (String(req.params.invoiceId) !== String(payload.invoiceId)) return redirectBack(payload.lookup, 'Tagihan QRIS statik tidak valid.');
  if (!hasStaticQrisEnabled(settings)) return redirectBack(payload.lookup, 'QRIS statik belum dikonfigurasi admin.');

  try {
    let invoice = ensureStaticQrisInvoice(req.params.invoiceId);
    if (!invoice) throw new Error('Tagihan tidak ditemukan');
    if (String(invoice.status || '').toLowerCase() === 'paid') {
      return redirectBack(payload.lookup, '', 'Tagihan ini sudah lunas.');
    }
    const customer = customerSvc.getCustomerById(invoice.customer_id);
    const exactAmount = Number(invoice.qris_amount_unique || invoice.amount || 0) || 0;
    const qrisPayload = buildDynamicQrisPayload(String(settings.qris_static_payload || '').trim(), exactAmount);
    res.render('static_qris_payment', {
      settings,
      invoice,
      customer,
      qrisUrl: String(settings.qris_static_qr_url || '').trim(),
      qrisPayload,
      exactAmount,
      qrisCode: Number(invoice.qris_unique_code || 0) || 0,
      isLoggedIn: false,
      backUrl: `/customer/check-billing?q=${encodeURIComponent(String(payload.lookup || customer?.id || ''))}`,
      pageTitle: 'Pembayaran QRIS Statis'
    });
  } catch (error) {
    logger.error(`[QRIS Static][Public] ${error.message}`);
    return redirectBack(payload.lookup, error.message || 'Gagal membuka QRIS statik.');
  }
});

// ─── TICKETS / KELUHAN ─────────────────────────────────────────────────────
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
    
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dikirim. Tim teknisi akan segera mengeceknya.' };

    // --- WHATSAPP NOTIFICATION FOR NEW TICKET ---
    try {
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const customer = customerSvc.getCustomerById(customerId);
        
        const waMsg = `🎫 *TIKET KELUHAN BARU*\n\n` +
                     `👤 *Pelanggan:* ${customer ? customer.name : 'Unknown'}\n` +
                     `📞 *WhatsApp:* ${customer ? customer.phone : '-'}\n` +
                     `📍 *Alamat:* ${customer ? customer.address : '-'}\n` +
                     `📝 *Subjek:* ${subject}\n` +
                     `💬 *Pesan:* ${message}\n\n` +
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
            await sendWA(digits, waMsg);
          }
        }

        // Kirim ke semua Teknisi Aktif
        const techSvc = require('../services/techService');
        const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
        const seenTech = new Set();
        for (const tech of technicians) {
          if (tech.phone) {
            let digits = String(tech.phone || '').replace(/\D/g, '');
            if (!digits) continue;
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            if (seenTech.has(digits)) continue;
            seenTech.add(digits);
            await sendWA(digits, waMsg);
          }
        }
      }
    } catch (waErr) {
      logger.error(`[Ticket] WA Notification Error: ${waErr.message}`);
    }
    // --------------------------------------------

  } catch (error) {
    req.session._msg = { type: 'danger', text: 'Gagal mengirim keluhan: ' + error.message };
  }
  res.redirect('/customer/dashboard');
});

// ─── PAYMENT ROUTES ────────────────────────────────────────────────────────
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
    const defaultMethod = activeChannels[0]?.code || (hasStaticQrisEnabled(settings) ? 'STATICQRIS' : 'QRIS');
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
        method = hasStaticQrisEnabled(settings) ? 'STATICQRIS' : 'QRIS';
        gateway = await resolveCustomerPaymentGateway(settings, method);
        if (method === 'STATICQRIS' && hasStaticQrisEnabled(settings)) {
          return res.redirect(`/customer/payment/static/${encodeURIComponent(String(inv.id))}`);
        }
      }
    }

    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
    if (!force && inv.payment_link) {
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
            order_id: inv.payment_order_id,
            link: inv.payment_link,
            reference: inv.payment_reference,
            payload: inv.payment_payload,
            expires_at: payloadExpiresAt
          });
        } catch {}
      }

      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        logger.info(`[Payment] Reusing existing link for INV-${inv.id}`);
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
      result = await paymentSvc.createTripayTransaction(inv, cust, method, appUrl);
    }
    
    if (result.success) {
      const resolvedExpiresAt =
        resolvePaymentExpiresAt(gateway, result) ||
        gatewayDefaultExpiresAtIso(gateway);
      // Simpan info pembayaran ke database
      billingSvc.updatePaymentInfo(inv.id, {
        gateway: gateway,
        order_id: result.order_id,
        link: result.link,
        reference: result.reference,
        payload: result.payload,
        expires_at: resolvedExpiresAt
      });

      logger.info(`[Payment] New link created for INV-${inv.id} via ${gateway}`);
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
    req.session._msg = { type: 'warning', text: 'QRIS statik belum dikonfigurasi admin.' };
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
    res.render('static_qris_payment', {
      settings,
      invoice,
      customer,
      qrisUrl: String(settings.qris_static_qr_url || '').trim(),
      qrisPayload,
      exactAmount,
      qrisCode: Number(invoice.qris_unique_code || 0) || 0,
      isLoggedIn: true,
      backUrl: '/customer/dashboard#billing-section',
      pageTitle: 'Pembayaran QRIS Statis'
    });
  } catch (error) {
    req.session._msg = { type: 'danger', text: error.message || 'Gagal membuka QRIS statik.' };
    return res.redirect('/customer/dashboard#billing-section');
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
            const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
            if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');
            if (!fresh.buyer_phone) throw new Error('Nomor WhatsApp pembeli kosong');
            const msg =
              `🎫 *VOUCHER HOTSPOT*\n\n` +
              `✅ Pembayaran diterima via *${gateway}*\n` +
              `📦 Paket: *${fresh.profile_name}* (${fresh.validity || '-'})\n` +
              `💰 Harga: Rp ${Number(fresh.price || 0).toLocaleString('id-ID')}\n\n` +
              `👤 User: *${created.code}*\n` +
              `🔑 Pass: *${created.pass}*\n\n` +
              `Terima kasih.`;
            await sendWA(fresh.buyer_phone, msg);
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

    const idNum = Number(invoiceIdCandidate || 0);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.json({ success: true });
    }

    logger.info(`[Webhook] Pembayaran diterima via ${gateway} untuk Invoice ID: ${idNum}`);

    const checkInv = billingSvc.getInvoiceById(idNum);
    if (checkInv && checkInv.status !== 'paid') {
      billingSvc.markAsPaid(idNum, gateway, `Otomatis via Webhook ${gateway}`);

      const customer = customerSvc.getCustomerById(checkInv.customer_id);
      
      try {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        if (false) {
          throw new Error('Bot WhatsApp belum terhubung');
        }
        if (!customer.phone) {
          throw new Error('Nomor WhatsApp pelanggan kosong');
        }
        const msg = `✅ *PEMBAYARAN BERHASIL*\n\nTerima kasih Kak *${customer.name}*,\n\nPembayaran tagihan internet periode *${checkInv.period_month}/${checkInv.period_year}* telah kami terima via *${gateway}*.\n\n💰 *Total:* Rp ${checkInv.amount.toLocaleString('id-ID')}\n📅 *Waktu:* ${new Date().toLocaleString('id-ID')}\n\nStatus layanan Anda kini telah aktif. Selamat berinternet kembali! 🚀`;
        await sendWA(customer.phone, buildPaidWhatsappMessage(customer, checkInv, gateway, settings, resolveRequestBaseUrl(req)));
      } catch (waErr) {
        logger.error(`[Webhook] Gagal kirim notif WA: ${waErr.message}`);
      }

      if (customer && customer.status === 'suspended') {
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
