const axios = require('axios');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const { normalizePhoneDigits } = require('./phoneService');

function getProvider() {
  const provider = String(getSetting('whatsapp_provider', 'local') || 'local').trim().toLowerCase();
  return provider === 'mpwa' ? 'mpwa' : 'local';
}

function normalizePath(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function joinUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const path = normalizePath(endpointPath, '/api/send-message');
  if (!base) throw new Error('Base URL MPWA belum diisi.');
  return `${base}${path}`;
}

function getMpwaConfig() {
  return {
    baseUrl: String(getSetting('whatsapp_mpwa_base_url', '') || '').trim(),
    apiKey: String(getSetting('whatsapp_mpwa_api_key', '') || '').trim(),
    sendPath: normalizePath(getSetting('whatsapp_mpwa_send_path', '/api/send-message'), '/api/send-message'),
    imagePath: normalizePath(getSetting('whatsapp_mpwa_image_path', ''), ''),
    authMode: String(getSetting('whatsapp_mpwa_auth_mode', 'bearer') || 'bearer').trim().toLowerCase(),
    numberField: String(getSetting('whatsapp_mpwa_number_field', 'number') || 'number').trim() || 'number',
    messageField: String(getSetting('whatsapp_mpwa_message_field', 'message') || 'message').trim() || 'message',
    device: String(getSetting('whatsapp_mpwa_device', '') || '').trim(),
    timeoutMs: Math.max(3000, Number(getSetting('whatsapp_mpwa_timeout_ms', 15000)) || 15000)
  };
}

function appendQueryApiKey(url, apiKey) {
  if (!apiKey) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('api_key', apiKey);
  return parsed.toString();
}

function buildMpwaRequest(url, payload, config) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  let finalUrl = url;
  const body = { ...payload };
  if (config.device) {
    body.sender = config.device;
    body.device = config.device;
    body.session = config.device;
  }
  if (config.apiKey) {
    if (config.authMode === 'x-api-key') {
      headers['x-api-key'] = config.apiKey;
    } else if (config.authMode === 'body') {
      body.api_key = config.apiKey;
      body.apikey = config.apiKey;
    } else if (config.authMode === 'query') {
      finalUrl = appendQueryApiKey(url, config.apiKey);
    } else if (config.authMode !== 'none') {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }
  return { url: finalUrl, body, headers };
}

function isMpwaSuccess(responseData) {
  if (!responseData || typeof responseData !== 'object') return true;
  const status = responseData.status;
  const success = responseData.success;
  if (success === false || status === false) return false;
  const normalized = String(status || success || '').trim().toLowerCase();
  return !['false', 'failed', 'fail', 'error', 'unauthorized'].includes(normalized);
}

async function postMpwa(endpointPath, payload) {
  const config = getMpwaConfig();
  const endpoint = joinUrl(config.baseUrl, endpointPath);
  const request = buildMpwaRequest(endpoint, payload, config);
  const response = await axios.post(request.url, request.body, {
    headers: request.headers,
    timeout: config.timeoutMs,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300 || !isMpwaSuccess(response.data)) {
    const detail = response.data && typeof response.data === 'object'
      ? JSON.stringify(response.data).slice(0, 300)
      : String(response.data || '').slice(0, 300);
    throw new Error(`MPWA gagal (${response.status}): ${detail || 'response tidak valid'}`);
  }
  return response.data;
}

async function getLocalModule() {
  return import('./whatsappBot.mjs');
}

async function ensureReady(maxWaitMs = 15000) {
  if (!getSetting('whatsapp_enabled', false)) return false;
  if (getProvider() === 'mpwa') {
    const config = getMpwaConfig();
    return Boolean(config.baseUrl);
  }
  const mod = await getLocalModule();
  return typeof mod.ensureWhatsAppReady === 'function'
    ? Boolean(await mod.ensureWhatsAppReady(maxWaitMs))
    : true;
}

async function getStatus() {
  if (!getSetting('whatsapp_enabled', false)) {
    return { provider: getProvider(), connection: 'disabled', enabled: false };
  }
  if (getProvider() === 'mpwa') {
    const config = getMpwaConfig();
    return {
      provider: 'mpwa',
      enabled: true,
      connection: config.baseUrl ? 'open' : 'not_configured',
      reason: config.baseUrl ? 'mpwa_gateway_configured' : 'mpwa_base_url_empty',
      user: config.device ? { id: config.device, name: 'MPWA' } : { name: 'MPWA Gateway' },
      lastUpdate: new Date()
    };
  }
  const mod = await getLocalModule();
  return {
    provider: 'local',
    enabled: true,
    ...(mod.whatsappStatus || { connection: 'unknown' })
  };
}

async function sendText(to, text) {
  if (!getSetting('whatsapp_enabled', false)) return false;
  const message = String(text || '').trim();
  const digits = normalizePhoneDigits(to);
  if (!digits || !message) return false;

  if (getProvider() === 'mpwa') {
    const config = getMpwaConfig();
    const payload = {
      [config.numberField]: digits,
      [config.messageField]: message
    };
    if (config.numberField !== 'phone') payload.phone = digits;
    if (config.numberField !== 'to') payload.to = digits;
    if (config.messageField !== 'text') payload.text = message;
    await postMpwa(config.sendPath, payload);
    return true;
  }

  const mod = await getLocalModule();
  return Boolean(await mod.sendWA(digits, message));
}

async function sendImage(to, imageBuffer, caption = '', options = {}) {
  if (!getSetting('whatsapp_enabled', false)) return false;
  const digits = normalizePhoneDigits(to);
  const buffer = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || []);
  const captionText = String(caption || '').trim();
  const mediaUrl = String(options.mediaUrl || options.url || '').trim();
  if (!digits) return false;
  if (!buffer.length) return sendText(digits, captionText);

  if (getProvider() === 'mpwa') {
    const config = getMpwaConfig();
    if (!config.imagePath) {
      logger.warn('[MPWA] Endpoint gambar belum diisi, mengirim caption sebagai teks.');
      return sendText(digits, captionText || 'Lampiran gambar tersedia.');
    }
    if (mediaUrl) {
      const payload = {
        [config.numberField]: digits,
        [config.messageField]: captionText,
        phone: digits,
        to: digits,
        media_type: 'image',
        caption: captionText,
        url: mediaUrl
      };
      await postMpwa(config.imagePath, payload);
      return true;
    }
    logger.warn('[MPWA] URL gambar publik belum tersedia, mengirim caption sebagai teks.');
    return sendText(digits, captionText || 'Lampiran gambar tersedia.');
  }

  const mod = await getLocalModule();
  return Boolean(await mod.sendWAImage(digits, buffer, captionText));
}

async function restartLocalBot() {
  if (getProvider() !== 'local') return false;
  const mod = await getLocalModule();
  if (typeof mod.restartWhatsAppBot === 'function') {
    await mod.restartWhatsAppBot();
    return true;
  }
  return false;
}

module.exports = {
  getProvider,
  getStatus,
  ensureReady,
  sendText,
  sendImage,
  restartLocalBot
};
