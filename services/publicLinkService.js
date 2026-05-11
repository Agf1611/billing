const crypto = require('crypto');
const { getSetting } = require('../config/settingsManager');

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createSignedPublicToken(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(crypto.createHmac('sha256', String(secret || '')).update(body).digest());
  return `${body}.${sig}`;
}

function createInvoiceAccessSignature(invoiceId, customerId, exp, secret) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${Number(invoiceId || 0)}.${Number(customerId || 0)}.${Number(exp || 0)}`)
    .digest('hex');
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function isUsablePublicBaseUrl(raw) {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return !isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveAppBaseUrl() {
  const explicit = String(getSetting('public_base_url', '') || '').trim();
  if (isUsablePublicBaseUrl(explicit)) return explicit.replace(/\/+$/, '');

  const appUrl = String(getSetting('app_url', '') || '').trim();
  if (isUsablePublicBaseUrl(appUrl)) return appUrl.replace(/\/+$/, '');

  if (explicit) return normalizeBaseUrl(explicit) || explicit.replace(/\/+$/, '');
  if (appUrl) return normalizeBaseUrl(appUrl) || appUrl.replace(/\/+$/, '');

  const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
  const port = Number(getSetting('server_port', 3001) || 3001);
  const hasProto = /^https?:\/\//i.test(hostRaw);
  const proto = port === 443 ? 'https' : 'http';
  const host = hasProto ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
  const withPort = (port === 80 || port === 443) ? host : `${host}:${port}`;
  return withPort.replace(/\/+$/, '');
}

function resolveRequestBaseUrl(req, fallbackBaseUrl = '') {
  const explicitOrigin = normalizeBaseUrl(req?.headers?.origin || '');
  if (isUsablePublicBaseUrl(explicitOrigin)) return explicitOrigin;

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const directHost = req?.get ? String(req.get('host') || '').trim() : '';
  const host = forwardedHost || directHost;
  const proto = forwardedProto === 'https' ? 'https' : (req?.protocol === 'https' ? 'https' : 'http');
  if (host) {
    const candidate = `${proto}://${host}`.replace(/\/+$/, '');
    if (isUsablePublicBaseUrl(candidate)) return candidate;
  }

  return normalizeBaseUrl(fallbackBaseUrl) || resolveAppBaseUrl();
}

function resolveCustomerLookup(customer = {}) {
  return String(customer.pppoe_username || customer.genieacs_tag || customer.phone || customer.id || '').trim();
}

function buildCustomerCheckBillingLink(customer = {}, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl) || resolveAppBaseUrl();
  const lookup = encodeURIComponent(resolveCustomerLookup(customer));
  return `${baseUrl}/customer/check-billing?q=${lookup}`;
}

function buildCustomerPortalLoginLink(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl) || resolveAppBaseUrl();
  return `${baseUrl}/customer/login`;
}

function buildPublicInvoicePrintLink(invoice = {}, customer = {}, ttlMs = 48 * 60 * 60 * 1000, options = {}) {
  const secret = String(getSetting('session_secret', '') || '').trim();
  if (!secret) return '';
  const baseUrl = normalizeBaseUrl(options.baseUrl) || resolveAppBaseUrl();
  const invoiceId = Number(invoice.id || 0);
  const customerId = Number(customer.id || invoice.customer_id || 0);
  if (!invoiceId || !customerId) return '';
  const exp = Date.now() + ttlMs;
  const sig = createInvoiceAccessSignature(invoiceId, customerId, exp, secret).slice(0, 12);
  const code = `${invoiceId.toString(36)}-${exp.toString(36)}-${sig}`;
  return `${baseUrl}/customer/i/${code}`;
}

function buildPublicInvoiceReceiptLink(invoice = {}, customer = {}, ttlMs = 48 * 60 * 60 * 1000, options = {}) {
  const printLink = buildPublicInvoicePrintLink(invoice, customer, ttlMs, options);
  if (!printLink) return '';
  return `${printLink}?style=receipt`;
}

function parsePublicInvoiceCode(code, secret, expectedCustomerId = 0) {
  const raw = String(code || '').trim();
  const [invoicePart, expPart, sigPart] = raw.split('-');
  if (!invoicePart || !expPart || !sigPart) return null;
  const invoiceId = parseInt(invoicePart, 36);
  const exp = parseInt(expPart, 36);
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) return null;
  if (!Number.isFinite(exp) || exp <= 0 || Date.now() > exp) return null;
  const customerId = Number(expectedCustomerId || 0);
  if (!customerId) return { invoiceId, exp, sig: String(sigPart) };
  const expected = createInvoiceAccessSignature(invoiceId, customerId, exp, secret).slice(0, 12);
  if (expected.length !== String(sigPart).length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sigPart)))) return null;
  return { invoiceId, exp, sig: String(sigPart), customerId };
}

function defaultBillingWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Kami ingin mengingatkan bahwa masih ada tagihan layanan internet Anda.',
    '',
    'Paket: {{paket}}',
    'Total tagihan: Rp {{tagihan}}',
    'Periode: {{rincian}}',
    'Cek tagihan: {{link}}',
    'Lihat invoice: {{invoice_link}}',
    '',
    'Jika pembayaran sudah dilakukan, Anda dapat mengabaikan pesan ini atau konfirmasi ke admin kami.',
    '',
    `Terima kasih,`,
    companyName
  ].join('\n');
}

function defaultDueReminderWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Kami ingin mengingatkan bahwa tagihan internet Anda akan segera jatuh tempo.',
    '',
    'Paket: {{paket}}',
    'Total tagihan: Rp {{tagihan}}',
    'Periode: {{rincian}}',
    'Cek tagihan: {{link}}',
    'Lihat invoice: {{invoice_link}}',
    '',
    'Silakan lakukan pembayaran sebelum layanan terisolir. Jika sudah membayar, Anda dapat mengabaikan pesan ini.',
    '',
    `Terima kasih,`,
    companyName
  ].join('\n');
}

function defaultIsolationWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Layanan internet Anda saat ini kami nonaktifkan sementara karena masih ada tagihan yang belum lunas.',
    '',
    'Paket: {{paket}}',
    'Tagihan belum lunas: Rp {{tagihan}}',
    'Periode: {{rincian}}',
    'Alasan: {{alasan}}',
    'Cek tagihan: {{link}}',
    'Lihat invoice: {{invoice_link}}',
    '',
    'Setelah pembayaran masuk, layanan akan kami bantu aktifkan kembali. Jika butuh bantuan, silakan hubungi admin kami.',
    '',
    `Terima kasih atas pengertiannya,`,
    companyName
  ].join('\n');
}

function defaultWelcomeWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Selamat datang di layanan internet {{company}}.',
    '',
    'Login portal: {{portal_link}}',
    'ID login: {{login_id}}',
    'Cek tagihan: {{link}}',
    '{{group_line}}',
    '',
    'Kami senang bisa melayani Anda. Jika ada pertanyaan atau butuh bantuan, silakan hubungi admin kami.',
    '',
    `Salam hangat,`,
    companyName
  ].join('\n');
}

function defaultReactivationWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Kabar baik, layanan internet Anda sudah aktif kembali.',
    '',
    'Paket: {{paket}}',
    'Login portal: {{portal_link}}',
    'Cek layanan: {{link}}',
    '{{group_line}}',
    '',
    'Terima kasih sudah menyelesaikan administrasi tagihan. Semoga layanan kami selalu nyaman digunakan.',
    '',
    `Salam,`,
    companyName
  ].join('\n');
}

function defaultPaidWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Pembayaran tagihan internet Anda sudah kami terima.',
    '',
    'Paket: {{paket}}',
    'Invoice: {{invoice_no}}',
    'Periode: {{rincian}}',
    'Total dibayar: Rp {{tagihan}}',
    'Metode bayar: {{paid_by}}',
    'Waktu bayar: {{paid_at}}',
    'Nota pembayaran: {{receipt_link}}',
    'Invoice lengkap: {{invoice_link}}',
    '',
    'Terima kasih. Layanan Anda akan kami jaga tetap nyaman digunakan.',
    '',
    `Salam,`,
    companyName
  ].join('\n');
}

function defaultIsolationPortalNotice() {
  return 'Layanan internet Anda sedang dinonaktifkan sementara karena masih ada tagihan yang belum lunas. Silakan cek tagihan atau hubungi admin bila membutuhkan bantuan.';
}

function fillWhatsappTemplate(template, replacements = {}) {
  let output = String(template || '').trim();
  Object.entries(replacements).forEach(([key, value]) => {
    const safeValue = String(value == null ? '' : value);
    output = output.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'gi'), safeValue);
  });
  return output;
}

module.exports = {
  createSignedPublicToken,
  parsePublicInvoiceCode,
  normalizeBaseUrl,
  isUsablePublicBaseUrl,
  resolveAppBaseUrl,
  resolveRequestBaseUrl,
  resolveCustomerLookup,
  buildCustomerPortalLoginLink,
  buildCustomerCheckBillingLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  defaultWelcomeWhatsappTemplate,
  defaultReactivationWhatsappTemplate,
  defaultPaidWhatsappTemplate,
  defaultIsolationPortalNotice,
  fillWhatsappTemplate
};
