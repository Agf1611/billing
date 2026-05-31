const { normalize, isStrongAdminPassword, isStrongSessionSecret } = require('./security');
const { isUsablePublicBaseUrl } = require('../services/publicLinkService');

function toBoolean(value, defaultValue = false) {
  if (value === true || value === 'true' || value === 1 || value === '1' || value === 'on') return true;
  if (value === false || value === 'false' || value === 0 || value === '0' || value === 'off') return false;
  return Boolean(defaultValue);
}

function isSelfUpdateEnabled(settings = {}, env = process.env) {
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'admin_self_update_enabled')) {
    return toBoolean(settings.admin_self_update_enabled, false);
  }
  return String(env?.NODE_ENV || '').trim().toLowerCase() !== 'production';
}

function resolveSafeBackRedirect(req, fallback = '/') {
  const target = String(req?.get?.('Referrer') || req?.get?.('Referer') || '').trim();
  const defaultTarget = String(fallback || '/').trim() || '/';
  if (!target) return defaultTarget;

  try {
    const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '')
      .split(',')[0]
      .trim();
    const reqHost = forwardedHost || String(req?.get?.('host') || '').trim();
    const reqProto = forwardedProto === 'https' ? 'https' : (req?.protocol === 'https' ? 'https' : 'http');
    const origin = reqHost ? `${reqProto}://${reqHost}` : '';
    if (!origin) return defaultTarget;
    const parsed = new URL(target, origin);
    if (parsed.origin !== origin) return defaultTarget;
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultTarget;
  } catch {
    return defaultTarget;
  }
}

function installSafeRedirectMiddleware(app) {
  app.use((req, res, next) => {
    const originalRedirect = res.redirect.bind(res);

    res.safeRedirect = (target, fallback = '/') => {
      const nextTarget = String(target || '').trim();
      if (!nextTarget || nextTarget === 'back') {
        return originalRedirect(resolveSafeBackRedirect(req, fallback));
      }
      return originalRedirect(nextTarget);
    };

    res.redirect = function patchedRedirect(statusOrUrl, maybeUrl) {
      if (typeof statusOrUrl === 'string') {
        if (statusOrUrl === 'back') return originalRedirect(resolveSafeBackRedirect(req, '/'));
        return originalRedirect(statusOrUrl);
      }
      if (typeof maybeUrl === 'string' && maybeUrl === 'back') {
        return originalRedirect(statusOrUrl, resolveSafeBackRedirect(req, '/'));
      }
      return originalRedirect(statusOrUrl, maybeUrl);
    };

    next();
  });
}

function getRuntimeConfigurationWarnings(settings = {}, env = process.env) {
  const warnings = [];
  const isProduction = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  const publicBaseUrl = String(settings?.public_base_url || '').trim();
  const appUrl = String(settings?.app_url || '').trim();
  const paymentNotifSecret = String(settings?.payment_notif_secret || env?.MY_WEBHOOK_SECRET || '').trim();
  const sessionSecret = normalize(settings?.session_secret || '');
  const adminPassword = normalize(settings?.admin_password || '');

  if (isProduction && !isUsablePublicBaseUrl(publicBaseUrl) && !isUsablePublicBaseUrl(appUrl)) {
    warnings.push({
      code: 'public-base-url',
      level: 'warning',
      text: 'Mode produksi aktif, tetapi public_base_url / app_url publik belum valid. Link pelanggan dan WhatsApp berisiko jatuh ke host lokal.'
    });
  }

  if (!isStrongSessionSecret(sessionSecret)) {
    warnings.push({
      code: 'session-secret',
      level: isProduction ? 'warning' : 'info',
      text: 'session_secret belum kuat atau masih default. Sesi login dan link bertanda tangan perlu diamankan.'
    });
  }

  if (!isStrongAdminPassword(adminPassword)) {
    warnings.push({
      code: 'admin-password',
      level: isProduction ? 'warning' : 'info',
      text: 'Password admin masih default/placeholder atau terlalu pendek. Ganti dari menu Pengaturan Admin.'
    });
  }

  if (!paymentNotifSecret || paymentNotifSecret.length < 8) {
    warnings.push({
      code: 'payment-notif-secret',
      level: 'warning',
      text: 'payment_notif_secret / MY_WEBHOOK_SECRET belum valid. Auto-verifikasi QRIS dan payment notif tidak akan bekerja.'
    });
  }

  return warnings;
}

module.exports = {
  isSelfUpdateEnabled,
  resolveSafeBackRedirect,
  installSafeRedirectMiddleware,
  getRuntimeConfigurationWarnings
};
