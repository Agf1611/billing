const crypto = require('crypto');

const HASH_PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

function normalizePassword(value) {
  return String(value || '');
}

function normalizeMinLength(optionsOrMinLength, fallback = 8) {
  if (typeof optionsOrMinLength === 'number' && Number.isFinite(optionsOrMinLength)) {
    return Math.max(1, Math.floor(optionsOrMinLength));
  }
  if (optionsOrMinLength && typeof optionsOrMinLength === 'object') {
    const candidate = Number(optionsOrMinLength.minLength);
    if (Number.isFinite(candidate)) {
      return Math.max(1, Math.floor(candidate));
    }
  }
  return fallback;
}

function isPasswordHash(value) {
  return String(value || '').startsWith(`${HASH_PREFIX}$`);
}

function hashPassword(password) {
  const plain = normalizePassword(password);
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = crypto.scryptSync(plain, salt, KEY_LENGTH).toString('hex');
  return `${HASH_PREFIX}$${salt}$${derived}`;
}

function verifyPassword(password, storedValue) {
  const plain = normalizePassword(password);
  const stored = String(storedValue || '');
  if (!stored) return false;

  if (!isPasswordHash(stored)) {
    return stored === plain;
  }

  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(plain, salt, expected.length);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function validateNewPassword(password, label = 'Password', optionsOrMinLength = 8) {
  const plain = normalizePassword(password);
  const minLength = normalizeMinLength(optionsOrMinLength, 8);
  if (plain.length < minLength) {
    throw new Error(`${label} minimal ${minLength} karakter.`);
  }
  return plain;
}

module.exports = {
  hashPassword,
  isPasswordHash,
  normalizePassword,
  validateNewPassword,
  verifyPassword,
};
