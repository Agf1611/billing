const crypto = require('crypto');
const { getSetting } = require('../config/settingsManager');
const billingSvc = require('./billingService');

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

function createShortInvoiceSignature(invoiceId, customerId, secret) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`invoice-check.${Number(invoiceId || 0)}.${Number(customerId || 0)}`)
    .digest('hex')
    .slice(0, 8);
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
  return String(
    customer.customer_code ||
    customer.pppoe_username ||
    customer.genieacs_tag ||
    customer.phone ||
    customer.id ||
    customer.customer_id ||
    ''
  ).trim();
}

function buildCustomerCheckBillingLink(customer = {}, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl) || resolveAppBaseUrl();
  const lookup = encodeURIComponent(resolveCustomerLookup(customer));
  return `${baseUrl}/customer/check-billing?q=${lookup}`;
}

function buildShortInvoiceCheckCode(invoice = {}, customer = {}, options = {}) {
  const secret = String(options.secret || getSetting('session_secret', '') || '').trim();
  const invoiceId = Number(invoice.id || 0);
  const customerId = Number(customer.id || invoice.customer_id || 0);
  if (!invoiceId || !customerId) return '';
  const sig = createShortInvoiceSignature(invoiceId, customerId, secret);
  return `${invoiceId}${sig}`;
}

function parseShortInvoiceCheckCode(code, secret, expectedCustomerId = 0) {
  const raw = String(code || '').trim().replace(/^inv/i, '');
  if (!/^\d+[a-f0-9]{8}$/i.test(raw)) return null;
  const invoiceId = Number(raw.slice(0, -8));
  const sig = raw.slice(-8).toLowerCase();
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) return null;
  let customerId = Number(expectedCustomerId || 0);
  if (!customerId) {
    const invoice = billingSvc.getInvoiceById(invoiceId);
    customerId = Number(invoice?.customer_id || 0);
  }
  if (!customerId) return null;
  const expected = createShortInvoiceSignature(invoiceId, customerId, secret).toLowerCase();
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  return { invoiceId, customerId, sig };
}

function buildCustomerInvoiceCheckBillingLink(invoice = {}, customer = {}, ttlMs = 7 * 24 * 60 * 60 * 1000, options = {}) {
  const secret = String(getSetting('session_secret', '') || '').trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl) || resolveAppBaseUrl();
  const invoiceId = Number(invoice.id || 0);
  const customerId = Number(customer.id || invoice.customer_id || 0);
  if (!invoiceId || !customerId) return buildCustomerCheckBillingLink(customer, options);
  const shortCode = buildShortInvoiceCheckCode(invoice, customer, { secret });
  if (shortCode) return `${baseUrl}/customer/inv${shortCode}`;
  const lookup = resolveCustomerLookup(customer);
  const token = createSignedPublicToken({
    invoiceId,
    customerId,
    lookup,
    exp: Date.now() + ttlMs
  }, secret);
  const qs = new URLSearchParams({ t: token });
  return `${baseUrl}/customer/check-billing?${qs.toString()}`;
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
  const shortCode = buildShortInvoiceCheckCode(invoice, customer, { secret });
  if (shortCode) return `${baseUrl}/customer/inv${shortCode}/print`;
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

function formatInvoiceDueDate(invoice = {}, customer = {}, locale = 'id-ID') {
  const dueAt = billingSvc.getInvoiceDueDate(invoice, customer?.isolate_day);
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) return '-';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(dueAt);
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
    'Tagihan internet Anda sudah tersedia.',
    'Paket: {{paket}}',
    'Periode: {{rincian}}',
    'Jatuh tempo: {{jatuh_tempo}}',
    'Total: Rp {{tagihan}}',
    '{{payment_guide}}',
    '',
    'Invoice: {{invoice_link}}',
    'Bayar Online: {{link}}',
    '',
    `Terima kasih, ${companyName}`
  ].join('\n');
}

function defaultDueReminderWhatsappTemplate(companyName = getSetting('company_header', 'ISP')) {
  return [
    'Halo {{nama}},',
    '',
    'Pengingat jatuh tempo tagihan internet.',
    'Paket: {{paket}}',
    'Periode: {{rincian}}',
    'Jatuh tempo: {{jatuh_tempo}}',
    'Total: Rp {{tagihan}}',
    '{{payment_guide}}',
    '',
    'Invoice: {{invoice_link}}',
    'Cek tagihan: {{link}}',
    '',
    `Terima kasih, ${companyName}`
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
    'Jatuh tempo: {{jatuh_tempo}}',
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
    'Jatuh tempo tagihan: {{jatuh_tempo}}',
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

function ensureDueDateLine(message, dueDateText) {
  const text = String(message || '').trim();
  const dueDate = String(dueDateText || '').trim();
  if (!text || !dueDate || dueDate === '-') return text;
  if (/jatuh tempo/i.test(text)) return text;

  const dueLine = `Jatuh tempo: ${dueDate}`;
  if (/^Periode:.*$/im.test(text)) {
    return text.replace(/^Periode:.*$/im, (line) => `${line}\n${dueLine}`);
  }
  return `${text}\n${dueLine}`;
}

module.exports = {
  createSignedPublicToken,
  parsePublicInvoiceCode,
  buildShortInvoiceCheckCode,
  parseShortInvoiceCheckCode,
  normalizeBaseUrl,
  isUsablePublicBaseUrl,
  resolveAppBaseUrl,
  resolveRequestBaseUrl,
  resolveCustomerLookup,
  buildCustomerPortalLoginLink,
  buildCustomerCheckBillingLink,
  buildCustomerInvoiceCheckBillingLink,
  buildPublicInvoicePrintLink,
  buildPublicInvoiceReceiptLink,
  formatInvoiceDueDate,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  defaultWelcomeWhatsappTemplate,
  defaultReactivationWhatsappTemplate,
  defaultPaidWhatsappTemplate,
  defaultIsolationPortalNotice,
  fillWhatsappTemplate,
  ensureDueDateLine
};
