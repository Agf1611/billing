/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const {
  getSetting,
  getSettings,
  saveSettings,
  getOperationalSettingsPath,
  getPrivateSettingsPath
} = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const customerDetailSvc = require('../services/customerDetailService');
const usageSvc = require('../services/usageService');
const packageChangeSvc = require('../services/packageChangeService');
const billingSvc = require('../services/billingService');
const whatsappGateway = require('../services/whatsappGatewayService');
const mikrotikService = require('../services/mikrotikService');
const monitoringCollectorSvc = require('../services/monitoringCollectorService');
const massOutageSvc = require('../services/massOutageService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const techSvc = require('../services/techService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const networkMapLinkSvc = require('../services/networkMapLinkService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const bookkeepingSvc = require('../services/bookkeepingService');
const cashLedgerSvc = require('../services/cashLedgerService');
const auditSvc = require('../services/auditTrailService');
const diagnosticsSvc = require('../services/diagnosticsService');
const employeeLocationSvc = require('../services/employeeLocationService');
const axios = require('axios');
const crypto = require('crypto');
const { normalizePhoneDigits, formatPhoneDisplay, normalizePhoneList } = require('../services/phoneService');
const {
  persistCompressedImageUpload
} = require('../services/imageUploadService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerInvoiceCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  formatInvoiceDueDate,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  defaultWelcomeWhatsappTemplate,
  defaultReactivationWhatsappTemplate,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine,
  resolveAppBaseUrl,
  resolveRequestBaseUrl
} = require('../services/publicLinkService');
const {
  isStrongAdminApiKey,
  isStrongAdminPassword,
  isStrongSessionSecret,
  isStrongXenditCallbackToken
} = require('../config/security');
const { verifyPassword } = require('../config/passwords');
const {
  getRuntimeConfigurationWarnings,
  isSelfUpdateEnabled
} = require('../config/runtimeSafety');
const registerBillingRoutes = require('./admin/registerBillingRoutes');
const registerCustomerRoutes = require('./admin/registerCustomerRoutes');
const registerWhatsappRoutes = require('./admin/registerWhatsappRoutes');
const {
  isPushConfigured,
  sendPushToCustomer,
  sendPushToCustomers,
  sendPushToTechnician,
  buildAdminPushExternalId
} = require('../services/pushNotificationService');
const {
  normalizeQrisPayload,
  hasStaticQrisEnabled,
  resolveQrisUniqueCodeRange,
  buildDynamicQrisPayload,
  buildDynamicQrisBuffer,
  decodeQrisPayloadFromBuffer,
  decodeQrisPayloadFromUrl
} = require('../services/qrisService');

const FIRST_INSTALL_ADMIN_USERNAME = 'admin';
const FIRST_INSTALL_ADMIN_PASSWORD = 'admin123';
const PLACEHOLDER_PATTERN = /^CHANGE_ME(?:_|$)/i;

function isPlaceholderSetting(value) {
  const normalized = String(value || '').trim();
  return PLACEHOLDER_PATTERN.test(normalized);
}

function isFirstInstallAdminLoginEnabled(settings = getSettings()) {
  return String(settings.admin_username || '').trim() === FIRST_INSTALL_ADMIN_USERNAME
    && isPlaceholderSetting(settings.admin_password);
}

function authenticateAdminLogin(username, password) {
  const settings = getSettings();
  const normalizedUsername = String(username || '').trim();
  const plainPassword = String(password || '');
  const configuredUsername = String(settings.admin_username || '').trim();
  const configuredPassword = String(settings.admin_password || '');

  if (isFirstInstallAdminLoginEnabled(settings)) {
    return normalizedUsername === FIRST_INSTALL_ADMIN_USERNAME && plainPassword === FIRST_INSTALL_ADMIN_PASSWORD
      ? { ok: true, firstInstall: true, username: FIRST_INSTALL_ADMIN_USERNAME }
      : { ok: false, firstInstall: true };
  }

  if (normalizedUsername === configuredUsername && verifyPassword(plainPassword, configuredPassword)) {
    return { ok: true, firstInstall: false, username: configuredUsername };
  }

  return { ok: false, firstInstall: false };
}

router.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('application/manifest+json');
  return res.json({
    id: '/admin/',
    name: 'Admin',
    short_name: 'Admin',
    description: `Admin ${String(getSetting('company_header', 'SICKAS WIFI') || 'SICKAS WIFI').trim() || 'SICKAS WIFI'}`,
    start_url: '/admin?source=pwa',
    scope: '/admin/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png', sizes: '192x192', purpose: 'any maskable' },
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png', sizes: '512x512', purpose: 'any maskable' },
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
});

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});
const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const IMAGE_UPLOAD_FIELDS = [
  'company_logo_file',
  'pwa_logo_file',
  'support_isp_logo_file',
  'invoice_signature_file',
  'invoice_stamp_file',
  'qris_static_qr_file',
  'customer_portal_banner_1_file',
  'customer_portal_banner_2_file',
  'customer_portal_banner_3_file'
];

function isEnabledSwitch(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function isRememberMeChecked(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function applyAdminLoginSession(req, rememberMe = false) {
  const keepSignedIn = Boolean(rememberMe);
  const maxAge = keepSignedIn ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
  req.session.rememberMe = keepSignedIn;
  req.session.adminRememberMe = keepSignedIn;
  if (req.session.cookie) {
    req.session.cookie.maxAge = maxAge;
    req.session.cookie.expires = new Date(Date.now() + maxAge);
  }
}

function clearConfiguredSessionCookies(res) {
  const cookieName = String(getSetting('session_cookie_name', 'billing.sid') || 'billing.sid').trim() || 'billing.sid';
  const cookieDomain = String(getSetting('session_cookie_domain', '') || '').trim();
  const baseOptions = {
    path: '/',
    httpOnly: true,
    sameSite: String(getSetting('session_cookie_same_site', 'lax') || 'lax').toLowerCase()
  };
  if (cookieDomain) baseOptions.domain = cookieDomain;
  res.clearCookie(cookieName, baseOptions);
  res.clearCookie('connect.sid', { path: '/' });
}

function sanitizePushBody(text, fallback = '') {
  const clean = String(text || '').replace(/\r/g, '').trim();
  return clean || fallback;
}

async function trySendInvoiceCreatedPush(customer, invoice, req, options = {}) {
  try {
    if (!customer || !invoice) return;
    const settings = getSettings();
    if (!isPushConfigured(settings) || !isEnabledSwitch(settings.onesignal_push_invoice_enabled ?? true)) return;
    const baseUrl = resolveRequestBaseUrl(req);
    const title = options.title || 'Tagihan Baru';
    const body = options.body || `Tagihan ${invoice.period_month}/${invoice.period_year} sudah tersedia. Buka aplikasi untuk cek detail pembayaran.`;
    await sendPushToCustomer(customer, {
      settings,
      title,
      message: body,
      targetUrl: `${baseUrl}/customer/dashboard#billing`,
      data: {
        kind: 'invoice',
        invoiceId: Number(invoice.id || 0) || null,
        customerId: Number(customer.id || 0) || null
      }
    });
  } catch (error) {
    logger.warn(`[PushNotification] Gagal kirim push tagihan: ${error.message}`);
  }
}

function resolveAdminPathFromRequest(req, fallback = '/admin/customers') {
  const candidates = [
    req?.body?._admin_return_to,
    req?.body?.return_to,
    req?.query?._admin_return_to,
    req?.query?.return_to,
    req?.get ? req.get('referer') : '',
    fallback
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    try {
      const parsed = new URL(raw, 'http://admin.local');
      if (!parsed.pathname.startsWith('/admin')) continue;
      return `${parsed.pathname}${parsed.search || ''}`;
    } catch (_error) {
      if (raw.startsWith('/admin')) return raw;
    }
  }
  return fallback;
}

function buildPostIsolationRedirect(req, fallback = '/admin/customers?status=suspended') {
  const current = resolveAdminPathFromRequest(req, fallback);
  try {
    const parsed = new URL(current, 'http://admin.local');
    if (parsed.pathname === '/admin/billing') {
      parsed.searchParams.set('status', 'isolated');
      parsed.searchParams.set('page', '1');
      return `${parsed.pathname}${parsed.search}`;
    }
    if (parsed.pathname === '/admin/customers') {
      parsed.searchParams.set('status', 'suspended');
      parsed.searchParams.set('page', '1');
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch (_error) {}
  return fallback;
}

function forceAdminRedirect(res, target) {
  res.statusCode = 302;
  res.setHeader('Location', target || '/admin');
  return res.end();
}

function queueManualIsolationNotifications({ req, customer, unpaidInvoices = [] }) {
  if (!customer?.id) return;
  const requestBaseUrl = resolveRequestBaseUrl(req);
  const unpaidTotal = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const periodLine = unpaidInvoices.length
    ? unpaidInvoices.map((inv) => `${inv.period_month}/${inv.period_year}`).join(', ')
    : 'tagihan aktif';
  const body = unpaidTotal > 0
    ? `Layanan internet Anda sementara diisolir. Tagihan belum lunas: Rp ${unpaidTotal.toLocaleString('id-ID')} (${periodLine}). Buka aplikasi pelanggan untuk bayar dan aktif kembali.`
    : 'Layanan internet Anda sementara diisolir. Buka aplikasi pelanggan untuk melihat status tagihan atau hubungi admin.';

  customerSvc.addPortalNotification(customer.id, {
    kind: 'suspension',
    tab: 'billing',
    title: 'Layanan internet diisolir',
    body,
    payload: {
      source: 'admin-manual-isolate',
      unpaidInvoiceIds: unpaidInvoices.map((inv) => Number(inv.id || 0)).filter(Boolean)
    }
  }, { dedupeWindowMs: 15 * 60 * 1000 });

  setImmediate(async () => {
    const settings = getSettings();
    try {
      if (isPushConfigured(settings)) {
        await sendPushToCustomer(customer, {
          settings,
          title: 'Layanan Internet Diisolir',
          message: body,
          targetUrl: `${requestBaseUrl}/customer/dashboard#billing`,
          data: {
            kind: 'suspension',
            source: 'admin-manual-isolate',
            customerId: Number(customer.id || 0) || null
          },
          timeoutMs: 7000
        });
      }
    } catch (error) {
      logger.warn(`[ManualIsolation] Gagal kirim push pelanggan ${customer.id}: ${error.message || String(error)}`);
    }

    try {
      if (customer.phone) {
        const waSent = await trySendWhatsappPayment(
          customer.phone,
          buildIsolationWhatsappMessage(
            customer,
            unpaidInvoices,
            'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.',
            { baseUrl: requestBaseUrl }
          )
        );
        if (!waSent) logger.warn(`[ManualIsolation] WhatsApp isolir pelanggan ${customer.id} tidak terkirim.`);
      }
    } catch (error) {
      logger.warn(`[ManualIsolation] Gagal kirim WhatsApp pelanggan ${customer.id}: ${error.message || String(error)}`);
    }
  });
}

function getUploadedSingleFile(req, fieldName) {
  const files = req && req.files;
  if (!files || !fieldName) return null;
  const bucket = files[fieldName];
  if (Array.isArray(bucket) && bucket[0] && bucket[0].buffer && Number(bucket[0].size || 0) > 0) return bucket[0];
  return null;
}

const CUSTOMER_IMAGE_UPLOAD_FIELDS = [
  { name: 'house_photo_file', maxCount: 1 },
  { name: 'ktp_photo_file', maxCount: 1 }
];

async function persistCustomerUpload(file, prefix) {
  if (!file?.buffer || Number(file.size || 0) <= 0) return '';
  const saved = await persistCompressedImageUpload(file, prefix, {
    maxBytes: 500 * 1024,
    maxDimension: 1600
  });
  return saved.publicUrl;
}

async function inspectQrisPayloadInput({ payload = '', qrUrl = '', uploadedFile = null } = {}) {
  const normalizedPayload = normalizeQrisPayload(payload || '');
  const trimmedQrUrl = String(qrUrl || '').trim();

  if (normalizedPayload) {
    const dynamicSample = buildDynamicQrisPayload(normalizedPayload, 150000);
    if (!dynamicSample) {
      return {
        ok: false,
        source: 'payload',
        message: 'Payload terisi, tetapi formatnya belum valid untuk QRIS dinamis.'
      };
    }
    return {
      ok: true,
      source: 'payload',
      payload: normalizedPayload,
      message: 'Payload manual valid dan siap dipakai untuk QRIS dinamis nominal otomatis.'
    };
  }

  let extractedPayload = '';
  let source = '';
  let warning = '';
  try {
    if (uploadedFile?.buffer?.length) {
      extractedPayload = await decodeQrisPayloadFromBuffer(uploadedFile.buffer);
      source = 'file';
    } else if (trimmedQrUrl) {
      extractedPayload = await decodeQrisPayloadFromUrl(trimmedQrUrl);
      source = 'url';
    }
  } catch (error) {
    warning = String(error?.message || '').trim();
  }

  if (extractedPayload) {
    const dynamicSample = buildDynamicQrisPayload(extractedPayload, 150000);
    if (!dynamicSample) {
      return {
        ok: false,
        source,
        message: 'Payload berhasil dibaca dari QR, tetapi belum valid untuk QRIS dinamis.'
      };
    }
    return {
      ok: true,
      source,
      payload: extractedPayload,
      message: `Payload berhasil dibaca otomatis dari ${source === 'file' ? 'gambar upload' : 'link QRIS'} dan siap dipakai untuk QRIS dinamis.`
    };
  }

  if (/linkqr\.id/i.test(trimmedQrUrl)) {
    return {
      ok: false,
      source: 'url',
      message: 'Link linkqr.id terdeteksi sebagai halaman, bukan payload langsung. Pakai gambar QR merchant asli atau tempel payload manual.'
    };
  }

  if (warning) {
    return {
      ok: false,
      source: source || 'unknown',
      message: warning
    };
  }

  return {
    ok: false,
    source: source || (trimmedQrUrl ? 'url' : uploadedFile?.buffer?.length ? 'file' : 'empty'),
    message: 'Belum ada payload valid yang bisa dibaca. Tempel payload, upload gambar QR, atau isi URL gambar QRIS langsung.'
  };
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

function isSvgUpload(file) {
  const mime = String(file?.mimetype || '').toLowerCase().trim();
  const ext = path.extname(String(file?.originalname || '')).toLowerCase().trim();
  return mime === 'image/svg+xml' || ext === '.svg';
}

function persistUploadedSvgToPublicImage(file, filename = 'logo-pwa.svg') {
  if (!file || !file.buffer || Number(file.size || 0) <= 0) return '';
  const targetDir = path.join(__dirname, '..', 'public', 'img');
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, filename);
  fs.writeFileSync(targetPath, file.buffer);
  return `/img/${filename}`;
}

function safeRemoveFixedPublicAsset(relativePath) {
  const clean = String(relativePath || '').replace(/^\//, '').replace(/\?.*$/, '').trim();
  if (!clean) return;
  const targetPath = path.join(__dirname, '..', 'public', clean.replace(/\//g, path.sep));
  try {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  } catch (_e) {}
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
  const wantsJson = req.path.startsWith('/api/')
    || String(req.get('accept') || '').includes('application/json')
    || String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest';
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'Sesi admin berakhir. Silakan login ulang.' });
  }
  return res.redirect('/admin/login');
}

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    const base = nm && un ? `Kasir ${nm} (@${un})` : nm ? `Kasir ${nm}` : 'Kasir';
    const method = normalizeCashierPaymentMethod(fb);
    return method ? `${base} - ${method}` : base;
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

function normalizeCashierPaymentMethod(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'kasir' || lower.startsWith('kasir ') || lower === 'admin' || lower.startsWith('admin ')) return '';
  if (lower.includes('online') || lower.includes('payment gateway')) return 'Online / Payment Gateway';
  if (lower.includes('bri')) return 'Transfer BRI';
  if (lower.includes('transfer')) return 'Transfer Manual';
  if (lower.includes('cash') || lower.includes('tunai')) return 'Tunai / Cash';
  return raw;
}

function formatPublicPaidByName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Admin';
  const cashierMatch = raw.match(/^Kasir(?:\s+(.+?))?(?:\s+\(@[^)]*\))?(\s*-\s*.+)?$/i);
  if (!cashierMatch) return raw;
  const name = String(cashierMatch[1] || '').trim();
  const suffix = String(cashierMatch[2] || '').trim();
  return `Admin${name ? ` ${name}` : ''}${suffix ? ` ${suffix}` : ''}`.trim();
}

function resolvePaymentActor(req, fallbackName = 'Admin') {
  if (req.session?.isCashier) {
    return {
      type: 'cashier',
      id: req.session.cashierId || null,
      name: String(req.session.cashierName || req.session.cashierUsername || fallbackName || 'Kasir').trim(),
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    };
  }
  if (req.session?.isAdmin) {
    return {
      type: 'admin',
      id: null,
      name: String(req.session.adminUser || fallbackName || 'Admin').trim(),
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    };
  }
  return null;
}

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const status = await whatsappGateway.getStatus();
    const ready = await whatsappGateway.ensureReady(12000);
    if (!ready) {
      logger.warn(`[WhatsApp] Kirim pesan pelanggan dibatalkan karena gateway belum siap (${status?.provider || 'local'}:${status?.connection || 'unknown'}).`);
      return false;
    }
    return Boolean(await whatsappGateway.sendText(to, String(message || '').trim()));
  } catch (error) {
    logger.warn(`[WhatsApp] Gagal kirim pesan pelanggan: ${error.message || String(error)}`);
    return false;
  }
}

const TECHNICIAN_TASK_TYPE_LABELS = {
  install: 'Pemasangan Baru',
  repair: 'Perbaikan',
  survey: 'Survey',
  maintenance: 'Maintenance',
  collection: 'Penagihan Lapangan',
  relocation: 'Relokasi',
  other: 'Lainnya'
};

const TECHNICIAN_TASK_PRIORITY_LABELS = {
  low: 'Rendah',
  medium: 'Sedang',
  high: 'Tinggi',
  urgent: 'Urgent'
};

const TECHNICIAN_TASK_STATUS_LABELS = {
  assigned: 'Ditugaskan',
  in_progress: 'Dikerjakan',
  done: 'Selesai',
  cancelled: 'Dibatalkan'
};

function formatTechnicianTaskDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function buildTechnicianTaskPortalLink(options = {}) {
  const baseUrl = resolveAppBaseUrl(options.baseUrl || options.fallbackBaseUrl || '');
  if (!baseUrl) return '/tech/tasks';
  return `${baseUrl}/tech/tasks`;
}

function buildTechnicianTaskWhatsappMessage(task, technician, options = {}) {
  const mode = String(options.mode || 'assigned').trim() || 'assigned';
  const taskType = TECHNICIAN_TASK_TYPE_LABELS[String(task?.task_type || '').trim()] || String(task?.task_type || 'Tugas Teknisi').trim();
  const priority = TECHNICIAN_TASK_PRIORITY_LABELS[String(task?.priority || '').trim()] || String(task?.priority || '-').trim() || '-';
  const status = TECHNICIAN_TASK_STATUS_LABELS[String(task?.status || '').trim()] || String(task?.status || '-').trim() || '-';
  const title =
    mode === 'updated' ? '🔄 *UPDATE TUGAS TEKNISI*'
      : mode === 'done' ? '✅ *TUGAS TEKNISI SELESAI*'
        : '📋 *TUGAS TEKNISI BARU*';
  const customerName = String(task?.customer_name || task?.linked_customer_name || '-').trim() || '-';
  const customerPhone = String(task?.customer_phone || task?.linked_customer_phone || '-').trim() || '-';
  const customerAddress = String(task?.customer_address || '-').trim() || '-';
  const locationNote = String(task?.location_note || '').trim();
  const description = String(task?.description || '-').trim() || '-';
  const technicianName = String(technician?.name || task?.technician_name || 'Teknisi').trim() || 'Teknisi';
  const portalLink = buildTechnicianTaskPortalLink(options);
  const lines = [
    title,
    '',
    `Halo ${technicianName},`,
    '',
    `Judul: ${String(task?.title || '-').trim() || '-'}`,
    `Jenis: ${taskType}`,
    `Status: ${status}`,
    `Prioritas: ${priority}`,
    `Pelanggan: ${customerName}`,
    `No. HP: ${customerPhone}`,
    `Alamat: ${customerAddress}`,
    `Jadwal: ${formatTechnicianTaskDate(task?.scheduled_date)}`,
    `Deadline: ${formatTechnicianTaskDate(task?.due_date)}`,
    `Detail: ${description}`
  ];

  if (locationNote) lines.push(`Patokan: ${locationNote}`);
  if (String(task?.task_type || '').trim() === 'install') {
    const secretMode = Number(task?.create_pppoe_secret || 0) ? 'Ya' : 'Tidak';
    const username = String(task?.pppoe_username || '').trim();
    const password = String(task?.pppoe_password || '').trim();
    const profile = String(task?.normal_pppoe_profile || '').trim();
    lines.push(`Mode secret baru: ${secretMode}`);
    if (username) {
      lines.push(`Akun PPPoE: ${username}`);
      lines.push(`Password: ${password || '(sama dengan username)'}`);
    }
    if (profile) lines.push(`Profile: ${profile}`);
  }
  lines.push('', `Buka tugas: ${portalLink}`);

  return lines.join('\n');
}

function hasTechnicianTaskOperationalChange(previousTask, nextTask) {
  if (!previousTask || !nextTask) return true;
  const watchedFields = [
    'technician_id',
    'title',
    'task_type',
    'description',
    'customer_id',
    'customer_name',
    'customer_phone',
    'customer_address',
    'location_note',
    'priority',
    'status',
    'scheduled_date',
    'due_date',
    'create_pppoe_secret',
    'pppoe_username',
    'pppoe_password',
    'normal_pppoe_profile'
  ];
  return watchedFields.some((field) => String(previousTask[field] ?? '') !== String(nextTask[field] ?? ''));
}

async function trySendTechnicianTaskWhatsappNotification(task, technician, options = {}) {
  if (!task || !technician) return false;
  const phone = String(technician.phone || '').trim();
  if (!phone) return false;
  const message = buildTechnicianTaskWhatsappMessage(task, technician, options);
  return trySendWhatsappPayment(phone, message);
}

async function trySendTechnicianTaskPushNotification(task, technician, options = {}) {
  if (!task || !technician) return false;
  const settings = getSettings();
  if (!isPushConfigured(settings)) return false;
  const mode = String(options.mode || 'assigned').trim();
  const modeLabel = mode === 'updated' ? 'Update job teknisi' : 'Job teknisi baru';
  const taskType = TECHNICIAN_TASK_TYPE_LABELS[String(task.task_type || '').trim()] || 'Job';
  const priority = TECHNICIAN_TASK_PRIORITY_LABELS[String(task.priority || '').trim()] || String(task.priority || '-');
  const customerName = String(task.customer_name || task.linked_customer_name || 'Pelanggan').trim();
  const message = `${taskType}: ${String(task.title || 'Tugas lapangan').trim()} - ${customerName}. Prioritas ${priority}.`;
  const result = await sendPushToTechnician(technician, {
    settings,
    title: modeLabel,
    message,
    targetUrl: `${resolveRequestBaseUrl(options.req, resolveAppBaseUrl())}/tech/tasks`,
    data: {
      kind: 'technician_task',
      taskId: Number(task.id || 0) || 0,
      mode: mode || 'assigned'
    }
  });
  if (!result?.success && !result?.skipped) {
    logger.warn(`[TechnicianPush] Gagal kirim push tugas #${task.id}: ${result?.reason || result?.error || 'unknown-error'}`);
  }
  return Boolean(result?.success);
}

function buildTechnicianCustomerApprovalMessage({ requestRow = {}, technician = {}, customer = {}, reviewNote = '', adminName = '', baseUrl = '' } = {}) {
  const techName = String(technician.name || technician.username || 'Teknisi').trim() || 'Teknisi';
  const customerName = String(customer.name || requestRow.customer_name || '-').trim() || '-';
  const customerPhone = String(customer.phone || requestRow.customer_phone || '-').trim() || '-';
  const pppoeUsername = String(customer.pppoe_username || requestRow.pppoe_username || '').trim();
  const portalLink = `${String(baseUrl || resolveAppBaseUrl()).replace(/\/+$/, '')}/tech/customers/new`;
  const lines = [
    '*PENGAJUAN DISETUJUI*',
    '',
    `Halo ${techName},`,
    `Pengajuan pelanggan sudah disetujui oleh ${String(adminName || 'Admin').trim() || 'Admin'}.`,
    '',
    `Pelanggan: ${customerName}`,
    `No. HP: ${customerPhone}`
  ];
  if (pppoeUsername) lines.push(`PPPoE: ${pppoeUsername}`);
  if (reviewNote) lines.push(`Catatan: ${reviewNote}`);
  lines.push('', `Buka portal teknisi: ${portalLink}`);
  return lines.join('\n');
}

async function notifyTechnicianCustomerApproval({ requestRow = {}, customer = {}, reviewNote = '', adminName = '', baseUrl = '' } = {}) {
  const technician = techSvc.getTechById(requestRow.technician_id);
  if (!technician) return { skipped: true, reason: 'technician-not-found' };
  const message = buildTechnicianCustomerApprovalMessage({ requestRow, technician, customer, reviewNote, adminName, baseUrl });
  const results = {};

  if (technician.phone) {
    results.whatsapp = await trySendWhatsappPayment(technician.phone, message);
  }

  const settings = getSettings();
  if (isPushConfigured(settings)) {
    const customerName = String(customer.name || requestRow.customer_name || 'Pelanggan').trim();
    const pushResult = await sendPushToTechnician(technician, {
      settings,
      title: 'Pengajuan pelanggan disetujui',
      message: `${customerName} sudah disetujui admin.`,
      targetUrl: `${String(baseUrl || resolveAppBaseUrl()).replace(/\/+$/, '')}/tech/customers/new`,
      data: {
        kind: 'technician_customer_approved',
        requestId: Number(requestRow.id || 0) || null,
        customerId: Number(customer.id || 0) || null
      },
      timeoutMs: 7000
    });
    results.push = Boolean(pushResult?.success);
  }

  return results;
}

async function notifyCustomerWelcomeAfterApproval(customer, options = {}) {
  if (!customer?.id) return { skipped: true, reason: 'customer-not-found' };
  const baseUrl = String(options.baseUrl || resolveAppBaseUrl()).trim();
  const results = {};
  try {
    customerSvc.addPortalNotification(customer.id, {
      kind: 'welcome',
      tab: 'home',
      title: 'Selamat datang',
      body: `Akun pelanggan ${customer.name || ''} sudah aktif. Anda bisa membuka portal pelanggan untuk cek layanan dan tagihan.`,
      payload: {
        source: 'technician-approval',
        customerId: Number(customer.id || 0) || null
      }
    }, { push: true, dedupeWindowMs: 10 * 60 * 1000 });
    results.portal = true;
  } catch (error) {
    logger.warn(`[CustomerApproval] Gagal membuat notifikasi welcome pelanggan ${customer.id}: ${error.message || String(error)}`);
    results.portal = false;
  }

  if (customer.phone) {
    const welcomeMessage = buildWelcomeWhatsappMessage(customer, { baseUrl });
    if (welcomeMessage) {
      results.whatsapp = await trySendWhatsappPayment(customer.phone, welcomeMessage);
    }
  }
  return results;
}

function resolveWhatsappTestRecipient(whatsappStatus = null, requestedPhone = '') {
  const linkedDigits = String(whatsappStatus?.user?.id || '')
    .split(':')[0]
    .replace(/\D/g, '');
  const linkedPhone = linkedDigits
    ? (linkedDigits.startsWith('0') ? `62${linkedDigits.slice(1)}` : linkedDigits)
    : '';
  const normalizePhone = (value = '') => normalizePhoneDigits(value);
  const requestedTarget = normalizePhone(requestedPhone);
  if (requestedTarget) return requestedTarget;

  const configuredTestNumber = normalizePhone(getSetting('whatsapp_test_number', ''));
  if (configuredTestNumber) return configuredTestNumber;

  const adminNumbers = Array.isArray(getSetting('whatsapp_admin_numbers', []))
    ? getSetting('whatsapp_admin_numbers', [])
    : [];
  const configuredTargets = [
    ...adminNumbers,
    getSetting('company_phone', '')
  ]
    .map(normalizePhone)
    .filter(Boolean);

  const preferredExternal = configuredTargets.find((phone) => phone && phone !== linkedPhone);
  if (preferredExternal) return preferredExternal;

  const fallback = configuredTargets[0] || '';
  if (fallback && linkedPhone && fallback === linkedPhone) return '';
  return fallback;
}

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat mengakses halaman ini.' };
  return res.redirect('/admin');
}

function restrictCashierInfrastructureAccess(req, res, next) {
  if (!req.session?.isCashier || req.session?.isAdmin) return next();
  const isApiRequest = String(req.path || '').startsWith('/api/');
  if (isApiRequest) {
    return res.status(403).json({ error: 'Akun kasir tidak memiliki akses ke menu jaringan, MikroTik, atau ONU.' });
  }
  return res.redirect('/admin');
}

function restrictCashierLimitedAccess(req, res, next) {
  if (!req.session?.isCashier || req.session?.isAdmin) return next();
  const isApiRequest = String(req.path || '').startsWith('/api/');
  if (isApiRequest) {
    return res.status(403).json({ error: 'Akun kasir hanya dapat melihat pelanggan, tagihan, pelunasan, dan monitor agent.' });
  }
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }
function companyLogo() { return String(getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png'; }

function normalizeAdminReturnTo(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//') || raw.includes('\\')) return '';
  try {
    const parsed = new URL(raw, 'http://admin.local');
    if (parsed.origin !== 'http://admin.local') return '';
    const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!target.startsWith('/admin')) return '';
    if (/^\/admin\/(?:login|logout)(?:\/|$|\?)/i.test(target)) return '';
    if (/^\/admin\/api(?:\/|$|\?)/i.test(target)) return '';
    return target;
  } catch (_error) {
    return '';
  }
}

function adminPathSection(pathValue) {
  const pathname = String(pathValue || '').split('?')[0].split('#')[0];
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'admin' ? (parts[1] || '') : '';
}

function shouldPreferAdminReturnTo(req, redirectTarget, returnTo) {
  if (!returnTo || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())) return false;
  const rawRedirect = String(redirectTarget || '').trim();
  if (!rawRedirect || rawRedirect === 'back' || rawRedirect.startsWith('//')) return false;
  try {
    const parsedRedirect = new URL(rawRedirect, 'http://admin.local');
    if (parsedRedirect.origin !== 'http://admin.local') return false;
    const redirectPath = parsedRedirect.pathname || '';
    const returnPath = new URL(returnTo, 'http://admin.local').pathname || '';
    if (!redirectPath.startsWith('/admin') || !returnPath.startsWith('/admin')) return false;
    if (/^\/admin\/(?:login|logout)(?:\/|$)/i.test(redirectPath)) return false;
    if (/^\/admin\/api(?:\/|$)/i.test(redirectPath)) return false;
    return adminPathSection(redirectPath) === adminPathSection(returnPath);
  } catch (_error) {
    return false;
  }
}

router.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  const originalSafeRedirect = typeof res.safeRedirect === 'function' ? res.safeRedirect.bind(res) : null;

  const getReturnTo = () => normalizeAdminReturnTo(
    req.body?._admin_return_to ||
    req.body?.return_to ||
    req.query?._admin_return_to ||
    req.query?.return_to ||
    ''
  );

  res.redirect = function adminReturnAwareRedirect(statusOrUrl, maybeUrl) {
    const hasStatus = typeof statusOrUrl === 'number';
    const redirectTarget = hasStatus ? maybeUrl : statusOrUrl;
    const returnTo = getReturnTo();
    if (typeof redirectTarget === 'string' && shouldPreferAdminReturnTo(req, redirectTarget, returnTo)) {
      return hasStatus ? originalRedirect(statusOrUrl, returnTo) : originalRedirect(returnTo);
    }
    return hasStatus ? originalRedirect(statusOrUrl, maybeUrl) : originalRedirect(statusOrUrl);
  };

  res.safeRedirect = function adminReturnAwareSafeRedirect(target, fallback = '/admin') {
    const returnTo = getReturnTo();
    const redirectTarget = target || fallback;
    if (shouldPreferAdminReturnTo(req, redirectTarget, returnTo)) {
      return originalRedirect(returnTo);
    }
    if (originalSafeRedirect) return originalSafeRedirect(target, fallback);
    return originalRedirect(redirectTarget || fallback || '/admin');
  };

  next();
});

router.use([
  /^\/olts(?:\/.*)?$/,
  '/map',
  '/devices',
  '/bulk',
  /^\/mikrotik(?:\/.*)?$/,
  /^\/vouchers(?:\/.*)?$/,
  /^\/routers(?:\/.*)?$/,
  /^\/api\/mikrotik(?:\/.*)?$/,
  /^\/api\/devices(?:\/.*)?$/,
  /^\/api\/device(?:\/.*)?$/,
  /^\/api\/bulk(?:\/.*)?$/
], requireAdminSession, restrictCashierInfrastructureAccess);

router.use([
  /^\/tickets(?:\/.*)?$/,
  /^\/packages(?:\/.*)?$/,
  /^\/settings(?:\/.*)?$/,
  /^\/backup(?:\/.*)?$/,
  /^\/update(?:\/.*)?$/,
  /^\/audit-logs(?:\/.*)?$/,
  /^\/inventory(?:\/.*)?$/,
  /^\/whatsapp(?:\/.*)?$/,
  /^\/collector-payments(?:\/.*)?$/,
  /^\/cashiers\/reports(?:\/.*)?$/,
  /^\/agents\/reports(?:\/.*)?$/
], requireAdminSession, restrictCashierLimitedAccess);

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
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const periods = (Array.isArray(invoices) ? invoices : [])
    .map((inv) => {
      const month = Number(inv?.period_month || 0);
      const year = Number(inv?.period_year || 0);
      if (!month || !year) return '';
      return `${monthNames[month - 1] || String(month).padStart(2, '0')} ${year}`;
    })
    .filter(Boolean);
  return periods.length ? periods.join(', ') : '-';
}

function formatRupiahValue(value) {
  return Number(Math.max(0, Number(value || 0) || 0)).toLocaleString('id-ID');
}

function resolveInvoiceTaxSource(primaryInvoice = null, customer = {}) {
  const includePpnRaw =
    primaryInvoice?.package_include_ppn ??
    primaryInvoice?.include_ppn ??
    customer?.package_include_ppn ??
    customer?.include_ppn ??
    0;
  const ppnPercentRaw =
    primaryInvoice?.package_ppn_percent ??
    primaryInvoice?.ppn_percent ??
    customer?.package_ppn_percent ??
    customer?.ppn_percent ??
    0;
  return {
    include_ppn: Number(includePpnRaw || 0) === 1 ? 1 : 0,
    ppn_percent: Math.max(0, Number(ppnPercentRaw || 0) || 0)
  };
}

function computeWhatsappTaxBreakdown(amount, taxSource = {}) {
  const nominalInvoice = Math.max(0, Number(amount || 0) || 0);
  const includePpn = Number(taxSource.include_ppn || 0) === 1;
  const ppnPercent = includePpn ? Math.max(0, Number(taxSource.ppn_percent || 0) || 0) : 0;
  if (!includePpn || ppnPercent <= 0) {
    return { saleAmount: nominalInvoice, ppnAmount: 0, nominalInvoice, ppnPercent: 0 };
  }
  const saleAmount = Math.round(nominalInvoice / (1 + (ppnPercent / 100)));
  const ppnAmount = Math.max(0, nominalInvoice - saleAmount);
  return { saleAmount, ppnAmount, nominalInvoice, ppnPercent };
}

function buildPaymentGuideMessage(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const invoiceList = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  const primaryInvoice = fallbackInvoice || invoiceList[0] || null;
  const effectiveInvoices = invoiceList.length ? invoiceList : (primaryInvoice ? [primaryInvoice] : []);
  const totalTagihan = effectiveInvoices.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const taxSource = resolveInvoiceTaxSource(primaryInvoice, customer);
  const breakdown = computeWhatsappTaxBreakdown(totalTagihan || Number(primaryInvoice?.amount || 0), taxSource);
  const baseInvoiceAmount = Math.max(0, Number(primaryInvoice?.amount || 0) || 0);
  const qrisAmountUnique = Math.max(0, Number(primaryInvoice?.qris_amount_unique || 0) || 0);
  const qrisCode = Math.max(0, Number(primaryInvoice?.qris_unique_code || 0) || 0);
  const uniqueDelta = qrisAmountUnique > baseInvoiceAmount ? (qrisAmountUnique - baseInvoiceAmount) : qrisCode;
  const lines = [];

  if (breakdown.ppnAmount > 0) {
    lines.push(
      '',
      `Rincian: Dasar Rp ${formatRupiahValue(breakdown.saleAmount)} + PPN ${Number(breakdown.ppnPercent || 0).toLocaleString('id-ID')}% Rp ${formatRupiahValue(breakdown.ppnAmount)}`
    );
  }

  if (effectiveInvoices.length > 1) {
    lines.push(
      '',
      `Total semua tagihan aktif: Rp ${formatRupiahValue(totalTagihan)} (${effectiveInvoices.length} bulan/tagihan)`,
      'Bayar Online bisa sekaligus semua tagihan atau pilih 1 bulan saja.',
      'Jika transfer manual, bayar sesuai total bulan yang dipilih lalu kirim bukti ke admin.'
    );
    return lines.join('\n').trim();
  }

  if (baseInvoiceAmount > 0 && qrisAmountUnique > 0 && uniqueDelta > 0) {
    lines.push(
      '',
      `Nominal otomatis: Rp ${formatRupiahValue(qrisAmountUnique)}`,
      `Kode pembayaran: ${String(qrisCode || uniqueDelta).padStart(3, '0')}`,
      'Pilih Bayar Online dan ikuti nominal tersebut agar otomatis terbaca lunas.'
    );
  }

  return lines.join('\n').trim();
}

function resolveStaticQrisPaymentSettings(settings = getSettings()) {
  return {
    qrUrl: String(settings?.qris_static_qr_url || '').trim(),
    payload: String(settings?.qris_static_payload || '').trim()
  };
}

async function buildInvoiceQrisImageBuffer(invoice, settings = getSettings()) {
  const exactAmount = Number(invoice?.qris_amount_unique || invoice?.amount || 0) || 0;
  const qrisConfig = resolveStaticQrisPaymentSettings(settings);
  if (!exactAmount || !qrisConfig.payload) return Buffer.alloc(0);
  const dynamicPayload = buildDynamicQrisPayload(qrisConfig.payload, exactAmount);
  if (!dynamicPayload) return Buffer.alloc(0);
  return buildDynamicQrisBuffer(dynamicPayload, { width: 720, margin: 1 });
}

function wantsJsonResponse(req) {
  const accept = String(req?.headers?.accept || '').toLowerCase();
  const requestedWith = String(req?.headers?.['x-requested-with'] || '').toLowerCase();
  return requestedWith === 'xmlhttprequest' || accept.includes('application/json') || req?.body?.ajax === '1';
}

function buildWhatsappCustomerPayload(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const invoiceList = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  let primaryInvoice = fallbackInvoice || invoiceList[0] || null;
  if (
    primaryInvoice &&
    String(primaryInvoice.status || 'unpaid').toLowerCase() === 'unpaid' &&
    (!Number(primaryInvoice.qris_amount_unique || 0) || !Number(primaryInvoice.qris_unique_code || 0)) &&
    String(getSetting('qris_static_payload', '') || '').trim()
  ) {
    try {
      const assigned = billingSvc.assignUniqueQrisForInvoice(primaryInvoice.id);
      if (assigned) {
        primaryInvoice = { ...primaryInvoice, ...assigned };
        const idx = invoiceList.findIndex((inv) => Number(inv.id || 0) === Number(primaryInvoice.id || 0));
        if (idx >= 0) invoiceList[idx] = { ...invoiceList[idx], ...assigned };
      }
    } catch (error) {
      logger.warn(`[WA Billing] Gagal auto-assign kode unik INV-${primaryInvoice.id}: ${error.message || error}`);
    }
  }
  const totalTagihan = invoiceList.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const effectiveTotalTagihan = totalTagihan || Number(primaryInvoice?.amount || 0) || 0;
  const taxSource = resolveInvoiceTaxSource(primaryInvoice, customer);
  const taxBreakdown = computeWhatsappTaxBreakdown(effectiveTotalTagihan, taxSource);
  const primaryAmount = Number(primaryInvoice?.amount || 0) || 0;
  const qrisAmountUnique = Number(primaryInvoice?.qris_amount_unique || 0) || 0;
  const qrisUniqueCode = Number(primaryInvoice?.qris_unique_code || 0) || 0;
  const uniqueDelta = qrisAmountUnique > primaryAmount ? (qrisAmountUnique - primaryAmount) : qrisUniqueCode;
  const paymentGuide = buildPaymentGuideMessage(customer, invoiceList, primaryInvoice, options);
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
  const invoiceNumbers = (invoiceList.length ? invoiceList : (primaryInvoice ? [primaryInvoice] : []))
    .map((invoice) => Number(invoice?.id || 0) > 0 ? `INV-${invoice.id}` : '')
    .filter(Boolean);
  return {
    nama: customer?.name || 'Pelanggan',
    paket: packageLabel,
    tagihan: Number(effectiveTotalTagihan || 0).toLocaleString('id-ID'),
    tagihan_dasar: formatRupiahValue(taxBreakdown.saleAmount),
    ppn: formatRupiahValue(taxBreakdown.ppnAmount),
    ppn_percent: Number(taxBreakdown.ppnPercent || 0).toLocaleString('id-ID'),
    tagihan_total: formatRupiahValue(taxBreakdown.nominalInvoice),
    qris_tagihan: formatRupiahValue(primaryAmount),
    qris_kode: qrisUniqueCode > 0 ? String(qrisUniqueCode).padStart(3, '0') : '',
    qris_nominal: qrisAmountUnique > 0 ? formatRupiahValue(qrisAmountUnique) : '',
    qris_total: qrisAmountUnique > 0 ? formatRupiahValue(qrisAmountUnique) : '',
    qris_penjumlahan: qrisAmountUnique > 0 && uniqueDelta > 0
      ? `Rp ${formatRupiahValue(primaryAmount)} + ${formatRupiahValue(uniqueDelta)} = Rp ${formatRupiahValue(qrisAmountUnique)}`
      : '',
    payment_guide: paymentGuide,
    rincian: formatInvoicePeriods(primaryInvoice ? invoiceList.length ? invoiceList : [primaryInvoice] : invoiceList),
    jatuh_tempo: primaryInvoice ? formatInvoiceDueDate(primaryInvoice, customer) : '-',
    link: checkBillingLink,
    portal_link: portalLink,
    invoice_link: invoiceLink || checkBillingLink,
    receipt_link: receiptLink || invoiceLink || checkBillingLink,
    invoice_no: invoiceNumbers.length ? invoiceNumbers.join(', ') : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: groupLink,
    group_line: groupLink ? `Grup pelanggan: ${groupLink}` : ''
  };
}

function buildBroadcastAnnouncementMessage(customer, template, options = {}) {
  const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
  const primaryInvoice = Array.isArray(unpaidInvoices) && unpaidInvoices.length ? unpaidInvoices[0] : null;
  const payload = buildWhatsappCustomerPayload(customer, unpaidInvoices, primaryInvoice, options);
  return fillWhatsappTemplate(template, {
    ...payload,
    company: company()
  }).trim();
}

function buildBillingWhatsappMessage(customer, invoices = [], fallbackInvoice = null, options = {}) {
  const template = String(
    getSetting('whatsapp_billing_message', defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, fallbackInvoice, options);
  const hasPaymentGuideToken = /\{\{\s*payment_guide\s*\}\}/i.test(template);
  let message = ensureDueDateLine(fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  }), payload.jatuh_tempo);
  if (!hasPaymentGuideToken && payload.payment_guide) {
    message += `\n\n${payload.payment_guide}`;
  }
  return message;
}

function buildIsolationWhatsappMessage(customer, invoices = [], reasonText = '', options = {}) {
  const template = String(
    getSetting('whatsapp_isolation_message', defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, null, options);
  return ensureDueDateLine(fillWhatsappTemplate(template, {
    ...payload,
    alasan: reasonText || 'Masih ada tagihan yang belum lunas.',
    company: getSetting('company_header', 'ISP')
  }), payload.jatuh_tempo);
}

function buildDueReminderWhatsappMessage(customer, invoices = [], options = {}) {
  const template = String(
    getSetting('whatsapp_due_reminder_message', defaultDueReminderWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
    defaultDueReminderWhatsappTemplate(getSetting('company_header', 'ISP'))
  ).trim();
  const payload = buildWhatsappCustomerPayload(customer, invoices, null, options);
  return ensureDueDateLine(fillWhatsappTemplate(template, {
    ...payload,
    company: getSetting('company_header', 'ISP')
  }), payload.jatuh_tempo);
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
  const paymentProofLink = payload.receipt_link || payload.invoice_link || payload.link || '';
  const billingLink = buildCustomerCheckBillingLink(customer, options);
  return ensureDueDateLine(fillWhatsappTemplate(template, {
    ...payload,
    link: paymentProofLink || payload.link,
    billing_link: billingLink,
    company: getSetting('company_header', 'ISP'),
    paid_by: formatPublicPaidByName(options.paidBy || '-'),
    paid_at: String(options.paidAt || new Date().toLocaleString('id-ID')).trim()
  }), payload.jatuh_tempo);
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
    package_name: 'Broadband 10 Mbps',
    package_include_ppn: 1,
    package_ppn_percent: 11
  };
  const sampleInvoices = [
    { id: 123, customer_id: 9999, amount: 150000, qris_unique_code: 123, qris_amount_unique: 150123, period_month: 5, period_year: 2026, package_name: 'Broadband 10 Mbps' }
  ];
  if (templateKey === 'welcome') return buildWelcomeWhatsappMessage(sampleCustomer, options);
  if (templateKey === 'due_reminder') return buildDueReminderWhatsappMessage(sampleCustomer, sampleInvoices, options);
  if (templateKey === 'isolation') return buildIsolationWhatsappMessage(sampleCustomer, sampleInvoices, 'Masih ada tagihan yang belum lunas.', options);
  if (templateKey === 'reactivation') return buildReactivationWhatsappMessage(sampleCustomer, options);
  if (templateKey === 'paid') return buildPaidWhatsappMessage(sampleCustomer, sampleInvoices, sampleInvoices[0], { ...options, paidBy: 'TRIPAY - BAYAR ONLINE', paidAt: '10 Mei 2026 12:00' });
  return buildBillingWhatsappMessage(sampleCustomer, sampleInvoices, sampleInvoices[0], options);
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  const cashierLegacyMessages = new Set([
    'Akun kasir hanya difokuskan untuk pembayaran dan pembukuan.',
    'Akun kasir hanya bisa melihat pelanggan, tagihan, pelunasan, dan monitor agent.'
  ]);
  if (m && cashierLegacyMessages.has(String(m.text || '').trim())) {
    return null;
  }
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

router.use(/^\/digiflazz(?:\/.*)?$/, requireAdminSession, restrictToAdmin, (req, res) => {
  req.session._msg = { type: 'warning', text: 'Menu Digiflazz sudah dinonaktifkan dari panel admin.' };
  return res.redirect('/admin/settings');
});

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
    'snapshot',
    'summary',
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

function getMonitoringCountKey(row, candidates = []) {
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      const computed = String(candidate(row) || '').trim();
      if (computed) return computed;
      continue;
    }
    const value = String(row?.[candidate] || '').trim();
    if (value) return value;
  }
  return '';
}

function countUniqueMonitoringRows(rows = [], candidates = []) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = getMonitoringCountKey(row, candidates);
    if (!key) continue;
    seen.add(key);
  }
  return seen.size;
}

function getNormalizedMonitoringIdentity(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) return normalized;
  }
  return '';
}

function countUniquePppoeUsers(rows = []) {
  return countUniqueMonitoringRows(rows, [
    (row) => getNormalizedMonitoringIdentity(row?.name, row?.user, row?.username)
  ]);
}

function countUniqueHotspotUsers(rows = []) {
  return countUniqueMonitoringRows(rows, [
    (row) => getNormalizedMonitoringIdentity(row?.name, row?.user, row?.username)
  ]);
}

function parseRouterIdParam(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRouterSelection(value, options = {}) {
  const requestedRouterId = parseRouterIdParam(value);
  if (!requestedRouterId) {
    return { routerId: null, requestedRouterId: null, missingRequestedRouter: false };
  }
  const router = mikrotikService.getRouterById(requestedRouterId);
  if (router) {
    return { routerId: requestedRouterId, requestedRouterId, missingRequestedRouter: false, router };
  }
  if (options.fallbackToNull === false) {
    return { routerId: requestedRouterId, requestedRouterId, missingRequestedRouter: true, router: null };
  }
  return { routerId: null, requestedRouterId, missingRequestedRouter: true, router: null };
}

function buildMissingRouterApiError(requestedRouterId) {
  return {
    error: `Router dengan ID ${requestedRouterId} sudah dihapus. Silakan pilih router lain atau muat ulang halaman.`,
    code: 'router_not_found',
    requestedRouterId
  };
}

function buildCollectorMetadata(snapshot) {
  const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    snapshotAt: raw.snapshotAt || null,
    ageMs: Number.isFinite(Number(raw.ageMs)) ? Number(raw.ageMs) : null,
    source: String(raw.source || 'collector').trim() || 'collector',
    routerReachable: Boolean(raw.routerReachable),
    collectorStatus: String(raw.collectorStatus || 'warming_up').trim() || 'warming_up',
    partialFailure: Boolean(raw.partialFailure),
    sections: raw.sections && typeof raw.sections === 'object' ? raw.sections : {}
  };
}

function getPendingCustomerRequestCount() {
  const technicianRequests = Number(db.prepare("SELECT COUNT(1) AS c FROM technician_customer_requests WHERE status = 'pending'").get()?.c || 0);
  const packageChangeRequests = packageChangeSvc.countPendingRequests();
  const profileChangeRequests = Number(db.prepare("SELECT COUNT(1) AS c FROM customer_profile_change_requests WHERE status = 'pending'").get()?.c || 0);
  return technicianRequests + packageChangeRequests + profileChangeRequests;
}

function getPendingApprovalBreakdown() {
  const technicianCustomerRequests = Number(db.prepare("SELECT COUNT(1) AS c FROM technician_customer_requests WHERE status = 'pending'").get()?.c || 0);
  const packageChangeRequests = packageChangeSvc.countPendingRequests();
  const profileChangeRequests = Number(db.prepare("SELECT COUNT(1) AS c FROM customer_profile_change_requests WHERE status = 'pending'").get()?.c || 0);
  const collectorRequests = Number(db.prepare("SELECT COUNT(1) AS c FROM collector_payment_requests WHERE status = 'pending'").get()?.c || 0);
  return {
    technicianCustomerRequests,
    packageChangeRequests,
    profileChangeRequests,
    collectorRequests,
    customerRequests: technicianCustomerRequests + packageChangeRequests + profileChangeRequests,
    total: technicianCustomerRequests + packageChangeRequests + profileChangeRequests + collectorRequests
  };
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
    pendingCustomerRequests: getPendingCustomerRequestCount(),
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
      desc: 'Broadcast info via WhatsApp dan Push App',
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
      label: 'Pengelolaan Akun',
      shortLabel: 'Akun',
      desc: 'Pengelolaan akun teknisi, kasir, dan kolektor',
      href: '/admin/accounts',
      icon: 'bi-person-workspace',
      tone: 'violet',
      countLabel: summary.activeTechnicians > 0 ? String(summary.activeTechnicians) : '',
      badge: summary.activeTechnicians > 0 ? `${summary.activeTechnicians} teknisi` : 'atur'
    });
    shortcuts.splice(8, 0, {
      label: 'Approval Pelanggan',
      shortLabel: 'Approve',
      desc: 'Pengajuan pelanggan baru dan pindah paket',
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
    return shortcuts.filter((item) => ['Tagihan', 'Pelanggan', 'Pembukuan'].includes(item.shortLabel || item.label));
  }

  const shortcutOrder = ['Tagihan', 'Pelanggan', 'MikroTik', 'Peta', 'Gangguan', 'Teknisi', 'Approve', 'Pembukuan', 'Isolir', 'Voucher', 'WA', 'Approval', 'Setting'];
  shortcuts.sort((a, b) => {
    const left = shortcutOrder.indexOf(a.shortLabel || a.label);
    const right = shortcutOrder.indexOf(b.shortLabel || b.label);
    return (left === -1 ? 999 : left) - (right === -1 ? 999 : right);
  });

  return shortcuts;
}

function getDashboardFinanceSnapshot({ year, month } = {}) {
  const now = new Date();
  const filterYear = Math.max(2000, parseInt(year, 10) || now.getFullYear());
  const filterMonth = Math.max(1, Math.min(12, parseInt(month, 10) || (now.getMonth() + 1)));
  const monthlyDataRaw = billingSvc.getMonthlyRevenue(filterYear);
  const billingMonthlyData = Array.isArray(monthlyDataRaw) ? monthlyDataRaw : [];
  const billingMonthlyMap = new Map(billingMonthlyData.map((item) => [Number(item.month || 0), item]));
  const monthlyData = [];

  for (let itemMonth = 1; itemMonth <= 12; itemMonth++) {
    const billingBucket = billingMonthlyMap.get(itemMonth) || {
      month: itemMonth,
      revenue: 0,
      paid_amount: 0,
      unpaid_amount: 0,
      total_invoices: 0,
      paid_count: 0,
      unpaid_count: 0,
      ontime_paid_count: 0,
      ontime_paid_amount: 0,
      late_paid_count: 0,
      late_paid_amount: 0
    };
    const bookkeepingSummary = bookkeepingSvc.getSummary({ month: itemMonth, year: filterYear }) || {};
    const expenseAmount = Number(bookkeepingSummary.total_expense || 0);
    const bookkeepingIncomeAmount = Number(bookkeepingSummary.total_income || 0);

    monthlyData.push({
      ...billingBucket,
      expense_amount: expenseAmount,
      expense_count: Number(bookkeepingSummary.expense_count || 0),
      bookkeeping_income_amount: bookkeepingIncomeAmount,
      bookkeeping_income_count: Number(bookkeepingSummary.income_count || 0),
      net_amount: Number(billingBucket.revenue || 0) - expenseAmount
    });
  }

  const selectedMonthData = monthlyData.find((item) => Number(item.month || 0) === filterMonth) || {
    month: filterMonth,
    revenue: 0,
    paid_amount: 0,
    unpaid_amount: 0,
    total_invoices: 0,
    paid_count: 0,
    unpaid_count: 0,
    ontime_paid_count: 0,
    ontime_paid_amount: 0,
    late_paid_count: 0,
    late_paid_amount: 0,
    expense_amount: 0,
    expense_count: 0,
    bookkeeping_income_amount: 0,
    bookkeeping_income_count: 0,
    net_amount: 0
  };

  const recentPaymentsRaw = billingSvc.getRecentPayments(40);
  const recentPayments = (Array.isArray(recentPaymentsRaw) ? recentPaymentsRaw : []).filter((row) => {
    if (!row?.paid_at) return false;
    const paidAt = new Date(row.paid_at);
    return paidAt.getFullYear() === filterYear && (paidAt.getMonth() + 1) === filterMonth;
  }).slice(0, 6);

  return {
    filterYear,
    filterMonth,
    monthlyData,
    selectedMonthData,
    recentPayments
  };
}

function getDashboardPriorityCollections(limit = 6) {
  const now = new Date();
  const rows = db.prepare(`
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
    ORDER BY
      i.period_year ASC,
      i.period_month ASC,
      COALESCE(i.due_day_snapshot, 31) ASC,
      i.amount DESC,
      c.name ASC
    LIMIT ?
  `).all(limit * 3);

  const prioritized = (Array.isArray(rows) ? rows : []).map((row) => {
    const month = Math.max(1, Number(row.period_month || 1));
    const year = Math.max(2000, Number(row.period_year || now.getFullYear()));
    const fallbackDay = Math.max(1, Number(row.due_day_snapshot || 1));
    const lastDay = new Date(year, month, 0).getDate() || 31;
    const dueDay = Math.min(fallbackDay, lastDay);
    const dueDate = new Date(year, month - 1, dueDay, 23, 59, 59, 999);
    const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return {
      ...row,
      dueDay,
      dueDateIso: dueDate.toISOString(),
      daysLeft
    };
  }).sort((a, b) => {
    if (Number(a.daysLeft) !== Number(b.daysLeft)) return Number(a.daysLeft) - Number(b.daysLeft);
    return Number(b.amount || 0) - Number(a.amount || 0);
  });

  return prioritized.slice(0, limit);
}

function parseMonitoringListQuery(req, defaultLimit = 25) {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 100)
    : defaultLimit;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'all';
  const wantsMeta = q.length > 0 || 'page' in req.query || 'limit' in req.query || ('status' in req.query && status !== 'all');
  return { page, limit, q, status, wantsMeta };
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

function replaceDirSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  copyDirSync(srcDir, destDir);
}

function getUpdateBackupTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

function copyFileIfExists(src, dest) {
  if (!src || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function summarizeSqliteDatabase(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, integrity: 'missing' };
  }

  let probe = null;
  try {
    const Database = require('better-sqlite3');
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const count = (table) => {
      try {
        return probe.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      } catch (_error) {
        return null;
      }
    };
    return {
      exists: true,
      integrity: probe.prepare('PRAGMA integrity_check').get().integrity_check,
      customers: count('customers'),
      invoices: count('invoices'),
      bookkeeping_entries: count('bookkeeping_entries'),
      packages: count('packages'),
      routers: count('routers')
    };
  } catch (error) {
    return { exists: true, integrity: 'error', error: error.message };
  } finally {
    try {
      if (probe) probe.close();
    } catch (_error) {}
  }
}

function copyRuntimeDirectory(srcDir, destDir, options = {}) {
  if (!srcDir || !fs.existsSync(srcDir)) return false;
  const exclude = options.exclude || null;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (exclude && exclude(entry.name, path.join(srcDir, entry.name))) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDirectory(src, dest, options);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
  return true;
}

function restoreRuntimeDirectory(srcDir, destDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return false;
  replaceDirSync(srcDir, destDir);
  return true;
}

function listAuthRuntimeDirectories(repoRoot, configuredAuthPath) {
  const dirs = new Set();
  if (configuredAuthPath && fs.existsSync(configuredAuthPath) && fs.statSync(configuredAuthPath).isDirectory()) {
    dirs.add(path.resolve(configuredAuthPath));
  }
  try {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^auth_info_baileys/i.test(entry.name)) {
        dirs.add(path.join(repoRoot, entry.name));
      }
    }
  } catch (_error) {}
  return Array.from(dirs);
}

async function createUpdateRuntimeBackup({
  repoRoot,
  settingsPath,
  privateSettingsPath,
  dbDir,
  authPath,
  uploadsPath
}) {
  const backupRoot = path.join(repoRoot, 'backups', 'update-runtime', getUpdateBackupTimestamp());
  const backupDbDir = path.join(backupRoot, 'database');
  const manifest = {
    createdAt: new Date().toISOString(),
    repoRoot,
    backupRoot,
    settings: {},
    database: {},
    authDirectories: [],
    uploads: false
  };

  fs.mkdirSync(backupRoot, { recursive: true });

  if (copyFileIfExists(settingsPath, path.join(backupRoot, 'settings.operational.json'))) {
    manifest.settings.operational = settingsPath;
  }
  if (copyFileIfExists(privateSettingsPath, path.join(backupRoot, 'settings.local.json'))) {
    manifest.settings.private = privateSettingsPath;
  }

  const activeDbPath = path.join(dbDir, 'billing.db');
  if (fs.existsSync(activeDbPath)) {
    fs.mkdirSync(backupDbDir, { recursive: true });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      manifest.database.checkpoint = true;
    } catch (error) {
      manifest.database.checkpoint = false;
      manifest.database.checkpointError = error.message;
    }
    await db.backup(path.join(backupDbDir, 'billing.db'));
    copyRuntimeDirectory(dbDir, backupDbDir, {
      exclude: (name) => ['billing.db', 'billing.db-wal', 'billing.db-shm'].includes(name)
    });
    manifest.database.source = activeDbPath;
    manifest.database.summary = summarizeSqliteDatabase(path.join(backupDbDir, 'billing.db'));
  } else if (fs.existsSync(dbDir)) {
    copyRuntimeDirectory(dbDir, backupDbDir);
    manifest.database.source = dbDir;
    manifest.database.summary = summarizeSqliteDatabase(path.join(backupDbDir, 'billing.db'));
  }

  for (const sourceDir of listAuthRuntimeDirectories(repoRoot, authPath)) {
    const dest = path.join(backupRoot, 'auth', path.basename(sourceDir));
    copyRuntimeDirectory(sourceDir, dest);
    manifest.authDirectories.push({ source: sourceDir, backup: dest });
  }

  if (uploadsPath && fs.existsSync(uploadsPath)) {
    manifest.uploads = copyRuntimeDirectory(uploadsPath, path.join(backupRoot, 'public_uploads'));
  }

  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function restoreUpdateRuntimeBackup(manifest, {
  privateSettingsPath,
  dbDir,
  authPath,
  uploadsPath
}) {
  if (!manifest || !manifest.backupRoot) return { restored: false, reason: 'manifest kosong' };
  const backupRoot = manifest.backupRoot;
  const backupPrivateSettings = path.join(backupRoot, 'settings.local.json');
  const backupOperationalSettings = path.join(backupRoot, 'settings.operational.json');
  if (fs.existsSync(backupPrivateSettings)) {
    copyFileIfExists(backupPrivateSettings, privateSettingsPath);
  } else if (fs.existsSync(backupOperationalSettings)) {
    copyFileIfExists(backupOperationalSettings, privateSettingsPath);
  }

  const backupDbDir = path.join(backupRoot, 'database');
  if (fs.existsSync(backupDbDir)) {
    restoreRuntimeDirectory(backupDbDir, dbDir);
  }

  const authRoot = path.join(backupRoot, 'auth');
  if (fs.existsSync(authRoot)) {
    for (const entry of fs.readdirSync(authRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const defaultDest = path.join(path.dirname(authPath), entry.name);
      const dest = entry.name === path.basename(authPath) ? authPath : defaultDest;
      restoreRuntimeDirectory(path.join(authRoot, entry.name), dest);
    }
  }

  const backupUploads = path.join(backupRoot, 'public_uploads');
  if (fs.existsSync(backupUploads)) {
    restoreRuntimeDirectory(backupUploads, uploadsPath);
  }

  return {
    restored: true,
    backupRoot,
    database: summarizeSqliteDatabase(path.join(dbDir, 'billing.db'))
  };
}

function assertRestoredRuntimeIsSafe(manifest, restored) {
  const before = manifest?.database?.summary || {};
  const after = restored?.database || {};
  if (!before.exists) return;
  if (!after.exists || after.integrity !== 'ok') {
    throw new Error(`Restore database runtime gagal atau tidak valid. Backup aman tersimpan di ${manifest.backupRoot}`);
  }
  const beforeCustomers = Number(before.customers || 0);
  const afterCustomers = Number(after.customers || 0);
  const beforeInvoices = Number(before.invoices || 0);
  const afterInvoices = Number(after.invoices || 0);
  if (beforeCustomers > 0 && afterCustomers < beforeCustomers) {
    throw new Error(`Restore database runtime mencurigakan: pelanggan ${beforeCustomers} menjadi ${afterCustomers}. Backup aman tersimpan di ${manifest.backupRoot}`);
  }
  if (beforeInvoices > 0 && afterInvoices < beforeInvoices) {
    throw new Error(`Restore database runtime mencurigakan: tagihan ${beforeInvoices} menjadi ${afterInvoices}. Backup aman tersimpan di ${manifest.backupRoot}`);
  }
}

function cleanupOldUpdateRuntimeBackups(repoRoot, keep = 20) {
  const root = path.join(repoRoot, 'backups', 'update-runtime');
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      const stats = fs.statSync(fullPath);
      return { fullPath, mtime: stats.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries.slice(Math.max(0, keep))) {
    fs.rmSync(entry.fullPath, { recursive: true, force: true });
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

function getGitCommit(repoRoot, ref = 'HEAD', short = false) {
  const args = ['rev-parse'];
  if (short) args.push('--short');
  args.push(ref);
  const r = runCmd('git', args, repoRoot);
  if (!r.ok) return '';
  return String(r.stdout || '').trim();
}

function getGitStatusLines(repoRoot) {
  const result = runCmd('git', ['status', '--porcelain'], repoRoot);
  if (!result.ok) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function createUpdateSafetyStash(repoRoot, label = `admin-self-update-${Date.now()}`) {
  const statusLines = getGitStatusLines(repoRoot);
  if (!statusLines.length) {
    return {
      created: false,
      label,
      ref: '',
      statusLines,
      result: { ok: true, code: 0, stdout: '', stderr: '' }
    };
  }

  const stashResult = runCmd('git', ['stash', 'push', '--include-untracked', '-m', label], repoRoot);
  if (!stashResult.ok) {
    return {
      created: false,
      label,
      ref: '',
      statusLines,
      result: stashResult
    };
  }

  const stashList = runCmd('git', ['stash', 'list', '--format=%gd::%s'], repoRoot);
  const stashRef = String(stashList.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('::'))
    .find((parts) => parts[1] === label)?.[0] || '';

  return {
    created: true,
    label,
    ref: stashRef,
    statusLines,
    result: stashResult
  };
}

function popUpdateSafetyStash(repoRoot, stashRef = '') {
  const ref = String(stashRef || '').trim();
  if (!ref) return { ok: true, code: 0, stdout: '', stderr: '' };
  return runCmd('git', ['stash', 'pop', ref], repoRoot);
}

function detectPm2Process(repoRoot) {
  const result = runCmd('pm2', ['jlist'], repoRoot);
  if (!result.ok) return null;

  try {
    const repoAbs = path.resolve(repoRoot);
    const appEntry = path.resolve(repoRoot, 'app-customer.js');
    const processes = JSON.parse(String(result.stdout || '[]'));
    const hit = processes.find((proc) => {
      const env = proc && proc.pm2_env ? proc.pm2_env : {};
      const cwd = env.pm_cwd ? path.resolve(String(env.pm_cwd)) : '';
      const execPath = env.pm_exec_path ? path.resolve(String(env.pm_exec_path)) : '';
      return cwd === repoAbs || execPath === appEntry;
    });
    if (!hit) return null;
    return {
      name: String(hit.name || '').trim(),
      pmId: hit.pm_id,
      cwd: hit.pm2_env?.pm_cwd || '',
      execPath: hit.pm2_env?.pm_exec_path || ''
    };
  } catch (_error) {
    return null;
  }
}

function getDefaultPm2ProcessName(repoRoot) {
  const base = path.basename(path.resolve(repoRoot));
  return base || 'billing-rtrw';
}

function queuePm2Restart(processName, repoRoot) {
  const safeName = String(processName || '').trim();
  if (!safeName) return false;
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', `ping 127.0.0.1 -n 3 >nul && pm2 restart "${safeName}" --update-env`], {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return true;
    }

    const shellQuote = `'${safeName.replace(/'/g, `'\\''`)}'`;
    const child = spawn('sh', ['-lc', `sleep 2; pm2 restart ${shellQuote} --update-env >/tmp/codex-update-restart.log 2>&1`], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch (_error) {
    return false;
  }
}

function runProjectValidation(repoRoot) {
  const checks = [
    { label: 'node scripts/check-syntax.js', cmd: 'node', args: ['scripts/check-syntax.js'] },
    { label: 'node scripts/smoke-render.js', cmd: 'node', args: ['scripts/smoke-render.js'] }
  ];
  return checks.map((check) => ({
    ...check,
    result: runCmd(check.cmd, check.args, repoRoot)
  }));
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const localCommit = getGitCommit(repoRoot, 'HEAD', true) || '-';
  const info = {
    localVersion,
    remoteVersion: '-',
    localCommit,
    remoteCommit: '-',
    branch: '-',
    needsUpdate: false,
    error: '',
    originUrl: '',
    repoPath: repoRoot,
    pm2ProcessName: '',
    pm2ProcessId: ''
  };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    info.error = 'Folder ini belum menjadi git repository.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;
  info.originUrl = getGitOriginUrl(repoRoot);
  const pm2Process = detectPm2Process(repoRoot);
  info.pm2ProcessName = pm2Process?.name || getDefaultPm2ProcessName(repoRoot);
  info.pm2ProcessId = pm2Process?.pmId ?? '';

  const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Gagal git fetch: ' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remoteCommit = getGitCommit(repoRoot, `origin/${branch}`, true);
  if (!remoteCommit) {
    info.error = `Tidak bisa membaca commit origin/${branch} dari GitHub.`;
    return info;
  }
  info.remoteCommit = remoteCommit;

  const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  const remoteVersion = remote.ok ? (String(remote.stdout || '').trim() || '-') : '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = remoteCommit !== localCommit || (remoteVersion !== '-' && remoteVersion !== localVersion);
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
  const approvalBreakdown = (req.session?.isAdmin || req.session?.isCashier)
    ? getPendingApprovalBreakdown()
    : { technicianCustomerRequests: 0, packageChangeRequests: 0, collectorRequests: 0, customerRequests: 0, total: 0 };
  res.locals.adminPendingCustomerRequests = approvalBreakdown.customerRequests;
  res.locals.adminPendingTechnicianCustomerRequests = approvalBreakdown.technicianCustomerRequests;
  res.locals.adminPendingPackageChangeRequests = approvalBreakdown.packageChangeRequests;
  res.locals.adminPendingCollectorApprovals = approvalBreakdown.collectorRequests;
  res.locals.adminPendingApprovalsTotal = approvalBreakdown.total;
  const adminOneSignalAppId = String(getSetting('onesignal_app_id', '') || '').trim();
  res.locals.adminPushEnabled = Boolean(req.session?.isAdmin && getSetting('onesignal_enabled', false) === true && adminOneSignalAppId);
  res.locals.adminOneSignalAppId = adminOneSignalAppId;
  res.locals.adminPushExternalId = req.session?.isAdmin
    ? buildAdminPushExternalId({ username: req.session.adminUser || getSetting('admin_username', 'admin') || 'admin' })
    : '';
  next();
});

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', {
    title: 'Admin Login',
    company: company(),
    logoUrl: companyLogo(),
    error: null,
    form: {},
    firstInstallLoginEnabled: isFirstInstallAdminLoginEnabled()
  });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const rememberMe = isRememberMeChecked(req.body.remember_me);
  const adminAuth = authenticateAdminLogin(username, password);
  if (adminAuth.ok) {
    req.session.isAdmin = true;
    req.session.adminUser = adminAuth.username;
    req.session.firstInstallAdminLogin = Boolean(adminAuth.firstInstall);
    applyAdminLoginSession(req, rememberMe);
    const nextUrl = adminAuth.firstInstall ? '/admin/settings#settings-akun' : '/admin';
    return req.session.save(() => res.redirect(nextUrl));
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    req.session.isCashier = true;
    req.session.cashierId = cashier.id;
    req.session.cashierName = cashier.name;
    req.session.cashierUsername = cashier.username;
    applyAdminLoginSession(req, rememberMe);
    return req.session.save(() => res.redirect('/admin'));
  }

  res.render('admin/login', {
    title: 'Admin Login',
    company: company(),
    logoUrl: companyLogo(),
    error: 'Username atau password salah',
    form: { username, rememberMe },
    firstInstallLoginEnabled: adminAuth.firstInstall || isFirstInstallAdminLoginEnabled()
  });
});

router.get('/logout', (req, res) => {
  const cashierId = req.session?.isCashier && !req.session?.isAdmin
    ? Number(req.session?.cashierId || 0) || 0
    : 0;
  if (cashierId) {
    try {
      employeeLocationSvc.clearEmployeeLocation('cashier', cashierId, 'logout');
    } catch (_error) {}
  }
  req.session.destroy(() => {
    clearConfiguredSessionCookies(res);
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
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const section = String(req.query.section || '').trim().toLowerCase();
    const wantsFull = req.query.full === 'true';
    const tableOnly = section === 'table';
    const timeoutMs = tableOnly ? 65000 : (wantsFull ? 65000 : 30000);
    const statsOptions = tableOnly
      ? {
          skipTelnetDetails: true,
          skipSystemMetrics: true,
          skipCardMetrics: true,
          skipUnauthOnus: true,
          skipFirmware: true,
          skipOnuUptime: true,
          fastSnLookup: true
        }
      : { skipTelnetDetails: wantsFull };
    const stats = await Promise.race([
      oltSvc.getOltStats(req.params.id, wantsFull || tableOnly, statsOptions),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`OLT request timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
      })
    ]);
    res.json(stats);
  } catch (e) {
    const isTimeout = /timeout/i.test(String(e && e.message || ''));
    res.status(isTimeout ? 504 : 500).json({ error: e.message });
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

router.get('/olts/:id/vlan-logs', requireAdminSession, async (req, res) => {
  try {
    const logs = oltSvc.getOltVlanPushLogs(req.params.id, req.query.limit || 20);
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/push-vlan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const actor = req.session.adminUser || 'Admin';
    const output = await oltSvc.pushOnuVlan(req.params.id, req.body, actor);
    res.json({ success: true, message: output.dryRun ? 'Mode uji berhasil dibuat.' : 'VLAN berhasil dikirim ke OLT.', output });
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
router.get('/map', requireAdminSession, async (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();
  const networkLinks = networkMapLinkSvc.listAllNetworkMapLinks();
  const staffLocations = employeeLocationSvc.getLiveEmployeeLocations({ maxAgeMinutes: 180 });
  let deviceByTag = new Map();
  let deviceByPppoe = new Map();

  try {
    const deviceResult = await customerDevice.listAllDevices(1500);
    if (deviceResult?.ok && Array.isArray(deviceResult.devices)) {
      deviceResult.devices.forEach((device) => {
        const mapped = customerDevice.mapDeviceData(device, device?._tags?.[0] || device?._id || '');
        if (!mapped) return;
        const pppoe = String(mapped.pppoeUsername || '').trim().toLowerCase();
        const tags = Array.isArray(device?._tags) ? device._tags : [];
        if (pppoe && pppoe !== 'n/a' && !deviceByPppoe.has(pppoe)) {
          deviceByPppoe.set(pppoe, mapped);
        }
        tags.forEach((tag) => {
          const key = String(tag || '').trim().toLowerCase();
          if (key && !deviceByTag.has(key)) deviceByTag.set(key, mapped);
        });
        const fallbackId = String(device?._id || '').trim().toLowerCase();
        if (fallbackId && !deviceByTag.has(fallbackId)) deviceByTag.set(fallbackId, mapped);
      });
    }
  } catch (error) {
    logger.warn(`[AdminMap] Gagal memuat data device untuk peta: ${error.message}`);
  }

  const enrichedCustomers = customers.map((customer) => {
    const tagKey = String(customer.genieacs_tag || '').trim().toLowerCase();
    const pppoeKey = String(customer.pppoe_username || '').trim().toLowerCase();
    const mapped = deviceByPppoe.get(pppoeKey) || deviceByTag.get(tagKey) || null;
    return {
      ...customer,
      device_rx_power: mapped?.rxPower || '',
      device_pppoe_username: mapped?.pppoeUsername || '',
      device_status: mapped?.status || '',
      device_last_inform: mapped?.lastInform || ''
    };
  });
  
  res.render('admin/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers: enrichedCustomers, 
    odps,
    networkLinks,
    staffLocations,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/api/staff-location', requireAdminSession, express.json({ limit: '32kb' }), (req, res) => {
  if (!req.session?.isCashier || req.session?.isAdmin) {
    return res.status(403).json({ ok: false, error: 'Akses lokasi hanya untuk akun kasir.' });
  }

  try {
    const cashierId = Number(req.session?.cashierId || 0) || 0;
    if (!cashierId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (req.body && req.body.enabled === false) {
      employeeLocationSvc.clearEmployeeLocation('cashier', cashierId, String(req.body.reason || 'disabled'));
      return res.json({ ok: true, disabled: true });
    }

    const cashier = adminSvc.getCashierById(cashierId);
    if (!cashier) return res.status(404).json({ ok: false, error: 'cashier_not_found' });

    const location = employeeLocationSvc.upsertEmployeeLocation({
      role: 'cashier',
      employeeId: cashierId,
      username: cashier.username,
      name: cashier.name || req.session?.cashierName || 'Kasir',
      phone: cashier.phone || '',
      lat: req.body?.lat,
      lng: req.body?.lng,
      accuracy: req.body?.accuracy,
      source: 'portal-cashier',
      userAgent: req.headers['user-agent'] || '',
      note: String(req.body?.note || '').trim()
    });

    return res.json({ ok: true, location });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Gagal menyimpan lokasi kasir.' });
  }
});

router.get('/api/staff-locations', requireAdminSession, (req, res) => {
  try {
    const role = String(req.query.role || 'all').trim().toLowerCase();
    const allLocations = employeeLocationSvc.getLiveEmployeeLocations({ maxAgeMinutes: 180 });
    const locations = role && role !== 'all'
      ? allLocations.filter((item) => String(item.role || '').trim().toLowerCase() === role)
      : allLocations;
    return res.json({ ok: true, locations });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Gagal memuat lokasi karyawan.' });
  }
});

router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.status(404).json({ ok: false, error: 'not_found' });
  const usageMeta = usageSvc.getUsageSnapshotMeta(customerId, new Date());
  const usageBlock = {
    storedUploadBytes: Math.max(0, Number(usageMeta?.usage?.bytes_in || 0) || 0),
    storedDownloadBytes: Math.max(0, Number(usageMeta?.usage?.bytes_out || 0) || 0),
    storedTotalBytes: Math.max(0, Number(usageMeta?.usage?.bytes_in || 0) || 0) + Math.max(0, Number(usageMeta?.usage?.bytes_out || 0) || 0),
    updatedAt: usageMeta?.updatedAt || '',
    freshnessSeconds: Number.isFinite(Number(usageMeta?.freshnessSeconds)) ? Number(usageMeta.freshnessSeconds) : null,
    usageLagSeconds: Number.isFinite(Number(usageMeta?.usageLagSeconds)) ? Number(usageMeta.usageLagSeconds) : null,
    usageSource: String(usageMeta?.usageSource || 'customer_usage').trim() || 'customer_usage',
    isAuthoritative: usageMeta?.isAuthoritative !== false,
    usageWritable: false
  };

  const routerId = customer.router_id ? Number(customer.router_id) : null;
  const username = String(customer.pppoe_username || '').trim();

  if (!routerId || !username) {
    return res.json({
      ok: true,
      available: false,
      username: username || null,
      live: { online: false, interface: null, source: 'snapshot', uptime: null, rxMbps: 0, txMbps: 0 },
      usage: usageBlock,
      online: false,
      rxMbps: 0,
      txMbps: 0
    });
  }
  try {
    const live = await customerDetailSvc.resolvePppoeTrafficLive(username, routerId, [routerId]);
    if (!live) {
      return res.json({
        ok: true,
        available: true,
        username,
        live: { online: false, interface: null, source: 'fallback', uptime: null, rxMbps: 0, txMbps: 0 },
        usage: usageBlock,
        online: false,
        rxMbps: 0,
        txMbps: 0
      });
    }
    if (!live.online) {
      return res.json({
        ok: true,
        available: true,
        username,
        live: { online: false, interface: live.iface || '-', source: live.source || 'ppp-active', uptime: live.uptime || '-', rxMbps: 0, txMbps: 0 },
        usage: usageBlock,
        online: false,
        rxMbps: 0,
        txMbps: 0
      });
    }
    return res.json({
      ok: true,
      available: true,
      username: live.username || username,
      live: {
        online: true,
        warmup: Boolean(live.warmup),
        interface: live.iface || '-',
        source: live.source || 'ppp-active',
        uptime: live.uptime || '-',
        rxMbps: Number.isFinite(Number(live.rxMbps || 0)) ? Number(live.rxMbps || 0) : 0,
        txMbps: Number.isFinite(Number(live.txMbps || 0)) ? Number(live.txMbps || 0) : 0
      },
      usage: usageBlock,
      online: true,
      warmup: Boolean(live.warmup),
      iface: live.iface || '-',
      source: live.source || 'ppp-active',
      uptime: live.uptime || '-',
      rxMbps: Number.isFinite(Number(live.rxMbps || 0)) ? Number(live.rxMbps || 0) : 0,
      txMbps: Number.isFinite(Number(live.txMbps || 0)) ? Number(live.txMbps || 0) : 0
    });
  } catch (e) {
    return res.json({
      ok: true,
      available: Boolean(username),
      username: username || null,
      live: { online: false, interface: null, source: 'fallback-error', uptime: null, rxMbps: 0, txMbps: 0 },
      usage: usageBlock,
      online: false,
      rxMbps: 0,
      txMbps: 0
    });
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

router.post('/api/customers/:id/location', requireAdminSession, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const id = Number(req.params.id);
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const clearCablePath = req.body?.clearCablePath !== false;
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Koordinat pelanggan tidak valid');
    customerSvc.updateCustomerMapLocation(id, lat, lng, { clearCablePath });
    res.json({
      ok: true,
      id,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      clearCablePath
    });
  } catch (e) {
    console.error('[API] Update Customer Location Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/customers/:id/odp-link', requireAdminSession, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const id = Number(req.params.id);
    const rawOdpId = req.body?.odpId;
    const odpId = rawOdpId == null || rawOdpId === '' ? null : Number(rawOdpId);
    const clearCablePath = req.body?.clearCablePath !== false;
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
    if (rawOdpId != null && rawOdpId !== '' && (!Number.isFinite(odpId) || odpId <= 0)) {
      throw new Error('ID ODP tidak valid');
    }
    customerSvc.updateCustomerOdpLink(id, odpId, { clearCablePath });
    res.json({
      ok: true,
      id,
      odpId,
      clearCablePath
    });
  } catch (e) {
    console.error('[API] Update Customer ODP Link Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/map-links', requireAdminSession, express.json({ limit: '96kb' }), (req, res) => {
  try {
    const fromOdpId = Number(req.body?.fromOdpId || 0);
    const toOdpId = Number(req.body?.toOdpId || 0);
    const linkKind = String(req.body?.linkKind || 'backbone').trim().toLowerCase() || 'backbone';
    const cableSize = String(req.body?.cableSize || '').trim();
    const path = req.body?.path;
    const pathJson = Array.isArray(path) ? JSON.stringify(path) : String(req.body?.pathJson || '').trim();
    const color = String(req.body?.color || '').trim();
    const result = networkMapLinkSvc.saveNetworkMapLink({
      fromOdpId,
      toOdpId,
      linkKind,
      cableSize,
      pathJson,
      color
    });
    res.json({
      ok: true,
      id: result.id,
      fromOdpId,
      toOdpId,
      linkKind,
      cableSize
    });
  } catch (e) {
    console.error('[API] Save Map Link Error:', e);
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
  return res.redirect('/admin/accounts?role=technician');
});

router.get('/accounts', requireAdminSession, restrictToAdmin, (req, res) => {
  const filterRole = ['all', 'technician', 'cashier', 'collector'].includes(String(req.query.role || '').trim())
    ? String(req.query.role || '').trim()
    : 'all';
  const accounts = adminSvc.listManagedAccounts(filterRole);
  const allAccounts = adminSvc.listManagedAccounts('all');
  const stats = {
    all: allAccounts.length,
    technician: allAccounts.filter((item) => item.role === 'technician').length,
    cashier: allAccounts.filter((item) => item.role === 'cashier').length,
    collector: allAccounts.filter((item) => item.role === 'collector').length
  };
  res.render('admin/accounts', {
    title: 'Pengelolaan Akun',
    company: company(),
    activePage: 'accounts',
    accounts,
    stats,
    filterRole,
    msg: flashMsg(req)
  });
});

router.post('/accounts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createManagedAccount(req.body.role, req.body);
    req.session._msg = { type: 'success', text: 'Akun pengguna berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect(`/admin/accounts?role=${encodeURIComponent(String(req.body.role || 'all'))}`);
});

router.post('/accounts/:role/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateManagedAccount(req.params.role, req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Akun pengguna berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect(`/admin/accounts?role=${encodeURIComponent(String(req.body.role || req.params.role || 'all'))}`);
});

router.post('/accounts/:role/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    adminSvc.deleteManagedAccount(req.params.role, req.params.id);
    req.session._msg = { type: 'success', text: 'Akun pengguna berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect(`/admin/accounts?role=${encodeURIComponent(String(req.params.role || 'all'))}`);
});

router.get('/technicians/manage-legacy', requireAdminSession, restrictToAdmin, (req, res) => {
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
  res.redirect('/admin/accounts?role=technician');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data teknisi diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/accounts?role=technician');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  req.session._msg = { type: 'success', text: 'Teknisi berhasil dihapus.' };
  res.redirect('/admin/accounts?role=technician');
});

router.get('/technician-tasks', requireAdminSession, restrictToAdmin, (req, res) => {
  const status = String(req.query.status || 'all').trim() || 'all';
  const taskType = String(req.query.task_type || 'all').trim() || 'all';
  const technicianId = Number(req.query.technician_id || 0) || 0;
  const tasks = techSvc.listAdminTechnicianTasks({ status, taskType, technicianId }) || [];
  const stats = techSvc.getAdminTechnicianTaskStats() || { total: 0, assigned: 0, inProgress: 0, done: 0 };
  const technicians = (adminSvc.getAllTechnicians() || []).filter((tech) => Number(tech.is_active || 0) === 1);
  res.render('admin/technician_tasks', {
    title: 'Tugas Teknisi',
    company: company(),
    activePage: 'technician_tasks',
    tasks,
    stats,
    technicians,
    filterStatus: status,
    filterTaskType: taskType,
    filterTechnicianId: technicianId,
    msg: flashMsg(req)
  });
});

router.post('/technician-tasks', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const customerId = Number(req.body.customer_id || 0) || null;
    const linkedCustomer = customerId ? customerSvc.getCustomerById(customerId) : null;
    const createResult = techSvc.createTechnicianTask({
      title: String(req.body.title || '').trim(),
      task_type: String(req.body.task_type || 'repair').trim(),
      description: String(req.body.description || '').trim(),
      customer_id: customerId,
      customer_name: linkedCustomer?.name || String(req.body.customer_name || '').trim(),
      customer_phone: linkedCustomer?.phone || String(req.body.customer_phone || '').trim(),
      customer_address: linkedCustomer?.address || String(req.body.customer_address || '').trim(),
      location_note: String(req.body.location_note || '').trim(),
      technician_id: Number(req.body.technician_id || 0) || null,
      priority: String(req.body.priority || 'medium').trim(),
      status: 'assigned',
      scheduled_date: String(req.body.scheduled_date || '').trim() || null,
      due_date: String(req.body.due_date || '').trim() || null,
      create_pppoe_secret: Number(req.body.create_pppoe_secret || 0) || 0,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      pppoe_password: String(req.body.pppoe_password || '').trim(),
      normal_pppoe_profile: String(req.body.normal_pppoe_profile || '').trim(),
      created_by_name: resolvePaidByName(req, 'Admin')
    });
    const createdTask = createResult?.lastInsertRowid ? techSvc.getTechnicianTaskById(createResult.lastInsertRowid, null) : null;
    const technicians = adminSvc.getAllTechnicians() || [];
    const assignedTechnician = createdTask
      ? technicians.find((tech) => Number(tech.id || 0) === Number(createdTask.technician_id || 0))
      : null;
    const notified = await trySendTechnicianTaskWhatsappNotification(createdTask, assignedTechnician, {
      mode: 'assigned',
      baseUrl: resolveRequestBaseUrl(req, resolveAppBaseUrl())
    });
    const pushNotified = await trySendTechnicianTaskPushNotification(createdTask, assignedTechnician, {
      mode: 'assigned',
      baseUrl: resolveRequestBaseUrl(req, resolveAppBaseUrl())
    });
    req.session._msg = {
      type: 'success',
      text: notified || pushNotified
        ? `Tugas teknisi berhasil dibuat dan notifikasi ${[notified ? 'WhatsApp' : '', pushNotified ? 'push app' : ''].filter(Boolean).join(' + ')} sudah dikirim.`
        : 'Tugas teknisi berhasil dibuat.'
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat tugas teknisi: ' + (e.message || String(e)) };
  }
  res.redirect('/admin/technician-tasks');
});

router.post('/technician-tasks/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const taskId = Number(req.params.id || 0);
    const customerId = Number(req.body.customer_id || 0) || null;
    const linkedCustomer = customerId ? customerSvc.getCustomerById(customerId) : null;
    const previousTask = techSvc.getTechnicianTaskById(taskId, null);
    techSvc.updateTechnicianTask(taskId, {
      title: String(req.body.title || '').trim(),
      task_type: String(req.body.task_type || 'repair').trim(),
      description: String(req.body.description || '').trim(),
      customer_id: customerId,
      customer_name: linkedCustomer?.name || String(req.body.customer_name || '').trim(),
      customer_phone: linkedCustomer?.phone || String(req.body.customer_phone || '').trim(),
      customer_address: linkedCustomer?.address || String(req.body.customer_address || '').trim(),
      location_note: String(req.body.location_note || '').trim(),
      technician_id: Number(req.body.technician_id || 0) || null,
      priority: String(req.body.priority || 'medium').trim(),
      status: String(req.body.status || 'assigned').trim() || 'assigned',
      scheduled_date: String(req.body.scheduled_date || '').trim() || null,
      due_date: String(req.body.due_date || '').trim() || null,
      create_pppoe_secret: Number(req.body.create_pppoe_secret || 0) || 0,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      pppoe_password: String(req.body.pppoe_password || '').trim(),
      normal_pppoe_profile: String(req.body.normal_pppoe_profile || '').trim(),
      completion_note: String(req.body.completion_note || '').trim()
    });
    const updatedTask = techSvc.getTechnicianTaskById(taskId, null);
    const technicians = adminSvc.getAllTechnicians() || [];
    const assignedTechnician = updatedTask
      ? technicians.find((tech) => Number(tech.id || 0) === Number(updatedTask.technician_id || 0))
      : null;
    const shouldNotify = hasTechnicianTaskOperationalChange(previousTask, updatedTask);
    const wasReassigned = String(previousTask?.technician_id || '') !== String(updatedTask?.technician_id || '');
    const notified = shouldNotify
      ? await trySendTechnicianTaskWhatsappNotification(updatedTask, assignedTechnician, {
          mode: wasReassigned ? 'assigned' : 'updated',
          baseUrl: resolveRequestBaseUrl(req, resolveAppBaseUrl())
        })
      : false;
    const pushNotified = shouldNotify
      ? await trySendTechnicianTaskPushNotification(updatedTask, assignedTechnician, {
          mode: wasReassigned ? 'assigned' : 'updated',
          baseUrl: resolveRequestBaseUrl(req, resolveAppBaseUrl())
        })
      : false;
    req.session._msg = {
      type: 'success',
      text: notified || pushNotified
        ? `Tugas teknisi berhasil diperbarui dan notifikasi ${[notified ? 'WhatsApp' : '', pushNotified ? 'push app' : ''].filter(Boolean).join(' + ')} sudah dikirim.`
        : 'Tugas teknisi berhasil diperbarui.'
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui tugas teknisi: ' + (e.message || String(e)) };
  }
  res.redirect('/admin/technician-tasks');
});

router.get('/customer-requests', requireAdminSession, restrictToAdmin, (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const technicianRows = db.prepare(`
    SELECT r.*,
           'new_customer' as request_type,
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

  const packageChangeRows = packageChangeSvc.listRequestsByStatus(status, 300).map((row) => ({
    ...row,
    request_type: 'package_change',
    technician_name: '',
    technician_username: 'portal-pelanggan',
    package_name: row.target_package_name || '',
    router_name: '',
    approved_customer_name: row.customer_name,
    payload_json: ''
  }));

  const profileChangeRows = db.prepare(`
    SELECT r.*,
           'profile_change' AS request_type,
           c.name AS customer_name,
           c.phone AS customer_phone,
           c.address AS customer_address
    FROM customer_profile_change_requests r
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 300
  `).all(status).map((row) => ({
    ...row,
    technician_name: '',
    technician_username: 'portal-pelanggan',
    package_name: '',
    router_name: '',
    approved_customer_name: row.customer_name,
    payload_json: ''
  }));

  const rows = [...technicianRows, ...packageChangeRows, ...profileChangeRows]
    .sort((a, b) => {
      const bt = new Date(b.requested_at || b.created_at || 0).getTime() || 0;
      const at = new Date(a.requested_at || a.created_at || 0).getTime() || 0;
      return (bt - at) || (Number(b.id || 0) - Number(a.id || 0));
    })
    .slice(0, 300);

  res.render('admin/customer_requests', {
    title: 'Approval Pelanggan Teknisi',
    company: company(),
    activePage: 'customer_requests',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/package-change-requests/:id/approve', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = packageChangeSvc.getRequestById(id);
    if (!row) throw new Error('Request pindah paket tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');

    const result = await packageChangeSvc.approveRequest(id, {
      actorName: resolvePaidByName(req, 'Admin'),
      reviewNote
    });

    req.session._msg = {
      type: 'success',
      text: result.stage === 'scheduled'
        ? `Pengajuan perubahan paket ${row.customer_name} ke ${row.target_package_name || 'paket baru'} disetujui dan dijadwalkan untuk siklus tagihan berikutnya${result.effectiveAt ? ` pada ${new Date(result.effectiveAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.`
        : `Pengajuan perubahan paket ${row.customer_name} ke ${row.target_package_name || 'paket baru'} disetujui.${Number(result.updatedInvoiceCount || 0) > 0 ? ` Tagihan aktif ikut diperbarui (${result.updatedInvoiceCount} tagihan).` : ''}${result.mikrotikProfileSynced ? ` Profil PPPoE otomatis dipindah ke ${result.targetProfile}.` : ''}${result.mikrotikSessionResetMessage ? ` ${result.mikrotikSessionResetMessage}` : ''}${result.mikrotikSyncMessage ? ` Catatan: ${result.mikrotikSyncMessage}` : ''}`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal approve pindah paket: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/package-change-requests/:id/reject', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = packageChangeSvc.getRequestById(id);
    if (!row) throw new Error('Request pindah paket tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');
    packageChangeSvc.rejectRequest(id, {
      actorName: resolvePaidByName(req, 'Admin'),
      reviewNote
    });
    req.session._msg = { type: 'success', text: 'Pengajuan pindah paket berhasil ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal reject pindah paket: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/profile-change-requests/:id/approve', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = db.prepare(`
      SELECT r.*, c.name AS customer_name
      FROM customer_profile_change_requests r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Request perubahan profil tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');

    const requestedName = String(row.requested_name || row.current_name || '').trim();
    const requestedPhone = normalizePhoneDigits(row.requested_phone || row.current_phone || '');
    const requestedAddress = String(row.requested_address || row.current_address || '').trim();
    if (!requestedName || !requestedPhone || !requestedAddress) throw new Error('Data request belum lengkap');

    const existingPhone = db.prepare('SELECT id, name FROM customers WHERE phone = ? AND id != ? LIMIT 1').get(requestedPhone, row.customer_id);
    if (existingPhone) throw new Error(`Nomor HP sudah dipakai pelanggan lain: ${existingPhone.name}`);

    const approvedBy = resolvePaidByName(req, 'Admin');
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE customers
        SET name = ?, phone = ?, address = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(requestedName, requestedPhone, requestedAddress, row.customer_id);
      db.prepare(`
        UPDATE customer_profile_change_requests
        SET status = 'approved',
            review_note = ?,
            reviewed_by_name = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            applied_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reviewNote, approvedBy, id);
    });
    tx();

    customerSvc.addPortalNotification(row.customer_id, {
      kind: 'profile',
      tab: 'profile',
      title: 'Perubahan profil disetujui',
      body: 'Data profil Anda sudah diperbarui.'
    }, { dedupeWindowMs: 60 * 1000 });

    req.session._msg = { type: 'success', text: `Perubahan profil ${row.customer_name || requestedName} disetujui.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal approve perubahan profil: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/profile-change-requests/:id/reject', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = db.prepare('SELECT id, customer_id, status FROM customer_profile_change_requests WHERE id = ?').get(id);
    if (!row) throw new Error('Request perubahan profil tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');
    db.prepare(`
      UPDATE customer_profile_change_requests
      SET status = 'rejected',
          review_note = ?,
          reviewed_by_name = ?,
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reviewNote, resolvePaidByName(req, 'Admin'), id);

    customerSvc.addPortalNotification(row.customer_id, {
      kind: 'profile',
      tab: 'profile',
      title: 'Perubahan profil ditolak',
      body: reviewNote || 'Pengajuan perubahan profil belum disetujui admin.'
    }, { dedupeWindowMs: 60 * 1000 });

    req.session._msg = { type: 'success', text: 'Pengajuan perubahan profil ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal reject perubahan profil: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/package-change-requests/:id/cancel', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    packageChangeSvc.cancelRequest(id, {
      actorName: resolvePaidByName(req, 'Admin'),
      reviewNote: String(req.body.review_note || '').trim() || 'Dibatalkan oleh admin.'
    });
    req.session._msg = { type: 'success', text: 'Request perubahan paket berhasil dibatalkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membatalkan request: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/package-change-requests/:id/complete', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const result = await packageChangeSvc.completeRequest(id, {
      actorName: resolvePaidByName(req, 'Admin'),
      reviewNote: String(req.body.review_note || '').trim() || 'Ditandai selesai oleh admin.'
    });
    req.session._msg = {
      type: 'success',
      text: `Request perubahan paket berhasil diselesaikan.${result.mikrotikProfileSynced ? ` Profil PPPoE aktif ikut dipindah ke ${result.targetProfile}.` : ''}${result.mikrotikSessionResetMessage ? ` ${result.mikrotikSessionResetMessage}` : ''}${result.mikrotikSyncMessage ? ` Catatan: ${result.mikrotikSyncMessage}` : ''}`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyelesaikan request: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/customer-requests');
});

router.post('/customer-requests/:id/approve', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID request tidak valid');
    const reviewNote = String(req.body.review_note || '').trim();
    const row = db.prepare('SELECT * FROM technician_customer_requests WHERE id = ?').get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status || '') !== 'pending') throw new Error('Request sudah diproses');

    const payload = JSON.parse(String(row.payload_json || '{}') || '{}');
    const shouldCreateSecret = payload.create_pppoe_secret === true || payload.create_pppoe_secret === 1 || payload.create_pppoe_secret === '1' || payload.create_pppoe_secret === 'true' || payload.create_pppoe_secret === 'on';
    const pppoeUsername = String(payload.pppoe_username || '').trim();
    const pppoePassword = String(payload.pppoe_password || '').trim();
    const routerId = payload.router_id ? Number(payload.router_id) : null;
    const syncWarnings = [];
    if (pppoeUsername) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId ?? null, pppoeUsername);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      const desiredProfile = resolveCustomerPppoeProfile(
        payload.package_id,
        payload.status,
        payload.isolir_profile,
        payload.normal_pppoe_profile
      );
      const targetProfile = await resolveAvailablePppoeProfile(desiredProfile, routerId, 'default');
      try {
        const existingSecret = await getExistingPppoeSecretByUsername(pppoeUsername, routerId);
        if (existingSecret && existingSecret.id) {
          const updatePayload = {};
          if (pppoePassword) updatePayload.password = pppoePassword;
          if (targetProfile) updatePayload.profile = targetProfile;
          if (Object.keys(updatePayload).length) {
            await mikrotikService.updatePppoeSecret(existingSecret.id, updatePayload, routerId);
          }
        } else if (shouldCreateSecret) {
          await mikrotikService.addPppoeSecret({
            name: pppoeUsername,
            password: pppoePassword || pppoeUsername,
            service: 'pppoe',
            profile: targetProfile,
            comment: payload.name ? `Customer: ${String(payload.name).trim()}` : ''
          }, routerId);
        } else {
          syncWarnings.push('Secret PPPoE belum ditemukan di router, jadi admin perlu mengecek akun existing sebelum layanan dipakai.');
        }
      } catch (syncErr) {
        syncWarnings.push(`Sinkron akun internet belum sempurna: ${syncErr.message}`);
      }
    }

    const createResult = customerSvc.createCustomer(payload);
    const customerId = Number(createResult.lastInsertRowid || 0) || null;
    const createdCustomer = customerId ? customerSvc.getCustomerById(customerId) : null;
    const approvedByName = resolvePaidByName(req, 'Admin');
    const approvalBaseUrl = resolveRequestBaseUrl(req, resolveAppBaseUrl());
    db.prepare(`
      UPDATE technician_customer_requests
      SET status='approved',
          review_note=?,
          reviewed_by_name=?,
          approved_customer_id=?,
          reviewed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(reviewNote, approvedByName, customerId, id);

    setImmediate(() => {
      notifyTechnicianCustomerApproval({
        requestRow: row,
        customer: createdCustomer || { id: customerId, ...payload },
        reviewNote,
        adminName: approvedByName,
        baseUrl: approvalBaseUrl
      }).catch((error) => {
        logger.warn(`[CustomerApproval] Gagal kirim notif approve ke teknisi request #${id}: ${error.message || String(error)}`);
      });

      notifyCustomerWelcomeAfterApproval(createdCustomer || { id: customerId, ...payload }, {
        baseUrl: approvalBaseUrl
      }).catch((error) => {
        logger.warn(`[CustomerApproval] Gagal kirim welcome pelanggan request #${id}: ${error.message || String(error)}`);
      });
    });

    const warningText = syncWarnings.length ? ` Catatan: ${syncWarnings.join(' | ')}` : '';
    req.session._msg = { type: 'success', text: `Pengajuan pelanggan "${row.customer_name}" disetujui.${warningText}` };
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
  return res.redirect('/admin/accounts?role=cashier');
});

router.get('/cashiers/manage-legacy', requireAdminSession, restrictToAdmin, (req, res) => {
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
  res.redirect('/admin/accounts?role=cashier');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kasir diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/accounts?role=cashier');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  req.session._msg = { type: 'success', text: 'Kasir berhasil dihapus.' };
  res.redirect('/admin/accounts?role=cashier');
});

// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, restrictToAdmin, (req, res) => {
  return res.redirect('/admin/accounts?role=collector');
});

router.get('/collectors/manage-legacy', requireAdminSession, restrictToAdmin, (req, res) => {
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
  res.redirect('/admin/accounts?role=collector');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kolektor diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/accounts?role=collector');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Kolektor berhasil dihapus.' };
  res.redirect('/admin/accounts?role=collector');
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

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes, {
      type: 'collector',
      id: row.collector_id || null,
      name: `${collectorLabel} (disetujui ${approver})`,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    });

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    let whatsappWarning = '';
    if (customer && customer.phone) {
      try {
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
      } catch (notifyError) {
        whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: `Request disetujui dan invoice dilunasi.${whatsappWarning}` };
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

router.post('/agents/:id/topup', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
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
    const dashboardFinance = getDashboardFinanceSnapshot({
      year: req.query.year,
      month: req.query.month
    });
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    const opsSummary = getAdminHomeSummary({ billing, custStats });
    const recentPayments = dashboardFinance.recentPayments;
    const topUnpaid = getDashboardPriorityCollections(6);
    const ticketStats = ticketSvc.getTicketStats();
    const allActiveTickets = ticketSvc
      .getAllTickets()
      .filter((ticket) => ['open', 'in_progress'].includes(String(ticket?.status || '').toLowerCase()));
    const recentActiveTickets = allActiveTickets.slice(0, 5);
    const allOpenOutages = massOutageSvc.listOpenIncidents();
    const openOutages = allOpenOutages.slice(0, 6);
    const approvalBreakdown = getPendingApprovalBreakdown();
    const technicianApprovalItems = db.prepare(`
      SELECT r.id,
             'Pelanggan Teknisi' AS type_label,
             r.customer_name AS title,
             r.customer_phone AS subtitle,
             t.name AS actor_name,
             r.created_at
      FROM technician_customer_requests r
      LEFT JOIN technicians t ON t.id = r.technician_id
      WHERE r.status = 'pending'
      ORDER BY datetime(r.created_at) DESC, r.id DESC
      LIMIT 4
    `).all();
    const packageApprovalItems = packageChangeSvc.listRequestsByStatus('pending', 4).map((row) => ({
      id: row.id,
      type_label: 'Pindah Paket',
      title: row.customer_name || 'Pelanggan',
      subtitle: row.target_package_name || 'Paket baru',
      actor_name: 'Portal Pelanggan',
      created_at: row.created_at
    }));
    const profileApprovalItems = db.prepare(`
      SELECT r.id,
             'Perubahan Profil' AS type_label,
             COALESCE(c.name, r.current_name, r.requested_name, 'Pelanggan') AS title,
             COALESCE(r.requested_phone, c.phone, '') AS subtitle,
             'Portal Pelanggan' AS actor_name,
             r.created_at
      FROM customer_profile_change_requests r
      LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.status = 'pending'
      ORDER BY datetime(r.created_at) DESC, r.id DESC
      LIMIT 4
    `).all();
    const dashboardApprovals = [...technicianApprovalItems, ...packageApprovalItems, ...profileApprovalItems]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 6);
    const allTechTasks = techSvc.listAdminTechnicianTasks({}) || [];
    const activeTechTasks = allTechTasks
      .filter((task) => ['assigned', 'in_progress'].includes(String(task?.status || '').toLowerCase()))
      .slice(0, 6);
    const activeTechTaskCount = allTechTasks
      .filter((task) => ['assigned', 'in_progress'].includes(String(task?.status || '').toLowerCase()))
      .length;
    const adminNotifications = db.prepare(`
      SELECT id, kind, title, body, target_url, delivery_status, created_at
      FROM admin_notifications
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 6
    `).all();
    const adminHomeShortcuts = buildAdminHomeShortcuts(req, opsSummary);
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard',
      billing,
      custStats,
      opsSummary,
      recentPayments,
      topUnpaid,
      ticketStats,
      recentActiveTickets,
      openOutages,
      activeTicketCount: allActiveTickets.length,
      openOutageCount: allOpenOutages.length,
      approvalBreakdown,
      dashboardApprovals,
      activeTechTasks,
      activeTechTaskCount,
      adminNotifications,
      adminHomeShortcuts,
      dashboardFilterMonth: dashboardFinance.filterMonth,
      dashboardFilterYear: dashboardFinance.filterYear,
      dashboardChartData: dashboardFinance.monthlyData,
      dashboardFinance: dashboardFinance.selectedMonthData
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

router.get('/api/outages', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const status = String(req.query.status || 'open').trim().toLowerCase();
    const outages = status === 'recent'
      ? massOutageSvc.listRecentIncidents(limit)
      : massOutageSvc.listOpenIncidents().slice(0, limit);
    res.json({
      success: true,
      status,
      count: outages.length,
      outages
    });
  } catch (error) {
    logger.error('Admin outage API error:', error);
    res.status(500).json({ success: false, error: error.message || 'Gagal memuat data gangguan massal.' });
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  res.redirect('/admin/monitoring');
});

router.get('/bulk', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null });
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
function buildInvoiceSummaryFromList(invoices = [], options = {}) {
  const summary = {
    total: { count: 0, total: 0 },
    paid: { count: 0, total: 0 },
    unpaid: { count: 0, total: 0 },
    isolated: { count: 0, total: 0 },
    overdue: { count: 0, total: 0 }
  };
  const getDueDate = typeof options.getDueDate === 'function' ? options.getDueDate : null;
  const todayStart = options.todayStart instanceof Date
    ? options.todayStart
    : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  for (const inv of invoices) {
    const amount = Number(inv?.amount || 0);
    const status = String(inv?.status || '').toLowerCase();
    const customerStatus = String(inv?.customer_status || '').toLowerCase();
    const isIsolated = customerStatus === 'suspended';
    const dueDate = getDueDate ? getDueDate(inv) : null;
    const isOverdue = status === 'unpaid'
      && !isIsolated
      && dueDate instanceof Date
      && dueDate.getTime() < todayStart.getTime();
    summary.total.count += 1;
    summary.total.total += amount;
    if (status === 'paid') {
      summary.paid.count += 1;
      summary.paid.total += amount;
    } else if (isIsolated) {
      summary.isolated.count += 1;
      summary.isolated.total += amount;
    } else {
      summary.unpaid.count += 1;
      summary.unpaid.total += amount;
      if (isOverdue) {
        summary.overdue.count += 1;
        summary.overdue.total += amount;
      }
    }
  }

  return summary;
}

/*
router.get('/customers', requireAdminSession, (req, res) => {
  const {
    search = '',
    status: filterStatus = '',
    segment: filterSegment = '',
    billingDayStart = '',
    billingDayEnd = '',
    month: rawMonth = '',
    year: rawYear = '',
    page: rawPage = '1',
    sortBy: rawSortBy = 'name',
    sortDir: rawSortDir = 'asc'
  } = req.query;
  const now = new Date();
  const selectedMonth = Math.min(12, Math.max(1, parseInt(rawMonth, 10) || (now.getMonth() + 1)));
  const selectedYear = parseInt(rawYear, 10) || now.getFullYear();
  const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = 25;
  const normalizedFilterStatus = String(filterStatus || '').trim().toLowerCase() === 'all'
    ? ''
    : String(filterStatus || '').trim();
  const allowedSortBy = new Set(['name', 'address', 'package', 'status', 'billing']);
  const sortBy = allowedSortBy.has(String(rawSortBy || '').trim()) ? String(rawSortBy).trim() : 'name';
  const sortDir = String(rawSortDir || '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
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
  let filteredCustomers = normalizedFilterStatus
    ? customers.filter(c => c.status === normalizedFilterStatus)
    : customers;

  if (filterSegment === 'new') {
    filteredCustomers = filteredCustomers.filter((c) => {
      const createdAt = String(c?.created_at || '');
      return createdAt.slice(5, 7) === monthKey && createdAt.slice(0, 4) === yearKey;
    });
  }

  if (normalizedBillingDayStart || normalizedBillingDayEnd) {
    filteredCustomers = filteredCustomers.filter((c) => {
      const dueDay = Number(c?.isolate_day || 0);
      if (!Number.isFinite(dueDay) || dueDay <= 0) return false;
      if (normalizedBillingDayStart && dueDay < normalizedBillingDayStart) return false;
      if (normalizedBillingDayEnd && dueDay > normalizedBillingDayEnd) return false;
      return true;
    });
  }

  const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), 'id', { sensitivity: 'base' });
  filteredCustomers = [...filteredCustomers].sort((left, right) => {
    let result = 0;
    if (sortBy === 'address') {
      result = compareText(left?.address, right?.address);
      if (result === 0) result = compareText(left?.name, right?.name);
    } else if (sortBy === 'package') {
      result = compareText(left?.package_name, right?.package_name);
      if (result === 0) result = compareText(left?.name, right?.name);
    } else if (sortBy === 'status') {
      const resolveStatusOrder = (customer) => {
        const statusKey = String(customer?.status || '').trim().toLowerCase();
        if (statusKey === 'suspended') return 0;
        if (statusKey === 'active') return 1;
        if (statusKey === 'inactive') return 2;
        return 3;
      };
      const resolveIsolateDay = (customer) => {
        if (Number(customer?.auto_isolate || 0) === 0) return 99;
        const day = Number(customer?.isolate_day || 0);
        return Number.isFinite(day) && day > 0 ? day : 99;
      };
      result = resolveIsolateDay(left) - resolveIsolateDay(right);
      if (result === 0) result = resolveStatusOrder(left) - resolveStatusOrder(right);
      if (result === 0) result = compareText(left?.name, right?.name);
    } else if (sortBy === 'billing') {
      const leftUnpaid = Number(left?.unpaid_count || 0);
      const rightUnpaid = Number(right?.unpaid_count || 0);
      result = leftUnpaid - rightUnpaid;
      if (result === 0) {
        const leftDueDay = Number(left?.isolate_day || 0);
        const rightDueDay = Number(right?.isolate_day || 0);
        result = leftDueDay - rightDueDay;
      }
      if (result === 0) result = compareText(left?.name, right?.name);
    } else {
      result = compareText(left?.name, right?.name);
      if (result === 0) result = compareText(left?.address, right?.address);
    }
    return sortDir === 'desc' ? (result * -1) : result;
  });

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
    customers: paginatedCustomers, stats, packages, routers, olts, odps, search, filterStatus: normalizedFilterStatus, filterSegment,
    selectedMonth, selectedYear, customerOverview,
    billingDayStart: normalizedBillingDayStart || '',
    billingDayEnd: normalizedBillingDayEnd || '',
    sortBy,
    sortDir,
    currentPage: safePage,
    totalPages,
    totalCustomersCount,
    pageSize,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, restrictToAdmin, upload.fields(CUSTOMER_IMAGE_UPLOAD_FIELDS), async (req, res) => {
  const createdUploadUrls = [];
  let customerCreated = false;
  try {
    const housePhotoUrl = await persistCustomerUpload(getUploadedSingleFile(req, 'house_photo_file'), 'admin-house-photo');
    const ktpPhotoUrl = await persistCustomerUpload(getUploadedSingleFile(req, 'ktp_photo_file'), 'admin-ktp-photo');
    if (housePhotoUrl) createdUploadUrls.push(housePhotoUrl);
    if (ktpPhotoUrl) createdUploadUrls.push(ktpPhotoUrl);
    req.body = req.body || {};
    req.body.nik = String(req.body.nik || '').trim();
    req.body.npwp = String(req.body.npwp || '').trim();
    req.body.house_photo_url = housePhotoUrl;
    req.body.ktp_photo_url = ktpPhotoUrl;
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
    customerCreated = true;
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
    if (!customerCreated) {
      for (const uploadedUrl of createdUploadUrls) {
        safeRemoveUploadAsset(uploadedUrl, /^\/uploads\/admin-(?:house|ktp)-photo-\d+\.webp$/i);
      }
    }
    logger.error(`[AdminCustomers] Gagal menambahkan pelanggan: ${e.stack || e.message || e}`);
    req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, restrictToAdmin, upload.fields(CUSTOMER_IMAGE_UPLOAD_FIELDS), async (req, res) => {
  const createdUploadUrls = [];
  let customerUpdated = false;
  try {
    const previousCustomer = customerSvc.getCustomerById(req.params.id) || {};
    const housePhotoFile = getUploadedSingleFile(req, 'house_photo_file');
    const ktpPhotoFile = getUploadedSingleFile(req, 'ktp_photo_file');
    req.body = req.body || {};
    req.body.nik = String(req.body.nik || '').trim();
    req.body.npwp = String(req.body.npwp || '').trim();
    if (housePhotoFile) {
      req.body.house_photo_url = await persistCustomerUpload(housePhotoFile, 'admin-house-photo');
      if (req.body.house_photo_url) createdUploadUrls.push(req.body.house_photo_url);
    }
    if (ktpPhotoFile) {
      req.body.ktp_photo_url = await persistCustomerUpload(ktpPhotoFile, 'admin-ktp-photo');
      if (req.body.ktp_photo_url) createdUploadUrls.push(req.body.ktp_photo_url);
    }
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
    customerUpdated = true;
    if (req.body.house_photo_url && req.body.house_photo_url !== previousCustomer.house_photo_url) {
      safeRemoveUploadAsset(previousCustomer.house_photo_url, /^\/uploads\/admin-house-photo-\d+\.(png|jpg|jpeg|webp)$/i);
    }
    if (req.body.ktp_photo_url && req.body.ktp_photo_url !== previousCustomer.ktp_photo_url) {
      safeRemoveUploadAsset(previousCustomer.ktp_photo_url, /^\/uploads\/admin-ktp-photo-\d+\.(png|jpg|jpeg|webp)$/i);
    }
    
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
    if (!customerUpdated) {
      for (const uploadedUrl of createdUploadUrls) {
        safeRemoveUploadAsset(uploadedUrl, /^\/uploads\/admin-(?:house|ktp)-photo-\d+\.webp$/i);
      }
    }
    logger.error(`[AdminCustomers] Gagal memperbarui pelanggan ${req.params.id}: ${e.stack || e.message || e}`);
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
function buildCustomerImportTemplateWorkbook() {
  const headers = [
    'ID Pelanggan',
    'Nama',
    'Telepon',
    'Email',
    'Alamat',
    'Paket',
    'Tag ONU',
    'PPPoE Username',
    'PPPoE Profile',
    'Isolir Profile',
    'Status',
    'Tanggal Pasang',
    'Auto Isolir',
    'Tgl Isolir',
    'ODP',
    'Latitude',
    'Longitude',
    'Catatan'
  ];
  const exampleRow = [
    '',
    'Budi Setiawan',
    '6281234567890',
    'budi@example.com',
    'Jl. Raya Contoh No. 10',
    'Paket Lite',
    'ONU-RuangTamu',
    'budi@sikluk',
    'paket-5mb',
    'BEATISOLIR',
    'active',
    '2026-05-12',
    'YA',
    '10',
    'ODP-01',
    '-6.200000',
    '106.816666',
    'Isi catatan bila perlu'
  ];
  const guideRows = [
    ['Panduan Import Pelanggan'],
    ['1. Isi minimal kolom Nama, Telepon, Alamat, dan Paket. ID Pelanggan boleh dikosongkan agar dibuat otomatis.'],
    ['2. Gunakan format nomor HP 628xxxxxxxxxx agar sinkron ke WhatsApp.'],
    ['3. Nama paket harus sama persis dengan nama paket di aplikasi.'],
    ['4. Status boleh: active, suspended, atau inactive.'],
    ['5. Tanggal Pasang gunakan format YYYY-MM-DD, contoh 2026-05-12.'],
    ['6. Auto Isolir isi YA atau TIDAK.'],
    ['7. Tgl Isolir isi angka 1 sampai 31.'],
    ['8. PPPoE Profile boleh dikosongkan bila ingin mengikuti profil default paket.'],
    ['9. Simpan file tetap dalam format .xlsx sebelum diunggah kembali.']
  ];

  const wb = XLSX.utils.book_new();
  const wsTemplate = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  const wsGuide = XLSX.utils.aoa_to_sheet(guideRows);
  XLSX.utils.book_append_sheet(wb, wsTemplate, 'Template Import');
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Panduan');
  return wb;
}

function formatPaidReportPeriodLabel(year, month = 0) {
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const safeYear = Math.max(2000, parseInt(year, 10) || new Date().getFullYear());
  const safeMonth = Math.max(0, Math.min(12, parseInt(month, 10) || 0));
  if (!safeMonth) return `Tahun ${safeYear}`;
  return `${monthNames[safeMonth - 1]} ${safeYear}`;
}

function buildPaidInvoiceReportWorkbook(report) {
  const periodLabel = formatPaidReportPeriodLabel(report?.year, report?.month);
  const wb = XLSX.utils.book_new();
  const rows = [
    ['DATA PELANGGAN'],
    [],
    [periodLabel, '', '', '', '', 'Total Jual', 'Total PPN', 'Total Invoice', ''],
    ['', '', '', '', '', report?.totalSaleAmount || 0, report?.totalPpnAmount || 0, report?.totalInvoiceAmount || 0, ''],
    ['No', 'Nama Pelanggan', 'NIK', 'NPWP', 'Alamat', 'Harga Jual', 'PPN', 'Nominal Invoice', 'Keterangan']
  ];

  const items = Array.isArray(report?.items) ? report.items : [];
  items.forEach((item) => {
    rows.push([
      item.no,
      item.customerName || '',
      item.nik || '',
      item.npwp || '',
      item.address || '',
      Number(item.saleAmount || 0),
      Number(item.ppnAmount || 0),
      Number(item.nominalInvoice || 0),
      item.description || ''
    ]);
  });

  if (!items.length) {
    rows.push(['', 'Belum ada invoice lunas pada periode ini', '', '', '', 0, 0, 0, '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 8 },
    { wch: 28 },
    { wch: 18 },
    { wch: 18 },
    { wch: 34 },
    { wch: 16 },
    { wch: 14 },
    { wch: 18 },
    { wch: 40 }
  ];
  ws['!merges'] = [
    XLSX.utils.decode_range('A1:I1'),
    XLSX.utils.decode_range('A3:E3')
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 5 };

  const currencyCols = ['F', 'G', 'H'];
  for (let rowIndex = 4; rowIndex <= rows.length; rowIndex++) {
    currencyCols.forEach((col) => {
      const cell = ws[`${col}${rowIndex}`];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = '"Rp" #,##0';
      }
    });
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Laporan Lunas');
  return wb;
}

router.get('/customers/import-template', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const wb = buildCustomerImportTemplateWorkbook();
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=template_import_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Download customer import template error:', e);
    res.status(500).send('Gagal menyiapkan template import pelanggan.');
  }
});

router.get('/customers/export', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const headers = [
      'ID Sistem',
      'ID Pelanggan',
      'Nama',
      'Telepon',
      'Email',
      'Alamat',
      'Paket',
      'Tag ONU',
      'PPPoE Username',
      'PPPoE Profile',
      'Isolir Profile',
      'Status',
      'Tanggal Pasang',
      'Auto Isolir',
      'Tgl Isolir',
      'ODP',
      'Latitude',
      'Longitude',
      'Catatan'
    ];
    const mapCustomerRow = (c) => ([
      c.id,
      c.customer_code || '',
      c.name,
      c.phone,
      c.email || '',
      c.address,
      c.package_name || '-',
      c.genieacs_tag,
      c.pppoe_username,
      c.normal_pppoe_profile || c.package_pppoe_profile || c.package_name || '',
      c.isolir_profile,
      c.status,
      c.install_date,
      c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      c.isolate_day,
      c.odp_name || '-',
      c.lat || '',
      c.lng || '',
      c.notes
    ]);
    const buildCustomerSheet = (rows) => {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map(mapCustomerRow)]);
      ws['!cols'] = headers.map((header) => ({ wch: Math.max(String(header).length + 4, 14) }));
      return ws;
    };
    const normalizeStatus = (value) => String(value || '').trim().toLowerCase();
    const activeCustomers = customers.filter((c) => normalizeStatus(c.status) === 'active');
    const inactiveCustomers = customers.filter((c) => normalizeStatus(c.status) === 'inactive');
    const suspendedCustomers = customers.filter((c) => normalizeStatus(c.status) === 'suspended');

    const wb = buildCustomerImportTemplateWorkbook();
    XLSX.utils.book_append_sheet(wb, buildCustomerSheet(activeCustomers), 'Pelanggan Aktif');
    XLSX.utils.book_append_sheet(wb, buildCustomerSheet(inactiveCustomers), 'Pelanggan Nonaktif');
    XLSX.utils.book_append_sheet(wb, buildCustomerSheet(suspendedCustomers), 'Pelanggan Isolir');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('Gagal export data.');
  }
});

router.post('/customers/import', requireAdminSession, restrictToAdmin, upload.single('file'), async (req, res) => {
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
        customer_code: cleanRow['ID Pelanggan'] || cleanRow['customer_code'] || cleanRow['kode_pelanggan'] || '',
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
      
      const id = cleanRow['ID Sistem'] || cleanRow['ID'] || cleanRow['id'];
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

router.post('/customers/:id/isolate', requireAdminSession, restrictToAdmin, async (req, res) => {
  let redirectTarget = buildPostIsolationRedirect(req);
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    const unpaidInvoices = customer ? billingSvc.getUnpaidInvoicesByCustomerId(customer.id) : [];
    if (customer) {
      queueManualIsolationNotifications({ req, customer, unpaidInvoices });
    }
    req.session._msg = { type: 'success', text: `Pelanggan "${customer?.name || req.params.id}" berhasil di-isolir manual. Info internet dimatikan sudah masuk inbox pelanggan, push/WhatsApp sedang dikirim.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
    redirectTarget = resolveAdminPathFromRequest(req, '/admin/customers');
  }
  return forceAdminRedirect(res, redirectTarget);
});

router.post('/customers/:id/unisolate', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await customerSvc.activateCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Layanan pelanggan "${customer.name}" berhasil diaktifkan kembali.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
  }
  return redirectBack(res, '/admin/customers');
});

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      const customer = customerSvc.getCustomerById(req.params.id);
      const invoice = billingSvc.getInvoiceById(result.invoiceId);
      await trySendInvoiceCreatedPush(customer, invoice, req, {
        body: `Tagihan periode ${month}/${year} sudah tersedia. Silakan buka aplikasi pelanggan untuk melihat nominal dan link pembayaran.`
      });
    }
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

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    const invoice = billingSvc.getInvoiceById(out.invoiceId);
    await trySendInvoiceCreatedPush(customer, invoice, req, {
      title: 'Tagihan Susulan',
      body: `Tagihan susulan prorata ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sudah tersedia di aplikasi pelanggan.`
    });
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

    let whatsappWarning = '';
    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const voided = Number(sum.voidedMonths || 0);
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}, hangus prabayar: ${voided}.` };

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
        const paidInvoicesLegacy = (Array.isArray(sum.paidMonths) ? sum.paidMonths : [])
          .map((paidMonth) => {
            const allInvoices = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
            return (Array.isArray(allInvoices) ? allInvoices : []).find(
              (item) => Number(item?.period_month) === Number(paidMonth) && Number(item?.period_year) === Number(sum.year)
            ) || null;
          })
          .filter(Boolean);
        const paidInvoices = Array.isArray(sum.paidInvoices) && sum.paidInvoices.length
          ? sum.paidInvoices.filter(Boolean)
          : paidInvoicesLegacy;
        try {
          await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
            baseUrl: resolveRequestBaseUrl(req),
            paidBy,
            paidAt: new Date().toLocaleString('id-ID')
          });
        } catch (notifyError) {
          whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
        }
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
          try {
            await sendPaidWhatsappNotification(customer, inv ? [inv] : [], inv, {
              baseUrl: resolveRequestBaseUrl(req),
              paidBy,
              paidAt: new Date().toLocaleString('id-ID')
            });
          } catch (notifyError) {
            whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
          }
        }
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
    if (req.session._msg && req.session._msg.type === 'success' && whatsappWarning) {
      req.session._msg.text += whatsappWarning;
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
*/
registerCustomerRoutes(router, {
  express,
  upload,
  requireAdminSession,
  restrictToAdmin,
  company,
  flashMsg,
  getSettings,
  customerSvc,
  customerDetailSvc,
  mikrotikService,
  oltSvc,
  odpSvc,
  billingSvc,
  db,
  logger,
  XLSX,
  isTruthyFormValue,
  getExistingPppoeSecretByUsername,
  resolveCustomerPppoeProfile,
  resolveAvailablePppoeProfile,
  buildWelcomeWhatsappMessage,
  buildIsolationWhatsappMessage,
  resolveRequestBaseUrl,
  trySendWhatsappPayment,
  redirectBack,
  resolvePaidByName,
  sendPaidWhatsappNotification,
  usageSvc,
  isPushConfigured,
  sendPushToCustomer
});
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

router.post('/billing/generate', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, year } = req.body;
    const generated = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    const count = typeof generated === 'number' ? generated : Number(generated?.count || 0);
    const createdInvoiceIds = Array.isArray(generated?.createdInvoiceIds) ? generated.createdInvoiceIds : [];
    for (const invoiceId of createdInvoiceIds) {
      const invoice = billingSvc.getInvoiceById(invoiceId);
      if (!invoice) continue;
      const customer = customerSvc.getCustomerById(invoice.customer_id);
      await trySendInvoiceCreatedPush(customer, invoice, req, {
        body: `Tagihan internet periode ${month}/${year} sudah tersedia. Silakan buka aplikasi pelanggan untuk melihat detail pembayaran.`
      });
    }
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
      hotspot_username: String(row.hotspot_username || '').trim(),
      mac_address: String(row.mac_address || '').trim(),
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
    let whatsappWarning = '';
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let customerId = null;
    const paidInvoices = [];
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        customerId = inv.customer_id;
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes, resolvePaymentActor(req, paidBy));
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
      if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && freshCustomer.unpaid_count === 0) {
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
        try {
          await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
            baseUrl: resolveRequestBaseUrl(req),
            paidBy,
            paidAt: new Date().toLocaleString('id-ID')
          });
        } catch (notifyError) {
          whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
        }
      }
    }

    req.session._msg = { type: 'success', text: `${ids.length} tagihan berhasil dilunasi.${whatsappWarning}` };
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
    let whatsappWarning = '';
    billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes, resolvePaymentActor(req, paidBy));
    
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
      try {
        await sendPaidWhatsappNotification(customer, [inv], inv, {
          baseUrl: resolveRequestBaseUrl(req),
          paidBy,
          paidAt: new Date().toLocaleString('id-ID')
        });
      } catch (notifyError) {
        whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
      }
    }
    if (customer && ['suspended', 'inactive'].includes(String(customer.status || '').toLowerCase())) {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
      if (freshCustomer && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: `Tagihan berhasil ditandai lunas.${whatsappWarning}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/unpay', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const confirmPassword = String(req.body.confirm_password || '').trim();
    if (!verifyPassword(confirmPassword, getSetting('admin_password', ''))) {
      throw new Error('Password admin salah. Batalkan lunas tidak diproses.');
    }
    billingSvc.markAsUnpaid(req.params.id, resolvePaymentActor(req, 'Admin'));
    req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/qris-assign', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    const force = String(req.query.force || '') === '1';
    const assigned = billingSvc.assignUniqueQrisForInvoice(invId, { force });
    req.session._msg = {
      type: 'success',
      text: `Kode pembayaran dibuat: Rp ${Number(assigned?.qris_amount_unique || 0).toLocaleString('id-ID')} (kode ${String(assigned?.qris_unique_code || '').padStart(3, '0')}).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat kode pembayaran: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/qris-clear', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Kode pembayaran dihapus dari tagihan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kode pembayaran: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  const asJson = wantsJsonResponse(req);
  try {
    let inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status || '').toLowerCase() === 'unpaid' && String(getSetting('qris_static_payload', '') || '').trim()) {
      inv = billingSvc.assignUniqueQrisForInvoice(inv.id);
    }

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

    const requestBaseUrl = resolveRequestBaseUrl(req);
    const queuedInvoice = { ...inv };
    const queuedCustomer = { ...customer };

    setImmediate(async () => {
      try {
        const whatsappStatus = await whatsappGateway.getStatus();
        const ready = await whatsappGateway.ensureReady(25000);
        if (!ready) {
          const waState = `${whatsappStatus?.provider || 'local'}:${whatsappStatus?.connection || 'unknown'}`;
          throw new Error(`WhatsApp belum siap (${waState}).`);
        }

        const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(queuedCustomer.id);
        let finalMessage = buildBillingWhatsappMessage(queuedCustomer, unpaidInvoices, queuedInvoice, { baseUrl: requestBaseUrl });
        const manualPaymentInfo = buildManualPaymentMessage();
        if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

        const qrisAmountUnique = Number(queuedInvoice.qris_amount_unique || 0) || 0;
        const qrisImageBuffer = qrisAmountUnique > 0 ? await buildInvoiceQrisImageBuffer(queuedInvoice) : Buffer.alloc(0);

        const sent = qrisImageBuffer.length
          ? await whatsappGateway.sendImage(queuedCustomer.phone, qrisImageBuffer, finalMessage)
          : await whatsappGateway.sendText(queuedCustomer.phone, finalMessage);
        if (!sent) {
          const waState = `${whatsappStatus?.provider || 'local'}:${whatsappStatus?.connection || 'unknown'}`;
          throw new Error(`Gateway WhatsApp menolak pengiriman. Status saat ini: ${waState}.`);
        }
      } catch (error) {
        logger.warn(`[BillingWA] Gagal kirim tagihan invoice ${queuedInvoice.id}: ${error.message || String(error)}`);
      }
    });

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp untuk ${customer.name} sedang dikirim di latar belakang.` };
    if (asJson) {
      return res.json({
        success: true,
        queued: true,
        message: req.session._msg.text,
        customerName: customer.name,
        invoiceId: Number(inv.id || 0) || null
      });
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
    if (asJson) {
      return res.status(400).json({ success: false, error: req.session._msg.text });
    }
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/push', requireAdminSession, async (req, res) => {
  try {
    let inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status || '').toLowerCase() === 'paid') throw new Error('Tagihan ini sudah lunas.');
    if (String(inv.status || '').toLowerCase() === 'unpaid' && String(getSetting('qris_static_payload', '') || '').trim()) {
      inv = billingSvc.assignUniqueQrisForInvoice(inv.id);
    }

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const settings = getSettings();
    if (!isPushConfigured(settings) || !isEnabledSwitch(settings.onesignal_push_invoice_enabled ?? true)) {
      throw new Error('OneSignal tagihan belum aktif atau belum lengkap.');
    }

    const requestBaseUrl = resolveRequestBaseUrl(req);
    const dueText = formatInvoiceDueDate(inv, customer);
    const title = `Tagihan INV-${inv.id}`;
    const body = `Tagihan ${inv.period_month}/${inv.period_year} sebesar Rp ${Number(inv.amount || 0).toLocaleString('id-ID')} jatuh tempo ${dueText}.`;
    const result = await sendPushToCustomer(customer, {
      settings,
      title,
      message: body,
      targetUrl: `${requestBaseUrl}/customer/dashboard#billing`,
      data: {
        kind: 'invoice',
        source: 'admin-manual-billing-push',
        invoiceId: Number(inv.id || 0) || null,
        customerId: Number(customer.id || 0) || null
      }
    });

    if (!result || result.success !== true) {
      throw new Error(result?.reason || result?.error || 'OneSignal tidak menerima push.');
    }

    customerSvc.addPortalNotification(customer.id, {
      kind: 'invoice',
      tab: 'billing',
      title,
      body,
      payload: {
        source: 'admin-manual-billing-push',
        senderName: 'Billing',
        senderRole: 'Tagihan',
        invoiceId: Number(inv.id || 0) || null
      }
    }, { dedupeWindowMs: 60 * 1000 });

    req.session._msg = { type: 'success', text: `Notifikasi tagihan push berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim push tagihan: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/_legacy-disabled/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

    const whatsappStatus = await whatsappGateway.getStatus();
    const ready = await whatsappGateway.ensureReady(10000);
    if (!ready) {
      const waState = `${whatsappStatus?.provider || 'local'}:${whatsappStatus?.connection || 'unknown'}`;
      throw new Error(`WhatsApp belum siap (${waState}). Silakan cek status WhatsApp di menu Admin.`);
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

    const templateQris = `Yth. *{{nama}}*,\n\nTagihan internet Anda untuk periode *{{periode}}*.\n\n📦 *Paket:* {{paket}}\n💳 *Bayar Online / Payment Gateway*\n💰 *Nominal (WAJIB tepat):* Rp {{qris_nominal}}\n🏷️ *Kode pembayaran:* {{qris_kode}}\n{{qris_qr}}\n\nCatatan: nominal harus sama persis agar sistem dapat mendeteksi pembayaran.\n\nTerima kasih.\nSalam,\nAdmin ${getSetting('company_header', 'ISP')}`;

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
          .replace(/{{qris_qr}}/gi, qrisQrUrl ? `🔗 Link bayar: ${qrisQrUrl}` : '')
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
        'Bayar Online / Payment Gateway',
        `Nominal tepat: Rp ${Number(qrisAmountUnique).toLocaleString('id-ID')}`,
        `Kode pembayaran: ${String(qrisCode).padStart(3, '0')}`
      ];
      if (qrisQrUrl) qrisLines.push(`Link bayar: ${qrisQrUrl}`);
      finalMessage += `\n${qrisLines.join('\n')}`;
    }
    if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

    const sent = await whatsappGateway.sendText(customer.phone, finalMessage);
    if (!sent) {
      const waState = `${whatsappStatus?.provider || 'local'}:${whatsappStatus?.connection || 'unknown'}`;
      throw new Error(`Gagal mengirim pesan melalui Gateway WhatsApp. Status saat ini: ${waState}.`);
    }

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
  }
  return redirectBack(res, '/admin/billing');
});

router.post('/billing/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
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
  resolvePaymentActor,
  sendPaidWhatsappNotification,
  buildBillingWhatsappMessage,
  buildManualPaymentMessage,
  resolveRequestBaseUrl,
  redirectBack,
  isPushConfigured,
  sendPushToCustomer
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
    const ticket = ticketSvc.getTicketById(ticketId);
    if (ticket?.customer_id) {
      const statusLabel = String(status || 'open').replace(/_/g, ' ').toUpperCase();
      customerSvc.addPortalNotification(ticket.customer_id, {
        kind: 'ticket',
        tab: 'ticketing',
        title: `Update tiket #${ticket.id}`,
        body: `${ticket.subject || 'Keluhan pelanggan'} - Status ${statusLabel}`
      }, { dedupeWindowMs: 5 * 60 * 1000 });
    }
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          if (ticket) {
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Petugas:* Admin\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await whatsappGateway.sendText(ticket.customer_phone, waMsg);
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
                await whatsappGateway.sendText(digits, adminMsg);
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
router.get('/reports/export-paid', requireAdminSession, (req, res) => {
  try {
    const year = Math.max(2000, parseInt(req.query.year, 10) || new Date().getFullYear());
    const month = Math.max(0, Math.min(12, parseInt(req.query.month, 10) || 0));
    const report = billingSvc.getPaidInvoiceReport({ year, month });
    const periodYear = Math.max(2000, parseInt(report?.year, 10) || year);
    const periodMonth = Math.max(0, Math.min(12, parseInt(report?.month, 10) || 0));
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const periodLabel = periodMonth ? `${monthNames[periodMonth - 1]} ${periodYear}` : `Tahun ${periodYear}`;
    const wb = XLSX.utils.book_new();
    const rows = [
      ['DATA PELANGGAN'],
      [],
      [periodLabel, '', '', '', '', 'Total Jual', 'Total PPN', 'Total Invoice', ''],
      ['', '', '', '', '', report?.totalSaleAmount || 0, report?.totalPpnAmount || 0, report?.totalInvoiceAmount || 0, ''],
      ['No', 'Nama Pelanggan', 'NIK', 'NPWP', 'Alamat', 'Harga Jual', 'PPN', 'Nominal Invoice', 'Keterangan']
    ];
    const items = Array.isArray(report?.items) ? report.items : [];
    items.forEach((item) => {
      rows.push([
        item.no,
        item.customerName || '',
        item.nik || '',
        item.npwp || '',
        item.address || '',
        Number(item.saleAmount || 0),
        Number(item.ppnAmount || 0),
        Number(item.nominalInvoice || 0),
        item.description || ''
      ]);
    });
    if (!items.length) {
      rows.push(['', 'Belum ada invoice lunas pada periode ini', '', '', '', 0, 0, 0, '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [
      { wch: 8 },
      { wch: 28 },
      { wch: 18 },
      { wch: 18 },
      { wch: 34 },
      { wch: 16 },
      { wch: 14 },
      { wch: 18 },
      { wch: 40 }
    ];
    ws['!merges'] = [
      XLSX.utils.decode_range('A1:I1'),
      XLSX.utils.decode_range('A3:E3')
    ];
    ws['!freeze'] = { xSplit: 0, ySplit: 5 };
    ['F', 'G', 'H'].forEach((col) => {
      for (let rowIndex = 4; rowIndex <= rows.length; rowIndex += 1) {
        const cell = ws[`${col}${rowIndex}`];
        if (cell && typeof cell.v === 'number') {
          cell.t = 'n';
          cell.z = '"Rp" #,##0';
        }
      }
    });
    XLSX.utils.book_append_sheet(wb, ws, 'Laporan Lunas');
    const periodSlug = month
      ? `${String(year)}-${String(month).padStart(2, '0')}`
      : `${String(year)}`;
    const downloadName = `laporan_invoice_lunas_${periodSlug}.xlsx`;
    const tempFile = path.join(os.tmpdir(), `${Date.now()}-${downloadName}`);
    XLSX.writeFile(wb, tempFile, { bookType: 'xlsx' });
    return res.download(tempFile, downloadName, (downloadError) => {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (cleanupError) {
        logger.warn(`[Reports] Gagal hapus file export sementara: ${cleanupError.message}`);
      }
      if (downloadError && !res.headersSent) {
        logger.error(`[Reports] Gagal kirim file export invoice lunas: ${downloadError.stack || downloadError.message}`);
        res.status(500).send('Gagal mengirim file export laporan invoice lunas.');
      }
    });
  } catch (error) {
    logger.error(`[Reports] Gagal export laporan invoice lunas: ${error.stack || error.message}`);
    res.status(500).send('Gagal export laporan invoice lunas.');
  }
});

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
function renderBookkeepingFormPage(req, res, formData = {}, msg = null, options = {}) {
  const now = new Date();
  const isEdit = Boolean(options.isEdit);
  const categories = bookkeepingSvc.getCategories();
  const normalizedType = String(formData.type || 'expense').trim().toLowerCase() === 'income' ? 'income' : 'expense';
  const categoryOptions = Array.isArray(categories[normalizedType]) ? categories[normalizedType] : [];
  let selectedCategory = String(formData.category || '').trim();
  let customCategory = String(formData.custom_category || '').trim();
  if (selectedCategory && !categoryOptions.includes(selectedCategory) && !customCategory) {
    customCategory = selectedCategory;
    selectedCategory = '';
  }
  return res.render('admin/bookkeeping_form', {
    title: isEdit ? 'Edit Pembukuan' : 'Tambah Pembukuan',
    company: company(),
    activePage: 'bookkeeping',
    categories,
    paymentMethods: typeof bookkeepingSvc.getPaymentMethods === 'function' ? bookkeepingSvc.getPaymentMethods() : [],
    formAction: options.formAction || '/admin/bookkeeping/new',
    formMode: isEdit ? 'edit' : 'create',
    formData: {
      id: formData.id || '',
      type: normalizedType,
      entry_date: String(formData.entry_date || new Date().toISOString().slice(0, 10)).trim(),
      amount: String(formData.amount || '').trim(),
      category: selectedCategory,
      custom_category: customCategory,
      description: String(formData.description || '').trim(),
      payment_method: String(formData.payment_method || 'cash').trim(),
      month: String(formData.month || (now.getMonth() + 1)).trim(),
      year: String(formData.year || now.getFullYear()).trim(),
      source_type: String(formData.source_type || '').trim()
    },
    msg: msg || flashMsg(req)
  });
}

router.get('/bookkeeping', requireAdminSession, (req, res) => {
  const now = new Date();
  const filterMonth = Math.max(0, Math.min(12, parseInt(req.query.month || (now.getMonth() + 1), 10) || (now.getMonth() + 1)));
  const filterYear = parseInt(req.query.year || now.getFullYear(), 10) || now.getFullYear();
  const type = String(req.query.type || '').trim();
  const category = String(req.query.category || '').trim();
  const search = String(req.query.search || '').trim();
  const detailSection = String(req.query.detail_section || '').trim().toLowerCase();
  const detailBucket = String(req.query.detail_bucket || '').trim().toLowerCase();
  const cashHolder = String(req.query.cash_holder || '').trim().toLowerCase();
  const requestedView = String(req.query.view || '').trim().toLowerCase();
  const allowedViews = new Set(['summary', 'ledger', 'staff-cash', 'settlements', 'role-payments']);
  const view = allowedViews.has(requestedView) ? requestedView : 'summary';
  const pageSize = 20;
  const requestedPage = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const categories = bookkeepingSvc.getCategories();
  try {
    bookkeepingSvc.syncPaidInvoiceIncomeEntries();
    if (typeof bookkeepingSvc.syncAgentVoucherIncomeEntries === 'function') bookkeepingSvc.syncAgentVoucherIncomeEntries();
    cashLedgerSvc.backfillBookkeepingHolders();
  } catch (syncError) {
    console.warn('[BOOKKEEPING] Sync paid invoice income failed:', syncError.message);
  }
  const summary = bookkeepingSvc.getSummary({ month: filterMonth, year: filterYear });
  const dashboard = bookkeepingSvc.getDashboardDetails({ month: filterMonth, year: filterYear });
  const categoryDetail = (detailSection && detailBucket && typeof bookkeepingSvc.listDashboardCategoryDetails === 'function')
    ? bookkeepingSvc.listDashboardCategoryDetails({
      section: detailSection,
      bucket: detailBucket,
      month: filterMonth,
      year: filterYear
    })
    : null;
  const cashLedger = cashLedgerSvc.getBookkeepingDashboard({ month: filterMonth, year: filterYear });
  const [cashHolderRole = '', cashHolderEntityRaw = ''] = cashHolder.split(':');
  const cashHolderEntityId = cashHolderEntityRaw === 'null' ? null : Number(cashHolderEntityRaw);
  const cashHolderTransactions = (detailSection === 'admin' && detailBucket === 'cash' && cashHolderRole)
    ? cashLedgerSvc.listCashHolderTransactions({
      role: cashHolderRole,
      entityId: Number.isFinite(cashHolderEntityId) ? cashHolderEntityId : (cashHolderRole === 'admin' ? 0 : null),
      month: filterMonth,
      year: filterYear,
      limit: 200
    })
    : [];
  const settlementSourceOptions = cashLedgerSvc
    .listManagedCashHolders({ includeInactive: true })
    .filter((item) => item.role !== 'admin');
  const totalEntries = bookkeepingSvc.countEntries({
    type,
    category,
    search,
    month: filterMonth,
    year: filterYear
  });
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const entries = bookkeepingSvc.listEntries({
    type,
    category,
    search,
    month: filterMonth,
    year: filterYear,
    limit: pageSize,
    offset: (currentPage - 1) * pageSize
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
    view,
    categories,
    summary,
    dashboard,
    categoryDetail,
    detailSection,
    detailBucket,
    cashHolder,
    cashHolderTransactions,
    cashLedger,
    settlementSourceOptions,
    entries,
    totalEntries,
    currentPage,
    totalPages,
    pageSize,
    msg: flashMsg(req)
  });
});

router.get('/bookkeeping/new', requireAdminSession, restrictToAdmin, (req, res) => {
  renderBookkeepingFormPage(req, res);
});

router.get('/bookkeeping/:id/edit', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const entry = bookkeepingSvc.getEntryById(req.params.id);
    if (!entry) throw new Error('Data pembukuan tidak ditemukan.');
    if (String(entry.source_type || '') === 'invoice') throw new Error('Pembukuan otomatis dari invoice tidak bisa diedit manual.');
    renderBookkeepingFormPage(req, res, {
      ...entry,
      month: req.query.month || (entry.entry_date ? Number(String(entry.entry_date).slice(5, 7)) : ''),
      year: req.query.year || (entry.entry_date ? Number(String(entry.entry_date).slice(0, 4)) : '')
    }, null, {
      isEdit: true,
      formAction: `/admin/bookkeeping/${entry.id}/update`
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
    return redirectBack(res, '/admin/bookkeeping');
  }
});

router.post('/bookkeeping/new', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const createdByRole = req.session?.isCashier ? 'cashier' : 'admin';
    const createdByName = resolvePaidByName(req, 'Admin');
    bookkeepingSvc.createEntry({
      ...req.body,
      created_by_role: createdByRole,
      created_by_name: createdByName
    });
    req.session._msg = { type: 'success', text: 'Pembukuan berhasil ditambahkan.' };
    return res.redirect('/admin/bookkeeping');
  } catch (e) {
    return renderBookkeepingFormPage(req, res, req.body, {
      type: 'error',
      text: 'Gagal menambah pembukuan: ' + (e.message || String(e))
    });
  }
});

router.post('/bookkeeping/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    bookkeepingSvc.updateEntry(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Pembukuan berhasil diperbarui.' };
    const month = String(req.body.month || '').trim();
    const year = String(req.body.year || '').trim();
    return res.redirect(`/admin/bookkeeping${month && year ? `?month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}&view=ledger` : '?view=ledger'}`);
  } catch (e) {
    return renderBookkeepingFormPage(req, res, { ...req.body, id: req.params.id }, {
      type: 'error',
      text: 'Gagal memperbarui pembukuan: ' + (e.message || String(e))
    }, {
      isEdit: true,
      formAction: `/admin/bookkeeping/${req.params.id}/update`
    });
  }
});

router.post('/bookkeeping', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
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

router.post('/bookkeeping/settlements', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const month = Math.max(1, Math.min(12, parseInt(req.body.month || (new Date().getMonth() + 1), 10) || (new Date().getMonth() + 1)));
  const year = parseInt(req.body.year || new Date().getFullYear(), 10) || new Date().getFullYear();
  try {
    cashLedgerSvc.createSettlement({
      ...req.body,
      created_by_role: req.session?.isCashier ? 'cashier' : 'admin',
      created_by_name: resolvePaidByName(req, 'Admin')
    });
    req.session._msg = { type: 'success', text: 'Setoran ke admin berhasil dicatat.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mencatat setoran: ' + (e.message || String(e)) };
  }
  return res.redirect(`/admin/bookkeeping?month=${month}&year=${year}`);
});

router.get('/bookkeeping/export', requireAdminSession, (req, res) => {
  const now = new Date();
  const filterMonth = Math.max(0, Math.min(12, parseInt(req.query.month || (now.getMonth() + 1), 10) || (now.getMonth() + 1)));
  const filterYear = parseInt(req.query.year || now.getFullYear(), 10) || now.getFullYear();
  try {
    bookkeepingSvc.syncPaidInvoiceIncomeEntries();
    if (typeof bookkeepingSvc.syncAgentVoucherIncomeEntries === 'function') bookkeepingSvc.syncAgentVoucherIncomeEntries();
    cashLedgerSvc.backfillBookkeepingHolders();

    const summary = bookkeepingSvc.getSummary({ month: filterMonth, year: filterYear });
    const comparison = bookkeepingSvc.getDashboardDetails({ month: filterMonth, year: filterYear }).comparison || {};
    const exportData = cashLedgerSvc.buildExportData({ month: filterMonth, year: filterYear });
    const workbook = XLSX.utils.book_new();

    const summarySheetRows = [
      { Metrik: 'Periode', Nilai: filterMonth > 0 ? `${filterMonth}/${filterYear}` : String(filterYear) },
      { Metrik: 'Total Pemasukan', Nilai: Number(summary.total_income || 0) },
      { Metrik: 'Total Pengeluaran', Nilai: Number(summary.total_expense || 0) },
      { Metrik: 'Total Bersih', Nilai: Number(comparison.netAmount || 0) },
      { Metrik: 'Jumlah Pemasukan', Nilai: Number(summary.income_count || 0) },
      { Metrik: 'Jumlah Pengeluaran', Nilai: Number(summary.expense_count || 0) },
      ...exportData.summaryRows
    ];

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summarySheetRows), 'Ringkasan');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.rolePayments), 'Per Peran');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.actorPayments), 'Per Petugas');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.paymentDetails), 'Detail Pembayaran');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.settlements), 'Detail Setor');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.balances), 'Saldo Berjalan');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportData.entries), 'Ledger');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const fileLabel = filterMonth > 0
      ? `pembukuan-${String(filterYear)}-${String(filterMonth).padStart(2, '0')}.xlsx`
      : `pembukuan-${String(filterYear)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}"`);
    return res.send(buffer);
  } catch (error) {
    logger.error(`[Bookkeeping] Gagal export pembukuan: ${error.stack || error.message}`);
    return res.status(500).send('Gagal export pembukuan.');
  }
});

router.post('/bookkeeping/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    bookkeepingSvc.deleteEntry(req.params.id);
    req.session._msg = { type: 'success', text: 'Data pembukuan dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus pembukuan: ' + (e.message || String(e)) };
  }
  return redirectBack(res, '/admin/bookkeeping');
});

router.get('/usage-audit', requireAdminSession, restrictToAdmin, (req, res) => {
  const rows = usageSvc.listUsageReplayAuditCurrentPeriod(new Date(), {
    minDiffBytes: 1024 * 1024 * 1024,
    minRatio: 1.25,
    limit: 300
  });
  const stats = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.totalStoredBytes += Number(row.storedTotalBytes || 0);
    acc.totalRuntimeBytes += Number(row.runtimeTotalBytes || 0);
    acc.totalDiffBytes += Number(row.diffBytes || 0);
    if (row.repairable) {
      acc.repairable += 1;
      acc.totalRepairSavedBytes += Number(row.repairSavedBytes || 0);
    } else {
      acc.manualReview += 1;
    }
    return acc;
  }, {
    total: 0,
    repairable: 0,
    manualReview: 0,
    totalStoredBytes: 0,
    totalRuntimeBytes: 0,
    totalDiffBytes: 0,
    totalRepairSavedBytes: 0
  });
  res.render('admin/usage_audit', {
    title: 'Audit Usage Pelanggan',
    company: company(),
    activePage: 'usage_audit',
    rows,
    stats,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/usage-audit/repair-all', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const results = usageSvc.repairUsageReplayForAllCurrentCustomers(new Date());
    const repairedCount = Array.isArray(results) ? results.length : 0;
    const savedBytes = (Array.isArray(results) ? results : []).reduce((sum, row) => (
      sum + Math.max(0, Number(row?.savedBytes || 0))
    ), 0);
    req.session._msg = {
      type: 'success',
      text: repairedCount > 0
        ? `Repair usage selesai untuk ${repairedCount} pelanggan. Hemat ${((savedBytes / (1024 ** 3)) || 0).toFixed(2)} GB duplikasi.`
        : 'Tidak ada pelanggan yang perlu direpair otomatis.'
    };
  } catch (error) {
    req.session._msg = { type: 'error', text: `Gagal repair usage massal: ${error.message}` };
  }
  return res.redirect('/admin/usage-audit');
});

router.post('/usage-audit/:id/repair', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const customerId = Number(req.params.id || 0);
    const customer = customerSvc.getCustomerById(customerId);
    if (!customer) {
      req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
      return res.redirect('/admin/usage-audit');
    }
    const result = usageSvc.repairUsageReplayForCurrentPeriod(customerId, new Date());
    req.session._msg = result?.repaired
      ? {
          type: 'success',
          text: `Usage ${customer.name} direpair. Dikoreksi ${((Number(result.savedBytes || 0) / (1024 ** 3)) || 0).toFixed(2)} GB.`
        }
      : {
          type: 'success',
          text: `Usage ${customer.name} sudah normal, tidak ada replay yang perlu diperbaiki.`
        };
  } catch (error) {
    req.session._msg = { type: 'error', text: `Gagal repair usage pelanggan: ${error.message}` };
  }
  return res.redirect('/admin/usage-audit');
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

router.post('/settings/payment/test-qris-payload', requireAdminSession, upload.fields([{ name: 'qris_static_qr_file', maxCount: 1 }]), async (req, res) => {
  try {
    const uploadedQrisStaticQr = getUploadedSingleFile(req, 'qris_static_qr_file');
    const result = await inspectQrisPayloadInput({
      payload: req.body?.qris_static_payload || '',
      qrUrl: req.body?.qris_static_qr_url || '',
      uploadedFile: uploadedQrisStaticQr
    });

    return res.json({
      ok: Boolean(result.ok),
      source: result.source || '',
      payload: result.payload || '',
      message: result.message || '',
      payloadLength: Number(String(result.payload || '').length || 0)
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: String(error?.message || error || 'Gagal mengetes payload QRIS.')
    });
  }
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

router.post('/update/run', requireAdminSession, restrictToAdmin, async (req, res) => {
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
  const localCommitBefore = getGitCommit(repoRoot, 'HEAD', true) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const pm2Process = detectPm2Process(repoRoot);
  const restartProcessName = pm2Process?.name || getDefaultPm2ProcessName(repoRoot);
  const settingsPath = getOperationalSettingsPath();
  const restoreSettingsPath = getPrivateSettingsPath();
  const dbDir = path.join(repoRoot, 'database');
  const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys');
  const authPath = path.join(repoRoot, authFolder);
  const logsPath = path.join(repoRoot, 'logs');
  const uploadsPath = path.join(repoRoot, 'public', 'uploads');
  let pulledNewCode = false;
  let safetyStashRef = '';
  let safetyStashLabel = '';
  let runtimeBackup = null;

  const restorePreservedData = () => {
    const restored = restoreUpdateRuntimeBackup(runtimeBackup, {
      privateSettingsPath: restoreSettingsPath,
      dbDir,
      authPath,
      uploadsPath
    });
    assertRestoredRuntimeIsSafe(runtimeBackup, restored);
    if (restored.restored) {
      log.push(`Runtime data dipulihkan dari ${restored.backupRoot}`);
      if (restored.database?.exists) {
        log.push(`Database runtime OK: pelanggan=${restored.database.customers ?? '-'}, tagihan=${restored.database.invoices ?? '-'}, integrity=${restored.database.integrity}`);
      }
    }
  };

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Folder ini belum menjadi git repository.');

    const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Gagal git fetch.');

    const remoteHead = getGitCommit(repoRoot, `origin/${branch}`, true);
    if (!remoteHead) throw new Error(`Tidak bisa membaca commit origin/${branch} dari GitHub.`);
    log.push(`$ git rev-parse --short origin/${branch}`);
    log.push(remoteHead);

    const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    const remoteVersion = remote.ok ? (String(remote.stdout || '').trim() || '-') : '-';

    if (remoteHead === localCommitBefore) {
      req.session._msg = {
        type: 'success',
        text: `Versi sudah terbaru: ${localBefore} (${localCommitBefore})`
      };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/update');
    }

    runtimeBackup = await createUpdateRuntimeBackup({
      repoRoot,
      settingsPath,
      privateSettingsPath: restoreSettingsPath,
      dbDir,
      authPath,
      uploadsPath
    });
    log.push(`Runtime data diamankan permanen di ${runtimeBackup.backupRoot}`);
    if (runtimeBackup.database?.summary?.exists) {
      log.push(`Backup database runtime OK: pelanggan=${runtimeBackup.database.summary.customers ?? '-'}, tagihan=${runtimeBackup.database.summary.invoices ?? '-'}, integrity=${runtimeBackup.database.summary.integrity}`);
    }

    const safetyStash = createUpdateSafetyStash(repoRoot);
    safetyStashLabel = safetyStash.label || '';
    safetyStashRef = safetyStash.ref || '';
    if (safetyStash.statusLines?.length) {
      log.push('$ git status --porcelain');
      log.push(safetyStash.statusLines.join('\n'));
    }
    if (safetyStash.created) {
      pushCmd(`git stash push --include-untracked -m ${safetyStash.label}`, safetyStash.result);
      if (safetyStashRef) log.push(`Local source diamankan di ${safetyStashRef}`);
      restorePreservedData();
    } else if (!safetyStash.result.ok) {
      pushCmd(`git stash push --include-untracked -m ${safetyStash.label}`, safetyStash.result);
      throw new Error('Gagal mengamankan perubahan source lokal sebelum update.');
    }

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
    pulledNewCode = true;

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    restorePreservedData();

    const npm = runCmd('npm', ['install', '--no-audit', '--no-fund'], repoRoot);
    pushCmd('npm install --no-audit --no-fund', npm);
    if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');

    const validations = runProjectValidation(repoRoot);
    for (const validation of validations) {
      pushCmd(validation.label, validation.result);
      if (!validation.result.ok) {
        throw new Error(`Validasi update gagal pada langkah: ${validation.label}`);
      }
    }
    cleanupOldUpdateRuntimeBackups(repoRoot, 20);

    const localAfter = readTextFileSafe(versionPath) || '-';
    const localCommitAfter = getGitCommit(repoRoot, 'HEAD', true) || '-';
    const restartQueued = queuePm2Restart(restartProcessName, repoRoot);
    const restartMessage = restartQueued
      ? ` Proses ${restartProcessName} dijadwalkan restart otomatis.`
      : ` Restart proses ${restartProcessName} perlu dilakukan manual.`;
    const stashMessage = safetyStashRef
      ? ` Perubahan source lokal lama diamankan di ${safetyStashRef}${safetyStashLabel ? ` (${safetyStashLabel})` : ''}.`
      : '';
    req.session._msg = {
      type: 'success',
      text: `Update selesai. Versi: ${localBefore} -> ${localAfter}. Commit: ${localCommitBefore} -> ${localCommitAfter}.${restartMessage}${stashMessage}`
    };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    let rollbackNote = '';
    if (pulledNewCode && localCommitBefore && localCommitBefore !== '-') {
      const reset = runCmd('git', ['reset', '--hard', localCommitBefore], repoRoot);
      pushCmd(`git reset ${'--hard'} ${localCommitBefore}`, reset);
      if (reset.ok) {
        restorePreservedData();
        const npmRollback = runCmd('npm', ['install', '--no-audit', '--no-fund'], repoRoot);
        pushCmd('npm install --no-audit --no-fund (rollback)', npmRollback);
        if (safetyStashRef) {
          const stashPop = popUpdateSafetyStash(repoRoot, safetyStashRef);
          pushCmd(`git stash pop ${safetyStashRef}`, stashPop);
          rollbackNote = stashPop.ok
            ? ' Source code dikembalikan ke commit sebelumnya.'
            : ' Source code dikembalikan ke commit sebelumnya, tetapi stash perubahan lokal perlu dipulihkan manual.';
        } else {
          rollbackNote = ' Source code dikembalikan ke commit sebelumnya.';
        }
      } else {
        rollbackNote = ' Rollback source gagal, perlu dicek manual.';
      }
    }
    req.session._msg = { type: 'error', text: 'Gagal update: ' + (e?.message || e) + rollbackNote };
    req.session._updateLog = log.join('\n');
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

router.post('/settings', requireAdminSession, upload.fields(IMAGE_UPLOAD_FIELDS.map((name) => ({ name, maxCount: 1 }))), async (req, res) => {
  const currentSettings = getSettings();
  const settingsSection = String(req.body.settings_section || 'usaha').trim() || 'usaha';
  const settingsFieldGroups = {
    usaha: [
      'company_header',
      'customer_id_prefix',
      'footer_info',
      'company_legal_name',
      'upstream_provider_name',
      'support_by_enabled',
      'support_isp_logo_url',
      'pwa_logo_url',
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
      'login_otp_enabled',
      'customer_portal_banner_1_url',
      'customer_portal_banner_2_url',
      'customer_portal_banner_3_url'
    ],
    payment: [
      'default_gateway',
      'qris_static_enabled',
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
      'tr069_acs_url',
      'tr069_acs_username',
      'tr069_acs_password',
      'tr069_periodic_enable',
      'tr069_periodic_interval',
      'mikrotik_host',
      'mikrotik_port',
      'mikrotik_user',
      'mikrotik_password',
      'mikrotik_os_mode',
      'digiflazz_username',
      'digiflazz_api_key',
      'digiflazz_webhook_secret',
      'digiflazz_webhook_id',
      'digiflazz_markup'
    ],
    whatsapp: [
      'whatsapp_enabled',
      'whatsapp_provider',
      'whatsapp_api_key',
      'whatsapp_mpwa_base_url',
      'whatsapp_mpwa_api_key',
      'whatsapp_mpwa_send_path',
      'whatsapp_mpwa_image_path',
      'whatsapp_mpwa_auth_mode',
      'whatsapp_mpwa_number_field',
      'whatsapp_mpwa_message_field',
      'whatsapp_mpwa_device',
      'whatsapp_admin_numbers',
      'whatsapp_noc_numbers',
      'whatsapp_test_number',
      'onesignal_enabled',
      'onesignal_app_id',
      'onesignal_rest_api_key',
      'onesignal_push_invoice_enabled',
      'onesignal_push_announcement_enabled',
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
    monitoring: [
      'mass_outage_detection_enabled',
      'mass_outage_delay_minutes',
      'mass_outage_threshold_count',
      'mass_outage_threshold_percent',
      'mass_outage_sample_limit',
      'mass_outage_notify_whatsapp_admin_noc',
      'mass_outage_notify_whatsapp_technician',
      'mass_outage_notify_push_admin',
      'mass_outage_notify_push_technician',
      'mass_outage_notify_telegram',
      'mass_outage_zone_aliases',
      'ewallet_live_auto_start',
      'ewallet_log_service_default',
      'ewallet_log_query_default',
      'ewallet_log_limit_default'
    ]
  };
  const selectedFields = settingsFieldGroups[settingsSection] || [];
  const submittedSettings = {};
  selectedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      submittedSettings[field] = req.body[field];
    }
  });
  let newSettings = { ...currentSettings, ...submittedSettings };
  const paymentSaveNotes = [];
  const finishSettingsRedirect = () => req.session.save(() => res.redirect(`/admin/settings#settings-${settingsSection}`));
  try {
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;
    if (newSettings.onesignal_enabled === 'true') newSettings.onesignal_enabled = true;
    else if (newSettings.onesignal_enabled === 'false') newSettings.onesignal_enabled = false;
    if (newSettings.onesignal_push_invoice_enabled === 'true') newSettings.onesignal_push_invoice_enabled = true;
    else if (newSettings.onesignal_push_invoice_enabled === 'false') newSettings.onesignal_push_invoice_enabled = false;
    if (newSettings.onesignal_push_announcement_enabled === 'true') newSettings.onesignal_push_announcement_enabled = true;
    else if (newSettings.onesignal_push_announcement_enabled === 'false') newSettings.onesignal_push_announcement_enabled = false;
    if (newSettings.tr069_periodic_enable === 'true') newSettings.tr069_periodic_enable = true;
    else if (newSettings.tr069_periodic_enable === 'false') newSettings.tr069_periodic_enable = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    if (newSettings.qris_static_enabled === 'true') newSettings.qris_static_enabled = true;
    else if (newSettings.qris_static_enabled === 'false') newSettings.qris_static_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.xendit_enabled === 'true') newSettings.xendit_enabled = true;
    else if (newSettings.xendit_enabled === 'false') newSettings.xendit_enabled = false;

    if (newSettings.duitku_enabled === 'true') newSettings.duitku_enabled = true;
    else if (newSettings.duitku_enabled === 'false') newSettings.duitku_enabled = false;
    if (newSettings.mass_outage_detection_enabled === 'true') newSettings.mass_outage_detection_enabled = true;
    else if (newSettings.mass_outage_detection_enabled === 'false') newSettings.mass_outage_detection_enabled = false;
    [
      'mass_outage_notify_whatsapp_admin_noc',
      'mass_outage_notify_whatsapp_technician',
      'mass_outage_notify_push_admin',
      'mass_outage_notify_push_technician',
      'mass_outage_notify_telegram'
    ].forEach((field) => {
      if (newSettings[field] === 'true') newSettings[field] = true;
      else if (newSettings[field] === 'false') newSettings[field] = false;
    });
    if (newSettings.ewallet_live_auto_start === 'true') newSettings.ewallet_live_auto_start = true;
    else if (newSettings.ewallet_live_auto_start === 'false') newSettings.ewallet_live_auto_start = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = normalizePhoneList(newSettings.whatsapp_admin_numbers);
    } else if (Array.isArray(newSettings.whatsapp_admin_numbers)) {
      newSettings.whatsapp_admin_numbers = normalizePhoneList(newSettings.whatsapp_admin_numbers);
    }
    if (typeof newSettings.whatsapp_noc_numbers === 'string') {
      newSettings.whatsapp_noc_numbers = normalizePhoneList(newSettings.whatsapp_noc_numbers);
    } else if (Array.isArray(newSettings.whatsapp_noc_numbers)) {
      newSettings.whatsapp_noc_numbers = normalizePhoneList(newSettings.whatsapp_noc_numbers);
    }
    if (newSettings.server_port !== undefined && newSettings.server_port !== '') newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port !== undefined && newSettings.mikrotik_port !== '') newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay !== undefined && newSettings.whatsapp_broadcast_delay !== '') newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    if (newSettings.digiflazz_markup !== undefined && newSettings.digiflazz_markup !== '') newSettings.digiflazz_markup = parseInt(newSettings.digiflazz_markup) || 0;
    if (newSettings.mass_outage_delay_minutes !== undefined && newSettings.mass_outage_delay_minutes !== '') {
      newSettings.mass_outage_delay_minutes = Math.max(1, parseInt(newSettings.mass_outage_delay_minutes, 10) || 10);
    }
    if (newSettings.mass_outage_threshold_count !== undefined && newSettings.mass_outage_threshold_count !== '') {
      newSettings.mass_outage_threshold_count = Math.max(1, parseInt(newSettings.mass_outage_threshold_count, 10) || 5);
    }
    if (newSettings.mass_outage_threshold_percent !== undefined && newSettings.mass_outage_threshold_percent !== '') {
      const percent = parseFloat(newSettings.mass_outage_threshold_percent);
      newSettings.mass_outage_threshold_percent = Number.isFinite(percent) && percent > 0 ? Math.min(100, percent) : 20;
    }
    if (newSettings.mass_outage_sample_limit !== undefined && newSettings.mass_outage_sample_limit !== '') {
      newSettings.mass_outage_sample_limit = Math.max(1, Math.min(20, parseInt(newSettings.mass_outage_sample_limit, 10) || 5));
    }
    if (newSettings.tr069_periodic_interval !== undefined && newSettings.tr069_periodic_interval !== '') {
      newSettings.tr069_periodic_interval = parseInt(newSettings.tr069_periodic_interval, 10) || 300;
    }

    [
      'company_header',
      'customer_id_prefix',
      'company_legal_name',
      'upstream_provider_name',
      'support_isp_logo_url',
      'company_logo_url',
      'customer_portal_banner_1_url',
      'customer_portal_banner_2_url',
      'customer_portal_banner_3_url',
      'pwa_logo_url',
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
      'ewallet_log_service_default',
      'ewallet_log_query_default',
      'ewallet_log_limit_default',
      'mass_outage_zone_aliases',
      'genieacs_url',
      'genieacs_username',
      'genieacs_password',
      'tr069_acs_url',
      'tr069_acs_username',
      'tr069_acs_password',
      'mikrotik_host',
      'mikrotik_user',
      'mikrotik_password',
      'mikrotik_os_mode',
      'digiflazz_username',
      'digiflazz_api_key',
      'digiflazz_webhook_secret',
      'digiflazz_webhook_id',
      'admin_username',
      'admin_password',
      'admin_api_key',
      'session_secret',
      'xendit_callback_token',
      'whatsapp_test_number',
      'whatsapp_billing_message',
      'whatsapp_isolation_message',
      'customer_isolation_notice'
    ].forEach((field) => {
      if (field in newSettings) newSettings[field] = String(newSettings[field] || '').trim();
    });

    if ('company_phone' in newSettings) {
      newSettings.company_phone = normalizePhoneDigits(newSettings.company_phone || '');
    }
    if ('customer_id_prefix' in newSettings) {
      newSettings.customer_id_prefix = String(newSettings.customer_id_prefix || 'SCK')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 10) || 'SCK';
    }
    if ('whatsapp_test_number' in newSettings) {
      newSettings.whatsapp_test_number = normalizePhoneDigits(newSettings.whatsapp_test_number || '');
    }

    const removeCompanyLogo = settingsSection === 'usaha' && String(req.body.remove_company_logo || '').trim() === '1';
    const removePwaLogo = settingsSection === 'usaha' && String(req.body.remove_pwa_logo || '').trim() === '1';
    const removeSupportLogo = settingsSection === 'usaha' && String(req.body.remove_support_logo || '').trim() === '1';
    const removeSignature = settingsSection === 'usaha' && String(req.body.remove_invoice_signature || '').trim() === '1';
    const removeStamp = settingsSection === 'usaha' && String(req.body.remove_invoice_stamp || '').trim() === '1';
    const removeQrisStaticQr = settingsSection === 'payment' && String(req.body.remove_qris_static_qr || '').trim() === '1';
    const uploadedLogo = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'company_logo_file') : null;
    if (uploadedLogo) {
      const previousLogo = String(getSetting('company_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousLogo, /^\/uploads\/company-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.company_logo_url = persistUploadedImageSetting(uploadedLogo, 'company-logo');
    } else if (removeCompanyLogo) {
      const previousLogo = String(getSetting('company_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousLogo, /^\/uploads\/company-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.company_logo_url = '';
    } else if (settingsSection === 'usaha') {
      newSettings.company_logo_url = String(newSettings.company_logo_url || currentSettings.company_logo_url || '').trim();
    }

    const uploadedPwaLogo = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'pwa_logo_file') : null;
    if (uploadedPwaLogo) {
      if (!isSvgUpload(uploadedPwaLogo)) {
        throw new Error('Logo PWA wajib berformat SVG.');
      }
      const publicPath = persistUploadedSvgToPublicImage(uploadedPwaLogo, 'logo-pwa.svg');
      newSettings.pwa_logo_url = `${publicPath}?v=${Date.now()}`;
    } else if (removePwaLogo) {
      safeRemoveFixedPublicAsset('/img/logo-pwa.svg');
      newSettings.pwa_logo_url = '';
    } else if (settingsSection === 'usaha') {
      newSettings.pwa_logo_url = String(newSettings.pwa_logo_url || currentSettings.pwa_logo_url || '').trim();
    }

    if (settingsSection === 'usaha') {
      for (let index = 1; index <= 3; index += 1) {
        const settingKey = `customer_portal_banner_${index}_url`;
        const fileField = `customer_portal_banner_${index}_file`;
        const uploadedBanner = getUploadedSingleFile(req, fileField);
        const previousBanner = String(getSetting(settingKey, '') || '').trim();
        if (uploadedBanner) {
          safeRemoveUploadAsset(previousBanner, /^\/uploads\/customer-portal-banner-\d+\.(png|jpg|jpeg|webp|svg)$/i);
          newSettings[settingKey] = persistUploadedImageSetting(uploadedBanner, 'customer-portal-banner');
        } else {
          newSettings[settingKey] = String(newSettings[settingKey] || currentSettings[settingKey] || '').trim();
        }
      }
    }

    const uploadedSupportLogo = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'support_isp_logo_file') : null;
    if (uploadedSupportLogo) {
      const previousSupportLogo = String(getSetting('support_isp_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousSupportLogo, /^\/uploads\/support-isp-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.support_isp_logo_url = persistUploadedImageSetting(uploadedSupportLogo, 'support-isp-logo');
    } else if (removeSupportLogo) {
      const previousSupportLogo = String(getSetting('support_isp_logo_url', '') || '').trim();
      safeRemoveUploadAsset(previousSupportLogo, /^\/uploads\/support-isp-logo-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.support_isp_logo_url = '';
    } else {
      newSettings.support_isp_logo_url = String(newSettings.support_isp_logo_url || currentSettings.support_isp_logo_url || '').trim();
    }

    const uploadedSignature = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'invoice_signature_file') : null;
    if (uploadedSignature) {
      const previousSignature = String(getSetting('invoice_signature_url', '') || '').trim();
      safeRemoveUploadAsset(previousSignature, /^\/uploads\/invoice-signature-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_signature_url = persistUploadedImageSetting(uploadedSignature, 'invoice-signature');
    } else if (removeSignature) {
      const previousSignature = String(getSetting('invoice_signature_url', '') || '').trim();
      safeRemoveUploadAsset(previousSignature, /^\/uploads\/invoice-signature-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_signature_url = '';
    } else {
      newSettings.invoice_signature_url = String(newSettings.invoice_signature_url || currentSettings.invoice_signature_url || '').trim();
    }

    const uploadedStamp = settingsSection === 'usaha' ? getUploadedSingleFile(req, 'invoice_stamp_file') : null;
    if (uploadedStamp) {
      const previousStamp = String(getSetting('invoice_stamp_url', '') || '').trim();
      safeRemoveUploadAsset(previousStamp, /^\/uploads\/invoice-stamp-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_stamp_url = persistUploadedImageSetting(uploadedStamp, 'invoice-stamp');
    } else if (removeStamp) {
      const previousStamp = String(getSetting('invoice_stamp_url', '') || '').trim();
      safeRemoveUploadAsset(previousStamp, /^\/uploads\/invoice-stamp-\d+\.(png|jpg|jpeg|webp|svg)$/i);
      newSettings.invoice_stamp_url = '';
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
      } else if (removeQrisStaticQr) {
        safeRemoveUploadAsset(previousQrisStaticQr, /^\/uploads\/qris-static-\d+\.(png|jpg|jpeg|webp|svg)$/i);
        newSettings.qris_static_qr_url = '';
        newSettings.qris_static_payload = '';
      } else {
        if (previousQrisStaticQr && previousQrisStaticQr !== submittedQrisStaticQr) {
          safeRemoveUploadAsset(previousQrisStaticQr, /^\/uploads\/qris-static-\d+\.(png|jpg|jpeg|webp|svg)$/i);
        }
        newSettings.qris_static_qr_url = submittedQrisStaticQr;
      }

      newSettings.qris_static_payload = normalizeQrisPayload(newSettings.qris_static_payload || '');
      if (!newSettings.qris_static_payload) {
        let extractedPayload = '';
        try {
          if (uploadedQrisStaticQr?.buffer?.length) {
            extractedPayload = await decodeQrisPayloadFromBuffer(uploadedQrisStaticQr.buffer);
          } else if (newSettings.qris_static_qr_url) {
            extractedPayload = await decodeQrisPayloadFromUrl(newSettings.qris_static_qr_url);
          }
        } catch (extractErr) {
          const extractMessage = String(extractErr?.message || '').trim();
          if (extractMessage) paymentSaveNotes.push(extractMessage);
        }

        if (extractedPayload) {
          newSettings.qris_static_payload = extractedPayload;
          paymentSaveNotes.push('Payload QRIS merchant berhasil dibaca otomatis dari gambar QR.');
        } else if (/linkqr\.id/i.test(String(newSettings.qris_static_qr_url || ''))) {
          paymentSaveNotes.push('Link linkqr.id terdeteksi sebagai halaman QRIS. Agar portal bisa membuat QRIS dinamis otomatis, upload gambar QR DANA Business atau tempel payload merchant QRIS.');
        }
      }
      newSettings.qris_static_enabled = (
        newSettings.qris_static_enabled === 'true' ||
        newSettings.qris_static_enabled === true ||
        newSettings.qris_static_enabled === '1' ||
        newSettings.qris_static_enabled === 1 ||
        newSettings.qris_static_enabled === 'on'
      );
    }

    newSettings.admin_username = String(newSettings.admin_username || currentSettings.admin_username || req.session.adminUser || 'admin').trim();
    newSettings.admin_password = String(newSettings.admin_password || currentSettings.admin_password || '').trim();
    newSettings.admin_api_key = String(newSettings.admin_api_key || currentSettings.admin_api_key || '').trim();
    newSettings.whatsapp_api_key = String(newSettings.whatsapp_api_key || currentSettings.whatsapp_api_key || '').trim();
    newSettings.whatsapp_provider = String(newSettings.whatsapp_provider || currentSettings.whatsapp_provider || 'local').trim().toLowerCase() === 'mpwa' ? 'mpwa' : 'local';
    newSettings.whatsapp_mpwa_base_url = String(newSettings.whatsapp_mpwa_base_url || currentSettings.whatsapp_mpwa_base_url || '').trim().replace(/\/+$/, '');
    newSettings.whatsapp_mpwa_api_key = String(newSettings.whatsapp_mpwa_api_key || currentSettings.whatsapp_mpwa_api_key || '').trim();
    newSettings.whatsapp_mpwa_send_path = String(newSettings.whatsapp_mpwa_send_path || currentSettings.whatsapp_mpwa_send_path || '/api/send-message').trim() || '/api/send-message';
    newSettings.whatsapp_mpwa_image_path = String(newSettings.whatsapp_mpwa_image_path || currentSettings.whatsapp_mpwa_image_path || '').trim();
    newSettings.whatsapp_mpwa_auth_mode = String(newSettings.whatsapp_mpwa_auth_mode || currentSettings.whatsapp_mpwa_auth_mode || 'bearer').trim().toLowerCase();
    if (!['bearer', 'x-api-key', 'body', 'query', 'none'].includes(newSettings.whatsapp_mpwa_auth_mode)) newSettings.whatsapp_mpwa_auth_mode = 'bearer';
    newSettings.whatsapp_mpwa_number_field = String(newSettings.whatsapp_mpwa_number_field || currentSettings.whatsapp_mpwa_number_field || 'number').trim() || 'number';
    newSettings.whatsapp_mpwa_message_field = String(newSettings.whatsapp_mpwa_message_field || currentSettings.whatsapp_mpwa_message_field || 'message').trim() || 'message';
    newSettings.whatsapp_mpwa_device = String(newSettings.whatsapp_mpwa_device || currentSettings.whatsapp_mpwa_device || '').trim();
    newSettings.session_secret = String(newSettings.session_secret || currentSettings.session_secret || '').trim();
    newSettings.xendit_callback_token = String(newSettings.xendit_callback_token || currentSettings.xendit_callback_token || '').trim();
    newSettings.mikrotik_user = String(newSettings.mikrotik_user || currentSettings.mikrotik_user || '').trim();
    newSettings.mikrotik_password = String(newSettings.mikrotik_password || currentSettings.mikrotik_password || '').trim();
    newSettings.genieacs_username = String(newSettings.genieacs_username || currentSettings.genieacs_username || '').trim();
    newSettings.genieacs_password = String(newSettings.genieacs_password || currentSettings.genieacs_password || '').trim();
    newSettings.invoice_signer_title = String(newSettings.invoice_signer_title || currentSettings.invoice_signer_title || 'Finance').trim();
    
    newSettings.login_otp_enabled = newSettings.login_otp_enabled === undefined
      ? Boolean(currentSettings.login_otp_enabled)
      : isEnabledSwitch(newSettings.login_otp_enabled);
    newSettings.telegram_enabled = newSettings.telegram_enabled === undefined
      ? Boolean(currentSettings.telegram_enabled)
      : isEnabledSwitch(newSettings.telegram_enabled);
    newSettings.auto_backup_enabled = newSettings.auto_backup_enabled === undefined
      ? Boolean(currentSettings.auto_backup_enabled)
      : isEnabledSwitch(newSettings.auto_backup_enabled);
    if (newSettings.ewallet_log_limit_default !== undefined && newSettings.ewallet_log_limit_default !== '') {
      const normalizedLogLimit = parseInt(newSettings.ewallet_log_limit_default, 10) || 200;
      newSettings.ewallet_log_limit_default = String([50, 100, 200, 500].includes(normalizedLogLimit) ? normalizedLogLimit : 200);
    } else {
      newSettings.ewallet_log_limit_default = String(currentSettings.ewallet_log_limit_default || '200');
    }
    newSettings.ewallet_live_auto_start = (
      newSettings.ewallet_live_auto_start === 'true' ||
      newSettings.ewallet_live_auto_start === true ||
      newSettings.ewallet_live_auto_start === '1' ||
      newSettings.ewallet_live_auto_start === 1 ||
      newSettings.ewallet_live_auto_start === 'on'
    );
    newSettings.mass_outage_detection_enabled = (
      newSettings.mass_outage_detection_enabled === 'true' ||
      newSettings.mass_outage_detection_enabled === true ||
      newSettings.mass_outage_detection_enabled === '1' ||
      newSettings.mass_outage_detection_enabled === 1 ||
      newSettings.mass_outage_detection_enabled === 'on'
    );
    [
      'mass_outage_notify_whatsapp_admin_noc',
      'mass_outage_notify_whatsapp_technician',
      'mass_outage_notify_push_admin',
      'mass_outage_notify_push_technician',
      'mass_outage_notify_telegram'
    ].forEach((field) => {
      if (newSettings[field] === undefined) return;
      newSettings[field] = (
        newSettings[field] === 'true' ||
        newSettings[field] === true ||
        newSettings[field] === '1' ||
        newSettings[field] === 1 ||
        newSettings[field] === 'on'
      );
    });
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
    if (settingsSection === 'whatsapp' && newSettings.whatsapp_api_key && !isStrongAdminApiKey(newSettings.whatsapp_api_key)) {
      throw new Error('WhatsApp API key minimal 24 karakter dan tidak boleh memakai nilai default.');
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
      req.session._msg = { type: 'success', text: ['Pengaturan berhasil disimpan.'].concat(paymentSaveNotes).join(' ') };
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
    backupDir: backupSvc.getBackupDirectory(),
    getSetting
  });
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = await backupSvc.backupAll();
    } else if (type === 'database') {
      result = await backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipe backup tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      if (type === 'all') {
        req.session._msg = {
          type: 'success',
          text: `Backup lengkap berhasil dibuat: ${result.database.fileName} dan ${result.settings.fileName}`
        };
      } else {
        req.session._msg = { type: 'success', text: `Backup berhasil dibuat: ${result.fileName}` };
      }
    } else {
      const errorText = result.error || result.database?.error || result.settings?.error || 'Terjadi kesalahan saat membuat backup.';
      req.session._msg = { type: 'error', text: `Gagal backup: ${errorText}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.get('/backup/download/:fileName', requireAdminSession, (req, res) => {
  try {
    const fileName = req.params.fileName;
    const filePath = backupSvc.getBackupFilePath(fileName);
    if (!fs.existsSync(filePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan.' };
      return res.redirect('/admin/backup');
    }
    return res.download(filePath, path.basename(filePath));
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal download backup: ${e.message}` };
    return res.redirect('/admin/backup');
  }
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = await backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipe restore tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      const extra = result.preRestoreBackup ? ` Backup sebelum restore: ${result.preRestoreBackup}.` : '';
      req.session._msg = { type: 'success', text: `Restore berhasil: ${fileName}.${extra}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/upload-restore', requireAdminSession, backupUpload.single('restoreFile'), async (req, res) => {
  try {
    const restoreType = String(req.body.restoreType || '').trim();
    if (!req.file) {
      req.session._msg = { type: 'error', text: 'Pilih file backup dari laptop terlebih dahulu.' };
      return res.redirect('/admin/backup');
    }
    if (restoreType !== 'database' && restoreType !== 'settings') {
      req.session._msg = { type: 'error', text: 'Tipe restore upload tidak valid.' };
      return res.redirect('/admin/backup');
    }

    const result = await backupSvc.importAndRestore(req.file, restoreType);
    if (result.success) {
      const extra = result.preRestoreBackup ? ` Backup sebelum restore: ${result.preRestoreBackup}.` : '';
      req.session._msg = {
        type: 'success',
        text: `Restore dari file lokal berhasil: ${result.uploadedFileName || req.file.originalname}.${extra}`
      };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore file lokal: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal upload restore: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const result = backupSvc.deleteBackup(fileName);
    if (!result.success) {
      req.session._msg = { type: 'error', text: result.error };
      return res.redirect('/admin/backup');
    }
    req.session._msg = { type: 'success', text: `Backup berhasil dihapus: ${result.fileName}` };
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
      title: 'Monitoring ONU',
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
    const { routerId } = resolveRouterSelection(req.query.routerId);
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
    const defaultRouter = routers.find((router) => Number(router.is_active || 0) === 1) || routers[0] || null;
    const autoRefreshRouterId = defaultRouter?.id || null;
    monitoringCollectorSvc.refreshRouterSnapshot(autoRefreshRouterId, { mode: 'full' }).catch((error) => {
        logger.warn(`[MikroTik] Auto refresh saat membuka menu gagal untuk router ${autoRefreshRouterId || 'default'}: ${error.message || error}`);
      });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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
      where.push('n.service = ? COLLATE NOCASE');
      params.push(service);
    }
    if (q) {
      where.push('(n.content LIKE ? OR n.service LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR CAST(n.matched_invoice_id AS TEXT) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT n.id,
             n.created_at,
             strftime('%Y-%m-%d %H:%M:%S', n.created_at, 'localtime') AS created_at_local,
             n.service,
             n.content,
             n.parsed_amount,
             n.parsed_ok,
             n.matched_invoice_id,
             n.matched_agent_topup_id,
             n.ip,
             i.customer_id AS matched_customer_id,
             i.period_month AS matched_period_month,
             i.period_year AS matched_period_year,
             i.status AS matched_invoice_status,
             c.name AS matched_customer_name,
             c.phone AS matched_customer_phone,
             a.name AS matched_agent_name,
             ato.pay_amount AS matched_agent_pay_amount
      FROM webhook_payment_notifs n
      LEFT JOIN invoices i ON i.id = n.matched_invoice_id
      LEFT JOIN customers c ON c.id = i.customer_id
      LEFT JOIN agent_topup_orders ato ON ato.id = n.matched_agent_topup_id
      LEFT JOIN agents a ON a.id = ato.agent_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY n.id DESC
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
  const { routerId } = resolveRouterSelection(req.query.routerId);
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
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
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
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const listQuery = parseMonitoringListQuery(req, 25);
    const forceRefresh = shouldForceMonitoringRefresh(req);
    const snapshot = forceRefresh
      ? await monitoringCollectorSvc.refreshRouterSnapshot(routerId, { mode: 'full' })
      : await monitoringCollectorSvc.getRouterSnapshot(routerId);
    const enriched = Array.isArray(snapshot?.derived?.tables?.pppoe) ? snapshot.derived.tables.pppoe : [];
    const derivedSummary = snapshot?.derived?.summary || {};
    const totalAll = Number(derivedSummary.totalSecrets || 0);
    const totalEnabled = Number(derivedSummary.totalSecretsActive || 0);
    const onlineCount = Number(derivedSummary.pppoeOnline || 0);
    const offlineCount = countUniquePppoeUsers(
      enriched.filter((row) => row.displayStatus === 'offline')
    );
    const disabledCount = Number(derivedSummary.pppoeDisabled || 0);
    const metadata = buildCollectorMetadata(snapshot);
    res.set('X-Mikrotik-Cache', metadata.source);
    if (!listQuery.wantsMeta) {
      return res.json(enriched);
    }
    let filtered = enriched;
    if (listQuery.status === 'online' || listQuery.status === 'offline' || listQuery.status === 'disabled') {
      filtered = filtered.filter((row) => row.displayStatus === listQuery.status);
    }
    if (listQuery.q) {
      filtered = filtered.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
        'name', 'profile', 'service', 'local-address', 'remote-address',
        'localAddress', 'remoteAddress', 'comment', 'caller-id', 'sessionRemoteAddress',
        'lastOnlineAt', 'offlineSince'
      ]));
    }
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: totalAll,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      onlineCount,
      offlineCount,
      disabledCount,
      enabledCount: totalEnabled,
      ...metadata,
      cache: {
        snapshot: metadata.source
      }
    });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.addPppoeSecret(req.body, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.updatePppoeSecret(req.params.id, req.body, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.deletePppoeSecret(req.params.id, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'secrets', 'active-pppoe']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const listQuery = parseMonitoringListQuery(req, 25);
    const forceRefresh = shouldForceMonitoringRefresh(req);
    const snapshot = forceRefresh
      ? await monitoringCollectorSvc.refreshRouterSnapshot(routerId, { mode: 'full' })
      : await monitoringCollectorSvc.getRouterSnapshot(routerId);
    const enriched = Array.isArray(snapshot?.derived?.tables?.hotspot) ? snapshot.derived.tables.hotspot : [];
    const derivedSummary = snapshot?.derived?.summary || {};
    const totalAll = Number(derivedSummary.totalHotspot || 0);
    const totalEnabled = Number(derivedSummary.totalHotspotActive || 0);
    const onlineCount = Number(derivedSummary.hotspotOnline || 0);
    const offlineCount = countUniqueHotspotUsers(
      enriched.filter((row) => row.displayStatus === 'offline')
    );
    const disabledCount = Number(derivedSummary.hotspotDisabled || 0);
    const metadata = buildCollectorMetadata(snapshot);
    res.set('X-Mikrotik-Cache', metadata.source);
    if (!listQuery.wantsMeta) {
      return res.json(enriched);
    }
    let filtered = enriched;
    if (listQuery.status === 'online' || listQuery.status === 'offline' || listQuery.status === 'disabled') {
      filtered = filtered.filter((row) => row.displayStatus === listQuery.status);
    }
    if (listQuery.q) {
      filtered = filtered.filter((row) => matchesMonitoringSearch(row, listQuery.q, [
          'name', 'profile', 'address', 'comment', 'limit-uptime',
          'limitUptime', 'mac-address', 'server', 'sessionAddress'
        ]));
    }
    const pageData = paginateMonitoringRows(filtered, listQuery.page, listQuery.limit);
    res.json({
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: totalAll,
      totalPages: pageData.totalPages,
      filteredTotal: filtered.length,
      onlineCount,
      offlineCount,
      disabledCount,
      enabledCount: totalEnabled,
      ...metadata,
      cache: {
        snapshot: metadata.source
      }
    });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.addHotspotUser(req.body, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.updateHotspotUser(req.params.id, req.body, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.deleteHotspotUser(req.params.id, routerId);
      clearMonitoringCache(routerId, ['snapshot', 'summary', 'hotspot-users', 'active-hotspot']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    res.json(await mikrotikService.getHotspotProfiles(routerId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const forceRefresh = shouldForceMonitoringRefresh(req);
    const snapshot = forceRefresh
      ? await monitoringCollectorSvc.refreshRouterSnapshot(routerId, { mode: 'full' })
      : await monitoringCollectorSvc.getRouterSnapshot(routerId);
    const metadata = buildCollectorMetadata(snapshot);
    res.set('X-Mikrotik-Cache', metadata.source);
    res.json({
      items: Array.isArray(snapshot?.raw?.pppoeActiveRaw) ? snapshot.raw.pppoeActiveRaw : [],
      ...metadata
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const forceRefresh = shouldForceMonitoringRefresh(req);
    const snapshot = forceRefresh
      ? await monitoringCollectorSvc.refreshRouterSnapshot(routerId, { mode: 'full' })
      : await monitoringCollectorSvc.getRouterSnapshot(routerId);
    const metadata = buildCollectorMetadata(snapshot);
    res.set('X-Mikrotik-Cache', metadata.source);
    res.json({
      items: Array.isArray(snapshot?.raw?.hotspotActiveRaw) ? snapshot.raw.hotspotActiveRaw : [],
      ...metadata
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/summary', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const forceRefresh = shouldForceMonitoringRefresh(req);
    const snapshot = forceRefresh
      ? await monitoringCollectorSvc.refreshRouterSnapshot(routerId, { mode: 'full' })
      : await monitoringCollectorSvc.getRouterSnapshot(routerId);
    const summary = snapshot?.derived?.summary || {};
    const metadata = buildCollectorMetadata(snapshot);
    const summaryPayload = {
      pppoeOnline: Number(summary.pppoeOnline || 0),
      pppoeOffline: Number(summary.pppoeOffline || 0),
      pppoeDisabled: Number(summary.pppoeDisabled || 0),
      hotspotOnline: Number(summary.hotspotOnline || 0),
      hotspotOffline: Number(summary.hotspotOffline || 0),
      hotspotDisabled: Number(summary.hotspotDisabled || 0),
      totalSecrets: Number(summary.totalSecrets || 0),
      totalSecretsActive: Number(summary.totalSecretsActive || 0),
      totalHotspot: Number(summary.totalHotspot || 0),
      totalHotspotActive: Number(summary.totalHotspotActive || 0),
      pppoeSecretRaw: Number(summary.pppoeSecretRaw || 0),
      pppoeSecretIgnored: Number(summary.pppoeSecretIgnored || 0),
      pppoeActiveRaw: Number(summary.pppoeActiveRaw || 0),
      pppoeActiveIgnored: Number(summary.pppoeActiveIgnored || 0),
      source: metadata.source
    };
    res.set('X-Mikrotik-Cache', metadata.source);
    res.json({
      ...summaryPayload,
      ...metadata,
      cache: {
        summary: metadata.source
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/interfaces', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const rows = await mikrotikService.getInterfaces(routerId, {
      bypassCache: shouldForceMonitoringRefresh(req)
    });
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
      ? rows.filter((row) => matchesMonitoringSearch(row, q, ['name', 'type', 'comment', 'macAddress']))
      : rows;
    res.json({
      items: filtered,
      total: rows.length,
      filteredTotal: filtered.length,
      sampledAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/interface-traffic', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const interfaceName = String(req.query.interface || '').trim();
    if (!interfaceName) return res.status(400).json({ error: 'Interface wajib dipilih' });
    const traffic = await mikrotikService.getInterfaceTraffic(routerId, interfaceName);
    res.json({ success: true, traffic });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/pppoe-sync', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const listQuery = parseMonitoringListQuery(req, 25);
    const data = await mikrotikService.getPppoeCustomerSync(routerId, {
      bypassCache: shouldForceMonitoringRefresh(req)
    });
    const section = ['matched', 'routerOnly', 'customerOnly'].includes(listQuery.status)
      ? listQuery.status
      : String(req.query.section || 'all').trim();
    const allRows = [
      ...data.matched.map((row) => ({ ...row, section: 'matched' })),
      ...data.routerOnly.map((row) => ({ ...row, section: 'routerOnly' })),
      ...data.customerOnly.map((row) => ({ ...row, section: 'customerOnly' }))
    ];
    let rows = section && section !== 'all'
      ? allRows.filter((row) => row.section === section)
      : allRows;
    if (listQuery.q) {
      rows = rows.filter((row) => {
        const customer = row.customer || {};
        return matchesMonitoringSearch({
          username: row.username,
          profile: row.profile,
          name: customer.name,
          phone: customer.phone,
          status: customer.status,
          genieacs_tag: customer.genieacs_tag
        }, listQuery.q, ['username', 'profile', 'name', 'phone', 'status', 'genieacs_tag']);
      });
    }
    const pageData = paginateMonitoringRows(rows, listQuery.page, listQuery.limit);
    res.json({
      ...data,
      items: pageData.items,
      page: pageData.page,
      limit: pageData.limit,
      total: allRows.length,
      totalPages: pageData.totalPages,
      filteredTotal: rows.length,
      section
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.addPppoeProfile(req.body, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.updatePppoeProfile(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.deletePppoeProfile(req.params.id, routerId);
    clearMonitoringCache(routerId, ['profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
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
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.addHotspotUserProfile(req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try {
    const selection = resolveRouterSelection(req.query.routerId, { fallbackToNull: false });
    if (selection.missingRequestedRouter) return res.status(409).json(buildMissingRouterApiError(selection.requestedRouterId));
    const { routerId } = selection;
    await mikrotikService.deleteHotspotUserProfile(req.params.id, routerId);
    clearMonitoringCache(routerId, ['hotspot-user-profiles']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.query.routerId);
    const backup = await mikrotikService.getBackup(routerId);
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
    const {
      target,
      message,
      delay: customDelay,
      batchSize: customBatchSize,
      hourlyLimit: customHourlyLimit,
      send_whatsapp,
      send_push,
      push_title
    } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    const shouldSendWhatsapp = isEnabledSwitch(send_whatsapp);
    const shouldSendPush = isEnabledSwitch(send_push);
    if (!shouldSendWhatsapp && !shouldSendPush) {
      throw new Error('Pilih minimal satu channel broadcast: WhatsApp atau Push App.');
    }
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

    const pushTitle = sanitizePushBody(push_title, 'Pengumuman Pelanggan');
    const portalAnnouncementItems = uniqueCustomers.map((customer) => {
      const body = sanitizePushBody(
        buildBroadcastAnnouncementMessage(customer, message, { baseUrl: requestBaseUrl }),
        'Ada pengumuman baru untuk pelanggan.'
      );
      return { customer, body };
    });

    if (shouldSendPush) {
      if (!isPushConfigured(getSettings()) || !isEnabledSwitch(getSetting('onesignal_push_announcement_enabled', true))) {
        throw new Error('OneSignal belum aktif atau belum lengkap. Cek App ID dan REST API Key di Pengaturan.');
      }
      try {
        const settings = getSettings();
        for (const item of portalAnnouncementItems) {
          await sendPushToCustomer(item.customer, {
            settings,
            title: pushTitle,
            message: item.body,
            targetUrl: `${requestBaseUrl}/customer/dashboard#home`,
            data: {
              kind: 'announcement',
              source: 'broadcast',
              target
            }
          });
        }
      } catch (pushError) {
        throw new Error(`Push OneSignal gagal: ${pushError.message}`);
      }
    }

    try {
      for (const item of portalAnnouncementItems) {
        customerSvc.addPortalNotification(item.customer.id, {
          kind: 'announcement',
          tab: 'home',
          title: pushTitle,
          body: item.body,
          payload: {
            senderName: 'Admin',
            senderRole: 'Pengumuman',
            source: 'broadcast',
            target
          }
        });
      }
    } catch (notificationError) {
      logger.warn(`[Broadcast] Simpan inbox pengumuman gagal: ${notificationError.message}`);
    }

    if (!shouldSendWhatsapp) {
      req.session._msg = {
        type: 'success',
        text: `Broadcast push berhasil dikirim/disimpan untuk ${uniqueCustomers.length} pelanggan tanpa WhatsApp.`
      };
      return res.redirect('/admin/whatsapp/broadcast');
    }

    const ready = await whatsappGateway.ensureReady(25000);
    if (!ready) {
      throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
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
            const payload = buildWhatsappCustomerPayload(cust, unpaidInvoices, primaryInvoice, { baseUrl: requestBaseUrl });
            let formattedMsg = buildBroadcastAnnouncementMessage(cust, message, { baseUrl: requestBaseUrl });
            if (!/\{\{\s*payment_guide\s*\}\}/i.test(message) && payload.payment_guide) {
              formattedMsg += `\n\n${payload.payment_guide}`;
            }
            
            // Add subtle variation untuk menghindari spam detection
            formattedMsg = addMessageVariation(formattedMsg, i);

            const sentOk = await whatsappGateway.sendText(cust.phone, formattedMsg);
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
      const whatsappStatus = await whatsappGateway.getStatus();
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const whatsappStatus = await whatsappGateway.getStatus();
    const ready = await whatsappGateway.ensureReady(25000);
    if (!ready) {
      throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
    }
    const adminPhone = resolveWhatsappTestRecipient(whatsappStatus, req.body?.test_phone);
    if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia. Isi kolom Nomor Test WA atau nomor admin/telepon usaha yang berbeda dari nomor bot.');
    const msg =
      `🧪 *TEST NOTIFIKASI WHATSAPP*\n\n` +
      `✅ Jika pesan ini masuk, berarti notifikasi WhatsApp portal billing sudah berfungsi.\n` +
      `📅 Waktu: ${new Date().toLocaleString('id-ID')}`;
    const messageText =
      `TEST NOTIFIKASI WHATSAPP\n\n` +
      `WhatsApp bot untuk ${getSetting('company_header', 'Portal Billing ISP')} sudah berfungsi.\n` +
      `Waktu: ${new Date().toLocaleString('id-ID')}`;
    const ok = await whatsappGateway.sendText(adminPhone, messageText);
    if (!ok) throw new Error('Gagal mengirim pesan test.');
    req.session._msg = { type: 'success', text: `Test notifikasi WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/test-template', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const whatsappStatus = await whatsappGateway.getStatus();
    const ready = await whatsappGateway.ensureReady(25000);
    if (!ready) {
      throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
    }
    const adminPhone = resolveWhatsappTestRecipient(whatsappStatus, req.body?.test_phone);
    if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia. Isi kolom Nomor Test WA atau nomor admin/telepon usaha yang berbeda dari nomor bot.');
    const templateKey = String(req.body.template_key || 'billing').trim();
    const previewMessage = buildWhatsappTemplatePreview(templateKey, { baseUrl: resolveRequestBaseUrl(req) });
    const ok = await whatsappGateway.sendText(adminPhone, previewMessage);
    if (!ok) throw new Error('Gagal mengirim test message.');
    req.session._msg = { type: 'success', text: `Test message WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim test message: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const confirmText = String(req.body?.confirm_reset_text || '').trim().toUpperCase();
    if (confirmText !== 'RESET WA') {
      req.session._msg = { text: 'Reset sesi dibatalkan. Ketik "RESET WA" untuk mengonfirmasi penghapusan sesi WhatsApp.', type: 'warning' };
      return res.redirect('/admin/whatsapp');
    }

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
  getSettings,
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
  isPermanentError,
  isPushConfigured,
  sendPushToCustomer
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
    monitoringCollectorSvc.syncConfiguredRouters();
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    monitoringCollectorSvc.syncConfiguredRouters();
    req.session._msg = { type: 'success', text: 'Router berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    monitoringCollectorSvc.syncConfiguredRouters();
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
    const { routerId } = resolveRouterSelection(req.query.routerId);
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
    const { routerId } = resolveRouterSelection(req.params.routerId);
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const { routerId } = resolveRouterSelection(req.params.routerId);
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
