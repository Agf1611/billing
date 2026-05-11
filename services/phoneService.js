function normalizePhoneDigits(input, defaultCountryCode = '62') {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith(defaultCountryCode)) {
    return digits;
  }

  if (digits.startsWith('0')) {
    return defaultCountryCode + digits.slice(1);
  }

  if (digits.startsWith('8')) {
    return defaultCountryCode + digits;
  }

  return defaultCountryCode + digits;
}

function formatPhoneDisplay(input, defaultCountryCode = '62') {
  const normalized = normalizePhoneDigits(input, defaultCountryCode);
  return normalized ? `+${normalized}` : '';
}

function normalizePhoneList(input) {
  const items = Array.isArray(input) ? input : String(input || '').split(',');
  return items
    .map((value) => normalizePhoneDigits(value))
    .filter(Boolean);
}

module.exports = {
  normalizePhoneDigits,
  formatPhoneDisplay,
  normalizePhoneList
};
