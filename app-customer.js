const express = require('express');
const path = require('path');
const dns = require('dns');
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const crypto = require('crypto');
const { logger } = require('./config/logger');
const db = require('./config/database');
const customerSvc = require('./services/customerService');
const { normalizePhoneDigits, formatPhoneDisplay, buildWhatsAppLink } = require('./services/phoneService');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { scheduleAutoBackup } = require('./services/backupService');
const { assertCriticalSecuritySettings } = require('./config/security');
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

// Settings Management
const session = require('express-session');
const { getSetting, getSettingsWithCache } = require('./config/settingsManager');
const { SUPPORTED_LANGS, FALLBACK_LANG, normalizeLang, t } = require('./config/i18n');
const { createSqliteSessionStore } = require('./config/sqliteSessionStore');
const billingSvc = require('./services/billingService');
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
      name: 'Portal Pelanggan',
      shortName: 'Pelanggan',
      startUrl: '/customer/login?source=pwa',
      scope: '/customer/',
      themeColor: '#2f6bff',
      backgroundColor: '#f6faff'
    },
    admin: {
      name: 'Admin',
      shortName: 'Admin',
      startUrl: '/admin?source=pwa',
      scope: '/admin/',
      themeColor: '#0f172a',
      backgroundColor: '#0f172a'
    },
    tech: {
      name: 'Portal Teknisi',
      shortName: 'Teknisi',
      startUrl: '/tech/login?source=pwa',
      scope: '/tech/',
      themeColor: '#0f172a',
      backgroundColor: '#0f172a'
    },
    agent: {
      name: 'Portal Agent',
      shortName: 'Agent',
      startUrl: '/agent/login?source=pwa',
      scope: '/agent/',
      themeColor: '#1e293b',
      backgroundColor: '#0f172a'
    },
    collector: {
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
    id: portal.scope,
    name: portal.name,
    short_name: portal.shortName,
    description: `${portal.name} ${companyName}`,
    start_url: portal.startUrl,
    scope: portal.scope,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
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
assertCriticalSecuritySettings(bootSettings);

const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = getSetting('cookie_secure', isProduction);
const trustProxy = getSetting('trust_proxy', false);
const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
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
  const maxAge = sessionState.rememberMe ? REMEMBER_ME_SESSION_MAX_AGE_MS : DEFAULT_SESSION_MAX_AGE_MS;
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
  res.locals.runtimeWarnings = getRuntimeConfigurationWarnings(settings, process.env);
  res.locals.selfUpdateEnabled = isSelfUpdateEnabled(settings, process.env);
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

const insertWebhookPaymentNotif = db.prepare(`
  INSERT INTO webhook_payment_notifs (service, content, parsed_amount, parsed_ok, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateWebhookPaymentNotifMatch = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_invoice_id = ?
  WHERE id = ?
`);

const selectRecentDuplicateWebhookMatched = db.prepare(`
  SELECT id, matched_invoice_id, created_at
  FROM webhook_payment_notifs
  WHERE service = ?
    AND content = ?
    AND parsed_amount = ?
    AND id != ?
    AND created_at >= datetime('now', '-2 day')
    AND matched_invoice_id IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
`);

const selectRecentDuplicateWebhookAny = db.prepare(`
  SELECT id, matched_invoice_id, created_at
  FROM webhook_payment_notifs
  WHERE service = ?
    AND content = ?
    AND parsed_amount = ?
    AND id != ?
    AND created_at >= datetime('now', '-2 day')
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

const markInvoicePaidAppendNote = db.prepare(`
  UPDATE invoices
  SET status='paid',
      paid_at=CURRENT_TIMESTAMP,
      paid_by_name=?,
      notes=CASE
        WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
        ELSE notes || '\n' || ?
      END,
      qris_paid_notif_id=?
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

function parseRupiahAmountFromNotification(content) {
  const text = String(content || '').replace(/\u00A0/g, ' ').trim();
  if (!text) return null;

  const candidates = [
    /(?:\bRp\.?\s*|IDR\s*)([0-9][0-9\.\,\s]*)/i,
    /(?:sebesar|senilai|nominal|masuk|transfer|top\s*up|topup|saldo\s+masuk)\s*(?:saldo\s*)?(?:\bRp\.?\s*)?([0-9][0-9\.\,\s]*)/i,
  ];

  let raw = null;
  for (const re of candidates) {
    const m = text.match(re);
    if (m && m[1]) {
      raw = String(m[1]);
      break;
    }
  }
  if (!raw) return null;

  let num = raw.replace(/\s+/g, '');
  if (num.includes(',')) num = num.split(',')[0];
  num = num.replace(/\./g, '');
  num = num.replace(/[^\d]/g, '');
  if (!num) return null;

  const amount = Number.parseInt(num, 10);
  return Number.isFinite(amount) ? amount : null;
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
    const { sendWA, ensureWhatsAppReady } = await import('./services/whatsappBot.mjs');
    const ready = await ensureWhatsAppReady(12000);
    if (!ready) throw new Error('Bot WhatsApp belum siap');
    const ok = await sendWA(
      customer.phone,
      buildWebhookPaidWhatsappMessage(customer, invoice, gatewayLabel, settings, resolveRequestBaseUrl(req))
    );
    if (!ok) throw new Error('sendWA mengembalikan gagal');
    return true;
  } catch (error) {
    logger.error(`[WEBHOOK][payment-notif] Gagal kirim notif lunas WA: ${error?.message || error}`);
    return false;
  }
}

app.post('/api/webhook/v1/payment-notif', async (req, res) => {
  const { service, content, secret_key } = req.body || {};
  const expected = String(
    process.env.MY_WEBHOOK_SECRET ||
    getSetting('payment_notif_secret', '') ||
    ''
  ).trim();

  if (!expected || typeof expected !== 'string' || expected.length < 8) {
    logger.error('[WEBHOOK][payment-notif] payment_notif_secret / MY_WEBHOOK_SECRET belum diset (minimal 8 karakter). Request ditolak.');
    return res.status(403).send('Forbidden');
  }

  if (String(secret_key || '') !== expected) {
    logger.warn(`[WEBHOOK][payment-notif] Forbidden: secret_key mismatch. service=${String(service || '-')}`);
    return res.status(403).send('Forbidden');
  }

  const rawText = String(content || '');
  logger.info(`[WEBHOOK][payment-notif] IN service=${String(service || '-')} content="${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);

  try {
    const amount = parseRupiahAmountFromNotification(rawText);
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
    if (amount != null) {
      try {
        const normalizedService = String(service || '');
        const duplicateMatched = notifId
          ? selectRecentDuplicateWebhookMatched.get(normalizedService, rawText, amount, notifId)
          : null;
        const duplicateAny = !duplicateMatched && notifId
          ? selectRecentDuplicateWebhookAny.get(normalizedService, rawText, amount, notifId)
          : null;

        if (duplicateMatched || duplicateAny) {
          matchedInvoiceId = Number((duplicateMatched?.matched_invoice_id ?? duplicateAny?.matched_invoice_id) || 0) || null;
          if (notifId && matchedInvoiceId) {
            try { updateWebhookPaymentNotifMatch.run(matchedInvoiceId, notifId); } catch {}
          }
          logger.warn(
            `[WEBHOOK][payment-notif] DUPLICATE ignored service=${normalizedService || '-'} amount=${amount} prior_notif=${duplicateMatched?.id || duplicateAny?.id || '-'} prior_match=${matchedInvoiceId || '-'}`
          );
          return res.status(200).json({
            status: 'processed',
            parsed: true,
            amount,
            matched_invoice_id: matchedInvoiceId,
            duplicate: true
          });
        }

        const candidates = selectInvoiceByUniqueAmount.all(amount);
        if (Array.isArray(candidates) && candidates.length === 1) {
          const inv = candidates[0];
          const invId = Number(inv.id || 0);
          const custId = Number(inv.customer_id || 0);
          if (invId > 0) {
            const noteLine = `AUTO-QRIS: cocok nominal unik Rp ${amount} (service=${String(service || '-')}, notif=${notifId || '-'})`;
            markInvoicePaidAppendNote.run('QRIS', noteLine, noteLine, notifId || null, invId);
            matchedInvoiceId = invId;

            if (notifId) {
              try { updateWebhookPaymentNotifMatch.run(invId, notifId); } catch {}
            }

            await trySendWebhookPaidWhatsapp(req, custId, invId, String(service || 'QRIS').toUpperCase());

            if (custId > 0 && String(inv.customer_status || '') === 'suspended') {
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
        } else if (Array.isArray(candidates) && candidates.length > 1) {
          logger.error(`[WEBHOOK][payment-notif] MATCH ambiguous: amount=${amount} candidates=${candidates.map(x => x.id).join(',')}`);
        }
      } catch (e) {
        logger.error(`[WEBHOOK][payment-notif] MATCH error: ${e && e.message ? e.message : String(e)}`);
      }
    }

    if (amount != null) {
      logger.info(`[WEBHOOK][payment-notif] PARSED service=${String(service || '-')} amount=${amount}`);
      return res.status(200).json({ status: 'processed', parsed: true, amount, matched_invoice_id: matchedInvoiceId });
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

// Mulai server dengan port dari settings.json
const port = global.appSettings.port;
logger.info(`Attempting to start server on configured port: ${port}`);

// Mulai server dengan port dari konfigurasi
startServer(port);

if (getSetting('whatsapp_enabled', false)) {
  import('./services/whatsappBot.mjs')
    .then((mod) => mod.startWhatsAppBot())
    .catch((err) => logger.error('Gagal memulai WhatsApp bot:', err));
}

if (getSetting('telegram_enabled', false)) {
  const { initTelegram } = require('./services/telegramBot');
  initTelegram();
}

// Mulai cron jobs (generate tagihan otomatis, dll)
const { startCronJobs } = require('./services/cronService');
startCronJobs();

// Mulai auto backup
scheduleAutoBackup();

// Error handling middleware (harus di akhir setelah semua routes)
app.use(notFoundHandler);
app.use(errorHandler);

// Export app untuk testing
module.exports = app;
