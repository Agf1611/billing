const axios = require('axios');
const db = require('../config/database');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const { resolveAppBaseUrl } = require('./publicLinkService');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function isTruthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function getPushSettings(settings = null) {
  const source = settings || getSettingsWithCache();
  return {
    enabled: isTruthy(source.onesignal_enabled),
    appId: normalizeText(source.onesignal_app_id),
    restApiKey: normalizeText(source.onesignal_rest_api_key),
    invoiceEnabled: source.onesignal_push_invoice_enabled == null ? true : isTruthy(source.onesignal_push_invoice_enabled),
    announcementEnabled: source.onesignal_push_announcement_enabled == null ? true : isTruthy(source.onesignal_push_announcement_enabled)
  };
}

function isPushConfigured(settings = null) {
  const config = getPushSettings(settings);
  return Boolean(config.enabled && config.appId && config.restApiKey);
}

function buildCustomerPushExternalId(customer) {
  const id = Number(customer && customer.id);
  if (!Number.isFinite(id) || id <= 0) return '';
  return `customer-${id}`;
}

function buildTechnicianPushExternalId(technician) {
  const id = Number(technician && technician.id);
  if (!Number.isFinite(id) || id <= 0) return '';
  return `technician-${id}`;
}

function buildAdminPushExternalId(admin) {
  const username = normalizeText(admin && admin.username);
  if (username) return `admin-${username.toLowerCase()}`;

  const id = normalizeText(admin && admin.id);
  if (id) return `admin-${id.toLowerCase()}`;

  return '';
}

function uniqueExternalIds(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => normalizeText(item)).filter(Boolean))];
}

function resolveTargetUrl(targetUrl = '', baseUrl = '') {
  const trimmed = normalizeText(targetUrl);
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const root = normalizeText(baseUrl) || resolveAppBaseUrl();
  return `${root.replace(/\/+$/, '')}/${trimmed.replace(/^\/+/, '')}`;
}

function resolveNotificationIcon(settings = {}, baseUrl = '') {
  const icon = normalizeText(settings.pwa_logo_url || settings.company_logo_url || '/img/mss-logo.png') || '/img/mss-logo.png';
  return resolveTargetUrl(icon, baseUrl);
}

function resolvePushPriority(options = {}) {
  const explicit = Number(options.priority);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.min(10, explicit));
  const importance = normalizeText(options.importance || options.urgency || '').toLowerCase();
  if (['high', 'urgent', 'critical', 'penting'].includes(importance)) return 10;
  return 10;
}

function buildWebButtons(targetUrl = '', options = {}) {
  if (options.webButtons === false || options.buttons === false) return undefined;
  if (Array.isArray(options.webButtons)) return options.webButtons;
  if (!targetUrl) return undefined;
  return [{
    id: 'open',
    text: normalizeText(options.openButtonText) || 'Buka',
    url: targetUrl
  }];
}

function logAdminNotification(options = {}, result = {}) {
  try {
    const title = normalizeText(options.title) || 'Notifikasi Admin';
    const body = normalizeText(options.message);
    if (!title) return;
    const baseUrl = normalizeText(options.baseUrl) || resolveAppBaseUrl();
    const targetUrl = resolveTargetUrl(options.targetUrl || '/admin', baseUrl) || '/admin';
    const data = options.data && typeof options.data === 'object' ? options.data : {};
    const kind = normalizeText(data.kind || options.kind || 'admin_push') || 'admin_push';
    db.prepare(`
      INSERT INTO admin_notifications (audience, kind, title, body, target_url, payload_json, delivery_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'admin',
      kind,
      title,
      body,
      targetUrl,
      JSON.stringify({
        ...data,
        pushResult: {
          success: Boolean(result?.success),
          skipped: Boolean(result?.skipped),
          reason: result?.reason || '',
          status: result?.status || null
        }
      }),
      result?.success ? 'sent' : (result?.skipped ? 'skipped' : 'failed')
    );
  } catch (error) {
    logger.warn(`[PushNotification] Gagal menyimpan log notifikasi admin: ${error.message || String(error)}`);
  }
}

async function sendPushToExternalIds(externalIds, options = {}) {
  const ids = uniqueExternalIds(externalIds);
  if (!ids.length) return { success: false, skipped: true, reason: 'no-external-ids' };

  const config = getPushSettings(options.settings);
  if (!config.enabled) return { success: false, skipped: true, reason: 'disabled' };
  if (!config.appId || !config.restApiKey) return { success: false, skipped: true, reason: 'not-configured' };

  const title = normalizeText(options.title) || 'Notifikasi Pelanggan';
  const message = normalizeText(options.message);
  if (!message) return { success: false, skipped: true, reason: 'empty-message' };

  const baseUrl = normalizeText(options.baseUrl) || resolveAppBaseUrl();
  const targetUrl = resolveTargetUrl(options.targetUrl || '/customer/dashboard', baseUrl);
  const imageUrl = normalizeText(options.imageUrl || options.image_url || '');
  const resolvedImageUrl = imageUrl ? resolveTargetUrl(imageUrl, baseUrl) : '';
  const iconUrl = resolveNotificationIcon(options.settings || {}, baseUrl);
  const ttlSeconds = Number(options.ttl || options.timeToLive || 259200);
  const priority = resolvePushPriority(options);
  const webButtons = buildWebButtons(targetUrl, options);
  const payload = {
    app_id: config.appId,
    target_channel: 'push',
    include_aliases: { external_id: ids },
    headings: { en: title },
    contents: { en: message },
    url: targetUrl,
    priority,
    chrome_web_icon: iconUrl,
    chrome_web_badge: iconUrl,
    data: {
      ...(options.data && typeof options.data === 'object' ? options.data : {}),
      targetUrl,
      priority,
      requireInteraction: options.requireInteraction !== false,
      ...(resolvedImageUrl ? { imageUrl: resolvedImageUrl, image_url: resolvedImageUrl } : {})
    },
    ttl: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 259200
  };

  if (webButtons) payload.web_buttons = webButtons;

  if (resolvedImageUrl) {
    payload.chrome_web_image = resolvedImageUrl;
    payload.big_picture = resolvedImageUrl;
    payload.ios_attachments = { image: resolvedImageUrl };
  }

  try {
    const response = await axios.post('https://api.onesignal.com/notifications', payload, {
      timeout: Number(options.timeoutMs || 15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Key ${config.restApiKey}`
      }
    });
    return {
      success: true,
      status: response.status,
      data: response.data || null,
      total: ids.length
    };
  } catch (error) {
    const status = error && error.response ? error.response.status : 0;
    const detail = error && error.response ? error.response.data : null;
    logger.warn(`[PushNotification] Gagal kirim push: ${error.message}`);
    if (detail) logger.warn(`[PushNotification] Detail: ${JSON.stringify(detail)}`);
    return {
      success: false,
      status,
      error: error.message || 'request-failed',
      detail,
      total: ids.length
    };
  }
}

async function sendPushToCustomer(customer, options = {}) {
  const externalId = buildCustomerPushExternalId(customer);
  if (!externalId) return { success: false, skipped: true, reason: 'invalid-customer' };
  return sendPushToExternalIds([externalId], options);
}

async function sendPushToCustomers(customers = [], options = {}) {
  const externalIds = uniqueExternalIds((Array.isArray(customers) ? customers : []).map(buildCustomerPushExternalId));
  return sendPushToExternalIds(externalIds, options);
}

async function sendPushToTechnician(technician, options = {}) {
  const externalId = buildTechnicianPushExternalId(technician);
  if (!externalId) return { success: false, skipped: true, reason: 'invalid-technician' };
  return sendPushToExternalIds([externalId], {
    targetUrl: '/tech',
    title: 'Notifikasi Teknisi',
    ...options
  });
}

async function sendPushToTechnicians(technicians = [], options = {}) {
  const externalIds = uniqueExternalIds((Array.isArray(technicians) ? technicians : []).map(buildTechnicianPushExternalId));
  return sendPushToExternalIds(externalIds, {
    targetUrl: '/tech',
    title: 'Notifikasi Teknisi',
    ...options
  });
}

async function sendPushToAdmins(admins = [], options = {}) {
  const externalIds = uniqueExternalIds((Array.isArray(admins) ? admins : []).map(buildAdminPushExternalId));
  const result = await sendPushToExternalIds(externalIds, {
    targetUrl: '/admin',
    title: 'Notifikasi Admin',
    ...options
  });
  logAdminNotification({ targetUrl: '/admin', title: 'Notifikasi Admin', ...options }, result);
  return result;
}

module.exports = {
  getPushSettings,
  isPushConfigured,
  buildCustomerPushExternalId,
  buildTechnicianPushExternalId,
  buildAdminPushExternalId,
  sendPushToExternalIds,
  sendPushToCustomer,
  sendPushToCustomers,
  sendPushToTechnician,
  sendPushToTechnicians,
  sendPushToAdmins
};
