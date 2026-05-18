const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const jsQR = require('jsqr');
const QRCode = require('qrcode');

function normalizeQrisPayload(payload) {
  return String(payload || '').replace(/[\r\n\t]+/g, '').trim();
}

function parseTlv(payload) {
  const text = normalizeQrisPayload(payload);
  const items = [];
  let index = 0;
  while (index + 4 <= text.length) {
    const tag = text.slice(index, index + 2);
    const lenRaw = text.slice(index + 2, index + 4);
    const length = Number.parseInt(lenRaw, 10);
    if (!Number.isFinite(length) || length < 0) throw new Error('Payload QRIS tidak valid');
    const start = index + 4;
    const end = start + length;
    if (end > text.length) throw new Error('Payload QRIS terpotong');
    items.push({ tag, value: text.slice(start, end) });
    index = end;
  }
  return items;
}

function buildTlv(items) {
  return items.map(({ tag, value }) => {
    const safeValue = String(value || '');
    return `${tag}${String(safeValue.length).padStart(2, '0')}${safeValue}`;
  }).join('');
}

function crc16Ccitt(text) {
  let crc = 0xFFFF;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatAmountForQris(amount) {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Nominal QRIS tidak valid');
  return value % 1 === 0 ? String(Math.trunc(value)) : value.toFixed(2);
}

function buildDynamicQrisPayload(basePayload, amount) {
  try {
    const normalized = normalizeQrisPayload(basePayload);
    if (!normalized) return '';
    const items = parseTlv(normalized).filter((item) => item.tag !== '63');
    const amountValue = formatAmountForQris(amount);

    let hasPointOfInitiation = false;
    let hasAmount = false;
    const updated = items.map((item) => {
      if (item.tag === '01') {
        hasPointOfInitiation = true;
        return { tag: '01', value: '12' };
      }
      if (item.tag === '54') {
        hasAmount = true;
        return { tag: '54', value: amountValue };
      }
      return item;
    });

    if (!hasPointOfInitiation) {
      const payloadFormatIndex = updated.findIndex((item) => item.tag === '00');
      if (payloadFormatIndex >= 0) updated.splice(payloadFormatIndex + 1, 0, { tag: '01', value: '12' });
      else updated.unshift({ tag: '01', value: '12' });
    }

    if (!hasAmount) {
      const countryIndex = updated.findIndex((item) => item.tag === '58');
      if (countryIndex >= 0) updated.splice(countryIndex, 0, { tag: '54', value: amountValue });
      else updated.push({ tag: '54', value: amountValue });
    }

    const payloadWithoutCrc = `${buildTlv(updated)}6304`;
    const crc = crc16Ccitt(payloadWithoutCrc);
    return `${payloadWithoutCrc}${crc}`;
  } catch {
    return '';
  }
}

function looksLikeQrisPayload(payload) {
  const normalized = normalizeQrisPayload(payload);
  if (!normalized || normalized.length < 32) return false;
  if (normalized.startsWith('000201')) return true;
  if (!/^(\d{2}\d{2}.+)+$/s.test(normalized)) return false;
  try {
    const items = parseTlv(normalized);
    return Array.isArray(items) && items.some((item) => item.tag === '00');
  } catch {
    return false;
  }
}

async function decodeQrisPayloadFromBuffer(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length) return '';

  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
    inversionAttempts: 'attemptBoth'
  });

  const payload = normalizeQrisPayload(result?.data || '');
  return looksLikeQrisPayload(payload) ? payload : '';
}

async function buildDynamicQrisBuffer(payload, options = {}) {
  const normalized = normalizeQrisPayload(payload);
  if (!normalized) return Buffer.alloc(0);
  try {
    return await QRCode.toBuffer(normalized, {
      type: 'png',
      width: Math.max(240, Number(options.width || 720) || 720),
      margin: Math.max(0, Number(options.margin ?? 1) || 0),
      color: {
        dark: String(options.dark || '#0f172a'),
        light: String(options.light || '#ffffff')
      }
    });
  } catch {
    return Buffer.alloc(0);
  }
}

async function buildDynamicQrisDataUrl(payload, options = {}) {
  const normalized = normalizeQrisPayload(payload);
  if (!normalized) return '';
  try {
    return await QRCode.toDataURL(normalized, {
      width: Math.max(240, Number(options.width || 720) || 720),
      margin: Math.max(0, Number(options.margin ?? 1) || 0),
      color: {
        dark: String(options.dark || '#0f172a'),
        light: String(options.light || '#ffffff')
      }
    });
  } catch {
    return '';
  }
}

function resolveLocalPublicAsset(publicUrl) {
  const normalized = String(publicUrl || '').trim();
  if (!normalized.startsWith('/uploads/')) return '';
  return path.join(__dirname, '..', 'public', normalized.replace(/^\//, '').replace(/\//g, path.sep));
}

async function loadQrisImageBufferFromUrl(url) {
  const target = String(url || '').trim();
  if (!target) return { buffer: Buffer.alloc(0), kind: 'empty' };

  if (/^https?:\/\//i.test(target)) {
    const res = await axios.get(target, {
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 400
    });
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error('URL QRIS bukan file gambar langsung. Tempel payload merchant atau upload gambar QR.');
    }
    return { buffer: Buffer.from(res.data), kind: 'remote' };
  }

  const localFile = resolveLocalPublicAsset(target);
  if (!localFile || !fs.existsSync(localFile)) {
    throw new Error('File QRIS tidak ditemukan.');
  }
  return { buffer: fs.readFileSync(localFile), kind: 'local' };
}

async function decodeQrisPayloadFromUrl(url) {
  const { buffer } = await loadQrisImageBufferFromUrl(url);
  return decodeQrisPayloadFromBuffer(buffer);
}

module.exports = {
  normalizeQrisPayload,
  buildDynamicQrisPayload,
  buildDynamicQrisBuffer,
  buildDynamicQrisDataUrl,
  looksLikeQrisPayload,
  decodeQrisPayloadFromBuffer,
  decodeQrisPayloadFromUrl
};
