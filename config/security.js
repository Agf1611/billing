const DEFAULT_STRINGS = new Set([
  '',
  'change-this-to-random-secret-key',
  'rahasia-portal-pelanggan-default-ganti-ini',
  'admin123',
  'admin-api-key-change-this',
  'xendit-callback-token-change-this',
]);

function normalize(value) {
  return String(value || '').trim();
}

function isDefaultLike(value) {
  const normalized = normalize(value);
  if (!normalized) return true;
  return DEFAULT_STRINGS.has(normalized);
}

function isStrongSessionSecret(value) {
  const normalized = normalize(value);
  return !isDefaultLike(normalized) && normalized.length >= 32;
}

function isStrongAdminPassword(value) {
  const normalized = normalize(value);
  return !isDefaultLike(normalized) && normalized.length >= 12;
}

function isStrongAdminApiKey(value) {
  const normalized = normalize(value);
  if (!normalized) return false;
  return !isDefaultLike(normalized) && normalized.length >= 24;
}

function isStrongXenditCallbackToken(value) {
  const normalized = normalize(value);
  if (!normalized) return false;
  return !isDefaultLike(normalized) && normalized.length >= 16;
}

function getCriticalSecurityIssues(settings = {}) {
  const issues = [];

  if (!normalize(settings.admin_username)) {
    issues.push('admin_username wajib diisi');
  }
  if (!isStrongAdminPassword(settings.admin_password)) {
    issues.push('admin_password masih default atau terlalu lemah');
  }
  if (!isStrongSessionSecret(settings.session_secret)) {
    issues.push('session_secret masih default atau terlalu pendek');
  }

  return issues;
}

function assertCriticalSecuritySettings(settings = {}) {
  const issues = getCriticalSecurityIssues(settings);
  if (issues.length > 0) {
    throw new Error(`Konfigurasi keamanan belum aman: ${issues.join('; ')}`);
  }
}

module.exports = {
  normalize,
  isStrongAdminApiKey,
  isStrongAdminPassword,
  isStrongSessionSecret,
  isStrongXenditCallbackToken,
  assertCriticalSecuritySettings,
  getCriticalSecurityIssues,
};
