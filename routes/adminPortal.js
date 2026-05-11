/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const bookkeepingSvc = require('../services/bookkeepingService');
const auditSvc = require('../services/auditTrailService');
const diagnosticsSvc = require('../services/diagnosticsService');
const axios = require('axios');
const crypto = require('crypto');
const { normalizePhoneDigits, formatPhoneDisplay, normalizePhoneList } = require('../services/phoneService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  defaultWelcomeWhatsappTemplate,
  defaultReactivationWhatsappTemplate,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate,
  resolveAppBaseUrl,
  resolveRequestBaseUrl
} = require('../services/publicLinkService');
const {
  isStrongAdminApiKey,
  isStrongAdminPassword,
  isStrongSessionSecret,
  isStrongXenditCallbackToken
} = require('../config/security');
const {
  getRuntimeConfigurationWarnings,
  isSelfUpdateEnabled
} = require('../config/runtimeSafety');
const registerBillingRoutes = require('./admin/registerBillingRoutes');
const registerWhatsappRoutes = require('./admin/registerWhatsappRoutes');

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});
const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const IMAGE_UPLOAD_FIELDS = ['company_logo_file', 'support_isp_logo_file', 'invoice_signature_file', 'invoice_stamp_file', 'qris_static_qr_file'];

function getUploadedSingleFile(req, fieldName) {
  const files = req && req.files;
  if (!files || !fieldName) return null;
  const bucket = files[fieldName];
  if (Array.isArray(bucket) && bucket[0] && bucket[0].buffer && Number(bucket[0].size || 0) > 0) return bucket[0];
  return null;
}

function toUploadImageExt(file) {
  const extFromMime = String(file?.mimetype || '').split('/').pop().toLowerCase();
  const extFromName = path.extname(String(file?.originalname || '')).toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(extFromName)) return extFromName;
  if (['png', 'jpg', 'jpeg', 'webp', 'svg+xml'].includes(extFromMime)) return extFromMime.replace('svg+xml', 'svg');
  return 'png';
}

function safeRemoveUploadAsset(publicUrl, pattern) {
  const current = String(publicUrl || '').trim();
  if (!pattern.test(current)) return;
  const oldPath = path.join(__dirname, '..', 'public', current.replace(/^\//, '').replace(/\//g, path.sep));
  try {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  } catch (_e) {}
}

function persistUploadedImageSetting(file, publicPrefix) {
  if (!file || !file.buffer || Number(file.size || 0) <= 0) return '';
  const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const ext = toUploadImageExt(file);
  const filename = `${publicPrefix}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

function digiflazzCreds() {
  const username = String(getSetting('digiflazz_username', '') || '').trim();
  const apiKey = String(getSetting('digiflazz_api_key', '') || '').trim();
  return { username, apiKey };
}

function digiflazzConfigured() {
  const { username, apiKey } = digiflazzCreds();
  return Boolean(username && apiKey);
}

function digiflazzSign(refId) {
  const { username, apiKey } = digiflazzCreds();
  if (!username || !apiKey) throw new Error('Digiflazz belum dikonfigurasi');
  return crypto.createHash('md5').update(username + apiKey + String(refId || '')).digest('hex');
}

async function digiflazzCekSaldo() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('depo');
  const response = await digiflazzApi.post('/cek-saldo', { cmd: 'deposit', username, sign });
  const data = response?.data?.data;
  if (data?.rc) throw new Error(String(data?.message || 'Gagal cek saldo Digiflazz'));
  return data;
}

async function digiflazzPriceListAll() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('pricelist');
  const response = await digiflazzApi.post('/price-list', { cmd: 'prepaid', username, sign });
  const data = response?.data?.data;
  if (!Array.isArray(data)) {
    const msg = response?.data?.data?.message || response?.data?.message || 'Gagal mengambil price list Digiflazz';
    throw new Error(String(msg));
  }
  return data;
}

const pppoeTrafficSamples = new Map();
function prunePppoeTrafficSamples(now) {
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || (now - v.t) > 15000) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
    if (obj[String(k).toLowerCase()] !== undefined && obj[String(k).toLowerCase()] !== null && obj[String(k).toLowerCase()] !== '') {
      const n = Number(obj[String(k).toLowerCase()]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k] !== undefined ? obj[k] : obj[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = String(req.headers['x-admin-key'] || '').trim();
  if (isStrongAdminApiKey(adminKey) && providedKey && providedKey === adminKey) return next();
  return res.status(401).json({ error: 'Unauthorized - Admin/Staff access required' });
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  return res.redirect('/admin/login');
}

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const { sendWA } = await import('../services/whatsappBot.mjs');
    return Boolean(await sendWA(to, String(message || '').trim()));
  } catch {
    return false;
  }
}

function resolveWhatsappTestRecipient(whatsappStatus = null) {
  const linkedDigits = String(whatsappStatus?.user?.id || '')
    .split(':')[0]
    .replace(/\D/g, '');
  if (linkedDigits && linkedDigits.length >= 9) {
    return linkedDigits.startsWith('0') ? `62${linkedDigits.slice(1)}` : linkedDigits;
  }

  const adminNumbers = getSetting('whatsapp_admin_numbers', []);
  const adminPhone = String(
    (Array.isArray(adminNumbers) && adminNumbers[0]) || getSetting('company_phone', '') || ''
  ).trim();
  if (!adminPhone) return '';
  const normalized = adminPhone.replace(/\D/g, '');
  if (!normalized) return '';
  return normalized.startsWith('0') ? `62${normalized.slice(1)}` : normalized;
}

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat mengakses halaman ini.' };
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }

function buildManualPaymentMessage(settings = getSettings()) {
  const bank = String(settings?.manual_payment_bank || '').trim();
  const accountNumber = String(settings?.manual_payment_account_number || '').trim();
  const accountName = String(settings?.manual_payment_account_name || '').trim();
  const notes = String(settings?.manual_payment_notes || '').trim();

  if (!bank || !accountNumber) return '';

  const lines = [
    '',
    '*Transfer Manual*',
    `Bank: ${bank}`,
    `No. Rek: ${accountNumber}`
  ];

  if (accountName) lines.push(`Atas Nama: ${accountName}`);
  if (notes) lines.push(`Catatan: ${notes}`);

  return lines.join('\n');
}

function formatInvoicePeriods(invoices = []) {
  const periods = (Array.isArray(invoices) ? invoices : [])
    .map((inv) => `${inv.period_month}/${inv.period_year}`)
    .filter(Boolean);
  return periods.length ? periods.join(', ') : '-';
}

function buildWhatsappCustomerPayload(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const invoiceList = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  const primaryInvoice = fallbackInvoice || invoiceList[0] || null;
  const totalTagihan = invoiceList.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const packageLabel = String(
    primaryInvoice?.package_name ||
    customer?.package_name ||
    customer?.packageName ||
    '-'
  ).trim() || '-';
  const checkBillingLink = buildCustomerCheckBillingLink(customer, options);
  const portalLink = buildCustomerPortalLoginLink(options);
  const groupLink = String(getSetting('whatsapp_group_invite_link', '') || '').trim();
  const invoiceLink = primaryInvoice ? buildPublicInvoicePrintLink(primaryInvoice, customer, 48 * 60 * 60 * 1000, options) : '';
  const receiptLink = primaryInvoice ? buildPublicInvoiceReceiptLink(primaryInvoice, customer, 48 * 60 * 60 * 1000, options) : '';
  return {
    nama: customer?.name || 'Pelanggan',
    paket: packageLabel,
    tagihan: Number(totalTagihan || Number(primaryInvoice?.amount || 0) || 0).toLocaleString('id-ID'),
    rincian: formatInvoicePeriods(primaryInvoice ? invoiceList.length ? invoiceList : [primaryInvoice] : invoiceList),
    link: checkBillingLink,
    portal_link: portalLink,
    invoice_link: invoiceLink || checkBillingLink,
    receipt_link: receiptLink || invoiceLink || checkBillingLink,
    invoice_no: primaryInvoice?.id ? `INV-${primaryInvoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: groupLink,
    group_line: groupLink ? `Grup pelanggan: ${groupLink}` : ''
  };
}

function buildBillingWhatsappMessage(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const template = String(
    getSetting('whatsapp_billing_message', defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, fallbackInvoice, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  });
}

function buildIsolationWhatsappMessage(customer, invoices = [], reasonText = '', options = {}) {
  const template = String(
    getSetting('whatsapp_isolation_message', defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, null, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    alasan: reasonText || 'Masih ada tagihan yang belum lunas.',
    company: getSetting('company_header', 'ISP')
  });
}

function buildDueReminderWhatsappMessage(customer, invoices = [], options = {}) {
  const template = String(
    getSetting('whatsapp_due_reminder_message', defaultDueReminderWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultDueReminderWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, null, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  });
}

function buildWelcomeWhatsappMessage(customer, options = {}) {
  const template = String(
    getSetting('whatsapp_welcome_message', defaultWelcomeWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultWelcomeWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, [], null, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  });
}

function buildReactivationWhatsappMessage(customer, options = {}) {
  const template = String(
    getSetting('whatsapp_reactivation_message', '') ||
    ''
  ).trim();
  const fallback = String(defaultReactivationWhatsappTemplate(getSetting('company_header', 'ISP'))).trim();
  const payload = buildWhatsappCustomerPayload(customer, [], null, options);
  return fillWhatsappTemplate(template || fallback, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  });
}

function buildPaidWhatsappMessage(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const template = String(
    getSetting('whatsapp_paid_message', defaultPaidWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultPaidWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, fallbackInvoice, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP'),
    paid_by: String(options.paidBy || '-').trim() || '-',
    paid_at: String(options.paidAt || new Date().toLocaleString('id-ID')).trim()
  });
}

async function sendPaidWhatsappNotification(customer, invoices = [], fallbackInvoice = null, options = {}) {
  if (!customer || !customer.phone) return false;
  const message = buildPaidWhatsappMessage(customer, invoices, fallbackInvoice, options);
  if (!message) return false;
  return trySendWhatsappPayment(customer.phone, message);
}

function buildWhatsappTemplatePreview(templateKey = 'billing', options = {}) {
  const sampleCustomer = {
    id: 9999,
    name: 'Bapak/Ibu Pelanggan',
    phone: '6281234567890',
    pppoe_username: 'pelanggan999',
    package_name: 'Broadband 10 Mbps'
  };
  const sampleInvoices = [
    { id: 123, customer_id: 9999, amount: 150000, period_month: 5, period_year: 2026, package_name: 'Broadband 10 Mbps' }
  ];
  if (templateKey === 'welcome') return buildWelcomeWhatsappMessage(sampleCustomer, options);
  if (templateKey === 'due_reminder') return buildDueReminderWhatsappMessage(sampleCustomer, sampleInvoices, options);
  if (templateKey === 'isolation') return buildIsolationWhatsappMessage(sampleCustomer, sampleInvoices, 'Masih ada tagihan yang belum lunas.', options);
  if (templateKey === 'reactivation') return buildReactivationWhatsappMessage(sampleCustomer, options);
  if (templateKey === 'paid') return buildPaidWhatsappMessage(sampleCustomer, sampleInvoices, sampleInvoices[0], { ...options, paidBy: 'TRIPAY - QRIS', paidAt: '10 Mei 2026 12:00' });
  return buildBillingWhatsappMessage(sampleCustomer, sampleInvoices, sampleInvoices[0], options);
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function redirectBack(res, fallback = '/admin') {
  return res.safeRedirect(null, fallback);
}

function popSettingsFormData(req) {
  const data = req.session._settingsFormData;
  delete req.session._settingsFormData;
  return data || null;
}

function popSettingsActivePane(req) {
  const pane = req.session._settingsActivePane;
  delete req.session._settingsActivePane;
  return pane || '';
}

function popUpdateLog(req) {
  const l = req.session._updateLog;
  delete req.session._updateLog;
  return l || '';
}

const mikrotikMonitoringCache = new Map();

function monitoringCacheKey(kind, routerId) {
  const rid = routerId === null || routerId === undefined || routerId === '' ? 'default' : String(routerId);
  return `${kind}:${rid}`;
}

async function getCachedMonitoringData({ kind, routerId, ttlMs, loader, bypassCache = false }) {
  const key = monitoringCacheKey(kind, routerId);
  const now = Date.now();
  const cached = mikrotikMonitoringCache.get(key);

  if (!bypassCache && cached && (now - cached.at) <= ttlMs) {
    return { data: cached.data, cacheStatus: 'HIT' };
  }

  try {
    const data = await loader();
    mikrotikMonitoringCache.set(key, { data, at: now });
    if (bypassCache) {
      return { data, cacheStatus: cached ? 'FORCE-REFRESH' : 'FORCE-MISS' };
    }
    return { data, cacheStatus: cached ? 'REFRESH' : 'MISS' };
  } catch (error) {
    if (cached && cached.data !== undefined) {
      return { data: cached.data, cacheStatus: 'STALE' };
    }
    throw error;
  }
}

async function withLoaderTimeout(loader, timeoutMs = 8000) {
  let timer = null;
  try {
    return await Promise.race([
      loader(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clearMonitoringCache(routerId = null, kinds = []) {
  const targets = Array.isArray(kinds) && kinds.length ? kinds : [
    'secrets',
    'active-pppoe',
    'profiles',
    'hotspot-users',
    'active-hotspot',
    'hotspot-user-profiles'
  ];
  for (const kind of targets) {
    mikrotikMonitoringCache.delete(monitoringCacheKey(kind, routerId));
  }
}

function shouldForceMonitoringRefresh(req) {
  return String(req.query.force || '').trim() === '1';
}

function getAdminHomeSummary({ billing = null, custStats = null } = {}) {
  const safeCount = (sql) => Number(db.prepare(sql).get()?.c || 0);
  return {
    unpaidInvoices: Number(billing?.unpaidCount || 0),
    pendingAmount: Number(billing?.pendingAmount || 0),
    totalCustomers: Number(custStats?.total || 0),
    activeCustomers: Number(custStats?.active || 0),
    suspendedCustomers: Number(custStats?.suspended || 0),
    openTickets: safeCount("SELECT COUNT(1) AS c FROM tickets WHERE status IN ('open','in_progress')"),
    openOnlyTickets: safeCount("SELECT COUNT(1) AS c FROM tickets WHERE status = 'open'"),
    activeTechnicians: safeCount("SELECT COUNT(1) AS c FROM technicians WHERE is_active = 1"),
    totalRouters: Array.isArray(mikrotikService.getAllRouters()) ? mikrotikService.getAllRouters().length : 0,
    pendingCollectorApprovals: safeCount("SELECT COUNT(1) AS c FROM collector_payment_requests WHERE status = 'pending'"),
    pendingCustomerRequests: safeCount("SELECT COUNT(1) AS c FROM technician_customer_requests WHERE status = 'pending'"),
    totalVoucherBatches: safeCount("SELECT COUNT(1) AS c FROM voucher_batches"),
    whatsappEnabled: Boolean(getSetting('whatsapp_enabled', false))
  };
}

function buildAdminHomeShortcuts(req, summary = {}) {
  const shortcuts = [
    {
      label: 'Tagihan Belum Bayar',
      shortLabel: 'Tagihan',
      desc: 'Invoice yang perlu ditagih hari ini',
      href: '/admin/billing?status=unpaid',
      icon: 'bi-receipt-cutoff',
      tone: 'danger',
      countLabel: summary.unpaidInvoices > 0 ? String(summary.unpaidInvoices) : '',
      badge: summary.unpaidInvoices > 0 ? `${summary.unpaidInvoices} unpaid` : 'aman'
    },
    {
      label: 'Data Pelanggan',
      shortLabel: 'Pelanggan',
      desc: 'Cari, edit, dan cek profil pelanggan',
      href: '/admin/customers',
      icon: 'bi-people',
      tone: 'primary',
      countLabel: summary.totalCustomers > 0 ? String(summary.totalCustomers) : '',
      badge: summary.totalCustomers > 0 ? `${summary.totalCustomers} data` : 'kosong'
    },
    {
      label: 'MikroTik',
      shortLabel: 'MikroTik',
      desc: 'PPPoE, hotspot, profile, dan router',
      href: '/admin/mikrotik',
      icon: 'bi-router',
      tone: 'cyan',
      countLabel: summary.totalRouters > 0 ? String(summary.totalRouters) : '',
      badge: summary.totalRouters > 0 ? `${summary.totalRouters} router` : 'cek'
    },
    {
      label: 'Pembukuan',
      shortLabel: 'Pembukuan',
      desc: 'Pemasukan, pengeluaran, dan kas bisnis',
      href: '/admin/bookkeeping',
      icon: 'bi-cash-coin',
      tone: 'emerald',
      badge: summary.pendingAmount > 0 ? `Rp ${(summary.pendingAmount || 0).toLocaleString('id-ID')}` : 'ringkas'
    },
    {
      label: 'Peta Jaringan',
      shortLabel: 'Peta',
      desc: 'Map OLT, ODP, dan pelanggan',
      href: '/admin/map',
      icon: 'bi-map',
      tone: 'sky',
      badge: 'monitor'
    },
    {
      label: 'Laporan Gangguan',
      shortLabel: 'Gangguan',
      desc: 'Keluhan yang harus ditindaklanjuti',
      href: '/admin/tickets',
      icon: 'bi-headset',
      tone: 'gold',
      countLabel: summary.openTickets > 0 ? String(summary.openTickets) : '',
      badge: summary.openTickets > 0 ? `${summary.openTickets} aktif` : 'kosong'
    },
    {
      label: 'Isolir Pelanggan',
      shortLabel: 'Isolir',
      desc: 'Daftar customer suspend dan overdue',
      href: '/admin/customers?status=suspended',
      icon: 'bi-shield-lock',
      tone: 'rose',
      countLabel: summary.suspendedCustomers > 0 ? String(summary.suspendedCustomers) : '',
      badge: summary.suspendedCustomers > 0 ? `${summary.suspendedCustomers} suspend` : 'aman'
    },
    {
      label: 'Voucher',
      shortLabel: 'Voucher',
      desc: 'Cetak dan kelola voucher hotspot',
      href: '/admin/vouchers',
      icon: 'bi-ticket-perforated',
      tone: 'orange',
      countLabel: summary.totalVoucherBatches > 0 ? String(summary.totalVoucherBatches) : '',
      badge: summary.totalVoucherBatches > 0 ? `${summary.totalVoucherBatches} batch` : 'buat'
    },
    {
      label: 'Pengumuman',
      shortLabel: 'WA',
      desc: 'Broadcast info ke pelanggan via WhatsApp',
      href: '/admin/whatsapp/broadcast',
      icon: 'bi-megaphone',
      tone: 'mint',
      countLabel: '',
      badge: summary.whatsappEnabled ? 'siap kirim' : 'cek WA'
    },
    {
      label: 'Approval Kolektor',
      shortLabel: 'Approval',
      desc: 'Persetujuan pembayaran lapangan',
      href: '/admin/collector-payments',
      icon: 'bi-check2-square',
      tone: 'slate',
      countLabel: summary.pendingCollectorApprovals > 0 ? String(summary.pendingCollectorApprovals) : '',
      badge: summary.pendingCollectorApprovals > 0 ? `${summary.pendingCollectorApprovals} pending` : 'bersih'
    }
  ];

  if (req.session?.isAdmin) {
    shortcuts.splice(7, 0, {
      label: 'Tugas Teknisi',
      shortLabel: 'Teknisi',
      desc: 'Teknisi aktif dan pembagian tugas',
      href: '/admin/technicians',
      icon: 'bi-person-workspace',
      tone: 'violet',
      countLabel: summary.activeTechnicians > 0 ? String(summary.activeTechnicians) : '',
      badge: summary.activeTechnicians > 0 ? `${summary.activeTechnicians} teknisi` : 'atur'
    });
    shortcuts.splice(8, 0, {
      label: 'Approval Pelanggan',
      shortLabel: 'Approve',
      desc: 'Pengajuan pelanggan baru dari teknisi',
      href: '/admin/customer-requests',
      icon: 'bi-person-check',
      tone: 'violet',
      countLabel: summary.pendingCustomerRequests > 0 ? String(summary.pendingCustomerRequests) : '',
      badge: summary.pendingCustomerRequests > 0 ? `${summary.pendingCustomerRequests} pending` : 'bersih'
    });
  }

  if (req.session?.isAdmin) {
    shortcuts.push({
      label: 'Pengaturan',
      shortLabel: 'Setting',
      desc: 'Backup dan pengaturan sistem',
      href: '/admin/settings',
      icon: 'bi-gear',
      tone: 'neutral',
      badge: 'sistem'
    });
  }

  if (req.session?.isCashier && !req.session?.isAdmin) {
    return shortcuts.filter((item) => ['Tagihan', 'Pelanggan', 'Pembukuan', 'Approval'].includes(item.shortLabel || item.label));
  }

  const shortcutOrder = ['Tagihan', 'Pelanggan', 'MikroTik', 'Peta', 'Gangguan', 'Teknisi', 'Approve', 'Pembukuan', 'Isolir', 'Voucher', 'WA', 'Approval', 'Setting'];
  shortcuts.sort((a, b) => {
    const left = shortcutOrder.indexOf(a.shortLabel || a.label);
    const right = shortcutOrder.indexOf(b.shortLabel || b.label);
    return (left === -1 ? 999 : left) - (right === -1 ? 999 : right);
  });

  return shortcuts;
}

function parseMonitoringListQuery(req, defaultLimit = 25) {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 100)
    : defaultLimit;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const wantsMeta = q.length > 0 || 'page' in req.query || 'limit' in req.query;
  return { page, limit, q, wantsMeta };
}

function matchesMonitoringSearch(row, q, fields = []) {
  if (!q) return true;
  for (const field of fields) {
    const value = row?.[field];
    if (value === null || value === undefined) continue;
    if (String(value).toLowerCase().includes(q)) return true;
  }
  return false;
}

function paginateMonitoringRows(rows, page, limit) {
  const total = Array.isArray(rows) ? rows.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * limit;
  return {
    items: rows.slice(start, start + limit),
    page: safePage,
    limit,
    total,
    totalPages,
    start
  };
}

function derivePppoeProfilesFromSecrets(secrets = []) {
  const seen = new Set();
  const rows = [];
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    const name = String(secret?.profile || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      id: `fallback:${name}`,
      name,
      localAddress: secret?.localAddress || secret?.['local-address'] || '-',
      remoteAddress: secret?.remoteAddress || secret?.['remote-address'] || '-',
      rateLimit: secret?.rateLimit || secret?.['rate-limit'] || '-',
      source: 'secrets-fallback'
    });
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));
}

function deriveHotspotProfilesFromUsers(users = []) {
  const seen = new Set();
  const rows = [];
  for (const user of Array.isArray(users) ? users : []) {
    const name = String(user?.profile || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      id: `fallback:${name}`,
      name,
      rateLimit: user?.rateLimit || user?.['rate-limit'] || '-',
      sharedUsers: user?.sharedUsers || user?.['shared-users'] || '-',
      sessionTimeout: user?.sessionTimeout || user?.['session-timeout'] || '-',
      comment: user?.comment || '',
      source: 'users-fallback'
    });
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));
}

function readTextFileSafe(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function runCmd(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message || e) };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDirSync(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function getGitDefaultBranch(repoRoot) {
  const r = runCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (r.ok) {
    const ref = String(r.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  return 'main';
}

function getGitOriginUrl(repoRoot) {
  const r = runCmd('git', ['remote', 'get-url', 'origin'], repoRoot);
  if (!r.ok) return '';
  return String(r.stdout || '').trim();
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const info = { localVersion, remoteVersion: '-', branch: '-', needsUpdate: false, error: '', originUrl: '' };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    info.error = 'Folder ini belum menjadi git repository.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;
  info.originUrl = getGitOriginUrl(repoRoot);

  const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Gagal git fetch: ' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  if (!remote.ok) {
    info.error = `Tidak bisa membaca version.txt dari GitHub (origin/${branch}).`;
    return info;
  }

  const remoteVersion = String(remote.stdout || '').trim() || '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = Boolean(remoteVersion && remoteVersion !== '-' && remoteVersion !== localVersion);
  return info;
}

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const m = String(script).match(/",rem,.*?,(.*?),(.*?),.*?"/);
  if (!m) return null;
  const validity = String(m[1] || '').trim();
  const priceStr = String(m[2] || '').trim();
  const price = Number(String(priceStr).replace(/[^\d]/g, '')) || 0;
  return { validity, price };
}

function isTruthyFormValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function resolveCustomerPppoeProfile(packageId, status, isolirProfile = '', normalPppoeProfile = '') {
  if (status === 'suspended') return String(isolirProfile || 'BEATISOLIR').trim() || 'BEATISOLIR';
  const explicitNormalProfile = String(normalPppoeProfile || '').trim();
  if (explicitNormalProfile) return explicitNormalProfile;
  if (packageId) {
    const pkg = customerSvc.getPackageById(packageId);
    if (pkg) {
      const packageProfile = String(pkg.pppoe_profile || pkg.name || '').trim();
      if (packageProfile) return packageProfile;
    }
  }
  return 'default';
}

async function resolveAvailablePppoeProfile(profileName, routerId = null, fallbackProfile = 'default') {
  const desired = String(profileName || '').trim();
  const fallback = String(fallbackProfile || 'default').trim() || 'default';
  if (!routerId) return desired || fallback;
  try {
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    const names = (Array.isArray(profiles) ? profiles : [])
      .map((item) => String(item?.name || '').trim())
      .filter(Boolean);
    const nameSet = new Set(names);
    if (desired && nameSet.has(desired)) return desired;
    if (nameSet.has(fallback)) return fallback;
    if (nameSet.has('default-encryption')) return 'default-encryption';
    return names[0] || desired || fallback;
  } catch {
    return desired || fallback;
  }
}

async function getExistingPppoeSecretByUsername(username, routerId = null) {
  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const results = await conn.client.menu('/ppp/secret')
      .where('service', 'pppoe')
      .where('name', username)
      .get();
    return Array.isArray(results) && results.length ? results[0] : null;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Avoid starting with 0 if it's only numbers
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function createVoucherBatchAsync(batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return;

  const routerId = batch.router_id ?? null;
  const vouchers = db.prepare('SELECT id, code, profile_name FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId);

  const updateVoucher = db.prepare('UPDATE vouchers SET code=?, password=?, comment=?, status=?, created_at=created_at WHERE id=?');
  const markVoucherCreated = db.prepare('UPDATE vouchers SET status=? WHERE id=?');
  const incCreated = db.prepare("UPDATE voucher_batches SET qty_created = qty_created + 1, updated_at = CURRENT_TIMESTAMP WHERE id=?");
  const incFailed = db.prepare("UPDATE voucher_batches SET qty_failed = qty_failed + 1, updated_at = CURRENT_TIMESTAMP WHERE id=?");
  const setBatchStatus = db.prepare("UPDATE voucher_batches SET status=?, updated_at = CURRENT_TIMESTAMP WHERE id=?");

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

  const makeUniqueCode = () => {
    const prefix = String(batch.prefix || '').trim();
    const coreLen = Math.max(4, Math.min(16, (Number(batch.code_length) || 6) - prefix.length));
    const userCode = prefix + genCode(coreLen, batch.charset || 'numbers');
    
    let passCode = userCode;
    if (batch.mode === 'member') {
      passCode = genCode(coreLen, batch.charset || 'numbers');
    }
    
    return { userCode, passCode };
  };

  const poolLimit = 8;
  let idx = 0;

  const worker = async () => {
    while (idx < vouchers.length) {
      const current = vouchers[idx++];
      let generated = { userCode: current.code, passCode: current.password || current.code };
      let attempt = 0;
      while (attempt < 10) {
        attempt++;

        if (existsCode.get(routerId, generated.userCode) && generated.userCode !== current.code) {
          generated = makeUniqueCode();
          continue;
        }

        try {
          const comment = `vc-${generated.userCode}-${batch.profile_name}`;
          const userData = {
            server: 'all',
            name: generated.userCode,
            password: generated.passCode,
            profile: batch.profile_name,
            comment
          };
          if (batch.validity) userData['limit-uptime'] = batch.validity;

          await mikrotikService.addHotspotUser(userData, routerId);

          if (generated.userCode !== current.code || generated.passCode !== current.password) {
            updateVoucher.run(generated.userCode, generated.passCode, comment, 'created', current.id);
          } else {
            markVoucherCreated.run('created', current.id);
          }
          incCreated.run(batchId);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exist') || msg.toLowerCase().includes('duplicate');
          if (isDup) {
            generated = makeUniqueCode();
            continue;
          }
          markVoucherCreated.run('failed', current.id);
          incFailed.run(batchId);
          break;
        }
      }
      if (attempt >= 10) {
        markVoucherCreated.run('failed', current.id);
        incFailed.run(batchId);
      }
    }
  };

  setBatchStatus.run('creating', batchId);
  const workers = Array.from({ length: poolLimit }, () => worker());
  await Promise.all(workers);

  const final = db.prepare('SELECT qty_total, qty_created, qty_failed FROM voucher_batches WHERE id=?').get(batchId);
  if (final.qty_created >= final.qty_total && final.qty_failed === 0) setBatchStatus.run('ready', batchId);
  else if (final.qty_created > 0) setBatchStatus.run('partial', batchId);
  else setBatchStatus.run('failed', batchId);
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null, form: {} });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const rememberMe = req.body.remember_me === 'on' || req.body.remember_me === '1' || req.body.remember_me === true || req.body.remember_me === 'true';
  if (username === getSetting('admin_username', '') && password === getSetting('admin_password', '')) {
    req.session.isAdmin = true;
    req.session.adminUser = username;
    req.session.rememberMe = rememberMe;
    req.session.cookie.maxAge = rememberMe ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
    return req.session.save(() => res.redirect('/admin'));
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    req.session.isCashier = true;
    req.session.cashierId = cashier.id;
    req.session.cashierName = cashier.name;
    req.session.cashierUsername = cashier.username;
    req.session.rememberMe = rememberMe;
    req.session.cookie.maxAge = rememberMe ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
    return req.session.save(() => res.redirect('/admin'));
  }

  res.render('admin/login', {
    title: 'Admin Login',
    company: company(),
    error: 'Username atau password salah',
    form: { username, rememberMe }
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

// ─── OLT MANAGEMENT ────────────────────────────────────────────────────────
router.get('/olts', requireAdminSession, async (req, res) => {
  const olts = oltSvc.getAllOlts();
  
  res.render('admin/olts', { 
    title: 'Manajemen OLT', 
    company: company(), 
    activePage: 'olts', 
    olts, 
    msg: flashMsg(req) 
  });
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getOltStats(req.params.id, req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/reboot', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await oltSvc.rebootOnu(req.params.id, req.params.index);
    res.json({ success: true, message: 'Perintah reboot berhasil dikirim.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/rename', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) throw new Error('Nama tidak boleh kosong');
    await oltSvc.renameOnu(req.params.id, req.params.index, name);
    res.json({ success: true, message: 'Nama ONU berhasil diubah.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/authorize', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const output = await oltSvc.authorizeOnu(req.params.id, req.body);
    res.json({ success: true, message: 'Otorisasi berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/configure-wan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { method, sn } = req.body;
    let output;
    if (method === 'tr069') {
      output = await oltSvc.configureWanViaAcs(sn, req.body);
    } else {
      output = await oltSvc.configureOnuWan(req.params.id, req.body);
    }
    res.json({ success: true, message: 'Konfigurasi WAN berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.createOlt(req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.updateOlt(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    oltSvc.deleteOlt(req.params.id);
    req.session._msg = { type: 'success', text: 'OLT berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

// ─── ODP & MAP MANAGEMENT ───────────────────────────────────────────────────
router.get('/map', requireAdminSession, (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();
  
  res.render('admin/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.status(404).json({ ok: false, error: 'not_found' });

  const routerId = customer.router_id ? Number(customer.router_id) : null;
  const username = String(customer.pppoe_username || '').trim();

  if (!routerId || !username) {
    return res.json({ ok: true, available: false, online: false, username: username || null, rxMbps: 0, txMbps: 0 });
  }

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, available: true, online: false, username, rxMbps: 0, txMbps: 0 });
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
            return res.json({
              ok: true,
              available: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              rxMbps: (Number(rxBps) || 0) / 1e6,
              txMbps: (Number(txBps) || 0) / 1e6
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

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const rxMbps = (dIn * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dOut * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      available: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/api/customers/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path } = req.body;
    if (!id) throw new Error('ID pelanggan tidak valid');
    customerSvc.updateCustomerCablePath(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/odps', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.createOdp(req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.updateOdp(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    odpSvc.deleteOdp(req.params.id);
    req.session._msg = { type: 'success', text: 'ODP berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, restrictToAdmin, (req, res) => {
  const technicians = adminSvc.getAllTechnicians();
  res.render('admin/technicians', { title: 'Manajemen Teknisi', company: company(), activePage: 'technicians', technicians, msg: flashMsg(req) });
});

router.post('/technicians', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createTechnician(req.body);
    req.session._msg = { type: 'success', text: 'Teknisi berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data teknisi diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  req.session._msg = { type: 'success', text: 'Teknisi berhasil dihapus.' };
  res.redirect('/admin/technicians');
});

router.get('/customer-requests', requireAdminSession, restrictToAdmin, (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           t.name as technician_name,
           t.username as technician_username,
           p.name as package_name,
           rt.name as router_name,
           c.name as approved_customer_name
    FROM technician_customer_requests r
    JOIN technicians t ON t.id = r.technician_id
    LEFT JOIN packages p ON p.id = r.package_id
    LEFT JOIN routers rt ON rt.id = r.router_id
    LEFT JOIN customers c ON c.id = r.approved_customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 300
  `).all(status);

  res.render('admin/customer_requests', {
    title: 'Approval Pelanggan Teknisi',
    company: company(),
    activePage: 'customer_requests',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/customer-requests/:id/approve', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = db.prepare('SELECT * FROM technician_customer_requests WHERE id = ?').get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');

    const payload = JSON.parse(String(row.payload_json || '{}') || '{}');
    const pppoeUsername = String(payload.pppoe_username || '').trim();
    const routerId = payload.router_id ? Number(payload.router_id) : null;
    if (pppoeUsername) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId ?? null, pppoeUsername);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);
    }

    const createResult = customerSvc.createCustomer(payload);
    const customerId = Number(createResult.lastInsertRowid || 0) || null;
    db.prepare(`
      UPDATE technician_customer_requests
      SET status='approved',
          review_note=?,
          reviewed_by_name=?,
          approved_customer_id=?,
          reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(reviewNote, resolvePaidByName(req, 'Admin'), customerId, id);

    req.session._msg = { type: 'success', text: `Pengajuan pelanggan "${row.customer_name}" disetujui.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal approve: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/customer-requests/:id/reject', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = db.prepare('SELECT id, status FROM technician_customer_requests WHERE id = ?').get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');
    db.prepare(`
      UPDATE technician_customer_requests
      SET status='rejected',
          review_note=?,
          reviewed_by_name=?,
          reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(reviewNote, resolvePaidByName(req, 'Admin'), id);
    req.session._msg = { type: 'success', text: 'Pengajuan pelanggan ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal reject: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

// --- CASHIER MANAGEMENT ---
router.get('/cashiers', requireAdminSession, restrictToAdmin, (req, res) => {
  const cashiers = adminSvc.getAllCashiers();
  res.render('admin/cashiers', { title: 'Manajemen Kasir', company: company(), activePage: 'cashiers', cashiers, msg: flashMsg(req) });
});

router.post('/cashiers', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCashier(req.body);
    req.session._msg = { type: 'success', text: 'Kasir berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kasir diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  req.session._msg = { type: 'success', text: 'Kasir berhasil dihapus.' };
  res.redirect('/admin/cashiers');
});

// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, restrictToAdmin, (req, res) => {
  const collectors = adminSvc.getAllCollectors();
  res.render('admin/collectors', { title: 'Manajemen Kolektor', company: company(), activePage: 'collectors', collectors, msg: flashMsg(req) });
});

router.post('/collectors', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCollector(req.body);
    req.session._msg = { type: 'success', text: 'Kolektor berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kolektor diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Kolektor berhasil dihapus.' };
  res.redirect('/admin/collectors');
});

router.get('/collector-payments', requireAdminSession, (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           col.name as collector_name, col.username as collector_username,
           i.period_month, i.period_year, i.amount as invoice_amount, i.status as invoice_status,
           c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.lat, c.lng
    FROM collector_payment_requests r
    JOIN collectors col ON col.id = r.collector_id
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 500
  `).all(status);

  res.render('admin/collector_payments', {
    title: 'Approval Pembayaran Kolektor',
    company: company(),
    activePage: 'collector_payments',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/collector-payments/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();

    const row = db.prepare(`
      SELECT r.*, col.name as collector_name, col.username as collector_username
      FROM collector_payment_requests r
      JOIN collectors col ON col.id = r.collector_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');

    const inv = billingSvc.getInvoiceById(row.invoice_id);
    if (!inv) throw new Error('Invoice tidak ditemukan');
    if (String(inv.status) === 'paid') {
      db.prepare(`
        UPDATE collector_payment_requests
        SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(req.session.isCashier ? 'cashier' : 'admin', resolvePaidByName(req, 'Admin'), 'Invoice sudah lunas', id);
      req.session._msg = { type: 'error', text: 'Invoice sudah lunas, request ditolak.' };
      return redirectBack(res, '/admin/collector-payments');
    }

    const collectorLabel =
      (`Kolektor ${(String(row.collector_name || '').trim())}` +
        (String(row.collector_username || '').trim() ? ` (@${String(row.collector_username).trim()})` : '')).trim();

    const approver = resolvePaidByName(req, 'Admin');
    const notesParts = [
      'Via Kolektor',
      collectorLabel,
      `Approved oleh ${approver}`,
    ];
    if (row.note) notesParts.push(String(row.note));
    if (decidedNote) notesParts.push(`Approval: ${decidedNote}`);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes);

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.phone) {
      const msg =
        `✅ *PEMBAYARAN BERHASIL*\n\n` +
        `👤 *Pelanggan:* ${customer.name}\n` +
        `🧾 *Invoice:* #${inv.id}\n` +
        `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n` +
        `💰 *Nominal Tagihan:* Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}\n` +
        `🏷️ *Dibayar Via:* ${collectorLabel}\n\n` +
        `Terima kasih.`;
      await sendPaidWhatsappNotification(customer, [inv], inv, {
        baseUrl: resolveRequestBaseUrl(req),
        paidBy: collectorLabel,
        paidAt: new Date().toLocaleString('id-ID')
      });
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: 'Request disetujui dan invoice dilunasi.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/collector-payments');
});

router.post('/collector-payments/:id/reject', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();
    const row = db.prepare(`SELECT * FROM collector_payment_requests WHERE id=?`).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');
    const approver = resolvePaidByName(req, 'Admin');
    db.prepare(`
      UPDATE collector_payment_requests
      SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);
    req.session._msg = { type: 'success', text: 'Request ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/collector-payments');
});

router.get('/cashiers/reports', requireAdminSession, (req, res) => {
  const allCashiers = adminSvc.getAllCashiers();
  const isAdmin = Boolean(req.session?.isAdmin);
  const isCashier = Boolean(req.session?.isCashier);

  const requested = req.query.cashierId != null && String(req.query.cashierId).trim() !== ''
    ? Number(req.query.cashierId)
    : null;

  const cashierId =
    isCashier && !isAdmin
      ? Number(req.session.cashierId || 0) || null
      : requested;

  const selectedCashier = cashierId
    ? (allCashiers || []).find(c => Number(c.id) === Number(cashierId)) || null
    : null;

  const paidByExact = selectedCashier
    ? (`Kasir ${(String(selectedCashier.name || '').trim())}` + (String(selectedCashier.username || '').trim() ? ` (@${String(selectedCashier.username).trim()})` : '')).trim()
    : null;

  const invWhere = [];
  const invParams = [];
  invWhere.push(`i.status='paid'`);
  invWhere.push(`i.paid_by_name LIKE 'Kasir %'`);
  if (paidByExact) {
    invWhere.push(`i.paid_by_name = ?`);
    invParams.push(paidByExact);
  }

  const invoiceRows = db.prepare(`
    SELECT i.id as ref_id,
           i.paid_at as at,
           i.paid_by_name as actor_name,
           i.amount as amount,
           i.notes as notes,
           i.period_month,
           i.period_year,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE ${invWhere.join(' AND ')}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 500
  `).all(...invParams).map(r => ({
    kind: 'invoice',
    at: r.at,
    actor_name: r.actor_name,
    amount: Number(r.amount || 0),
    notes: r.notes || '',
    ref_id: r.ref_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || '',
    period_month: r.period_month,
    period_year: r.period_year,
    package_name: r.package_name || ''
  }));

  const topupWhere = [];
  const topupParams = [];
  topupWhere.push(`t.type='topup'`);
  topupWhere.push(`t.note LIKE 'Kasir %:%'`);
  if (paidByExact) {
    topupWhere.push(`t.note LIKE ?`);
    topupParams.push(`${paidByExact}:%`);
  }

  const topupRows = db.prepare(`
    SELECT t.id as ref_id,
           t.created_at as at,
           t.amount_buy as amount,
           t.note as notes,
           a.name as agent_name,
           a.username as agent_username
    FROM agent_transactions t
    JOIN agents a ON t.agent_id = a.id
    WHERE ${topupWhere.join(' AND ')}
    ORDER BY datetime(t.created_at) DESC, t.id DESC
    LIMIT 500
  `).all(...topupParams).map(r => {
    const rawNote = String(r.notes || '');
    const idx = rawNote.indexOf(':');
    const actor = idx > 0 ? rawNote.slice(0, idx).trim() : '';
    const rest = idx > 0 ? rawNote.slice(idx + 1).trim() : rawNote.trim();
    return {
      kind: 'agent_topup',
      at: r.at,
      actor_name: actor || 'Kasir',
      amount: Number(r.amount || 0),
      notes: rest,
      ref_id: r.ref_id,
      agent_name: r.agent_name || '',
      agent_username: r.agent_username || ''
    };
  });

  const rows = [...invoiceRows, ...topupRows].sort((a, b) => {
    const atA = a && a.at ? String(a.at) : '';
    const atB = b && b.at ? String(b.at) : '';
    if (atA !== atB) return atB.localeCompare(atA);
    return Number(b?.ref_id || 0) - Number(a?.ref_id || 0);
  }).slice(0, 800);

  const invSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(i.amount) as total
    FROM invoices i
    WHERE ${invWhere.join(' AND ')}
  `).get(...invParams);

  const topupSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(t.amount_buy) as total
    FROM agent_transactions t
    WHERE ${topupWhere.join(' AND ')}
  `).get(...topupParams);

  const safeCashiers = isAdmin
    ? allCashiers
    : selectedCashier
      ? [selectedCashier]
      : [];

  res.render('admin/cashier_reports', {
    title: 'Laporan Kasir',
    company: company(),
    activePage: 'cashiers_reports',
    cashiers: safeCashiers,
    cashierId: cashierId || '',
    paidByExact: paidByExact || '',
    rows,
    summary: {
      count: Number(invSumRow?.cnt || 0) + Number(topupSumRow?.cnt || 0),
      total: Number(invSumRow?.total || 0) + Number(topupSumRow?.total || 0),
      invoice_count: Number(invSumRow?.cnt || 0),
      invoice_total: Number(invSumRow?.total || 0),
      topup_count: Number(topupSumRow?.cnt || 0),
      topup_total: Number(topupSumRow?.total || 0)
    },
    msg: flashMsg(req)
  });
});

// --- AGENT MANAGEMENT ---
router.get('/agents', requireAdminSession, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const routers = mikrotikService.getAllRouters();
  res.render('admin/agents', {
    title: 'Manajemen Agent',
    company: company(),
    activePage: 'agents',
    agents,
    routers,
    msg: flashMsg(req)
  });
});

router.post('/agents', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.createAgent(req.body);
    req.session._msg = { type: 'success', text: 'Agent berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.updateAgent(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data agent diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    agentSvc.deleteAgent(req.params.id);
    req.session._msg = { type: 'success', text: 'Agent berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/topup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || '').trim();
    const actorName = req.session?.isCashier ? resolvePaidByName(req, 'Kasir') : (req.session.adminUser || 'Admin');
    agentSvc.topupAgent(req.params.id, amount, note, actorName);
    req.session._msg = { type: 'success', text: 'Topup saldo berhasil.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal topup: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.get('/agents/reports', requireAdminSession, restrictToAdmin, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const agentId = req.query.agentId ? Number(req.query.agentId) : null;
  const txs = agentSvc.listAgentTransactions({ agentId, limit: 500 });
  res.render('admin/agent_reports', {
    title: 'Laporan Agent',
    company: company(),
    activePage: 'agents_reports',
    agents,
    agentId,
    txs,
    msg: flashMsg(req)
  });
});

router.get('/api/agents/:id/prices', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const rows = agentSvc.getAgentPrices(Number(req.params.id));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices', requireAdmin, restrictToAdmin, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const result = agentSvc.upsertAgentHotspotPrice(agentId, req.body);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices/:priceId/delete', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const priceId = Number(req.params.priceId);
    const result = agentSvc.deleteAgentHotspotPrice(agentId, priceId);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdminSession, async (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    const opsSummary = getAdminHomeSummary({ billing, custStats });
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing, custStats, opsSummary,
      adminHomeShortcuts: buildAdminHomeShortcuts(req, opsSummary)
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null });
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
function buildInvoiceSummaryFromList(invoices = []) {
  const summary = {
    total: { count: 0, total: 0 },
    paid: { count: 0, total: 0 },
    unpaid: { count: 0, total: 0 }
  };

  for (const inv of invoices) {
    const amount = Number(inv?.amount || 0);
    summary.total.count += 1;
    summary.total.total += amount;
    if (String(inv?.status || '').toLowerCase() === 'paid') {
      summary.paid.count += 1;
      summary.paid.total += amount;
    } else {
      summary.unpaid.count += 1;
      summary.unpaid.total += amount;
    }
  }

  return summary;
}

router.get('/customers', requireAdminSession, (req, res) => {
  const {
    search = '',
    status: filterStatus = '',
    billingDayStart = '',
    billingDayEnd = '',
    month: rawMonth = '',
    year: rawYear = '',
    page: rawPage = '1'
  } = req.query;
  const now = new Date();
  const selectedMonth = Math.min(12, Math.max(1, parseInt(rawMonth, 10) || (now.getMonth() + 1)));
  const selectedYear = parseInt(rawYear, 10) || now.getFullYear();
  const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = 25;
  const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
  const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
  const monthKey = String(selectedMonth).padStart(2, '0');
  const yearKey = String(selectedYear);
  const customers = customerSvc.getAllCustomers(search);
  const stats = customerSvc.getCustomerStats();
  const packages = customerSvc.getAllPackages();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const odps = odpSvc.getAllOdps();

  // Apply status filter in JS if provided
  let filteredCustomers = filterStatus
    ? customers.filter(c => c.status === filterStatus)
    : customers;

  if (normalizedBillingDayStart || normalizedBillingDayEnd) {
    filteredCustomers = filteredCustomers.filter((c) => {
      const dueDay = Number(c?.isolate_day || 0);
      if (!Number.isFinite(dueDay) || dueDay <= 0) return false;
      if (normalizedBillingDayStart && dueDay < normalizedBillingDayStart) return false;
      if (normalizedBillingDayEnd && dueDay > normalizedBillingDayEnd) return false;
      return true;
    });
  }

  const activeRevenue = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(p.price, 0)), 0) AS total
    FROM customers c
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE c.status = 'active'
  `).get();
  const newCustomers = db.prepare(`
    SELECT COUNT(*) AS c
    FROM customers
    WHERE strftime('%m', created_at) = ? AND strftime('%Y', created_at) = ?
  `).get(monthKey, yearKey);
  const unpaidInvoices = db.prepare(`
    SELECT COUNT(DISTINCT customer_id) AS count, COALESCE(SUM(amount), 0) AS total
    FROM invoices
    WHERE period_month = ? AND period_year = ? AND status = 'unpaid'
  `).get(selectedMonth, selectedYear);
  const paidInvoices = db.prepare(`
    SELECT COUNT(DISTINCT customer_id) AS count, COALESCE(SUM(amount), 0) AS total
    FROM invoices
    WHERE period_month = ? AND period_year = ? AND status = 'paid'
  `).get(selectedMonth, selectedYear);
  const cashPayments = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM invoices
    WHERE status = 'paid'
      AND strftime('%m', paid_at) = ?
      AND strftime('%Y', paid_at) = ?
      AND (payment_gateway IS NULL OR TRIM(payment_gateway) = '')
  `).get(monthKey, yearKey);
  const onlinePayments = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM invoices
    WHERE status = 'paid'
      AND strftime('%m', paid_at) = ?
      AND strftime('%Y', paid_at) = ?
      AND payment_gateway IS NOT NULL
      AND TRIM(payment_gateway) <> ''
  `).get(monthKey, yearKey);

  const customerOverview = {
    month: selectedMonth,
    year: selectedYear,
    totalCustomers: Number(stats.total || 0),
    activeCustomers: Number(stats.active || 0),
    activeRevenue: Number(activeRevenue?.total || 0),
    newCustomers: Number(newCustomers?.c || 0),
    unpaidCustomers: Number(unpaidInvoices?.count || 0),
    unpaidAmount: Number(unpaidInvoices?.total || 0),
    paidCustomers: Number(paidInvoices?.count || 0),
    paidAmount: Number(paidInvoices?.total || 0),
    cashTransactions: Number(cashPayments?.count || 0),
    cashAmount: Number(cashPayments?.total || 0),
    onlineTransactions: Number(onlinePayments?.count || 0),
    onlineAmount: Number(onlinePayments?.total || 0),
    suspendedCustomers: Number(stats.suspended || 0),
    inactiveCustomers: Number(stats.inactive || 0)
  };

  const totalCustomersCount = filteredCustomers.length;
  const totalPages = Math.max(1, Math.ceil(totalCustomersCount / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedCustomers = filteredCustomers.slice((safePage - 1) * pageSize, safePage * pageSize);

  res.render('admin/customers', {
    title: 'Data Pelanggan', company: company(), activePage: 'customers',
    customers: paginatedCustomers, stats, packages, routers, olts, odps, search, filterStatus,
    selectedMonth, selectedYear, customerOverview,
    billingDayStart: normalizedBillingDayStart || '',
    billingDayEnd: normalizedBillingDayEnd || '',
    currentPage: safePage,
    totalPages,
    totalCustomersCount,
    pageSize,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const syncWarnings = [];
    if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      const shouldCreateSecret = isTruthyFormValue(req.body.create_pppoe_secret);
      const pppoePassword = String(req.body.pppoe_password || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId, username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let existingSecret = null;
      let lookupFailed = false;
      try {
        existingSecret = await getExistingPppoeSecretByUsername(username, routerId);
      } catch (lookupErr) {
        lookupFailed = true;
        syncWarnings.push(`Secret PPPoE belum bisa dicek ke MikroTik: ${lookupErr.message}`);
      }

      if (!existingSecret && !lookupFailed) {
        if (!shouldCreateSecret) {
          syncWarnings.push('PPPoE Username belum ditemukan di MikroTik, tetapi data pelanggan tetap disimpan.');
        } else {
          const desiredProfile = resolveCustomerPppoeProfile(
            req.body.package_id,
            req.body.status,
            req.body.isolir_profile,
            req.body.normal_pppoe_profile
          );
          const targetProfile = await resolveAvailablePppoeProfile(desiredProfile, routerId, 'default');
          const secretPassword = pppoePassword || username;
          try {
            await mikrotikService.addPppoeSecret({
              name: username,
              password: secretPassword,
              service: 'pppoe',
              profile: targetProfile,
              comment: req.body.name ? `Customer: ${String(req.body.name).trim()}` : ''
            }, routerId);
            if (targetProfile !== desiredProfile) {
              syncWarnings.push(`Secret PPPoE dibuat dengan profile "${targetProfile}" karena profile "${desiredProfile}" belum tersedia di router.`);
            }
          } catch (secretErr) {
            syncWarnings.push(`Secret PPPoE belum berhasil dibuat otomatis: ${secretErr.message}`);
          }
        }
      }
    }

    const createResult = customerSvc.createCustomer(req.body);
    const createdCustomer = customerSvc.getCustomerById(createResult.lastInsertRowid);
    
    // Sync to MikroTik if username provided
    if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
      const desiredProfile = resolveCustomerPppoeProfile(
        req.body.package_id,
        req.body.status,
        req.body.isolir_profile,
        req.body.normal_pppoe_profile
      );
      const targetProfile = await resolveAvailablePppoeProfile(
        desiredProfile,
        req.body.router_id ? Number(req.body.router_id) : null,
        'default'
      );
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
          if (targetProfile !== desiredProfile) {
            syncWarnings.push(`Profile PPPoE pelanggan disetel ke "${targetProfile}" karena profile "${desiredProfile}" belum tersedia di router.`);
          }
        } catch (mErr) {
          console.error('Mikrotik sync error (create):', mErr);
          syncWarnings.push(`Profil PPPoE belum berhasil disinkronkan: ${mErr.message}`);
        }
      }
    }

    if (createdCustomer && createdCustomer.phone) {
      const welcomeMessage = buildWelcomeWhatsappMessage(createdCustomer, { baseUrl: resolveRequestBaseUrl(req) });
      if (welcomeMessage) {
        await trySendWhatsappPayment(createdCustomer.phone, welcomeMessage);
      }
    }

    const warningText = syncWarnings.length ? ` Catatan: ${syncWarnings.join(' | ')}` : '';
    req.session._msg = { type: 'success', text: `Pelanggan "${req.body.name}" berhasil ditambahkan.${warningText}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
      const customerId = Number(req.params.id);
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(routerId, username, customerId);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(routerId);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
    }

    customerSvc.updateCustomer(req.params.id, req.body);
    
    // Sync to MikroTik if username provided
    if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
      const desiredProfile = resolveCustomerPppoeProfile(
        req.body.package_id,
        req.body.status,
        req.body.isolir_profile,
        req.body.normal_pppoe_profile
      );
      const targetProfile = await resolveAvailablePppoeProfile(
        desiredProfile,
        req.body.router_id ? Number(req.body.router_id) : null,
        'default'
      );
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
        } catch (mErr) {
          console.error('Mikrotik sync error (update):', mErr);
        }
      }
    }

    req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const data = customers.map(c => ({
      'ID': c.id,
      'Nama': c.name,
      'Telepon': c.phone,
      'Email': c.email || '',
      'Alamat': c.address,
      'Paket': c.package_name || '-',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'PPPoE Profile': c.normal_pppoe_profile || c.package_pppoe_profile || c.package_name || '',
      'Isolir Profile': c.isolir_profile,
      'Status': c.status,
      'Tanggal Pasang': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Tgl Isolir': c.isolate_day,
      'ODP': c.odp_name || '-',
      'Latitude': c.lat || '',
      'Longitude': c.lng || '',
      'Catatan': c.notes
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('Gagal export data.');
  }
});

router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('File tidak ditemukan');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    logger.info(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    const odps = odpSvc.getAllOdps();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        logger.debug('[Import] Skipping row - Name is empty.');
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);

      const odpName = cleanRow['ODP'] || cleanRow['odp'] || cleanRow['ODP Name'];
      const odp = odps.find(o => o.name === odpName);
      
      const data = {
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        email: cleanRow['Email'] || cleanRow['email'] || cleanRow['email_address'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        package_id: pkg ? pkg.id : null,
        odp_id: odp ? odp.id : null,
        lat: cleanRow['Latitude'] || cleanRow['latitude'] || cleanRow['Lat'] || '',
        lng: cleanRow['Longitude'] || cleanRow['longitude'] || cleanRow['Lng'] || '',
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: cleanRow['PPPoE Username'] || cleanRow['pppoe_username'],
        normal_pppoe_profile: cleanRow['PPPoE Profile'] || cleanRow['pppoe_profile'] || '',
        isolir_profile: cleanRow['Isolir Profile'] || cleanRow['isolir_profile'] || 'BEATISOLIR',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Tanggal Pasang'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        logger.info(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        logger.info(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    logger.info(`[Import] Finished. Total processed: ${count}`);
    req.session._msg = { type: 'success', text: `Berhasil mengimpor ${count} data pelanggan.` };
  } catch (e) {
    logger.error('Import error:', e);
    req.session._msg = { type: 'error', text: 'Gagal impor: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    const unpaidInvoices = customer ? billingSvc.getUnpaidInvoicesByCustomerId(customer.id) : [];
    if (customer && customer.phone) {
      const requestBaseUrl = resolveRequestBaseUrl(req);
      await trySendWhatsappPayment(
        customer.phone,
        buildIsolationWhatsappMessage(
          customer,
          unpaidInvoices,
          'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.',
          { baseUrl: requestBaseUrl }
        )
      );
    }
    req.session._msg = { type: 'success', text: `Pelanggan "${customer.name}" berhasil di-isolir manual.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.activateCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Layanan pelanggan "${customer.name}" berhasil diaktifkan kembali.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      req.session._msg = { type: 'success', text: `Tagihan berhasil dibuat untuk "${result.customerName}" periode ${month}/${year}.` };
    } else {
      req.session._msg = { type: 'success', text: `Tagihan sudah ada untuk "${result.customerName}" periode ${month}/${year}.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate tagihan: ' + e.message };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const r = customerSvc.resetPromoCyclesUsed(req.params.id);
    if (!r.changes) {
      req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
    } else {
      const c = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Counter promo untuk "${c ? c.name : req.params.id}" di-reset (siklus promo dihitung ulang dari awal).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    req.session._msg = {
      type: 'success',
      text: `Tagihan susulan prorata untuk "${out.customerName}" periode ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sebesar Rp ${Number(out.amount).toLocaleString('id-ID')} (${out.billableDays}/${out.daysInMonth} hari).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, months, year, paid_by_name, notes } = req.body;
    const y = parseInt(year);
    const paidBy = resolvePaidByName(req, paid_by_name);
    const customer = customerSvc.getCustomerById(req.params.id);

    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}.` };

      if (customer && customer.phone && done > 0) {
        const monthsText = (sum.paidMonths || []).join(', ');
        const msg =
          `✅ *PEMBAYARAN BERHASIL*\n\n` +
          `👤 *Pelanggan:* ${customer.name}\n` +
          `📅 *Tahun:* ${sum.year}\n` +
          `🧾 *Bulan Dibayar:* ${monthsText || '-'}\n` +
          `💰 *Total:* Rp ${Number(total || 0).toLocaleString('id-ID')}\n` +
          `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
          `Terima kasih.`;
        const paidInvoices = (Array.isArray(sum.paidMonths) ? sum.paidMonths : [])
          .map((paidMonth) => {
            const allInvoices = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
            return (Array.isArray(allInvoices) ? allInvoices : []).find(
              (item) => Number(item?.period_month) === Number(paidMonth) && Number(item?.period_year) === Number(sum.year)
            ) || null;
          })
          .filter(Boolean);
        await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
          baseUrl: resolveRequestBaseUrl(req),
          paidBy,
          paidAt: new Date().toLocaleString('id-ID')
        });
      }
    } else {
      const m = parseInt(month);
      const result = billingSvc.payInvoiceForCustomerPeriod(req.params.id, m, y, paidBy, notes);
      if (result.alreadyPaid) {
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" sudah lunas.` };
      } else {
        const verb = result.created ? 'dibuat & dilunasi' : 'dilunasi';
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" berhasil ${verb}.` };

        if (customer && customer.phone) {
          const invs = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
          const inv = (Array.isArray(invs) ? invs : []).find(i => Number(i?.period_month) === Number(m) && Number(i?.period_year) === Number(y)) || null;
          const amount = inv ? Number(inv.amount || 0) : 0;
          const msg =
            `✅ *PEMBAYARAN BERHASIL*\n\n` +
            `👤 *Pelanggan:* ${customer.name}\n` +
            `📅 *Periode:* ${m}/${y}\n` +
            `${inv ? `🧾 *Invoice:* #${inv.id}\n` : ''}` +
            `💰 *Nominal Tagihan:* Rp ${amount.toLocaleString('id-ID')}\n` +
            `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
            `Terima kasih.`;
          await sendPaidWhatsappNotification(customer, inv ? [inv] : [], inv, {
            baseUrl: resolveRequestBaseUrl(req),
            paidBy,
            paidAt: new Date().toLocaleString('id-ID')
          });
        }
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar: ' + e.message };
  }
  return redirectBack(res, '/admin/customers');
});

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, (req, res) => {
  res.render('admin/packages', {
    title: 'Paket Internet', company: company(), activePage: 'packages',
    packages: customerSvc.getAllPackages(), msg: flashMsg(req)
  });
});

router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.createPackage(req.body);
    req.session._msg = { type: 'success', text: `Paket "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.updatePackage(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Paket berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    customerSvc.deletePackage(req.params.id);
    req.session._msg = { type: 'success', text: 'Paket berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

// ─── BILLING ───────────────────────────────────────────────────────────────
/*
router.get('/billing', requireAdminSession, (req, res) => {
  const {
    month: filterMonth,
    year: rawFilterYear = new Date().getFullYear(),
    status: filterStatus = 'all',
    search = '',
    billingDayStart = '',
    billingDayEnd = '',
    page: rawPage = '1'
  } = req.query;
  const filterYear = parseInt(rawFilterYear, 10) || new Date().getFullYear();
  const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = 25;
  let invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search });
  const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
  const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
  if (normalizedBillingDayStart || normalizedBillingDayEnd) {
    invoices = invoices.filter((inv) => {
      const day = Number(inv?.due_day_snapshot || 0);
      if (!Number.isFinite(day) || day <= 0) return false;
      if (normalizedBillingDayStart && day < normalizedBillingDayStart) return false;
      if (normalizedBillingDayEnd && day > normalizedBillingDayEnd) return false;
      return true;
    });
  }
  const summary = buildInvoiceSummaryFromList(invoices);
  const totalInvoicesCount = invoices.length;
  const totalPages = Math.max(1, Math.ceil(totalInvoicesCount / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedInvoices = invoices.slice((safePage - 1) * pageSize, safePage * pageSize);
  res.render('admin/billing', {
    title: 'Tagihan', company: company(), activePage: 'billing',
    invoices: paginatedInvoices, summary, filterMonth, filterYear, filterStatus, search,
    billingDayStart: normalizedBillingDayStart || '',
    billingDayEnd: normalizedBillingDayEnd || '',
    currentPage: safePage,
    totalPages,
    totalInvoicesCount,
    pageSize,
    msg: flashMsg(req)
  });
});

router.get('/billing/:id/print', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
  res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    company: settings.company_header || 'Billing ISP',
    settings,
    printStyle,
    viewerRole: 'admin',
    printBasePath: `/admin/billing/${inv.id}/print`
  });
});

router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const count = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    req.session._msg = { type: 'success', text: `${count} tagihan baru berhasil digenerate untuk periode ${month}/${year}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate: ' + e.message };
  }
  res.redirect('/admin/billing');
});

router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
  try {
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear());
    const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear());
    const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/suggest', requireAdmin, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const suggestions = customerSvc.getCustomerSearchSuggestions(q, 8).map((row) => ({
      id: Number(row.id || 0) || 0,
      name: String(row.name || '').trim(),
      phone: String(row.phone || '').trim(),
      pppoe_username: String(row.pppoe_username || '').trim(),
      genieacs_tag: String(row.genieacs_tag || '').trim(),
      address: String(row.address || '').trim()
    }));
    res.json(suggestions);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const paidBy = resolvePaidByName(req, paid_by_name);
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let customerId = null;
    const paidInvoices = [];
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        customerId = inv.customer_id;
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes);
        if (!wasPaid) {
          paidInvoices.push({
            id: inv.id,
            amount: Number(inv.amount || 0),
            period_month: inv.period_month,
            period_year: inv.period_year
          });
        }
      }
    }

    // Un-isolate logic
    if (customerId) {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === customerId);
      if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(customerId);
      }
    }

    if (customerId && paidInvoices.length > 0) {
      const customer = customerSvc.getCustomerById(customerId);
      if (customer && customer.phone) {
        const total = paidInvoices.reduce((a, b) => a + Number(b.amount || 0), 0);
        const periods = paidInvoices
          .map(x => `${x.period_month}/${x.period_year}`)
          .slice(0, 10)
          .join(', ') + (paidInvoices.length > 10 ? `, +${paidInvoices.length - 10} lainnya` : '');
        const msg =
          `✅ *PEMBAYARAN BERHASIL*\n\n` +
          `👤 *Pelanggan:* ${customer.name}\n` +
          `🧾 *Tagihan Dibayar:* ${paidInvoices.length} invoice\n` +
          `📅 *Periode:* ${periods}\n` +
          `💰 *Total:* Rp ${Number(total || 0).toLocaleString('id-ID')}\n` +
          `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
          `Terima kasih.`;
        await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
          baseUrl: resolveRequestBaseUrl(req),
          paidBy,
          paidAt: new Date().toLocaleString('id-ID')
        });
      }
    }

    req.session._msg = { type: 'success', text: `${ids.length} tagihan berhasil dilunasi.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');

    const paidBy = resolvePaidByName(req, req.body.paid_by_name);
    const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
    billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);
    
    // Check if customer is currently suspended and has no more unpaid invoices
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!wasPaid && customer && customer.phone) {
      const msg =
        `✅ *PEMBAYARAN BERHASIL*\n\n` +
        `👤 *Pelanggan:* ${customer.name}\n` +
        `🧾 *Invoice:* #${inv.id}\n` +
        `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n` +
        `💰 *Nominal Tagihan:* Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}\n` +
        `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
        `Terima kasih.`;
      await sendPaidWhatsappNotification(customer, [inv], inv, {
        baseUrl: resolveRequestBaseUrl(req),
        paidBy,
        paidAt: new Date().toLocaleString('id-ID')
      });
    }
    if (customer && customer.status === 'suspended') {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
      if (freshCustomer && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: 'Tagihan berhasil ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
  try {
    billingSvc.markAsUnpaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

    const force = String(req.query.force || '') === '1';
    const inv = db.prepare('SELECT id, status, amount, qris_amount_unique FROM invoices WHERE id=?').get(invId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

    if (!force && inv.qris_amount_unique) {
      req.session._msg = { type: 'success', text: 'Kode QRIS sudah ada untuk tagihan ini.' };
      return redirectBack(res, '/admin/billing');
    }

    const baseAmount = Number(inv.amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

    const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
    const update = db.prepare(`
      UPDATE invoices
      SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=CURRENT_TIMESTAMP
      WHERE id=?
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

    if (!chosenAmount) throw new Error('Gagal membuat nominal unik (slot 1-999 penuh).');

    update.run(chosenCode, chosenAmount, invId);
    req.session._msg = { type: 'success', text: `Kode QRIS dibuat: Rp ${Number(chosenAmount).toLocaleString('id-ID')} (kode ${chosenCode}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat kode QRIS: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Kode QRIS dihapus dari tagihan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kode QRIS: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    
    if (whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan cek status WhatsApp di menu Admin.');
    }

    const qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    const qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();

    // Hitung Tagihan
    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const requestBaseUrl = resolveRequestBaseUrl(req);
    const invoiceReminderMessage = buildBillingWhatsappMessage(customer, unpaidInvoices, inv, { baseUrl: requestBaseUrl });
    const totalTagihan = unpaidInvoices.reduce((sum, i) => sum + i.amount, 0);
    const rincianBulan = unpaidInvoices.map(i => `${i.period_month}/${i.period_year}`).join(', ');
    
    // Generate Link Login
    const loginLink = `${requestBaseUrl}/customer/login`;

    const templateQris = `Yth. *{{nama}}*,\n\nTagihan internet Anda untuk periode *{{periode}}*.\n\n📦 *Paket:* {{paket}}\n💳 *Pembayaran QRIS (Semua E-Wallet)*\n💰 *Nominal (WAJIB tepat):* Rp {{qris_nominal}}\n🏷️ *Kode:* {{qris_kode}}\n{{qris_qr}}\n\nCatatan: nominal harus sama persis agar sistem dapat mendeteksi pembayaran.\n\nTerima kasih.\nSalam,\nAdmin ${getSetting('company_header', 'ISP')}`;

    // Pesan Template (Sama dengan Broadcast Unpaid)
    const template = `Yth. *{{nama}}*,\n\nBerdasarkan data sistem kami, Anda memiliki tagihan internet yang *BELUM LUNAS*.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\nMohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih atas kerja samanya.\nSalam,\nAdmin ${getSetting('company_header', 'ISP')}`;

    const manualPaymentInfo = buildManualPaymentMessage();
    const formattedMsg = (qrisAmountUnique > 0 && qrisCode > 0)
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{periode}}/gi, `${inv.period_month}/${inv.period_year}`)
          .replace(/{{paket}}/gi, inv.package_name || '-')
          .replace(/{{qris_nominal}}/gi, Number(qrisAmountUnique).toLocaleString('id-ID'))
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, qrisQrUrl ? `🔗 QRIS: ${qrisQrUrl}` : '')
      : template
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
          .replace(/{{rincian}}/gi, rincianBulan || '-')
          .replace(/{{paket}}/gi, inv.package_name || '-')
          .replace(/{{link}}/gi, loginLink);
    let finalMessage = invoiceReminderMessage;
    if (qrisAmountUnique > 0 && qrisCode > 0) {
      const qrisLines = [
        '',
        'Pembayaran QRIS',
        `Nominal tepat: Rp ${Number(qrisAmountUnique).toLocaleString('id-ID')}`,
        `Kode unik: ${String(qrisCode).padStart(3, '0')}`
      ];
      if (qrisQrUrl) qrisLines.push(`QRIS: ${qrisQrUrl}`);
      finalMessage += `\n${qrisLines.join('\n')}`;
    }
    if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

    const sent = await sendWA(customer.phone, finalMessage);
    if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
  try {
    billingSvc.deleteInvoice(req.params.id);
    req.session._msg = { type: 'success', text: 'Tagihan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

// ─── TICKETS ───────────────────────────────────────────────────────────────
*/
registerBillingRoutes(router, {
  express,
  requireAdmin,
  requireAdminSession,
  billingSvc,
  customerSvc,
  db,
  getSetting,
  getSettings,
  company,
  flashMsg,
  buildInvoiceSummaryFromList,
  resolvePaidByName,
  sendPaidWhatsappNotification,
  buildBillingWhatsappMessage,
  buildManualPaymentMessage,
  resolveRequestBaseUrl,
  redirectBack
});
const ticketSvc = require('../services/ticketService');

router.get('/tickets', requireAdminSession, (req, res) => {
  const { status = 'all' } = req.query;
  const tickets = ticketSvc.getAllTickets(status);
  const stats = ticketSvc.getTicketStats();
  res.render('admin/tickets', {
    title: 'Keluhan Pelanggan', company: company(), activePage: 'tickets',
    tickets, stats, filterStatus: status, msg: flashMsg(req)
  });
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status } = req.body;
    const ticketId = req.params.id;
    
    ticketSvc.updateTicketStatus(ticketId, status);
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Petugas:* Admin\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await sendWA(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin Numbers
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *LAPORAN TIKET SELESAI (OLEH ADMIN)*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                if (digits.startsWith('0')) digits = '62' + digits.slice(1);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  return redirectBack(res, '/admin/tickets');
});

router.post('/tickets/:id/delete', requireAdminSession, (req, res) => {
  try {
    ticketSvc.deleteTicket(req.params.id);
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus keluhan: ' + e.message };
  }
  return redirectBack(res, '/admin/tickets');
});

// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports', requireAdminSession, (req, res) => {
  const filterYear = parseInt(req.query.year, 10) || new Date().getFullYear();
  const filterMonth = Math.max(0, Math.min(12, parseInt(req.query.month, 10) || 0));
  const now = new Date();
  const zeroOverview = {
    totalInvoices: 0,
    totalAmount: 0,
    paidCount: 0,
    paidAmount: 0,
    unpaidCount: 0,
    unpaidAmount: 0,
    ontimePaidCount: 0,
    ontimePaidAmount: 0,
    latePaidCount: 0,
    latePaidAmount: 0
  };
  const safeNumberQuery = (sql, ...params) => {
    try {
      return Number(db.prepare(sql).get(...params)?.t || 0);
    } catch (error) {
      logger.warn(`[Reports] Query gagal, pakai 0. SQL: ${sql}. Error: ${error.message}`);
      return 0;
    }
  };

  try {
    const monthlyDataRaw = billingSvc.getMonthlyRevenue(filterYear);
    const monthlyData = Array.isArray(monthlyDataRaw) ? monthlyDataRaw : [];
    const selectedMonthData = filterMonth > 0
      ? (monthlyData.find((item) => Number(item.month || 0) === filterMonth) || {
          month: filterMonth,
          total_invoices: 0,
          paid_count: 0,
          paid_amount: 0,
          unpaid_count: 0,
          unpaid_amount: 0,
          revenue: 0,
          ontime_paid_count: 0,
          ontime_paid_amount: 0,
          late_paid_count: 0,
          late_paid_amount: 0
        })
      : null;
    const recentPaymentsRaw = billingSvc.getRecentPayments(30);
    const recentPayments = (Array.isArray(recentPaymentsRaw) ? recentPaymentsRaw : []).filter((row) => {
      if (!filterMonth) return true;
      if (!row || !row.paid_at) return false;
      const paidAt = new Date(row.paid_at);
      return paidAt.getFullYear() === filterYear && (paidAt.getMonth() + 1) === filterMonth;
    }).slice(0, 10);
    const dueFocusRaw = db.prepare(`
      SELECT
        i.id,
        i.customer_id,
        i.period_month,
        i.period_year,
        i.amount,
        i.due_day_snapshot,
        c.name,
        c.phone
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'unpaid'
        AND i.period_year = ?
        AND (? = 0 OR i.period_month = ?)
      ORDER BY
        i.period_month ASC,
        COALESCE(i.due_day_snapshot, 31) ASC,
        i.amount DESC,
        c.name ASC
      LIMIT 8
    `).all(filterYear, filterMonth, filterMonth);
    const topUnpaid = (Array.isArray(dueFocusRaw) ? dueFocusRaw : []).map((row) => {
      const month = Number(row.period_month || 0);
      const year = Number(row.period_year || filterYear);
      const fallbackDay = Math.max(1, Number(row.due_day_snapshot || 1));
      const lastDay = new Date(year, Math.max(month, 1), 0).getDate() || 31;
      const day = Math.min(fallbackDay, lastDay);
      const dueDate = new Date(year, Math.max(month, 1) - 1, day, 23, 59, 59, 999);
      const diffDays = Math.ceil((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      return {
        ...row,
        due_date_iso: dueDate.toISOString(),
        days_left: diffDays
      };
    }).sort((a, b) => {
      const aRank = Number(a.days_left);
      const bRank = Number(b.days_left);
      if (aRank !== bRank) return aRank - bRank;
      return Number(b.amount || 0) - Number(a.amount || 0);
    });
    const activeCustomers = Number(customerSvc.getCustomerStats()?.active || 0);
    const collectionOverview = (filterMonth > 0 ? [selectedMonthData] : monthlyData).reduce((acc, item) => {
      acc.totalInvoices += Number(item?.total_invoices || 0);
      acc.totalAmount += Number(item?.paid_amount || 0) + Number(item?.unpaid_amount || 0);
      acc.paidCount += Number(item?.paid_count || 0);
      acc.paidAmount += Number(item?.paid_amount || 0);
      acc.unpaidCount += Number(item?.unpaid_count || 0);
      acc.unpaidAmount += Number(item?.unpaid_amount || 0);
      acc.ontimePaidCount += Number(item?.ontime_paid_count || 0);
      acc.ontimePaidAmount += Number(item?.ontime_paid_amount || 0);
      acc.latePaidCount += Number(item?.late_paid_count || 0);
      acc.latePaidAmount += Number(item?.late_paid_amount || 0);
      return acc;
    }, { ...zeroOverview });

    const yStr = String(filterYear);
    const revenueYearAll = safeNumberQuery(
      "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ?",
      yStr
    );
    const revenueYearDirect = safeNumberQuery(
      "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')",
      yStr
    );
    const revenueYearAgent = Math.max(0, revenueYearAll - revenueYearDirect);
    const agentDepositYear = safeNumberQuery(
      "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ?",
      yStr
    );

    const nowYearStr = String(now.getFullYear());
    const nowMonthStr = String(now.getMonth() + 1).padStart(2, '0');
    const revenueThisMonthAll = safeNumberQuery(
      "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ?",
      nowYearStr, nowMonthStr
    );
    const revenueThisMonthDirect = safeNumberQuery(
      "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')",
      nowYearStr, nowMonthStr
    );
    const revenueThisMonthAgent = Math.max(0, revenueThisMonthAll - revenueThisMonthDirect);
    const agentDepositThisMonth = safeNumberQuery(
      "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?",
      nowYearStr, nowMonthStr
    );

    const cashInYear = revenueYearDirect + agentDepositYear;
    const cashInThisMonth = revenueThisMonthDirect + agentDepositThisMonth;
    const pendingAmount = filterMonth > 0
      ? Number(selectedMonthData?.unpaid_amount || 0)
      : safeNumberQuery("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid'");
    const reportRevenue = filterMonth > 0 ? Number(selectedMonthData?.paid_amount || 0) : revenueYearAll;
    const reportCurrent = filterMonth > 0 ? Number(selectedMonthData?.revenue || 0) : revenueThisMonthAll;
    const reportAgentRevenue = filterMonth > 0
      ? safeNumberQuery(
          "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND paid_by_name LIKE 'Agent %'",
          String(filterYear), String(filterMonth).padStart(2, '0')
        )
      : revenueYearAgent;
    const reportAgentDeposit = filterMonth > 0
      ? safeNumberQuery(
          "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?",
          String(filterYear), String(filterMonth).padStart(2, '0')
        )
      : agentDepositYear;
    const reportCashIn = filterMonth > 0
      ? (safeNumberQuery(
          "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')",
          String(filterYear), String(filterMonth).padStart(2, '0')
        ) + reportAgentDeposit)
      : cashInYear;

    res.render('admin/reports', {
      title: 'Laporan Keuangan',
      company: company(),
      activePage: 'reports',
      filterYear,
      filterMonth,
      monthlyData,
      chartData: monthlyData,
      recentPayments,
      topUnpaid,
      totalRevenue: reportRevenue,
      thisMonth: reportCurrent,
      pendingAmount,
      activeCustomers,
      collectionOverview,
      revenueYearAgent: reportAgentRevenue,
      revenueThisMonthAgent,
      agentDepositYear: reportAgentDeposit,
      agentDepositThisMonth,
      cashInYear: reportCashIn,
      cashInThisMonth
    });
  } catch (error) {
    logger.error(`[Reports] Gagal render halaman laporan keuangan: ${error.stack || error.message}`);
    res.render('admin/reports', {
      title: 'Laporan Keuangan',
      company: company(),
      activePage: 'reports',
      filterYear,
      filterMonth,
      monthlyData: [],
      chartData: [],
      recentPayments: [],
      topUnpaid: [],
      totalRevenue: 0,
      thisMonth: 0,
      pendingAmount: 0,
      activeCustomers: 0,
      collectionOverview: { ...zeroOverview },
      revenueYearAgent: 0,
      revenueThisMonthAgent: 0,
      agentDepositYear: 0,
      agentDepositThisMonth: 0,
      cashInYear: 0,
      cashInThisMonth: 0,
      msg: { type: 'error', text: 'Data laporan belum lengkap, tapi halaman tetap ditampilkan agar bisa diakses.' }
    });
  }
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/bookkeeping', requireAdminSession, (req, res) => {
  const now = new Date();
  const filterMonth = Math.max(0, Math.min(12, parseInt(req.query.month || (now.getMonth() + 1), 10) || (now.getMonth() + 1)));
  const filterYear = parseInt(req.query.year || now.getFullYear(), 10) || now.getFullYear();
  const type = String(req.query.type || '').trim();
  const category = String(req.query.category || '').trim();
  const search = String(req.query.search || '').trim();
  const categories = bookkeepingSvc.getCategories();
  try {
    bookkeepingSvc.syncPaidInvoiceIncomeEntries();
  } catch (syncError) {
    console.warn('[BOOKKEEPING] Sync paid invoice income failed:', syncError.message);
  }
  const summary = bookkeepingSvc.getSummary({ month: filterMonth, year: filterYear });
  const entries = bookkeepingSvc.listEntries({
    type,
    category,
    search,
    month: filterMonth,
    year: filterYear,
    limit: 300
  });
  res.render('admin/bookkeeping', {
    title: 'Pembukuan',
    company: company(),
    activePage: 'bookkeeping',
    filterMonth,
    filterYear,
    type,
    category,
    search,
    categories,
    summary,
    entries,
    msg: flashMsg(req)
  });
});

router.post('/bookkeeping', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const createdByRole = req.session?.isCashier ? 'cashier' : 'admin';
    const createdByName = resolvePaidByName(req, 'Admin');
    bookkeepingSvc.createEntry({
      ...req.body,
      created_by_role: createdByRole,
      created_by_name: createdByName
    });
    req.session._msg = { type: 'success', text: 'Pembukuan berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambah pembukuan: ' + (e.message || String(e)) };
  }
  res.redirect('/admin/bookkeeping');
});

router.post('/bookkeeping/:id/delete', requireAdminSession, (req, res) => {
  try {
    bookkeepingSvc.deleteEntry(req.params.id);
    req.session._msg = { type: 'success', text: 'Data pembukuan dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus pembukuan: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/bookkeeping');
});

router.get('/settings', requireAdminSession, (req, res) => {
  const settings = getSettings();
  const stickySettings = popSettingsFormData(req);
  const activeSettingsPane = String(popSettingsActivePane(req) || '').trim();
  const mergedSettings = stickySettings ? { ...settings, ...stickySettings } : { ...settings };
  [
    'admin_username',
    'admin_password',
    'admin_api_key',
    'session_secret',
    'mikrotik_user',
    'mikrotik_password',
    'genieacs_username',
    'genieacs_password'
  ].forEach((field) => {
    const nextValue = mergedSettings[field];
    if (nextValue === undefined || nextValue === null || String(nextValue).trim() === '') {
      const fallback = settings[field];
      if (fallback !== undefined && fallback !== null && String(fallback).trim() !== '') {
        mergedSettings[field] = fallback;
      }
    }
  });
  mergedSettings.admin_username = String(mergedSettings.admin_username || settings.admin_username || req.session.adminUser || 'admin').trim();
  const baseUrl = resolveRequestBaseUrl(req, resolveAppBaseUrl());
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Pengaturan Sistem', company: company(), activePage: 'settings',
    settings: mergedSettings, msg: flashMsg(req),
    activeSettingsPane,
    runtimeWarnings: getRuntimeConfigurationWarnings(mergedSettings, process.env),
    selfUpdateEnabled: isSelfUpdateEnabled(mergedSettings, process.env),
    digiflazzWebhookUrl,
    paymentWebhookUrl
  });
});

router.get('/digiflazz', requireAdminSession, restrictToAdmin, async (req, res) => {
  const settings = getSettings();
  const baseUrl = resolveRequestBaseUrl(req, resolveAppBaseUrl());
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  let digi = { configured: digiflazzConfigured(), deposit: null, error: null };
  if (digi.configured) {
    try {
      const data = await digiflazzCekSaldo();
      digi.deposit = Number(data?.deposit || 0);
    } catch (e) {
      digi.error = String(e?.message || e || '');
    }
  }

  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push('(sku LIKE ? OR product_name LIKE ? OR brand LIKE ? OR category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status === 'active') where.push('status = 1');
  if (status === 'inactive') where.push('status = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const products = db.prepare(`SELECT * FROM digiflazz_products ${whereSql} ORDER BY category, brand, price_sell LIMIT 300`).all(...params);
  const categories = db.prepare("SELECT category FROM digiflazz_products WHERE category IS NOT NULL AND TRIM(category)<>'' GROUP BY category ORDER BY category").all().map(r => r.category);
  const stats = db.prepare('SELECT COUNT(1) AS total, SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status=0 THEN 1 ELSE 0 END) AS inactive FROM digiflazz_products').get();
  const lastSync = db.prepare('SELECT * FROM digiflazz_sync_logs ORDER BY id DESC LIMIT 1').get();
  const webhookLogs = db.prepare(
    `
    SELECT id, created_at, ref_id, status, signature_ok, matched_agent_tx_id, ip
    FROM digiflazz_webhook_logs
    ORDER BY id DESC
    LIMIT 80
  `
  ).all();

  const recentPulsaTx = db.prepare(
    `
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.type = 'pulsa'
    ORDER BY t.id DESC
    LIMIT 60
  `
  ).all();

  res.render('admin/digiflazz', {
    title: 'Digiflazz',
    company: company(),
    activePage: 'digiflazz',
    msg: flashMsg(req),
    settings,
    digi,
    digiflazzWebhookUrl,
    q,
    category,
    status,
    products,
    categories,
    stats,
    lastSync,
    recentPulsaTx,
    webhookLogs
  });
});

router.post('/digiflazz/check-balance', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const data = await digiflazzCekSaldo();
    const depo = Number(data?.deposit || 0);
    req.session._msg = { type: 'success', text: `Saldo Digiflazz: Rp ${depo.toLocaleString('id-ID')}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek saldo Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/sync-products', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const markup = Math.max(0, Math.floor(Number(getSetting('digiflazz_markup', 0) || 0)));
    const list = await digiflazzPriceListAll();

    const selectOne = db.prepare('SELECT sku, product_name, category, brand, price_modal, price_sell, status FROM digiflazz_products WHERE sku = ?');
    const upsert = db.prepare(
      `
      INSERT INTO digiflazz_products (sku, product_name, category, brand, price_modal, price_sell, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sku) DO UPDATE SET
        product_name=excluded.product_name,
        category=excluded.category,
        brand=excluded.brand,
        price_modal=excluded.price_modal,
        price_sell=excluded.price_sell,
        status=excluded.status,
        updated_at=CURRENT_TIMESTAMP
    `
    );

    const run = db.transaction(() => {
      const summary = { total: 0, inserted: 0, updated: 0, active: 0, inactive: 0, skippedNoPrice: 0 };
      for (const p of list) {
        summary.total++;
        const sku = String(p?.buyer_sku_code || '').trim();
        if (!sku) continue;

        const priceModal = Number(p?.price ?? p?.buyer_price ?? 0) || 0;
        if (priceModal <= 0) {
          summary.skippedNoPrice++;
          continue;
        }

        const status = p?.buyer_product_status ? 1 : 0;
        if (status === 1) summary.active++;
        else summary.inactive++;

        const existing = selectOne.get(sku);
        const name = String(p?.product_name || sku).trim();
        const cat = String(p?.category || '').trim();
        const brand = String(p?.brand || '').trim();
        const priceSell = Math.floor(priceModal + markup);

        if (!existing) summary.inserted++;
        else {
          const changed =
            String(existing.product_name || '') !== name ||
            String(existing.category || '') !== cat ||
            String(existing.brand || '') !== brand ||
            Number(existing.price_modal || 0) !== Math.floor(priceModal) ||
            Number(existing.price_sell || 0) !== priceSell ||
            Number(existing.status || 0) !== status;
          if (changed) summary.updated++;
        }

        upsert.run(sku, name, cat, brand, Math.floor(priceModal), priceSell, status);
      }

      db.prepare(
        'INSERT INTO digiflazz_sync_logs (total, inserted, updated, active, inactive) VALUES (?, ?, ?, ?, ?)'
      ).run(summary.total, summary.inserted, summary.updated, summary.active, summary.inactive);

      return summary;
    });

    const s = run();
    req.session._msg = { type: 'success', text: `Sync Digiflazz OK | Total: ${s.total} | Baru: ${s.inserted} | Update: ${s.updated} | Aktif: ${s.active} | Nonaktif: ${s.inactive} | SkipNoPrice: ${s.skippedNoPrice}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal sync produk Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/products/update-price', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const priceSell = Math.max(0, Math.floor(Number(req.body.price_sell || 0) || 0));
    if (!sku) throw new Error('SKU wajib');
    const info = db.prepare('UPDATE digiflazz_products SET price_sell=?, updated_at=CURRENT_TIMESTAMP WHERE sku=?').run(priceSell, sku);
    if (info.changes === 0) throw new Error('SKU tidak ditemukan');
    req.session._msg = { type: 'success', text: `Harga jual diperbarui: ${sku}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update harga: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.get('/update', requireAdminSession, restrictToAdmin, (req, res) => {
  const settings = getSettings();
  if (!isSelfUpdateEnabled(settings, process.env)) {
    req.session._msg = { type: 'error', text: 'Fitur update internal dinonaktifkan pada mode produksi demi keamanan.' };
    return res.redirect('/admin/settings');
  }
  const repoRoot = path.resolve(__dirname, '..');
  const info = getUpdateInfo(repoRoot);
  res.render('admin/update', {
    title: 'Update Aplikasi',
    company: company(),
    activePage: 'update',
    msg: flashMsg(req),
    log: popUpdateLog(req),
    info
  });
});

router.post('/update/run', requireAdminSession, restrictToAdmin, (req, res) => {
  const settings = getSettings();
  if (!isSelfUpdateEnabled(settings, process.env)) {
    req.session._msg = { type: 'error', text: 'Fitur update internal dinonaktifkan pada mode produksi demi keamanan.' };
    return res.redirect('/admin/settings');
  }
  const repoRoot = path.resolve(__dirname, '..');
  const log = [];
  const pushCmd = (label, r) => {
    log.push(`$ ${label}`.trim());
    if (r.stdout) log.push(String(r.stdout).trimEnd());
    if (r.stderr) log.push(String(r.stderr).trimEnd());
  };

  const versionPath = path.join(repoRoot, 'version.txt');
  const localBefore = readTextFileSafe(versionPath) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const backupRoot = path.join(os.tmpdir(), `billing-update-backup-${Date.now()}`);
  const backupSettings = path.join(backupRoot, 'settings.json');
  const backupDb = path.join(backupRoot, 'database');
  const backupAuth = path.join(backupRoot, 'auth_info_baileys');
  const backupLogs = path.join(backupRoot, 'logs');
  const backupUploads = path.join(backupRoot, 'uploads');
  const settingsPath = path.join(repoRoot, 'settings.json');
  const dbDir = path.join(repoRoot, 'database');
  const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys');
  const authPath = path.join(repoRoot, authFolder);
  const logsPath = path.join(repoRoot, 'logs');
  const uploadsPath = path.join(repoRoot, 'public', 'uploads');

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Folder ini belum menjadi git repository.');

    const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Gagal git fetch.');

    const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    if (!remote.ok) throw new Error('Tidak bisa membaca version.txt dari GitHub.');
    const remoteVersion = String(remote.stdout || '').trim() || '-';

    if (remoteVersion !== '-' && remoteVersion === localBefore) {
      req.session._msg = { type: 'success', text: 'Versi sudah terbaru: ' + localBefore };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/settings');
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backupSettings);
    if (fs.existsSync(dbDir)) copyDirSync(dbDir, backupDb);
    if (fs.existsSync(authPath)) copyDirSync(authPath, backupAuth);
    if (fs.existsSync(logsPath)) copyDirSync(logsPath, backupLogs);
    if (fs.existsSync(uploadsPath)) copyDirSync(uploadsPath, backupUploads);

    const switchLocal = runCmd('git', ['switch', branch], repoRoot);
    pushCmd(`git switch ${branch}`, switchLocal);
    if (!switchLocal.ok) {
      const switchTrack = runCmd('git', ['switch', '--track', `origin/${branch}`], repoRoot);
      pushCmd(`git switch --track origin/${branch}`, switchTrack);
      if (!switchTrack.ok) throw new Error(`Gagal pindah ke branch ${branch}. Pastikan worktree bersih sebelum update.`);
    }

    const pull = runCmd('git', ['pull', '--ff-only', 'origin', branch], repoRoot);
    pushCmd(`git pull --ff-only origin ${branch}`, pull);
    if (!pull.ok) throw new Error('Gagal mengambil update terbaru secara fast-forward.');

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    const clean = runCmd(
      'git',
      [
        'clean',
        '-fd',
        '-e', 'settings.json',
        '-e', 'database',
        '-e', 'node_modules',
        '-e', authFolder,
        '-e', 'data',
        '-e', 'logs',
        '-e', 'public/uploads',
        '-e', 'backups'
      ],
      repoRoot
    );
    pushCmd(`git clean -fd -e settings.json -e database -e node_modules -e ${authFolder} -e data -e logs -e public/uploads -e backups`, clean);

    if (fs.existsSync(backupSettings)) fs.copyFileSync(backupSettings, settingsPath);
    if (fs.existsSync(backupDb)) {
      fs.mkdirSync(dbDir, { recursive: true });
      copyDirSync(backupDb, dbDir);
    }
    if (fs.existsSync(backupAuth)) {
      fs.mkdirSync(authPath, { recursive: true });
      copyDirSync(backupAuth, authPath);
    }
    if (fs.existsSync(backupLogs)) {
      fs.mkdirSync(logsPath, { recursive: true });
      copyDirSync(backupLogs, logsPath);
    }
    if (fs.existsSync(backupUploads)) {
      fs.mkdirSync(uploadsPath, { recursive: true });
      copyDirSync(backupUploads, uploadsPath);
    }

    const npm = runCmd('npm', ['install'], repoRoot);
    pushCmd('npm install', npm);
    if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');

    const localAfter = readTextFileSafe(versionPath) || '-';
    req.session._msg = { type: 'success', text: `Update selesai. Versi: ${localBefore} → ${localAfter}. Database, settings, auth WhatsApp, log, dan upload tetap aman.` };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update: ' + (e?.message || e) };
    req.session._updateLog = log.join('\n');
  } finally {
    try {
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.redirect('/admin/update');
});

router.post('/api/telegram/sync', requireAdminSession, async (req, res) => {
  try {
    const { initTelegram } = require('../services/telegramBot');
    initTelegram();
    res.json({ success: true, message: 'Bot Telegram berhasil disinkronkan.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', requireAdminSession, upload.fields(IMAGE_UPLOAD_FIELDS.map((name) => ({ name, maxCount: 1 }))), (req, res) => {
  const currentSettings = getSettings();
  const settingsSection = String(req.body.settings_section || 'usaha').trim() || 'usaha';
  const settingsFieldGroups = {
    usaha: [
      'company_header',
      'footer_info',
      'company_legal_name',
      'upstream_provider_name',
      'support_by_enabled',
      'support_isp_logo_url',
      'company_manager',
      'invoice_signer_title',
      'company_phone',
      'company_email',
      'company_address',
      'public_base_url',
      'manual_payment_bank',
      'manual_payment_account_number',
      'manual_payment_account_name',
      'manual_payment_notes',
      'office_lat',
      'office_lng',
      'operational_hours',
      'server_port',
      'login_otp_enabled'
    ],
    payment: [
      'default_gateway',
      'qris_static_qr_url',
      'qris_static_payload',
      'payment_notif_secret',
      'tripay_enabled',
      'tripay_api_key',
      'tripay_private_key',
      'tripay_merchant_code',
      'tripay_mode',
      'midtrans_enabled',
      'midtrans_server_key',
      'midtrans_mode',
      'xendit_enabled',
      'xendit_api_key',
      'xendit_callback_token',
      'duitku_enabled',
      'duitku_merchant_code',
      'duitku_api_key',
      'duitku_mode'
    ],
    akun: [
      'admin_username',
      'admin_password',
      'admin_api_key',
      'session_secret'
    ],
    integrasi: [
      'genieacs_url',
      'genieacs_username',
      'genieacs_password',
      'mikrotik_host',
      'mikrotik_port',
      'mikrotik_user',
      'mikrotik_password',
      'digiflazz_username',
      'digiflazz_api_key',
      'digiflazz_webhook_secret',
      'digiflazz_webhook_id',
      'digiflazz_markup'
    ],
    whatsapp: [
      'whatsapp_enabled',
      'whatsapp_admin_numbers',
      'whatsapp_group_invite_link',
      'whatsapp_broadcast_delay',
      'whatsapp_welcome_message',
      'whatsapp_due_reminder_message',
      'whatsapp_billing_message',
      'whatsapp_isolation_message',
      'whatsapp_reactivation_message',
      'whatsapp_paid_message',
      'whatsapp_auto_billing_enabled',
      'customer_isolation_notice'
    ],
    telegram: [
      'telegram_enabled',
      'telegram_admin_id',
      'telegram_bot_token'
    ],
    monitoring: []
  };
  const selectedFields = settingsFieldGroups[settingsSection] || [];
  const submittedSettings = {};
  selectedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      submittedSettings[field] = req.body[field];
    }
  });
  let newSettings = { ...currentSettings, ...submittedSettings };
  const finishSettingsRedirect = () => req.session.save(() => res.redirect(`/admin/settings#settings-${settingsSection}`));
  try {
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.xendit_enabled === 'true') newSettings.xendit_enabled = true;
    else if (newSettings.xendit_enabled === 'false') newSettings.xendit_enabled = false;

    if (newSettings.duitku_enabled === 'true') newSettings.duitku_enabled = true;
    else if (newSettings.duitku_enabled === 'false') newSettings.duitku_enabled = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = normalizePhoneList(newSettings.whatsapp_admin_numbers);
    } else if (Array.isArray(newSettings.whatsapp_admin_numbers)) {
      newSettings.whatsapp_admin_numbers = normalizePhoneList(newSettings.whatsapp_admin_numbers);
    }
    if (newSettings.server_port !== undefined && newSettings.server_port !== '') newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port !== undefined && newSettings.mikrotik_port !== '') newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay !== undefined && newSettings.whatsapp_broadcast_delay !== '') newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    if (newSettings.digiflazz_markup !== undefined && newSettings.digiflazz_markup !== '') newSettings.digiflazz_markup = parseInt(newSettings.digiflazz_markup) || 0;

    [
      'company_header',
      'company_legal_name',
      'upstream_provider_name',
      'support_isp_logo_url',
      'company_logo_url',
      'invoice_signature_url',
      'invoice_stamp_url',
      'footer_info',
      'company_manager',
      'invoice_signer_title',
      'company_phone',
      'company_email',
      'company_address',
      'operational_hours',
      'manual_payment_bank',
      'manual_payment_account_name',
      'manual_payment_account_number',
      'manual_payment_notes',
      'qris_static_qr_url',
      'qris_static_payload',
      'payment_notif_secret',
      'genieacs_url',
      'genieacs_username',
      'genieacs_password',
      'mikrotik_host',
      'mikrotik_user',
      'mikrotik_password',
      'digiflazz_username',
      'digiflazz_api_key',
      'digiflazz_webhook_secret',
      'digiflazz_webhook_id',
      'admin_username',
      'admin_password',
      'admin_api_key',
      'session_secret',
      'xendit_callback_token',
      'whatsapp_billing_message',
      'whatsapp_isolation_message',
      'customer_isolation_notice'
    ].forEach((field) => {
      if (field in newSettings) newSettings[field] = String(newSettings[field] || '').trim();
    });

    if ('company_phone' in newSettings) {
      newSettings.company_phone = normalizePhoneDigits(newSettings.company_phone || '');
    }

    const uploadedLogo = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'company_logo_file') : null;
    if (uploadedLogo) {
      const previousLogo = String(getSetting('company_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousLogo, /^\/uploads\/company-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.company_logo_url = persistUploadedImageSetting(uploadedLogo, 'company-logo');
    } else if (settingsSection === 'usaha' && !newSettings.company_logo_url) {
      newSettings.company_logo_url = String(getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim();
    }

    const uploadedSupportLogo = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'support_isp_logo_file') : null;
    if (uploadedSupportLogo) {
      const previousSupportLogo = String(getSetting('support_isp_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousSupportLogo, /^\/uploads\/support-isp-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.support_isp_logo_url = persistUploadedImageSetting(uploadedSupportLogo, 'support-isp-logo');
    } else {
      newSettings.support_isp_logo_url = String(newSettings.support_isp_logo_url || currentSettings.support_isp_logo_url || '').trim();
    }

    const uploadedSignature = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'invoice_signature_file') : null;
    if (uploadedSignature) {
      const previousSignature = String(getSetting('invoice_signature_url', '') || '').trim();
      safeRemoveUploadAsset(previousSignature, /^\/uploads\/invoice-signature-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_signature_url = persistUploadedImageSetting(uploadedSignature, 'invoice-signature');
    } else {
      newSettings.invoice_signature_url = String(newSettings.invoice_signature_url || currentSettings.invoice_signature_url || '').trim();
    }

    const uploadedStamp = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'invoice_stamp_file') : null;
    if (uploadedStamp) {
      const previousStamp = String(getSetting('invoice_stamp_url', '') || '').trim();
      safeRemoveUploadAsset(previousStamp, /^\/uploads\/invoice-stamp-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_stamp_url = persistUploadedImageSetting(uploadedStamp, 'invoice-stamp');
    } else {
      newSettings.invoice_stamp_url = String(newSettings.invoice_stamp_url || currentSettings.invoice_stamp_url || '').trim();
    }

    if (settingsSection === 'payment') {
      const previousQrisStaticQr = String(getSetting('qris_static_qr_url', '') || '').trim();
      const submittedQrisStaticQr = Object.prototype.hasOwnProperty.call(submittedSettings, 'qris_static_qr_url')
        ? String(submittedSettings.qris_static_qr_url || '').trim()
        : previousQrisStaticQr;
      const uploadedQrisStaticQr = getUploadedSingleFile(req, 'qris_static_qr_file');
      if (uploadedQrisStaticQr) {
        safeRemoveUploadAsset(previousQrisStaticQr, /^\/uploads\/qris-static-\d+\.(png|jpg|jpeg|webp|svg)$/i);
        newSettings.qris_static_qr_url = persistUploadedImageSetting(uploadedQrisStaticQr, 'qris-static');
      } else {
        if (previousQrisStaticQr && previousQrisStaticQr !== submittedQrisStaticQr) {
          safeRemoveUploadAsset(previousQrisStaticQr, /^\/uploads\/qris-static-\d+\.(png|jpg|jpeg|webp|svg)$/i);
        }
        newSettings.qris_static_qr_url = submittedQrisStaticQr;
      }
    }

    newSettings.admin_username = String(newSettings.admin_username || currentSettings.admin_username || req.session.adminUser || 'admin').trim();
    newSettings.admin_password = String(newSettings.admin_password || currentSettings.admin_password || '').trim();
    newSettings.admin_api_key = String(newSettings.admin_api_key || currentSettings.admin_api_key || '').trim();
    newSettings.session_secret = String(newSettings.session_secret || currentSettings.session_secret || '').trim();
    newSettings.xendit_callback_token = String(newSettings.xendit_callback_token || currentSettings.xendit_callback_token || '').trim();
    newSettings.mikrotik_user = String(newSettings.mikrotik_user || currentSettings.mikrotik_user || '').trim();
    newSettings.mikrotik_password = String(newSettings.mikrotik_password || currentSettings.mikrotik_password || '').trim();
    newSettings.genieacs_username = String(newSettings.genieacs_username || currentSettings.genieacs_username || '').trim();
    newSettings.genieacs_password = String(newSettings.genieacs_password || currentSettings.genieacs_password || '').trim();
    newSettings.invoice_signer_title = String(newSettings.invoice_signer_title || currentSettings.invoice_signer_title || 'Finance').trim();
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');
    newSettings.telegram_enabled = (newSettings.telegram_enabled === 'true');
    newSettings.auto_backup_enabled = (newSettings.auto_backup_enabled === 'true');
    newSettings.support_by_enabled = (
      newSettings.support_by_enabled === 'true' ||
      newSettings.support_by_enabled === true ||
      newSettings.support_by_enabled === '1' ||
      newSettings.support_by_enabled === 1 ||
      newSettings.support_by_enabled === 'on'
    );

    if (settingsSection === 'akun') {
      if (!newSettings.admin_username) throw new Error('Username admin wajib diisi.');
      if (!isStrongAdminPassword(newSettings.admin_password)) throw new Error('Password admin minimal 12 karakter dan tidak boleh memakai nilai default.');
      if (!isStrongSessionSecret(newSettings.session_secret)) throw new Error('Session secret minimal 32 karakter dan tidak boleh memakai nilai default.');
      if (newSettings.admin_api_key && !isStrongAdminApiKey(newSettings.admin_api_key)) throw new Error('Admin API key minimal 24 karakter dan tidak boleh memakai nilai default.');
    }
    if (settingsSection === 'payment' && newSettings.xendit_enabled && !isStrongXenditCallbackToken(newSettings.xendit_callback_token)) {
      throw new Error('Xendit callback token wajib diisi minimal 16 karakter saat Xendit diaktifkan.');
    }

    const success = saveSettings(newSettings);
    if (success) {
      delete req.session._settingsFormData;
      req.session._settingsActivePane = settingsSection;
      // Re-init services if needed
      if (newSettings.telegram_enabled) {
        require('../services/telegramBot').initTelegram();
      } else {
        require('../services/telegramBot').initTelegram(); // This will stop it if it was running
      }
      req.session._msg = { type: 'success', text: 'Pengaturan berhasil disimpan.' };
    } else {
      req.session._settingsFormData = { ...newSettings };
      req.session._settingsActivePane = settingsSection;
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan' };
    }
  } catch (e) {
    req.session._settingsFormData = { ...newSettings };
    req.session._settingsActivePane = settingsSection;
    const hasUploadedFile = Boolean(
      (req.file && req.file.size) ||
      (req.files && Object.values(req.files).some((bucket) => Array.isArray(bucket) && bucket.some((item) => item && item.size)))
    );
    const extraLogoNote = hasUploadedFile ? ' Pilih ulang file upload jika masih ingin menggantinya.' : '';
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message + extraLogoNote };
  }
  return finishSettingsRedirect();
});

// ─── BACKUP & RECOVERY ──────────────────────────────────────────────────────
router.get('/backup', requireAdminSession, (req, res) => {
  const result = backupSvc.listBackups();
  res.render('admin/backup', {
    title: 'Backup & Recovery',
    company: company(),
    activePage: 'backup',
    msg: flashMsg(req),
    backups: result.backups || [],
    total: result.total || 0,
    getSetting
  });
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = backupSvc.backupAll();
    } else if (type === 'database') {
      result = backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipe backup tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Backup berhasil dibuat: ${result.fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal backup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipe restore tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Restore berhasil: ${fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    const backupFilePath = path.join(backupDir, fileName);

    if (!fs.existsSync(backupFilePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan' };
      return res.redirect('/admin/backup');
    }

    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${fileName}`);
    req.session._msg = { type: 'success', text: `Backup berhasil dihapus: ${fileName}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal menghapus: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/cleanup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { retentionDays } = req.body;
    const result = backupSvc.cleanupOldBackups(parseInt(retentionDays) || 30);

    if (result.success) {
      req.session._msg = { type: 'success', text: `Cleanup selesai: ${result.deletedCount} backup lama dihapus` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal cleanup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

// ─── INVENTORY / WAREHOUSE ──────────────────────────────────────────────────
router.get('/inventory', requireAdminSession, (req, res) => {
  const items = inventorySvc.getAllItems(req.query.q);
  const categories = inventorySvc.getAllCategories();
  const logs = inventorySvc.getInventoryLogs(100);

  res.render('admin/inventory', {
    title: 'Manajemen Inventaris',
    company: company(),
    activePage: 'inventory',
    msg: flashMsg(req),
    items,
    categories,
    logs
  });
});

router.post('/inventory/category/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createCategory(req.body);
    req.session._msg = { type: 'success', text: 'Kategori berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/category/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteCategory(req.params.id);
    req.session._msg = { type: 'success', text: 'Kategori berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createItem(req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateItem(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/stock/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.addStock(req.body, req.session.adminUser || 'Admin');
    req.session._msg = { type: 'success', text: 'Stok berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.get('/audit-logs', requireAdminSession, restrictToAdmin, (req, res) => {
  const filters = {
    action: req.query.action || null,
    entity_type: req.query.entity_type || null,
    limit: 100
  };
  const logs = auditSvc.getAuditTrail(filters);
  const stats = auditSvc.getAuditStats();

  res.render('admin/audit_logs', {
    title: 'Audit Trail / Log Aktivitas',
    company: company(),
    activePage: 'audit_logs',
    logs,
    stats,
    filters
  });
});

// ─── MONITORING ──────────────────────────────────────────────────────────────
router.get('/monitoring', requireAdminSession, restrictToAdmin, async (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  const performanceSummary = monitoringSvc.getPerformanceSummary();
  const dependencies = await diagnosticsSvc.checkDependencies();
  const recentErrors = diagnosticsSvc.getRecentErrors(10);

  res.render('admin/monitoring', {
      title: 'Monitoring Sistem',
      company: company(),
      activePage: 'monitoring',
      healthStatus,
      performanceSummary,
      dependencies,
      recentErrors
    });
});

router.get('/api/health', requireAdmin, (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  res.json(healthStatus);
});

router.get('/api/metrics', requireAdmin, (req, res) => {
  const metrics = monitoringSvc.getAllMetrics();
  res.json(metrics);
});

router.get('/api/metrics/history', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = monitoringSvc.getMetricsHistory(limit);
  res.json(history);
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;
    const now = Date.now();
    devices.forEach(d => {
      if (d._lastInform && (now - new Date(d._lastInform).getTime()) < 15 * 60 * 1000) online++;
      else offline++;
    });
    res.json({ total, online, offline, warning: 0, lastUpdate: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 100, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    let devices = result.devices.map(d => {
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id);
      return {
        id: d._id, tags: d._tags || [],
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s) || matchingTags.has(t.toLowerCase())) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeIP && d.pppoeIP.toLowerCase().includes(s)) ||
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.pppoeUsername && matchingPppoes.has(d.pppoeUsername.toLowerCase()))
      ); 
    }
    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    const total = devices.length;
    const paginated = devices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devices: paginated, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get devices', detail: e.message });
  }
});

router.get('/api/device/:tag', requireAdmin, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireAdmin, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireAdmin, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

router.post('/api/bulk/ssid', requireAdmin, express.json(), async (req, res) => {
  const { tags, ssid } = req.body;
  if (!Array.isArray(tags) || !ssid) return res.status(400).json({ error: 'Tags and SSID required' });
  const results = [];
  for (const tag of tags) {
    try { results.push({ tag, success: await customerDevice.updateSSID(tag, ssid) }); }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});


router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik', 
    routers, msg: flashMsg(req)
  });
});

router.get('/vouchers', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  res.render('admin/vouchers', {
    title: 'Manajemen Voucher', company: company(), activePage: 'mikrotik',
    routers, msg: flashMsg(req), settings: getSettings()
  });
});

router.get('/api/vouchers/template', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.json({
    use_template: !!settings.voucher_print_use_template,
    default_style: String(settings.voucher_print_default_style || ''),
    header: String(settings.voucher_print_template_header || ''),
    row: String(settings.voucher_print_template_row || ''),
    footer: String(settings.voucher_print_template_footer || '')
  });
});

router.post('/api/vouchers/template', requireAdminSession, restrictToAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const useTemplate = !!req.body.use_template;
    const defaultStyle = String(req.body.default_style || '').trim().toLowerCase();
    const header = String(req.body.header || '');
    const row = String(req.body.row || '');
    const footer = String(req.body.footer || '');
    saveSettings({
      voucher_print_use_template: useTemplate,
      voucher_print_default_style: defaultStyle,
      voucher_print_template_header: header,
      voucher_print_template_row: row,
      voucher_print_template_footer: footer
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/webhook/payment-notif/logs', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const service = String(req.query.service || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (service) {
      where.push('service = ?');
      params.push(service);
    }
    if (q) {
      where.push('(content LIKE ? OR service LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT id, created_at, service, content, parsed_amount, parsed_ok, matched_invoice_id, ip
      FROM webhook_payment_notifs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhook/payment-notif/clear', requireAdminSession, restrictToAdmin, express.json(), (req, res) => {
  try {
    db.prepare('DELETE FROM webhook_payment_notifs').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vouchers/batches/:id/print', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const settings = getSettings();
  const requestedStyle = String(req.query.style || '').trim().toLowerCase();
  const style = requestedStyle || String(settings.voucher_print_default_style || '').trim().toLowerCase() || (settings.voucher_print_use_template ? 'template' : 'cards');

  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripUnsafe = (html) => {
    let out = String(html || '');
    out = out.replace(/<\?(?:php)?[\s\S]*?\?>/gi, '');
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    return out;
  };

  const applyVars = (tpl, vars) => {
    let out = String(tpl || '');
    out = out.replace(/%([a-zA-Z0-9_#]+)%/g, (m, k) => (vars[k] != null ? vars[k] : m));
    out = out.replace(/\{\{\s*([a-zA-Z0-9_#]+)\s*\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  };

  const formatValidity = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return `${Number(mDay[1])} hari`;
    return s;
  };

  let renderedHtml = '';
  let templateError = '';
  const builtinTemplate = (name) => {
    const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
      ? ('+' + String(settings.whatsapp_admin_numbers[0]))
      : String(settings.company_phone || '');
    const companyName = settings.company_header || company();
    const timeStamp = new Date().toISOString();
    const priceNumber = Number(batch.price || 0);
    const priceText = priceNumber.toLocaleString('id-ID');
    const validityText = formatValidity(batch.validity);

    const rows = (vouchers || []).map((v, i) => {
      const credential = (String(v.code) === String(v.password))
        ? escapeHtml(String(v.code))
        : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
      return {
        idx: i + 1,
        username: escapeHtml(v.code),
        password: escapeHtml(v.password),
        credential,
        profile: escapeHtml(batch.profile_name || v.profile_name || ''),
        company: escapeHtml(companyName),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        price: escapeHtml(String(priceNumber)),
        priceText: escapeHtml(priceText),
        validity: escapeHtml(batch.validity || ''),
        validityText: escapeHtml(validityText),
      };
    });

    if (name === 'mks') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.v-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.vc{border:1px solid #0f172a;border-radius:10px;min-height:110px;padding:8px;position:relative;break-inside:avoid;overflow:hidden}
.vc:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(59,130,246,.03),rgba(16,185,129,.025))}
.vc>*{position:relative}
.vh{font-weight:900;font-size:11px;letter-spacing:.2px}
.vp{position:absolute;top:8px;right:8px;font-size:10.5px;font-weight:800;background:rgba(16,185,129,.16);border:1px solid rgba(16,185,129,.35);padding:2px 7px;border-radius:999px}
.vm{font-size:10px;color:#334155;margin-top:6px}
.vu{font-weight:950;font-size:18px;letter-spacing:1px;margin-top:8px;font-family:Consolas,monospace;line-height:1.15}
.vf{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="vc">
  <div class="vh">${r.company}</div>
  <div class="vp">${r.currency} ${r.priceText}</div>
  <div class="vm">${r.profile} • ${r.validityText}</div>
  <div class="vu">${r.credential}</div>
  <div class="vf">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="v-grid">\n${html}\n</div>`;
    }

    if (name === 'simple') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{border:1.5px solid #334155;border-radius:10px;padding:8px 8px 22px;min-height:110px;position:relative;break-inside:avoid}
.hd{font-weight:800;font-size:11px}
.code{font-weight:900;font-size:22px;letter-spacing:2px;margin-top:6px;font-family:Consolas,monospace}
.meta{font-size:10px;color:#334155;margin-top:4px}
.wa{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="card">
  <div class="hd">${r.company}</div>
  <div class="meta">${r.profile} • ${r.validityText} • ${r.currency} ${r.priceText}</div>
  <div class="code">${r.username}</div>
  <div class="meta">${r.password}</div>
  <div class="wa">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="grid">\n${html}\n</div>`;
    }

    if (name === 'minimal') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.c{border:1px dashed #334155;border-radius:8px;padding:6px 6px 18px;min-height:84px;position:relative;break-inside:avoid}
.t{font-weight:900;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{font-size:9.5px;color:#334155;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{font-weight:950;font-size:18px;letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace}
.w{position:absolute;left:6px;right:6px;bottom:5px;font-size:9px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
      const html = rows.map(r => `<div class="c">
  <div class="t">${r.company}</div>
  <div class="m">${r.profile}</div>
  <div class="k">${r.username}</div>
  <div class="w">${r.validityText} • ${r.currency} ${r.priceText} • ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="g">\n${html}\n</div>`;
    }

    return '';
  };

  if (style === 'mks' || style === 'simple' || style === 'minimal') {
    renderedHtml = builtinTemplate(style);
  } else if (style === 'template') {
    const headerTpl = String(settings.voucher_print_template_header || '');
    const rowTpl = String(settings.voucher_print_template_row || '');
    const footerTpl = String(settings.voucher_print_template_footer || '');

    if (rowTpl.trim()) {
      const looksLikePhpOnly = (tpl) => {
        const s = String(tpl || '');
        const hasHtml = /<\s*[a-zA-Z][^>]*>/.test(s);
        const phpSignals = /(\$[a-zA-Z_])|(\bif\s*\()|(\bsubstr\s*\()|(\bstrlen\s*\()|(\belse(if)?\b)|(\bforeach\b)/.test(s);
        const manyPhp = (s.match(/\$/g) || []).length >= 3;
        return !hasHtml && (phpSignals || manyPhp);
      };
      const combined = `${headerTpl}\n${rowTpl}\n${footerTpl}`;
      if (/<\?(?:php)?/i.test(combined) || looksLikePhpOnly(combined)) {
        templateError = 'Template yang dipaste masih format PHP (Mikhmon). Di sini hanya mendukung template HTML + placeholder (%username% dll).';
      }

      const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
        ? ('+' + String(settings.whatsapp_admin_numbers[0]))
        : String(settings.company_phone || '');
      const timeStamp = new Date().toISOString();
      const priceNumber = Number(batch.price || 0);
      const priceText = priceNumber.toLocaleString('id-ID');
      const validityText = formatValidity(batch.validity);

      const parts = [];
      parts.push(stripUnsafe(applyVars(headerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      vouchers.forEach((v, i) => {
        const credential = (String(v.code) === String(v.password))
          ? escapeHtml(String(v.code))
          : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
        const vars = {
          username: escapeHtml(v.code),
          password: escapeHtml(v.password),
          profile: escapeHtml(batch.profile_name || v.profile_name || ''),
          validity: escapeHtml(batch.validity || ''),
          validityText: escapeHtml(validityText),
          price: escapeHtml(String(priceNumber)),
          priceText: escapeHtml(priceText),
          currency: 'Rp',
          company: escapeHtml(settings.company_header || company()),
          phone: escapeHtml(phone),
          timeStamp: escapeHtml(timeStamp),
          '#': escapeHtml(String(i + 1)),
          credential
        };
        parts.push(stripUnsafe(applyVars(rowTpl, vars)));
      });

      parts.push(stripUnsafe(applyVars(footerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      renderedHtml = parts.join('\n');
    }
  }

  let finalStyle = style;
  if (finalStyle === 'template') {
    const s = String(renderedHtml || '').trim();
    if (!s || !/<\s*[a-zA-Z][^>]*>/.test(s) || templateError) {
      renderedHtml = '';
      finalStyle = 'cards';
    }
  }

  res.render('admin/print_vouchers', {
    title: 'Cetak Voucher',
    company: company(),
    settings,
    batch,
    vouchers,
    style: finalStyle,
    renderedHtml,
    templateError
  });
});

router.get('/vouchers/batches/:id/export.csv', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const lines = [];
  lines.push(['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at', 'used_at'].join(','));
  const createdAt = batch.created_at || '';
  const validity = batch.validity || '';
  const price = Number(batch.price || 0);
  const routerName = batch.router_name || '';
  for (const v of vouchers) {
    const row = [
      v.code,
      v.password,
      v.profile_name,
      validity,
      price,
      routerName,
      batchId,
      createdAt,
      v.used_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=vouchers_batch_${batchId}.csv`);
  res.send(lines.join('\n'));
});

router.get('/api/vouchers/batches', requireAdmin, (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const rows = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE (? IS NULL OR b.router_id = ?)
    ORDER BY b.id DESC
    LIMIT 200
  `).all(routerId, routerId);
  res.json(rows);
});

router.get('/api/vouchers/batches/:id', requireAdmin, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, status, used_at, last_seen_comment, last_seen_uptime, last_seen_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
    LIMIT 2000
  `).all(batchId);
  res.json({ batch, vouchers });
});

router.post('/api/vouchers/batches', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(5000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const priceInput = req.body.price;
    
    if (!profileName) return res.status(400).json({ error: 'Profile wajib diisi' });
    if (!qty) return res.status(400).json({ error: 'Jumlah voucher wajib diisi' });
    if (prefix.length >= codeLength) return res.status(400).json({ error: 'Prefix terlalu panjang' });

    const profiles = await mikrotikService.getHotspotUserProfiles(routerId);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) return res.status(400).json({ error: 'Profile Hotspot tidak ditemukan di MikroTik' });

    const meta = parseMikhmonOnLogin(profile.onLogin || profile['on-login']);
    if (!meta || !meta.validity) return res.status(400).json({ error: 'Profile belum memiliki metadata harga/durasi (Format Mikhmon)' });

    const createdBy = req.session?.isAdmin ? (req.session.adminUser || 'admin') : (req.session.cashierName || 'staff');
    let price = Number(meta.price || 0);
    if (priceInput !== undefined && priceInput !== null && String(priceInput).trim() !== '') {
      const p = Number(priceInput);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Harga tidak valid' });
      price = Math.floor(p);
    }

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, meta.validity || '', prefix, codeLength, createdBy, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    const exists = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(4, Math.min(16, codeLength - prefix.length));
      const userCode = prefix + genCode(coreLen, charset);
      let passCode = userCode;
      if (mode === 'member') {
        passCode = genCode(coreLen, charset);
      }
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const generated = makeCode();
      if (codes.has(generated.userCode)) continue;
      if (exists.get(routerId, generated.userCode)) continue;
      codes.add(generated.userCode);
      initialVouchers.push(generated);
    }

    const tx = db.transaction((items) => {
      for (const c of items) {
        insertVoucher.run(batchId, routerId, c.userCode, c.passCode, profileName, `vc-${c.userCode}-${profileName}`);
      }
    });
    tx(initialVouchers);

    setImmediate(() => {
      createVoucherBatchAsync(batchId).catch(e => logger.error('[VoucherBatch] Error: ' + (e?.message || e)));
    });

    res.json({ success: true, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/sync', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

    const routerId = batch.router_id ?? null;
    const users = await mikrotikService.getHotspotUsers(routerId);
    const byName = new Map();
    for (const u of users) {
      if (u?.name) byName.set(String(u.name), u);
    }

    const list = db.prepare('SELECT id, code, used_at FROM vouchers WHERE batch_id = ?').all(batchId);
    const updSeen = db.prepare("UPDATE vouchers SET last_seen_comment=?, last_seen_uptime=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?");
    const markUsed = db.prepare("UPDATE vouchers SET used_at=CURRENT_TIMESTAMP, status='used', last_seen_comment=?, last_seen_uptime=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?");
    const markMissing = db.prepare("UPDATE vouchers SET status='missing', last_seen_at=CURRENT_TIMESTAMP WHERE id=?");

    let usedNew = 0;
    let missing = 0;

    const tx = db.transaction(() => {
      for (const v of list) {
        const u = byName.get(String(v.code));
        if (!u) {
          markMissing.run(v.id);
          missing++;
          continue;
        }
        const comment = String(u.comment || '');
        const uptime = String(u.uptime || '');
        const isUsedByComment = comment && !comment.toLowerCase().startsWith('vc') && !comment.toLowerCase().startsWith('up');
        const isUsedByUptime = uptime && uptime !== '0s' && uptime !== '0' && uptime !== '00:00:00';
        const usedNow = isUsedByComment || isUsedByUptime;
        if (usedNow && !v.used_at) {
          markUsed.run(comment, uptime, v.id);
          usedNew++;
        } else {
          updSeen.run(comment, uptime, v.id);
        }
      }
    });
    tx();

    res.json({ success: true, usedNew, missing, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/delete', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    if (!batchId) return res.status(400).json({ error: 'Batch ID tidak valid' });

    const batch = db.prepare('SELECT id, status FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
    if (String(batch.status) === 'creating') {
      return res.status(400).json({ error: 'Batch sedang diproses (creating). Silakan tunggu hingga selesai.' });
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ?) AS total,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ? AND v.used_at IS NOT NULL) AS used
    `).get(batchId, batchId);

    const del = db.prepare('DELETE FROM voucher_batches WHERE id = ?');
    del.run(batchId);

    res.json({ success: true, deletedBatchId: batchId, deletedVouchers: stats?.total || 0, usedCount: stats?.used || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const listQuery = parseMonitoringListQuery(req, 25);
    const [secretsResult, activeResult] = await Promise.all([
      getCachedMonitoringData({
        kind: 'secrets',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeSecrets(routerId), 8000),
        bypassCache
      }),
      getCachedMonitoringData({
        kind: 'active-pppoe',
        routerId,
        ttlMs: 2000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeActive(routerId), 20000),
        bypassCache
      })
    ]);
    const data = Array.isArray(secretsResult.data) ? secretsResult.data : [];
    const activeSessions = Array.isArray(activeResult.data) ? activeResult.data : [];
    const activeByName = new Map(activeSessions.map((session) => [String(session?.name || ''), session]));
    const enriched = data.map((secret) => {
      const active = activeByName.get(String(secret?.name || '')) || null;
      return {
        ...secret,
        session: active,
        sessionUptime: active?.uptime || null,
        sessionRemoteAddress: active?.address || null,
        isOnline: Boolean(active),
        displayStatus: active
          ? 'online'
          : (secret?.disabled === true || secret?.disabled === 'true' ? 'disabled' : 'offline')
      };
    });
    res.set('X-Mikrotik-Cache', `${secretsResult.cacheStatus}/${activeResult.cacheStatus}`);
    if (!listQuery.wantsMeta) {
      return res.json(enriched);
    }
    const filtered = listQuery.q
      ? enriched.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
          'name', 'profile', 'service', 'local-address', 'remote-address',
          'localAddress', 'remoteAddress', 'comment', 'caller-id', 'sessionRemoteAddress'
        ]))
      : enriched;
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: enriched.length,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      onlineCount: activeSessions.length,
      cache: {
        secrets: secretsResult.cacheStatus,
        active: activeResult.cacheStatus
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.addPppoeSecret(req.body, routerId);
    clearMonitoringCache(routerId, ['secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.updatePppoeSecret(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.deletePppoeSecret(req.params.id, routerId);
    clearMonitoringCache(routerId, ['secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const listQuery = parseMonitoringListQuery(req, 25);
    const [usersResult, activeResult] = await Promise.all([
      getCachedMonitoringData({
        kind: 'hotspot-users',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotUsers(routerId), 8000),
        bypassCache
      }),
      getCachedMonitoringData({
        kind: 'active-hotspot',
        routerId,
        ttlMs: 2000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotActive(routerId), 20000),
        bypassCache
      })
    ]);
    const data = Array.isArray(usersResult.data) ? usersResult.data : [];
    const activeSessions = Array.isArray(activeResult.data) ? activeResult.data : [];
    const activeByUser = new Map(activeSessions.map((session) => [String(session?.user || ''), session]));
    const enriched = data.map((user) => {
      const active = activeByUser.get(String(user?.name || '')) || null;
      return {
        ...user,
        session: active,
        sessionUptime: active?.uptime || null,
        sessionAddress: active?.address || null,
        isOnline: Boolean(active),
        displayStatus: active
          ? 'online'
          : (user?.disabled === true || user?.disabled === 'true' ? 'disabled' : 'offline')
      };
    });
    res.set('X-Mikrotik-Cache', `${usersResult.cacheStatus}/${activeResult.cacheStatus}`);
    if (!listQuery.wantsMeta) {
      return res.json(enriched);
    }
    const filtered = listQuery.q
      ? enriched.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
          'name', 'profile', 'address', 'comment', 'limit-uptime',
          'limitUptime', 'mac-address', 'server', 'sessionAddress'
        ]))
      : enriched;
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: enriched.length,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      onlineCount: activeSessions.length,
      cache: {
        users: usersResult.cacheStatus,
        active: activeResult.cacheStatus
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.addHotspotUser(req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.updateHotspotUser(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.deleteHotspotUser(req.params.id, routerId);
    clearMonitoringCache(routerId, ['hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const { data, cacheStatus } = await getCachedMonitoringData({
      kind: 'active-pppoe',
      routerId,
      ttlMs: 2000,
      loader: () => withLoaderTimeout(() => mikrotikService.getPppoeActive(routerId), 20000),
      bypassCache
    });
    res.set('X-Mikrotik-Cache', cacheStatus);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const { data, cacheStatus } = await getCachedMonitoringData({
      kind: 'active-hotspot',
      routerId,
      ttlMs: 2000,
      loader: () => withLoaderTimeout(() => mikrotikService.getHotspotActive(routerId), 20000),
      bypassCache
    });
    res.set('X-Mikrotik-Cache', cacheStatus);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/summary', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const [secrets, activePppoe, hotspotUsers, activeHotspot] = await Promise.all([
      getCachedMonitoringData({
        kind: 'secrets',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeSecrets(routerId), 8000),
        bypassCache
      }),
      getCachedMonitoringData({
        kind: 'active-pppoe',
        routerId,
        ttlMs: 2000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeActive(routerId), 20000),
        bypassCache
      }),
      getCachedMonitoringData({
        kind: 'hotspot-users',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotUsers(routerId), 8000),
        bypassCache
      }),
      getCachedMonitoringData({
        kind: 'active-hotspot',
        routerId,
        ttlMs: 2000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotActive(routerId), 20000),
        bypassCache
      })
    ]);

    res.json({
      pppoeOnline: Array.isArray(activePppoe.data) ? activePppoe.data.length : 0,
      hotspotOnline: Array.isArray(activeHotspot.data) ? activeHotspot.data.length : 0,
      totalSecrets: Array.isArray(secrets.data) ? secrets.data.length : 0,
      totalHotspot: Array.isArray(hotspotUsers.data) ? hotspotUsers.data.length : 0,
      cache: {
        secrets: secrets.cacheStatus,
        activePppoe: activePppoe.cacheStatus,
        hotspotUsers: hotspotUsers.cacheStatus,
        activeHotspot: activeHotspot.cacheStatus
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.addPppoeProfile(req.body, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.updatePppoeProfile(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.deletePppoeProfile(req.params.id, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const listQuery = parseMonitoringListQuery(req, 25);
    let profiles = [];
    let cacheStatus = 'MISS';
    let dataSource = 'hotspot-user-profiles';
    try {
      const result = await getCachedMonitoringData({
        kind: 'hotspot-user-profiles',
        routerId,
        ttlMs: 15000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotUserProfiles(routerId), 12000),
        bypassCache
      });
      profiles = Array.isArray(result.data) ? result.data : [];
      cacheStatus = result.cacheStatus;
    } catch (_error) {
      const fallback = await getCachedMonitoringData({
        kind: 'hotspot-users',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getHotspotUsers(routerId), 8000),
        bypassCache
      });
      profiles = deriveHotspotProfilesFromUsers(fallback.data);
      cacheStatus = `FALLBACK:${fallback.cacheStatus}`;
      dataSource = 'hotspot-users-fallback';
    }
    res.set('X-Mikrotik-Cache', cacheStatus);
    if (!listQuery.wantsMeta) {
      return res.json(profiles);
    }
    const filtered = listQuery.q
      ? profiles.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
          'name', 'rate-limit', 'shared-users', 'session-timeout',
          'on-login', 'comment'
        ]))
      : profiles;
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: profiles.length,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      cache: { profiles: cacheStatus, source: dataSource }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.addHotspotUserProfile(req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    await mikrotikService.deleteHotspotUserProfile(req.params.id, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup(req.query.routerId);
    res.setHeader('Content-disposition', 'attachment; filename=mikrotik_backup_' + new Date().toISOString().slice(0,10) + '.rsc');
    res.setHeader('Content-type', 'text/plain');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
// Global Broadcast Tracker
global.broadcastStatus = {
  active: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null,
  paused: false,
  stopped: false,
  currentBatch: 0,
  messagesPerHour: 0,
  hourlyLimit: 100
};

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

// Helper: Cek apakah waktu aman untuk broadcast (hindari jam sibuk)
function isSafeTimeToBroadcast() {
  const now = new Date();
  const hour = now.getHours();
  // Hindari jam 00:00 - 06:00 (jam malam) dan jam 18:00 - 21:00 (jam sibuk)
  return hour >= 8 && hour <= 17;
}

// Helper: Hitung delay berdasarkan jam (lebih lama di jam sibuk)
function getTimeBasedDelay(baseDelayMs) {
  const now = new Date();
  const hour = now.getHours();
  
  // Jam sibuk (18:00 - 21:00): delay 2x lebih lama
  if (hour >= 18 && hour <= 21) {
    return baseDelayMs * 2;
  }
  
  // Jam malam (00:00 - 06:00): delay 3x lebih lama
  if (hour >= 0 && hour <= 6) {
    return baseDelayMs * 3;
  }
  
  // Jam normal: delay normal
  return baseDelayMs;
}

// Helper: Cek duplicate message untuk menghindari spam
function isDuplicateMessage(phone, message, messageHistory) {
  const key = `${phone}_${message.substring(0, 50)}`;
  const lastSent = messageHistory.get(key);
  if (!lastSent) return false;
  
  const timeDiff = Date.now() - lastSent;
  return timeDiff < 3600000; // 1 jam
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Cek apakah error adalah temporary (bisa retry)
function isTemporaryError(errorMessage) {
  const temporaryErrorPatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /rate.*limit/i,
    /too.*many/i,
    /429/i,
    /500/i,
    /502/i,
    /503/i,
    /504/i
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Global message history untuk duplicate detection
global.broadcastMessageHistory = new Map();

/*
router.get('/whatsapp', requireAdminSession, async (req, res) => {
  res.render('admin/whatsapp', {
    title: 'Status WhatsApp', company: company(), activePage: 'whatsapp', msg: flashMsg(req)
  });
});

router.get('/whatsapp/broadcast', requireAdminSession, (req, res) => {
  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: company(), activePage: 'whatsapp', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting,
    templateDefaults: {
      billing: defaultBillingWhatsappTemplate(company()),
      dueReminder: defaultDueReminderWhatsappTemplate(company()),
      isolation: defaultIsolationWhatsappTemplate(company()),
      welcome: defaultWelcomeWhatsappTemplate(company()),
      reactivation: defaultReactivationWhatsappTemplate(company()),
      paid: defaultPaidWhatsappTemplate(company())
    }
  });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

// API: Pause Broadcast
router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = true;
  logger.info('[Broadcast] Broadcast dipause oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dipause.' });
});

// API: Resume Broadcast
router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dilanjutkan.' });
});

// API: Stop Broadcast
router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.stopped = true;
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dihentikan.' });
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    const requestBaseUrl = resolveRequestBaseUrl(req);
    
    // Smart Rate Limit Settings
    const baseDelayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 5)) * 1000; // Default 5 detik
    const batchSize = parseInt(customBatchSize) || 15; // Default 15 pesan per batch (lebih aman)
    const batchPauseMs = 120000; // Pause 2 menit setelah setiap batch (lebih aman)
    const hourlyLimit = parseInt(customHourlyLimit) || 80; // Default 80 pesan per jam (lebih aman)
    
    if (customDelay) {
      const v = parseInt(customDelay);
      if (Number.isFinite(v) && v >= 1 && v <= 60) {
        saveSettings({ whatsapp_broadcast_delay: v });
      }
    }

    if (global.broadcastStatus.active) {
      throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
    }

    let customers = [];
    const allCust = customerSvc.getAllCustomers();
    
    if (target === 'all') {
      customers = allCust;
    } else if (target === 'active') {
      customers = allCust.filter(c => c.status === 'active');
    } else if (target === 'suspended') {
      customers = allCust.filter(c => c.status === 'suspended');
    } else if (target === 'unpaid') {
      customers = allCust.filter(c => c.unpaid_count > 0);
    }

    // Ambil pelanggan unik berdasarkan nomor HP
    const uniqueCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      let phoneKey = String(c.phone || '').replace(/\D/g, '');
      if (phoneKey.startsWith('0')) phoneKey = '62' + phoneKey.slice(1);
      if (phoneKey && phoneKey.length > 8 && !seenPhones.has(phoneKey)) {
        uniqueCustomers.push(c);
        seenPhones.add(phoneKey);
      }
    }

    if (uniqueCustomers.length === 0) {
      throw new Error('Tidak ada nomor pelanggan yang valid untuk target tersebut.');
    }

    const { sendWA, ensureWhatsAppReady } = await import('../services/whatsappBot.mjs');
    const ready = await ensureWhatsAppReady(25000);
    if (!ready) {
      throw new Error('Bot WhatsApp belum terhubung. Silakan buka menu WhatsApp dan pastikan statusnya Terhubung.');
    }
    
    // Initialize Tracker dengan Smart Rate Limit
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date(),
      paused: false,
      stopped: false,
      currentBatch: 0,
      messagesPerHour: 0,
      hourlyLimit: hourlyLimit
    };

    const sendMessageAsync = async () => {
      let batchCount = 0;
      let messagesInCurrentHour = 0;
      let hourStartTime = Date.now();
      
      for (let i = 0; i < uniqueCustomers.length; i++) {
        // Cek jika broadcast dihentikan
        if (global.broadcastStatus.stopped) {
          logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
          break;
        }
        
        // Cek jika broadcast dipause
        while (global.broadcastStatus.paused) {
          await new Promise(r => setTimeout(r, 2000));
          if (global.broadcastStatus.stopped) break;
        }
        
        if (global.broadcastStatus.stopped) break;

        // Hourly Rate Limiting
        const elapsedHour = Date.now() - hourStartTime;
        if (elapsedHour >= 3600000) { // 1 jam
          messagesInCurrentHour = 0;
          hourStartTime = Date.now();
        }
        
        if (messagesInCurrentHour >= hourlyLimit) {
          const waitTime = 3600000 - elapsedHour;
          logger.info(`[Broadcast] Hourly limit tercapai (${hourlyLimit} pesan). Menunggu ${Math.floor(waitTime / 60000)} menit...`);
          await new Promise(r => setTimeout(r, waitTime));
          messagesInCurrentHour = 0;
          hourStartTime = Date.now();
        }

        const cust = uniqueCustomers[i];
        let attemptCount = 0;
        const maxAttempts = 3;
        
        while (attemptCount < maxAttempts) {
          try {
            // Smart Random Delay
            const randomDelay = getRandomDelay(baseDelayMs, 2000);
            await new Promise(r => setTimeout(r, randomDelay));
            
            const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
            const primaryInvoice = Array.isArray(unpaidInvoices) && unpaidInvoices.length ? unpaidInvoices[0] : null;
            let formattedMsg = fillWhatsappTemplate(
              message,
              {
                ...buildWhatsappCustomerPayload(cust, unpaidInvoices, primaryInvoice, { baseUrl: requestBaseUrl }),
                company: company()
              }
            );
            
            // Add subtle variation untuk menghindari spam detection
            formattedMsg = addMessageVariation(formattedMsg, i);

            const sentOk = await sendWA(cust.phone, formattedMsg);
            if (!sentOk) throw new Error('sendWA mengembalikan gagal');
            global.broadcastStatus.sent++;
            messagesInCurrentHour++;
            global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
            batchCount++;
            
            // Batch Processing: Pause setelah N pesan
            if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
              logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
              global.broadcastStatus.currentBatch++;
              await new Promise(r => setTimeout(r, batchPauseMs));
              batchCount = 0;
            }
            
            break; // Sukses, keluar dari retry loop
          } catch (e) {
            attemptCount++;
            const errorMsg = e.message || e.toString();
            
            // Cek apakah error permanent (tidak perlu retry)
            if (isPermanentError(errorMsg)) {
              logger.warn(`[Broadcast] SKIP: Error permanent untuk ${cust.phone} - ${errorMsg}`);
              global.broadcastStatus.failed++;
              break; // Skip retry langsung ke pelanggan berikutnya
            }
            
            // Error temporary, bisa retry
            logger.error(`[Broadcast] Gagal kirim ke ${cust.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
            
            if (attemptCount >= maxAttempts) {
              logger.warn(`[Broadcast] Max attempts tercapai untuk ${cust.phone}`);
              global.broadcastStatus.failed++;
            } else {
              // Exponential backoff untuk retry
              const backoffDelay = getBackoffDelay(attemptCount);
              logger.info(`[Broadcast] Retry ke ${cust.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
              await new Promise(r => setTimeout(r, backoffDelay));
            }
          }
        }
      }
      
      global.broadcastStatus.active = false;
      logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
    };
    
    sendMessageAsync(); 

    req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${uniqueCustomers.length} pelanggan dengan smart rate limit.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? true : false;
    const delay = req.body && req.body.delay ? parseInt(req.body.delay) : null;
    const next = { whatsapp_auto_billing_enabled: enabled };
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
      next.whatsapp_broadcast_delay = delay;
    }
    const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (msg) {
      next.whatsapp_auto_billing_message = msg;
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: `Pengingat tagihan otomatis ${enabled ? 'diaktifkan' : 'dimatikan'}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/templates', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const next = {
      whatsapp_group_invite_link: String(req.body.whatsapp_group_invite_link || '').trim(),
      whatsapp_welcome_message: String(req.body.whatsapp_welcome_message || '').trim(),
      whatsapp_due_reminder_message: String(req.body.whatsapp_due_reminder_message || '').trim(),
      whatsapp_billing_message: String(req.body.whatsapp_billing_message || '').trim(),
      whatsapp_isolation_message: String(req.body.whatsapp_isolation_message || '').trim(),
      whatsapp_reactivation_message: String(req.body.whatsapp_reactivation_message || '').trim(),
      whatsapp_paid_message: String(req.body.whatsapp_paid_message || '').trim()
    };
    saveSettings(next);
    req.session._msg = { type: 'success', text: 'Template WhatsApp berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan template WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const { whatsappStatus } = await import('../services/whatsappBot.mjs');
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const { sendWA, ensureWhatsAppReady } = await import('../services/whatsappBot.mjs');
    const ready = await ensureWhatsAppReady(25000);
    if (!ready) {
      throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
    }
    const adminPhone = resolveWhatsappTestRecipient(whatsappStatus);
    if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia.');
    const msg =
      `🧪 *TEST NOTIFIKASI WHATSAPP*\n\n` +
      `✅ Jika pesan ini masuk, berarti notifikasi WhatsApp portal billing sudah berfungsi.\n` +
      `📅 Waktu: ${new Date().toLocaleString('id-ID')}`;
    const messageText =
      `TEST NOTIFIKASI WHATSAPP\n\n` +
      `WhatsApp bot untuk ${getSetting('company_header', 'Portal Billing ISP')} sudah berfungsi.\n` +
      `Waktu: ${new Date().toLocaleString('id-ID')}`;
    const ok = await sendWA(adminPhone, messageText);
    if (!ok) throw new Error('Gagal mengirim pesan test (sendWA=false).');
    req.session._msg = { type: 'success', text: `Test notifikasi WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/test-template', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { sendWA, whatsappStatus, ensureWhatsAppReady } = await import('../services/whatsappBot.mjs');
    const ready = await ensureWhatsAppReady(25000);
    if (!ready) {
      throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
    }
    const adminPhone = resolveWhatsappTestRecipient(whatsappStatus);
    if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia.');
    const templateKey = String(req.body.template_key || 'billing').trim();
    const previewMessage = buildWhatsappTemplatePreview(templateKey, { baseUrl: resolveRequestBaseUrl(req) });
    const ok = await sendWA(adminPhone, previewMessage);
    if (!ok) throw new Error('Gagal mengirim test message.');
    req.session._msg = { type: 'success', text: `Test message WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim test message: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
    const folderPath = path.resolve(__dirname, '..', authFolder);
    
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);
      
      // Trigger restart bot secara asinkron
      import('../services/whatsappBot.mjs').then(m => m.restartWhatsAppBot()).catch(e => {
        logger.error('Failed to trigger WA restart:', e.message);
      });

      req.session._msg = { text: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang, silakan tunggu QR Code muncul.', type: 'success' };
    } else {
      req.session._msg = { text: 'Folder sesi tidak ditemukan atau sudah dihapus.', type: 'warning' };
    }
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to reset WA session:', e.message);
    req.session._msg = { text: 'Gagal menghapus sesi: ' + e.message + '. (Kemungkinan file sedang digunakan, silakan matikan aplikasi dulu lalu hapus folder ' + getSetting('whatsapp_auth_folder', 'auth_info_baileys') + ' secara manual)', type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

// ─── ROUTERS (MULTI-ROUTER) ──────────────────────────────────────────────────
*/
registerWhatsappRoutes(router, {
  express,
  requireAdmin,
  requireAdminSession,
  company,
  flashMsg,
  getSetting,
  saveSettings,
  logger,
  customerSvc,
  billingSvc,
  resolveRequestBaseUrl,
  fillWhatsappTemplate,
  buildWhatsappCustomerPayload,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  defaultWelcomeWhatsappTemplate,
  defaultReactivationWhatsappTemplate,
  defaultPaidWhatsappTemplate,
  buildWhatsappTemplatePreview,
  resolveWhatsappTestRecipient,
  formatPhoneDisplay,
  path,
  fs,
  getRandomDelay,
  getBackoffDelay,
  addMessageVariation,
  isPermanentError
});
router.get('/routers', requireAdminSession, (req, res) => {
  res.render('admin/routers', {
    title: 'Manajemen Router', company: company(), activePage: 'mikrotik',
    routers: mikrotikService.getAllRouters(), msg: flashMsg(req)
  });
});

router.post('/routers', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.createRouter(req.body);
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Router berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    req.session._msg = { type: 'success', text: 'Router berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.get('/api/routers/:id/test', requireAdmin, async (req, res) => {
  try {
    const conn = await mikrotikService.getConnection(req.params.id);
    if (conn && conn.api) {
      conn.api.close();
      return res.json({ success: true, message: 'Koneksi ke Router Berhasil!' });
    }
    throw new Error('Gagal terhubung ke router');
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/routers/:id/setup-firewall', requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.setupIsolirFirewall(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/isolir-portal-script', requireAdmin, (req, res) => {
  try {
    const data = mikrotikService.generateIsolirPortalScript();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const bypassCache = shouldForceMonitoringRefresh(req);
    const listQuery = parseMonitoringListQuery(req, 25);
    let profiles = [];
    let cacheStatus = 'MISS';
    let dataSource = 'profiles';
    try {
      const result = await getCachedMonitoringData({
        kind: 'profiles',
        routerId,
        ttlMs: 15000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeProfiles(routerId), 12000),
        bypassCache
      });
      profiles = Array.isArray(result.data) ? result.data : [];
      cacheStatus = result.cacheStatus;
    } catch (_error) {
      const fallback = await getCachedMonitoringData({
        kind: 'secrets',
        routerId,
        ttlMs: 10000,
        loader: () => withLoaderTimeout(() => mikrotikService.getPppoeSecrets(routerId), 8000),
        bypassCache
      });
      profiles = derivePppoeProfilesFromSecrets(fallback.data);
      cacheStatus = `FALLBACK:${fallback.cacheStatus}`;
      dataSource = 'secrets-fallback';
    }
    res.set('X-Mikrotik-Cache', cacheStatus);
    if (!listQuery.wantsMeta) {
      return res.json(profiles);
    }
    const filtered = listQuery.q
      ? profiles.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
          'name', 'localAddress', 'remoteAddress', 'rateLimit'
        ]))
      : profiles;
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: profiles.length,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      cache: { profiles: cacheStatus, source: dataSource }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/profiles/:routerId', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.params.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.routerId ? Number(req.params.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
