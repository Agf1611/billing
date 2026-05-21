const axios = require('axios');
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
  const payload = {
    app_id: config.appId,
    target_channel: 'push',
    include_aliases: { external_id: ids },
    headings: { en: title },
    contents: { en: message },
    data: {
      ...(options.data && typeof options.data === 'object' ? options.data : {}),
      targetUrl
    },
    ttl: Number(options.ttl || 86400)
  };

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
  return sendPushToExternalIds(externalIds, {
    targetUrl: '/admin',
    title: 'Notifikasi Admin',
    ...options
  });
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
