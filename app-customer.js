const express = require('express');
const path = require('path');
const dns = require('dns');
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const crypto = require('crypto');
const { logger } = require('./config/logger');
const db = require('./config/database');
const customerSvc = require('./services/customerService');
const whatsappGateway = require('./services/whatsappGatewayService');
const { normalizePhoneDigits, formatPhoneDisplay, buildWhatsAppLink } = require('./services/phoneService');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { scheduleAutoBackup } = require('./services/backupService');
const { getCriticalSecurityIssues, isStrongAdminApiKey } = require('./config/security');
const {
  installSafeRedirectMiddleware,
  getRuntimeConfigurationWarnings,
  isSelfUpdateEnabled
} = require('./config/runtimeSafety');

// Prefer IPv4 to avoid AggregateError (IPv6 timeouts) on some servers
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Handle unhandled promise rejections to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason instanceof Error ? reason.stack : JSON.stringify(reason);
  logger.error(`Unhandled Rejection: ${errorMsg}`);
});

// Keep the app alive if external libraries emit uncaught runtime errors
// during transient MikroTik connectivity failures.
process.on('uncaughtException', (err) => {
  const errorMsg = err instanceof Error ? err.stack : String(err);
  logger.error(`uncaughtException: ${errorMsg}`);
});

// Settings Management
const session = require('express-session');
const { getSetting, getSettingsWithCache } = require('./config/settingsManager');
const { SUPPORTED_LANGS, FALLBACK_LANG, normalizeLang, t } = require('./config/i18n');
const { createSqliteSessionStore } = require('./config/sqliteSessionStore');
const billingSvc = require('./services/billingService');
const agentSvc = require('./services/agentService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  formatInvoiceDueDate,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine,
  resolveRequestBaseUrl
} = require('./services/publicLinkService');

// Inisialisasi aplikasi Express
const app = express();

function buildPortalManifest(portalKey = 'customer') {
  const settings = getSettingsWithCache();
  const companyName = String(settings.company_header || 'SICKAS WIFI').trim() || 'SICKAS WIFI';
  const logoSrc = String(settings.pwa_logo_url || settings.company_logo_url || '/img/logo.png').trim() || '/img/logo.png';
  const portalMap = {
    customer: {
      id: '/pwa/customer',
      name: 'Portal Pelanggan',
      shortName: 'Pelanggan',
      startUrl: '/customer/login?source=pwa',
      scope: '/customer/',
      themeColor: '#2f6bff',
      backgroundColor: '#f6faff'
    },
    admin: {
      id: '/pwa/admin',
      name: 'Admin',
      shortName: 'Admin',
      startUrl: '/admin?source=pwa',
      scope: '/admin/',
      themeColor: '#0f172a',
      backgroundColor: '#0f172a'
    },
    tech: {
      id: '/pwa/tech',
      name: 'Portal Teknisi',
      shortName: 'Teknisi',
      startUrl: '/tech/login?source=pwa',
      scope: '/tech/',
      themeColor: '#0f172a',
      backgroundColor: '#0f172a'
    },
    agent: {
      id: '/pwa/agent',
      name: 'Portal Agent',
      shortName: 'Agent',
      startUrl: '/agent/login?source=pwa',
      scope: '/agent/',
      themeColor: '#1e293b',
      backgroundColor: '#0f172a'
    },
    collector: {
      id: '/pwa/collector',
      name: 'Portal Kolektor',
      shortName: 'Kolektor',
      startUrl: '/collector/login?source=pwa',
      scope: '/collector/',
      themeColor: '#0f172a',
      backgroundColor: '#08111f'
    }
  };
  const portal = portalMap[portalKey] || portalMap.customer;
  return {
    id: portal.id,
    name: portal.name,
    short_name: portal.shortName,
    description: `${portal.name} ${companyName}`,
    start_url: portal.startUrl,
    scope: portal.scope,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    launch_handler: {
      client_mode: ['navigate-existing', 'auto']
    },
    orientation: 'portrait',
    background_color: portal.backgroundColor,
    theme_color: portal.themeColor,
    icons: [
      { src: logoSrc, sizes: '192x192', purpose: 'any maskable' },
      { src: logoSrc, sizes: '512x512', purpose: 'any maskable' },
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  };
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const manifestMap = {
    '/manifest.webmanifest': 'customer',
    '/admin/manifest.webmanifest': 'admin',
    '/tech/manifest.webmanifest': 'tech',
    '/agent/manifest.webmanifest': 'agent',
    '/collector/manifest.webmanifest': 'collector'
  };
  const portalKey = manifestMap[req.path];
  if (!portalKey) return next();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('application/manifest+json');
  return res.send(buildPortalManifest(portalKey));
});

const bootSettings = getSettingsWithCache();
const bootSecurityIssues = getCriticalSecurityIssues(bootSettings);
if (bootSecurityIssues.length) {
  logger.warn(`[security] Instalasi belum aman penuh: ${bootSecurityIssues.join('; ')}. Aplikasi tetap dijalankan supaya konfigurasi awal bisa diselesaikan dari Admin.`);
}

const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = getSetting('cookie_secure', isProduction);
const trustProxy = getSetting('trust_proxy', false);
const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const CUSTOMER_PERSISTENT_SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const sessionCookieName = String(getSetting('session_cookie_name', 'billing.sid') || 'billing.sid').trim() || 'billing.sid';
const sessionCookieDomain = String(getSetting('session_cookie_domain', '') || '').trim();
const rawSessionCookieSameSite = String(getSetting('session_cookie_same_site', 'lax') || 'lax').trim().toLowerCase();
const sessionCookieSameSite = ['lax', 'strict', 'none'].includes(rawSessionCookieSameSite)
  ? rawSessionCookieSameSite
  : 'lax';
const sessionStore = createSqliteSessionStore({
  defaultMaxAgeMs: REMEMBER_ME_SESSION_MAX_AGE_MS,
  cleanupIntervalMs: 30 * 60 * 1000,
});

function applySessionLifetime(sessionState) {
  if (!sessionState || !sessionState.cookie) return;
  const keepSignedIn = Boolean(sessionState.rememberMe || sessionState.adminRememberMe);
  const maxAge = sessionState.customerPersistentLogin
    ? CUSTOMER_PERSISTENT_SESSION_MAX_AGE_MS
    : (keepSignedIn ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS);
  sessionState.cookie.maxAge = maxAge;
}

if (trustProxy) {
  app.set('trust proxy', 1);
}

installSafeRedirectMiddleware(app);

// Middleware dasar
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(session({
  name: sessionCookieName,
  secret: getSetting('session_secret', ''),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: Boolean(cookieSecure),
    httpOnly: true,
    sameSite: sessionCookieSameSite,
    ...(sessionCookieDomain ? { domain: sessionCookieDomain } : {}),
    maxAge: DEFAULT_SESSION_MAX_AGE_MS
  }
}));

app.use((req, res, next) => {
  applySessionLifetime(req.session);
  next();
});

app.use((req, res, next) => {
  const settings = getSettingsWithCache();
  res.locals.settings = settings;
  res.locals.runtimeWarnings = getRuntimeConfigurationWarnings(settings, process.env);
  res.locals.selfUpdateEnabled = isSelfUpdateEnabled(settings, process.env);
  res.locals.companyLogoUrl = String(settings.company_logo_url || '/img/logo.png').trim() || '/img/logo.png';
  res.locals.pwaLogoUrl = String(settings.pwa_logo_url || settings.company_logo_url || '/img/logo.png').trim() || '/img/logo.png';
  res.locals.normalizePhoneDigits = normalizePhoneDigits;
  res.locals.formatPhoneDisplay = formatPhoneDisplay;
  res.locals.buildWhatsAppLink = buildWhatsAppLink;
  next();
});

// i18n middleware (aman: hanya teks UI, tidak mengubah logic fitur)
app.use((req, res, next) => {
  if (req.query && typeof req.query.lang === 'string') {
    const requested = normalizeLang(req.query.lang);
    req.session.lang = requested;
  }
  const saved = req.session?.lang || getSetting('default_lang', FALLBACK_LANG);
  const lang = normalizeLang(saved);
  res.locals.lang = lang;
  res.locals.availableLangs = Array.from(SUPPORTED_LANGS);
  res.locals.t = (key, fallback = '') => t(lang, key, fallback);
  next();
});

app.get('/lang/:lang', (req, res) => {
  const targetLang = normalizeLang(req.params.lang);
  req.session.lang = targetLang;
  const referer = req.get('referer');
  if (referer) return res.redirect(referer);
  return res.redirect('/');
});

const runtimeWarnings = getRuntimeConfigurationWarnings(bootSettings, process.env);
runtimeWarnings.forEach((item) => {
  logger.warn(`[Runtime] ${item.text}`);
});

// Konstanta
const VERSION = '2.0.0';

function extractRequestApiKey(req) {
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return String(
    req.headers['x-api-key'] ||
    req.headers['x-whatsapp-api-key'] ||
    req.headers.apikey ||
    bearer ||
    req.query?.api_key ||
    req.query?.apikey ||
    req.query?.key ||
    req.query?.token ||
    req.body?.api_key ||
    req.body?.apikey ||
    ''
  ).trim();
}

function getWhatsappApiKey() {
  const dedicatedKey = String(getSetting('whatsapp_api_key', '') || '').trim();
  if (dedicatedKey) return dedicatedKey;
  return String(getSetting('admin_api_key', '') || '').trim();
}

function requireWhatsappApiKey(req, res, next) {
  const configuredKey = getWhatsappApiKey();
  if (!isStrongAdminApiKey(configuredKey)) {
    return res.status(503).json({
      success: false,
      error: 'whatsapp_api_key_not_configured',
      message: 'WhatsApp API key belum diatur atau terlalu lemah.'
    });
  }
  const providedKey = extractRequestApiKey(req);
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'API key tidak valid.'
    });
  }
  return next();
}

app.get('/api/whatsapp/status', requireWhatsappApiKey, async (req, res) => {
  try {
    const whatsappStatus = await whatsappGateway.getStatus();
    return res.json({
      success: true,
      enabled: Boolean(getSetting('whatsapp_enabled', false)),
      provider: whatsappStatus?.provider || 'local',
      connection: whatsappStatus?.connection || 'unknown',
      reason: whatsappStatus?.reason || '',
      user: whatsappStatus?.user || null
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal membaca status WhatsApp.'
    });
  }
});

app.post('/api/whatsapp/send-message', requireWhatsappApiKey, async (req, res) => {
  try {
    if (!getSetting('whatsapp_enabled', false)) {
      return res.status(503).json({
        success: false,
        error: 'whatsapp_disabled',
        message: 'WhatsApp bot sedang nonaktif.'
      });
    }

    const to = String(req.body?.number || req.body?.phone || req.body?.to || req.body?.target || '').trim();
    const message = String(req.body?.message || req.body?.text || req.body?.body || '').trim();
    if (!to) return res.status(400).json({ success: false, error: 'missing_number', message: 'Nomor tujuan wajib diisi.' });
    if (!message) return res.status(400).json({ success: false, error: 'missing_message', message: 'Pesan wajib diisi.' });
    if (message.length > 5000) return res.status(400).json({ success: false, error: 'message_too_long', message: 'Pesan maksimal 5000 karakter.' });

    const whatsappStatus = await whatsappGateway.getStatus();
    const ready = await whatsappGateway.ensureReady(15000);
    if (!ready) {
      return res.status(503).json({
        success: false,
        error: 'whatsapp_not_ready',
        message: 'WhatsApp bot belum terhubung.',
        connection: whatsappStatus?.connection || 'unknown'
      });
    }

    const sent = await whatsappGateway.sendText(to, message);
    if (!sent) {
      return res.status(502).json({
        success: false,
        error: 'send_failed',
        message: 'WhatsApp gagal mengirim pesan.'
      });
    }

    return res.json({
      success: true,
      message: 'Pesan WhatsApp berhasil dikirim.',
      data: {
        number: normalizePhoneDigits(to),
        length: message.length
      }
    });
  } catch (error) {
    logger.error(`[WA API] Gagal send-message: ${error.stack || error.message || error}`);
    return res.status(500).json({
      success: false,
      error: error.message || 'Gagal mengirim WhatsApp.'
    });
  }
});

function firstWebhookTextValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function findWebhookValue(source, keys = [], depth = 0) {
  if (!source || typeof source !== 'object' || depth > 4) return '';
  for (const key of keys) {
    const direct = source[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  }
  for (const value of Object.values(source)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findWebhookValue(item, keys, depth + 1);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findWebhookValue(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function extractIncomingWhatsappPayload(body = {}) {
  const source = body?.data && typeof body.data === 'object' ? body.data : body;
  const numberRaw = firstWebhookTextValue(
    source.number,
    source.phone,
    source.from,
    source.remoteJid,
    source.chatId,
    source.sender,
    source.participant,
    findWebhookValue(source, ['number', 'phone', 'from', 'remoteJid', 'chatId', 'sender', 'participant'])
  );
  const text = firstWebhookTextValue(
    source.message,
    source.text,
    source.body,
    source.caption,
    source.conversation,
    source.content,
    source.messageText,
    findWebhookValue(source, ['message', 'text', 'body', 'caption', 'conversation', 'content', 'messageText'])
  );
  return {
    number: normalizePhoneDigits(String(numberRaw || '').replace(/@.+$/, '')),
    text: String(text || '').trim(),
    rawNumber: numberRaw
  };
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function buildIncomingWhatsappReply({ customer, text, settings, req }) {
  const normalized = String(text || '').trim().toLowerCase();
  const companyName = settings?.company_header || 'SICKAS WIFI';
  const wantsMenu = !normalized || ['menu', 'halo', 'hallo', 'hai', 'hi', 'hello', 'bantuan', 'help'].includes(normalized);
  if (wantsMenu) {
    return [
      `Halo${customer?.name ? ` Kak ${customer.name}` : ''}, selamat datang di ${companyName}.`,
      '',
      'Silakan balas dengan angka:',
      '1. Cek tagihan',
      '2. Cara bayar',
      '3. Lapor gangguan',
      '4. Hubungi admin'
    ].join('\n');
  }

  const wantsBill = normalized === '1'
    || normalized.includes('tagihan')
    || normalized.includes('cek bayar')
    || normalized.includes('cek pembayaran')
    || normalized.includes('invoice');
  if (wantsBill) {
    if (!customer) {
      return 'Nomor WhatsApp ini belum ditemukan di data pelanggan. Silakan kirim nama/ID pelanggan atau hubungi admin.';
    }
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id) || [];
    if (!invoices.length) {
      return `Halo Kak ${customer.name}, tagihan aktif belum ditemukan. Terima kasih.`;
    }
    const total = invoices.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
    const rows = invoices.slice(0, 5).map((inv, index) => {
      const period = [inv.period_month, inv.period_year].filter(Boolean).join('/') || `INV-${inv.id}`;
      return `${index + 1}. ${period} - ${formatRupiah(inv.amount)}`;
    });
    return [
      `Tagihan Kak ${customer.name}:`,
      ...rows,
      '',
      `Total: ${formatRupiah(total)}`,
      `Link cek/bayar: ${buildCustomerCheckBillingLink(customer, { baseUrl: resolveRequestBaseUrl(req) })}`
    ].join('\n');
  }

  if (normalized === '2' || normalized.includes('cara bayar') || normalized.includes('bayar')) {
    return `Cara bayar dapat dibuka melalui link cek tagihan. Balas 1 atau ketik "cek tagihan" untuk melihat nominal dan link pembayaran.`;
  }

  if (normalized === '3' || normalized.includes('gangguan') || normalized.includes('lapor')) {
    return 'Laporan gangguan diterima. Mohon kirim detail kendala, nama pelanggan, dan alamat singkat agar teknisi/admin bisa mengecek.';
  }

  if (normalized === '4' || normalized.includes('admin')) {
    return 'Baik, pesan Kakak akan diteruskan ke admin. Mohon tunggu sebentar.';
  }

  return '';
}

app.post('/api/whatsapp/chatsmart-webhook', requireWhatsappApiKey, async (req, res) => {
  try {
    const payload = extractIncomingWhatsappPayload(req.body || {});
    const text = payload.text;
    const from = payload.number;
    const fromMe = Boolean(req.body?.fromMe || req.body?.from_me || req.body?.key?.fromMe || req.body?.data?.fromMe || req.body?.data?.from_me);

    logger.info(`[WA Webhook] incoming from=${from || payload.rawNumber || '-'} fromMe=${fromMe ? 1 : 0} text="${String(text || '').replace(/\r?\n/g, ' ').slice(0, 180)}"`);
    if (fromMe || !from || !text) {
      return res.json({ success: true, processed: false });
    }

    const settings = getSettingsWithCache();
    const customer = customerSvc.findCustomerByAny(from);
    const reply = buildIncomingWhatsappReply({ customer, text, settings, req });
    if (reply) {
      const sendDirect = ['1', 'true', 'yes'].includes(String(req.query?.send_direct || req.body?.send_direct || '').toLowerCase());
      if (sendDirect) {
        await whatsappGateway.sendText(from, reply);
      }
      const responseJson = ['1', 'true', 'yes'].includes(String(req.query?.response_json || req.body?.response_json || '').toLowerCase());
      if (responseJson || sendDirect) {
        return res.json({ success: true, processed: true, replied: true, text: reply, message: reply });
      }
      return res.type('text/plain').send(reply);
    }
    return res.json({ success: true, processed: true, replied: false });
  } catch (error) {
    logger.error(`[WA Webhook] Gagal proses ChatSmart webhook: ${error.stack || error.message || error}`);
    return res.status(500).json({ success: false, error: error.message || 'Gagal proses webhook WhatsApp.' });
  }
});

const insertWebhookPaymentNotif = db.prepare(`
  INSERT INTO webhook_payment_notifs (service, content, parsed_amount, parsed_ok, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateWebhookPaymentNotifMatch = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_invoice_id = ?
  WHERE id = ?
`);

const updateWebhookPaymentNotifAgentTopupMatch = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_agent_topup_id = ?
  WHERE id = ?
`);

const selectRecentDuplicateWebhookMatched = db.prepare(`
  SELECT id, matched_invoice_id, matched_agent_topup_id, created_at
  FROM webhook_payment_notifs
  WHERE service = ?
    AND content = ?
    AND parsed_amount = ?
    AND id != ?
    AND created_at >= datetime('now', '-2 day')
    AND (matched_invoice_id IS NOT NULL OR matched_agent_topup_id IS NOT NULL)
  ORDER BY id DESC
  LIMIT 1
`);

const selectInvoiceByUniqueAmount = db.prepare(`
  SELECT i.id, i.customer_id, i.status, i.amount, i.qris_amount_unique, i.qris_unique_code, i.notes,
         c.status as customer_status
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.status = 'unpaid' AND i.qris_amount_unique = ?
  ORDER BY i.id DESC
  LIMIT 2
`);

const updateInvoiceQrisPaidNotif = db.prepare(`
  UPDATE invoices
  SET qris_paid_notif_id=?
  WHERE id=?
`);

const countUnpaidInvoicesForCustomer = db.prepare(`SELECT COUNT(1) as c FROM invoices WHERE customer_id=? AND status='unpaid'`);

const insertDigiflazzWebhookLog = db.prepare(`
  INSERT INTO digiflazz_webhook_logs (ref_id, status, signature, signature_ok, matched_agent_tx_id, ip, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectAgentPulsaTxByRefId = db.prepare(`
  SELECT id, agent_id, amount_buy, amount_sell, digi_refunded, digi_status
  FROM agent_transactions
  WHERE type = 'pulsa' AND digi_ref_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const updateAgentPulsaTxFromWebhook = db.prepare(`
  UPDATE agent_transactions
  SET digi_status = ?,
      digi_trx_id = ?,
      digi_sn = ?,
      digi_message = ?,
      digi_price = ?
  WHERE id = ?
`);

const markAgentPulsaRefunded = db.prepare(`UPDATE agent_transactions SET digi_refunded = 1 WHERE id = ?`);

const getAgentByIdForWebhook = db.prepare(`SELECT id, balance FROM agents WHERE id = ?`);
const updateAgentBalanceForWebhook = db.prepare(`UPDATE agents SET balance = ? WHERE id = ?`);
const insertAgentTxRefund = db.prepare(`
  INSERT INTO agent_transactions (
    agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
  ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
`);

function normalizeDigiflazzStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'sukses' || s === 'success') return 'success';
  if (s === 'gagal' || s === 'failed') return 'failed';
  if (s === 'pending' || s === 'process' || s === 'processing') return 'pending';
  return 'pending';
}

function getIp(req) {
  return String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
}

function normalizeAmountCandidate(raw) {
  let text = String(raw || '').replace(/\s+/g, '').replace(/[^\d.,]/g, '');
  if (!text) return null;

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    const parts = text.split(decimalSep);
    const tail = parts[parts.length - 1] || '';
    text = text.replace(new RegExp(`\\${thousandsSep}`, 'g'), '');
    if (tail.length <= 2) text = text.split(decimalSep)[0];
    else text = text.replace(new RegExp(`\\${decimalSep}`, 'g'), '');
  } else if (lastComma >= 0) {
    const parts = text.split(',');
    const tail = parts[parts.length - 1] || '';
    text = tail.length === 2 ? parts.slice(0, -1).join('') : parts.join('');
  } else if (lastDot >= 0) {
    const parts = text.split('.');
    const tail = parts[parts.length - 1] || '';
    text = tail.length === 2 ? parts.slice(0, -1).join('') : parts.join('');
  }

  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;
  const amount = Number.parseInt(digits, 10);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function pushAmountCandidate(target, raw) {
  const amount = normalizeAmountCandidate(raw);
  if (amount && !target.includes(amount)) target.push(amount);
}

function firstTextValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function buildPaymentNotificationInput(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const nestedNotification = payload.notification && typeof payload.notification === 'object' ? payload.notification : {};
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const appName = firstTextValue(
    payload.service,
    payload.app,
    payload.app_name,
    payload.appName,
    payload.package,
    payload.package_name,
    payload.packageName,
    payload.source,
    nestedNotification.service,
    nestedNotification.app,
    nestedNotification.appName,
    nestedNotification.packageName,
    nestedData.service,
    nestedData.app,
    nestedData.appName
  );
  const title = firstTextValue(
    payload.title,
    payload.notification_title,
    payload.notificationTitle,
    payload.subject,
    nestedNotification.title,
    nestedData.title
  );
  const text = firstTextValue(
    payload.content,
    payload.text,
    payload.message,
    payload.body,
    payload.notification,
    payload.data,
    payload.notification_text,
    payload.notificationText,
    nestedNotification.content,
    nestedNotification.text,
    nestedNotification.message,
    nestedNotification.body,
    nestedData.content,
    nestedData.text,
    nestedData.message
  );
  const bigText = firstTextValue(
    payload.big_text,
    payload.bigText,
    payload.extra_text,
    payload.extraText,
    payload.sub_text,
    payload.subText,
    payload.summary,
    nestedNotification.big_text,
    nestedNotification.bigText,
    nestedNotification.extraText,
    nestedNotification.subText,
    nestedNotification.summary,
    nestedData.bigText,
    nestedData.summary
  );
  const amount = firstTextValue(
    payload.amount,
    payload.nominal,
    payload.value,
    payload.total,
    nestedNotification.amount,
    nestedData.amount,
    nestedData.nominal,
    nestedData.total
  );
  const parts = [title, text, bigText, amount].filter(Boolean);
  return {
    service: appName || 'NOTIFICATION',
    content: parts.length ? parts.join('\n') : firstTextValue(payload.raw, payload.raw_text, payload.rawText)
  };
}

function isLikelyOutgoingPaymentNotification(content) {
  const text = String(content || '').toLowerCase();
  if (!text) return false;

  const incomingHints = [
    'masuk',
    'menerima',
    'diterima',
    'terima uang',
    'uang masuk',
    'saldo bertambah',
    'dana masuk',
    'qris masuk',
    'pembayaran diterima',
    'kredit',
    'credit'
  ];
  if (incomingHints.some((hint) => text.includes(hint))) return false;

  const outgoingHints = [
    'mengirim',
    'kirim uang',
    'terkirim',
    'transfer keluar',
    'saldo berkurang',
    'top up',
    'topup',
    'isi saldo',
    'bayar ke',
    'pembayaran ke',
    'belanja',
    'pembelian',
    'tarik saldo',
    'withdraw'
  ];
  return outgoingHints.some((hint) => text.includes(hint));
}

function parseRupiahAmountsFromNotification(content) {
  const text = String(content || '').replace(/\u00A0/g, ' ').trim();
  if (!text) return [];

  const amounts = [];
  const patterns = [
    /(?:\+\s*)?(?:Rp\.?\s*|IDR\s*)([0-9][0-9.,]*)/gi,
    /(?:\bRp\.?\s*|IDR\s*)(?:\+|:|=)?\s*([0-9][0-9.,]*)/gi,
    /(?:sebesar|senilai|nominal|masuk|diterima|terima|menerima|saldo\s+masuk|payment|pembayaran|setoran|kredit|credit)\s*(?:saldo\s*)?(?:\bRp\.?\s*)?(?:\+|:|=)?\s*([0-9][0-9.,]*)/gi,
    /([0-9][0-9.,]*)\s*(?:telah\s+)?(?:masuk|diterima|ditambahkan|credited)/gi
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1]) pushAmountCandidate(amounts, match[1]);
    }
  }

  return amounts;
}

function findUniqueQrisInvoiceMatch(amounts = []) {
  const checked = [];
  const ambiguous = [];
  for (const amount of Array.isArray(amounts) ? amounts : []) {
    const candidates = selectInvoiceByUniqueAmount.all(amount);
    checked.push({ amount, count: candidates.length, ids: candidates.map((row) => row.id) });
    if (candidates.length === 1) {
      return { amount, invoice: candidates[0], checked, ambiguous };
    }
    if (candidates.length > 1) {
      ambiguous.push({ amount, ids: candidates.map((row) => row.id) });
    }
  }
  return { amount: null, invoice: null, checked, ambiguous };
}

function appendInvoiceNote(existingNotes, noteLine) {
  const current = String(existingNotes || '').trim();
  const next = String(noteLine || '').trim();
  if (!next) return current;
  return current ? `${current}\n${next}` : next;
}

function buildWebhookPaidWhatsappMessage(customer, invoice, gateway, settings, baseUrl) {
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

async function trySendWebhookPaidWhatsapp(req, customerId, invoiceId, gatewayLabel) {
  try {
    const settings = getSettingsWithCache();
    if (!settings?.whatsapp_enabled) return false;
    const customer = customerSvc.getCustomerById(customerId);
    const invoice = billingSvc.getInvoiceById(invoiceId);
    if (!customer || !invoice || !customer.phone) return false;
    const ready = await whatsappGateway.ensureReady(12000);
    if (!ready) throw new Error('WhatsApp belum siap');
    const ok = await whatsappGateway.sendText(
      customer.phone,
      buildWebhookPaidWhatsappMessage(customer, invoice, gatewayLabel, settings, resolveRequestBaseUrl(req))
    );
    if (!ok) throw new Error('Gateway WhatsApp mengembalikan gagal');
    return true;
  } catch (error) {
    logger.error(`[WEBHOOK][payment-notif] Gagal kirim notif lunas WA: ${error?.message || error}`);
    return false;
  }
}

app.post('/api/webhook/v1/payment-notif', async (req, res) => {
  const payload = req.body || {};
  const providedSecret = firstTextValue(
    payload.secret_key,
    payload.secret,
    payload.token,
    req.headers['x-webhook-secret'],
    req.headers['x-payment-secret'],
    req.headers['x-api-key']
  );
  const notificationInput = buildPaymentNotificationInput(payload);
  const service = notificationInput.service;
  const content = notificationInput.content;
  const expected = String(
    process.env.MY_WEBHOOK_SECRET ||
    getSetting('payment_notif_secret', '') ||
    ''
  ).trim();

  if (!expected || typeof expected !== 'string' || expected.length < 8) {
    logger.error('[WEBHOOK][payment-notif] payment_notif_secret / MY_WEBHOOK_SECRET belum diset (minimal 8 karakter). Request ditolak.');
    return res.status(403).send('Forbidden');
  }

  if (providedSecret !== expected) {
    logger.warn(`[WEBHOOK][payment-notif] Forbidden: secret_key mismatch. service=${String(service || '-')}`);
    return res.status(403).send('Forbidden');
  }

  const rawText = String(content || '');
  logger.info(`[WEBHOOK][payment-notif] IN service=${String(service || '-')} content="${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);

  try {
    const ignoredOutgoing = isLikelyOutgoingPaymentNotification(rawText);
    const amountCandidates = parseRupiahAmountsFromNotification(rawText);
    const qrisMatch = ignoredOutgoing ? { amount: null, invoice: null, checked: [], ambiguous: [] } : findUniqueQrisInvoiceMatch(amountCandidates);
    const agentTopupMatch = ignoredOutgoing || qrisMatch.invoice
      ? { amount: null, order: null, checked: [], ambiguous: [] }
      : agentSvc.findPendingAgentTopupByPayAmounts(amountCandidates);
    const amount = qrisMatch.amount || agentTopupMatch.amount || amountCandidates[0] || null;
    const ip = String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
    const ua = String(req.get('user-agent') || '');
    let notifId = null;
    try {
      const r = insertWebhookPaymentNotif.run(
        String(service || ''),
        rawText,
        amount != null ? amount : null,
        amount != null ? 1 : 0,
        ip,
        ua
      );
      notifId = Number(r?.lastInsertRowid || 0) || null;
    } catch (e) {
      logger.error(`[WEBHOOK][payment-notif] DB log insert failed: ${e && e.message ? e.message : String(e)}`);
    }

    let matchedInvoiceId = null;
    let matchedAgentTopupId = null;
    if (amount != null) {
      try {
        const normalizedService = String(service || '');
        const duplicateMatched = notifId
          ? amountCandidates
              .map((candidateAmount) => selectRecentDuplicateWebhookMatched.get(normalizedService, rawText, candidateAmount, notifId))
              .find(Boolean)
          : null;

        const duplicateMatchedInvoiceId = duplicateMatched
          ? (Number(duplicateMatched.matched_invoice_id || 0) || null)
          : null;
        const duplicateMatchedAgentTopupId = duplicateMatched
          ? (Number(duplicateMatched.matched_agent_topup_id || 0) || null)
          : null;
        if (
          duplicateMatched &&
          (
            (!qrisMatch.invoice && !agentTopupMatch.order) ||
            (qrisMatch.invoice && Number(qrisMatch.invoice.id || 0) === duplicateMatchedInvoiceId) ||
            (agentTopupMatch.order && Number(agentTopupMatch.order.id || 0) === duplicateMatchedAgentTopupId)
          )
        ) {
          matchedInvoiceId = duplicateMatchedInvoiceId;
          matchedAgentTopupId = duplicateMatchedAgentTopupId;
          if (notifId && matchedInvoiceId) {
            try { updateWebhookPaymentNotifMatch.run(matchedInvoiceId, notifId); } catch {}
          }
          if (notifId && matchedAgentTopupId) {
            try { updateWebhookPaymentNotifAgentTopupMatch.run(matchedAgentTopupId, notifId); } catch {}
          }
          logger.warn(
            `[WEBHOOK][payment-notif] DUPLICATE ignored service=${normalizedService || '-'} amount=${amount} prior_notif=${duplicateMatched.id || '-'} prior_invoice=${matchedInvoiceId || '-'} prior_agent_topup=${matchedAgentTopupId || '-'}`
          );
          return res.status(200).json({
            status: 'processed',
            parsed: true,
            amount,
            amounts: amountCandidates,
            matched_invoice_id: matchedInvoiceId,
            matched_agent_topup_id: matchedAgentTopupId,
            duplicate: true
          });
        }
        if (duplicateMatched && qrisMatch.invoice) {
          logger.warn(
            `[WEBHOOK][payment-notif] DUPLICATE content ignored because new unpaid invoice matched service=${normalizedService || '-'} amount=${amount} prior_match=${duplicateMatchedInvoiceId || '-'} new_match=${qrisMatch.invoice.id || '-'}`
          );
        }

        if (ignoredOutgoing) {
          logger.warn(`[WEBHOOK][payment-notif] IGNORED outgoing/debit notification service=${normalizedService || '-'} amount=${amount || '-'} content="${rawText.replace(/\r?\n/g, ' ').slice(0, 240)}"`);
        } else if (qrisMatch.invoice) {
          const inv = qrisMatch.invoice;
          const invId = Number(inv.id || 0);
          const custId = Number(inv.customer_id || 0);
          if (invId > 0) {
            const noteLine = `AUTO-QRIS: cocok nominal unik Rp ${amount} (service=${String(service || '-')}, notif=${notifId || '-'})`;
            const nextNotes = appendInvoiceNote(inv.notes, noteLine);
            billingSvc.markAsPaid(invId, 'QRIS', nextNotes, {
              type: 'system',
              id: null,
              name: 'Webhook QRIS',
              ip,
              userAgent: ua
            });
            if (notifId) updateInvoiceQrisPaidNotif.run(notifId, invId);
            matchedInvoiceId = invId;

            if (notifId) {
              try { updateWebhookPaymentNotifMatch.run(invId, notifId); } catch {}
            }

            await trySendWebhookPaidWhatsapp(req, custId, invId, String(service || 'QRIS').toUpperCase());

            if (custId > 0 && ['suspended', 'inactive'].includes(String(inv.customer_status || '').toLowerCase())) {
              const cnt = countUnpaidInvoicesForCustomer.get(custId);
              const unpaid = Number(cnt?.c || 0);
              if (unpaid === 0) {
                try { await customerSvc.activateCustomer(custId); } catch (e) {
                  logger.error(`[WEBHOOK][payment-notif] Activate customer failed: ${e && e.message ? e.message : String(e)}`);
                }
              }
            }

            logger.info(`[WEBHOOK][payment-notif] MATCH invoice=${invId} amount=${amount}`);
          }
        } else if (agentTopupMatch.order) {
          const order = agentTopupMatch.order;
          const orderId = Number(order.id || 0);
          if (orderId > 0) {
            const completed = agentSvc.completeAgentTopupOrder(orderId, notifId, String(service || 'QRIS').toUpperCase());
            matchedAgentTopupId = orderId;
            if (notifId) {
              try { updateWebhookPaymentNotifAgentTopupMatch.run(orderId, notifId); } catch {}
            }
            logger.info(
              `[WEBHOOK][payment-notif] MATCH agent_topup=${orderId} agent=${order.agent_id || '-'} amount=${amount} credited=${Number(completed?.order?.amount || order.amount || 0)}`
            );
          }
        } else if (qrisMatch.ambiguous.length) {
          logger.error(`[WEBHOOK][payment-notif] MATCH ambiguous: ${qrisMatch.ambiguous.map((item) => `amount=${item.amount} candidates=${item.ids.join(',')}`).join(' | ')}`);
        } else if (agentTopupMatch.ambiguous.length) {
          logger.error(`[WEBHOOK][payment-notif] TOPUP ambiguous: ${agentTopupMatch.ambiguous.map((item) => `amount=${item.amount} candidates=${item.ids.join(',')}`).join(' | ')}`);
        } else if (amountCandidates.length) {
          logger.warn(`[WEBHOOK][payment-notif] Tidak ada invoice/topup pending dengan nominal unik: ${amountCandidates.join(', ')}`);
        }
      } catch (e) {
        logger.error(`[WEBHOOK][payment-notif] MATCH error: ${e && e.message ? e.message : String(e)}`);
      }
    }

    if (amount != null) {
      logger.info(`[WEBHOOK][payment-notif] PARSED service=${String(service || '-')} amount=${amount} candidates=${amountCandidates.join(',')}`);
      return res.status(200).json({
        status: 'processed',
        parsed: true,
        amount,
        amounts: amountCandidates,
        matched_invoice_id: matchedInvoiceId,
        matched_agent_topup_id: matchedAgentTopupId,
        ignored: ignoredOutgoing ? 'outgoing_payment' : false
      });
    }

    logger.error(`[WEBHOOK][payment-notif] FAILED parse: "${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  } catch (err) {
    logger.error(`[WEBHOOK][payment-notif] ERROR ${err && err.stack ? err.stack : String(err)}`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  }
});

app.get('/webhook/digiflazz', (req, res) => {
  res.json({ success: true, message: 'OK. Use POST for Digiflazz webhook.' });
});
app.head('/webhook/digiflazz', (req, res) => res.status(200).end());
app.post('/webhook/digiflazz', async (req, res) => {
  const payload = req.body || {};
  const signature = req.headers['x-hub-signature'] || req.headers['x-digiflazz-delivery'];
  const eventName = String(req.headers['x-digiflazz-event'] || '').trim();
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const secret = String(getSetting('digiflazz_webhook_secret', '') || '').trim();
  const expectedHookId = String(getSetting('digiflazz_webhook_id', '') || '').trim();

  if (!secret) return res.status(503).send('Webhook secret belum dikonfigurasi');
  if (!signature || typeof signature !== 'string') return res.status(401).send('Unauthorized');

  const raw = req.rawBody || JSON.stringify(payload);
  const selfSignature = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('hex');

  let sigOk = 0;
  try {
    const a = Buffer.from(String(signature));
    const b = Buffer.from(String(selfSignature));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) sigOk = 1;
  } catch (e) {
    sigOk = 0;
  }

  const data = payload?.data || {};
  const refId = String(data?.ref_id || '').trim();
  const vendorStatus = String(data?.status || '').trim();
  const vendorMessage = String(data?.message || '').trim();
  const vendorSn = String(data?.sn || '').trim();
  const vendorTrxId = String(data?.trx_id || '').trim();
  const vendorPrice = Math.max(0, Math.floor(Number(data?.price || 0) || 0));

  const ip = getIp(req);

  const pingHookId = String(payload?.hook_id || '').trim();
  if (!refId && payload && payload.sed && pingHookId) {
    try { insertDigiflazzWebhookLog.run('', eventName || 'ping', String(signature || ''), sigOk, null, ip, raw); } catch {}
    if (!sigOk) return res.status(401).send('Unauthorized');
    const hookIdOk = !expectedHookId || expectedHookId === pingHookId;
    logger.info(`[WEBHOOK][digiflazz] ping hook_id=${pingHookId} expected=${expectedHookId || '-'} ok=${hookIdOk ? 1 : 0} event=${eventName || '-'} ua=${userAgent || '-'} ip=${ip}`);
    return res.json({ success: true, type: 'ping', hook_id: pingHookId, hook_id_ok: hookIdOk });
  }

  if (!refId) {
    try { insertDigiflazzWebhookLog.run('', vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(400).send('Invalid payload');
  }

  if (!sigOk) {
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(401).send('Unauthorized');
  }

  let matchedTxId = null;
  try {
    const tx = selectAgentPulsaTxByRefId.get(refId);
    matchedTxId = tx?.id || null;

    const nextStatus = normalizeDigiflazzStatus(vendorStatus);
    if (tx && tx.id) {
      updateAgentPulsaTxFromWebhook.run(
        nextStatus,
        vendorTrxId,
        vendorSn,
        vendorMessage,
        vendorPrice,
        tx.id
      );

      if (nextStatus === 'failed' && Number(tx.digi_refunded || 0) !== 1) {
        const runRefund = db.transaction(() => {
          const fresh = selectAgentPulsaTxByRefId.get(refId);
          if (!fresh || !fresh.id) return;
          if (Number(fresh.digi_refunded || 0) === 1) return;

          const agent = getAgentByIdForWebhook.get(fresh.agent_id);
          if (!agent) return;

          const amount = Math.max(0, Math.floor(Number(fresh.amount_sell || 0) || 0));
          const before = Number(agent.balance || 0);
          const after = before + amount;
          updateAgentBalanceForWebhook.run(after, fresh.agent_id);
          insertAgentTxRefund.run(
            fresh.agent_id,
            amount,
            amount,
            before,
            after,
            `REFUND Digiflazz webhook (tx#${fresh.id} ref=${refId})`
          );
          markAgentPulsaRefunded.run(fresh.id);
        });
        runRefund();
      }
    }
  } catch (e) {
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
    return res.status(500).send('Internal Server Error');
  }

  try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
  logger.info(`[WEBHOOK][digiflazz] event=${eventName || '-'} ua=${userAgent || '-'} ref=${refId} status=${vendorStatus} ok=${sigOk} match=${matchedTxId || '-'}`);
  return res.json({ success: true, ref_id: refId, matched_agent_tx_id: matchedTxId });
});

// Inisialisasi database billing
try {
  require('./config/database');
  logger.info('[DB] Billing database ready');
} catch (e) {
  logger.error('[DB] Database init failed:', e.message);
}

// Variabel global untuk modul lain yang masih membaca konfigurasi (mis. skrip utilitas)
global.appSettings = {
  port: getSetting('server_port', 4555),
  host: getSetting('server_host', 'localhost'),
  genieacsUrl: getSetting('genieacs_url', 'http://localhost:7557'),
  genieacsUsername: getSetting('genieacs_username', ''),
  genieacsPassword: getSetting('genieacs_password', ''),
  companyHeader: getSetting('company_header', 'ISP Monitor'),
  footerInfo: getSetting('footer_info', ''),
};

// Route untuk health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: VERSION
    });
});

// Redirect root ke portal pelanggan
app.get('/', (req, res) => {
  res.redirect('/customer/login');
});

// Alias singkat: /login → /customer/login
app.get('/login', (req, res) => {
  res.redirect('/customer/login');
});

// Halaman Isolir (Akses langsung dari redirect MikroTik)
app.get('/isolated', (req, res) => {
  const { getSettingsWithCache } = require('./config/settingsManager');
  const customerSvc = require('./services/customerService');
  const settings = getSettingsWithCache();
  const sessionCustomerId = Number(req.session?.customerId || 0);
  const sessionPhone = String(req.session?.phone || '').trim();
  const profile = sessionCustomerId > 0
    ? customerSvc.getCustomerById(sessionCustomerId)
    : (sessionPhone ? customerSvc.findCustomerByAny(sessionPhone) : null);
  const normalizedStatus = String(profile?.status || 'suspended').trim().toLowerCase();
  const isInactive = normalizedStatus === 'inactive';
  res.render('isolated', {
    company: settings.company_header || 'My ISP',
    adminPhone: settings.company_phone || '',
    address: settings.company_address || '',
    accountState: isInactive ? 'inactive' : 'suspended',
    accountStateLabel: isInactive ? 'Nonaktif' : 'Terisolir',
    isolationNotice: String(
      isInactive
        ? 'Akun pelanggan Anda sedang nonaktif. Silakan hubungi admin untuk aktivasi atau informasi lanjutan.'
        : (settings.customer_isolation_notice ||
          'Layanan internet Anda sedang dinonaktifkan sementara karena masih ada tagihan yang belum lunas. Silakan cek tagihan atau hubungi admin bila membutuhkan bantuan.')
    ).trim()
  });
});

// Tambahkan view engine dan static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
// Mount customer portal
const customerPortal = require('./routes/customerPortal');
app.use('/customer', customerPortal);
app.get(/^\/inv(?:\/)?(\d+[a-f0-9]{8})(?:\/print)?$/i, (req, res) => {
  return res.redirect(`/customer${req.originalUrl}`);
});
app.get(/^\/i\/([A-Za-z0-9-]+)$/i, (req, res) => {
  return res.redirect(`/customer${req.originalUrl}`);
});

// Mount admin portal
const adminPortal = require('./routes/adminPortal');
app.use('/admin', adminPortal);

// Mount tech portal
const techPortal = require('./routes/techPortal');
app.use('/tech', techPortal);

// Mount agent portal
const agentPortal = require('./routes/agentPortal');
app.use('/agent', agentPortal);

// Mount collector portal
const collectorPortal = require('./routes/collectorPortal');
app.use('/collector', collectorPortal);

// Fungsi untuk memulai server dengan penanganan port yang sudah digunakan
function startServer(portToUse) {
    logger.info(`Mencoba memulai server pada port ${portToUse}...`);
    
    // Coba port alternatif jika port utama tidak tersedia
    try {
        const server = app.listen(portToUse, () => {
            logger.info(`Server berhasil berjalan pada port ${portToUse}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            // Update global.appSettings.port dengan port yang berhasil digunakan
            global.appSettings.port = portToUse.toString();
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`PERINGATAN: Port ${portToUse} sudah digunakan, mencoba port alternatif...`);
                // Coba port alternatif (port + 1000)
                const alternativePort = portToUse + 1000;
                logger.info(`Mencoba port alternatif: ${alternativePort}`);
                
                // Buat server baru dengan port alternatif
                const alternativeServer = app.listen(alternativePort, () => {
                    logger.info(`Server berhasil berjalan pada port alternatif ${alternativePort}`);
                    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
                    // Update global.appSettings.port dengan port yang berhasil digunakan
                    global.appSettings.port = alternativePort.toString();
                }).on('error', (altErr) => {
                    logger.error(`ERROR: Gagal memulai server pada port alternatif ${alternativePort}:`, altErr.message);
                    process.exit(1);
                });
            } else {
                logger.error('Error starting server:', err);
                process.exit(1);
            }
        });
    } catch (error) {
        logger.error(`Terjadi kesalahan saat memulai server:`, error);
        process.exit(1);
    }
}

// Mulai server dengan port dari konfigurasi aktif
const port = global.appSettings.port;
logger.info(`Attempting to start server on configured port: ${port}`);

// Mulai server dengan port dari konfigurasi
startServer(port);

function parseEnvFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return null;
}

function shouldRunBackgroundWorkers() {
  const explicit =
    parseEnvFlag(process.env.BILLING_BACKGROUND_WORKER) ??
    parseEnvFlag(process.env.RUN_BACKGROUND_JOBS);
  if (explicit !== null) return explicit;

  const configuredPort = String(global.appSettings?.port || process.env.PORT || '').trim();
  if (configuredPort === '3001') return false;
  return true;
}

function shouldRunWhatsappWorker() {
  const explicit =
    parseEnvFlag(process.env.BILLING_WHATSAPP_WORKER) ??
    parseEnvFlag(process.env.RUN_WHATSAPP_BOT);
  if (explicit !== null) return explicit;
  return true;
}

const backgroundWorkersEnabled = shouldRunBackgroundWorkers();
const whatsappWorkerEnabled = shouldRunWhatsappWorker();

if (whatsappWorkerEnabled && getSetting('whatsapp_enabled', false) && whatsappGateway.getProvider() === 'local') {
  import('./services/whatsappBot.mjs')
    .then((mod) => mod.startWhatsAppBot())
    .catch((err) => logger.error('Gagal memulai WhatsApp bot:', err));
} else if (!whatsappWorkerEnabled) {
  logger.info(`[WA] Worker WhatsApp dinonaktifkan untuk port ${global.appSettings?.port || process.env.PORT || '-'}.`);
} else if (getSetting('whatsapp_enabled', false) && whatsappGateway.getProvider() === 'mpwa') {
  logger.info('[WA] Provider MPWA aktif, worker bot lokal tidak dijalankan.');
}

if (backgroundWorkersEnabled) {
  if (getSetting('telegram_enabled', false)) {
    const { initTelegram } = require('./services/telegramBot');
    initTelegram();
  }

  // Mulai cron jobs (generate tagihan otomatis, dll)
  const { startCronJobs } = require('./services/cronService');
  startCronJobs();

  // Mulai collector snapshot MikroTik agar dashboard memakai sumber data yang konsisten.
  const monitoringCollectorSvc = require('./services/monitoringCollectorService');
  monitoringCollectorSvc.startCollectorService();

  // Mulai auto backup
  scheduleAutoBackup();
} else {
  logger.info(`[Background] Worker dinonaktifkan untuk port ${global.appSettings?.port || process.env.PORT || '-'}. Web tetap berjalan.`);
}

// Error handling middleware (harus di akhir setelah semua routes)
app.use(notFoundHandler);
app.use(errorHandler);

// Export app untuk testing
module.exports = app;
