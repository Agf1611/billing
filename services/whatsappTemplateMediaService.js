const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const whatsappGateway = require('./whatsappGatewayService');
const { resolveAppBaseUrl } = require('./publicLinkService');

const TEMPLATE_IMAGE_SETTINGS = Object.freeze({
  welcome: 'whatsapp_welcome_image_url',
  due_reminder: 'whatsapp_due_reminder_image_url',
  billing: 'whatsapp_billing_image_url',
  isolation: 'whatsapp_isolation_image_url',
  reactivation: 'whatsapp_reactivation_image_url',
  paid: 'whatsapp_paid_image_url'
});

function normalizeTemplateKey(templateKey = '') {
  const key = String(templateKey || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TEMPLATE_IMAGE_SETTINGS, key) ? key : '';
}

function getTemplateImageUrl(templateKey = '') {
  const key = normalizeTemplateKey(templateKey);
  if (!key) return '';
  return String(getSetting(TEMPLATE_IMAGE_SETTINGS[key], '') || '').trim();
}

function buildAbsoluteImageUrl(imageUrl = '', baseUrl = '') {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(baseUrl || resolveAppBaseUrl() || '').trim().replace(/\/+$/, '');
  return base ? `${base}/${value.replace(/^\/+/, '')}` : '';
}

function resolveLocalPublicFile(imageUrl = '') {
  const cleanUrl = String(imageUrl || '').trim().split('?')[0];
  if (!cleanUrl.startsWith('/uploads/')) return '';
  const publicRoot = path.resolve(__dirname, '..', 'public');
  const filePath = path.resolve(publicRoot, cleanUrl.replace(/^\/+/, '').replace(/\//g, path.sep));
  if (!filePath.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(filePath)) return '';
  return filePath;
}

async function loadImageBuffer(imageUrl = '') {
  const localFile = resolveLocalPublicFile(imageUrl);
  if (localFile) return fs.readFileSync(localFile);
  if (!/^https?:\/\//i.test(String(imageUrl || '').trim())) return Buffer.alloc(0);
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 12000,
    maxContentLength: 3 * 1024 * 1024
  });
  return Buffer.from(response.data || []);
}

async function sendTemplateMessage(phone, message, templateKey = '', options = {}) {
  const caption = String(message || '').trim();
  if (!phone || !caption) return false;

  const imageUrl = String(options.imageUrl || getTemplateImageUrl(templateKey) || '').trim();
  const fallbackImageBuffer = Buffer.isBuffer(options.fallbackImageBuffer)
    ? options.fallbackImageBuffer
    : Buffer.alloc(0);
  let imageBuffer = fallbackImageBuffer;
  let mediaUrl = '';
  if (imageUrl) {
    try {
      const customImageBuffer = await loadImageBuffer(imageUrl);
      if (customImageBuffer.length) {
        imageBuffer = customImageBuffer;
        mediaUrl = buildAbsoluteImageUrl(imageUrl, options.baseUrl);
      }
    } catch (error) {
      logger.warn(`[WhatsAppTemplateMedia] Gambar ${normalizeTemplateKey(templateKey) || 'custom'} tidak bisa dibaca: ${error.message || error}. Mencoba fallback.`);
    }
  }

  if (imageBuffer.length) {
    try {
      const sent = await whatsappGateway.sendImage(phone, imageBuffer, caption, { mediaUrl });
      if (sent) return true;
    } catch (error) {
      logger.warn(`[WhatsAppTemplateMedia] Gagal kirim gambar ${normalizeTemplateKey(templateKey) || 'custom'}: ${error.message || error}. Mencoba teks.`);
    }
  }

  return Boolean(await whatsappGateway.sendText(phone, caption));
}

module.exports = {
  TEMPLATE_IMAGE_SETTINGS,
  normalizeTemplateKey,
  getTemplateImageUrl,
  buildAbsoluteImageUrl,
  resolveLocalPublicFile,
  sendTemplateMessage
};
