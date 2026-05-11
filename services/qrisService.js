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

module.exports = {
  normalizeQrisPayload,
  buildDynamicQrisPayload
};
