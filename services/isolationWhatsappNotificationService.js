const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const billingSvc = require('./billingService');
const whatsappGateway = require('./whatsappGatewayService');
const whatsappTemplateMedia = require('./whatsappTemplateMediaService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerInvoiceCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  defaultIsolationWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine,
  formatInvoiceDueDate,
  resolveAppBaseUrl
} = require('./publicLinkService');

function formatRupiahValue(value) {
  return Number(Math.max(0, Number(value || 0) || 0)).toLocaleString('id-ID');
}

function normalizeInvoiceList(customer, invoices = [], now = new Date()) {
  const rows = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  if (rows.length) return rows;
  if (!customer?.id) return [];
  try {
    return billingSvc.getDueUnpaidInvoicesByCustomerId(customer.id, now);
  } catch (error) {
    logger.warn(`[IsolationWA] Gagal membaca tagihan jatuh tempo pelanggan ${customer.id}: ${error.message || String(error)}`);
    return [];
  }
}

function buildInvoicePeriods(invoices = []) {
  const periods = (Array.isArray(invoices) ? invoices : [])
    .map((invoice) => `${invoice.period_month}/${invoice.period_year}`)
    .filter(Boolean);
  return periods.length ? periods.join(', ') : '-';
}

function buildPaymentGuide(customer, invoices = [], options = {}) {
  const primaryInvoice = invoices[0] || null;
  const link = primaryInvoice
    ? buildCustomerInvoiceCheckBillingLink(primaryInvoice, customer, undefined, options)
    : buildCustomerCheckBillingLink(customer, options);
  const lines = [
    'Agar layanan bisa aktif kembali, silakan bayar tagihan melalui Bayar Online:',
    link
  ];
  return lines.join('\n');
}

function buildIsolationMessage(customer, invoices = [], options = {}) {
  const invoiceRows = normalizeInvoiceList(customer, invoices, options.now || new Date());
  const primaryInvoice = invoiceRows[0] || null;
  const companyName = getSetting('company_header', 'ISP');
  const template = String(
    getSetting('whatsapp_isolation_message', defaultIsolationWhatsappTemplate(companyName)) ||
    defaultIsolationWhatsappTemplate(companyName)
  ).trim();
  const totalTagihan = invoiceRows.reduce((sum, invoice) => sum + (Number(invoice.amount || 0) || 0), 0);
  const groupLink = String(getSetting('whatsapp_group_invite_link', '') || '').trim();
  const invoiceLink = primaryInvoice
    ? buildPublicInvoicePrintLink(primaryInvoice, customer, undefined, options)
    : buildCustomerCheckBillingLink(customer, options);
  const checkBillingLink = buildCustomerCheckBillingLink(customer, options);
  const dueDate = primaryInvoice ? formatInvoiceDueDate(primaryInvoice, customer) : '-';
  const payload = {
    nama: customer?.name || customer?.customer_name || 'Pelanggan',
    pelanggan: customer?.name || customer?.customer_name || 'Pelanggan',
    paket: String(customer?.package_name || primaryInvoice?.package_name || '-').trim() || '-',
    tagihan: formatRupiahValue(totalTagihan),
    total: formatRupiahValue(totalTagihan),
    rincian: buildInvoicePeriods(invoiceRows),
    periode: buildInvoicePeriods(invoiceRows),
    jatuh_tempo: dueDate,
    alasan: options.reason || 'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.',
    link: checkBillingLink,
    billing_link: checkBillingLink,
    portal_link: buildCustomerPortalLoginLink(options),
    invoice_link: invoiceLink,
    receipt_link: invoiceLink,
    invoice_no: primaryInvoice?.id ? `INV-${primaryInvoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: groupLink,
    group_line: groupLink ? `Grup pelanggan: ${groupLink}` : '',
    payment_guide: buildPaymentGuide(customer, invoiceRows, options),
    company: companyName
  };
  return ensureDueDateLine(fillWhatsappTemplate(template, payload), payload.jatuh_tempo);
}

async function sendIsolationNotification(customer, invoices = [], options = {}) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    if (!customer || !customer.phone) return false;
    const ready = await whatsappGateway.ensureReady(Number(options.readyTimeoutMs || 15000) || 15000);
    if (!ready) {
      logger.warn(`[IsolationWA] Gateway WhatsApp belum siap untuk pelanggan ${customer.id || customer.name || '-'}.`);
      return false;
    }
    const baseUrl = String(options.baseUrl || resolveAppBaseUrl() || '').trim();
    const invoiceRows = normalizeInvoiceList(customer, invoices, options.now || new Date());
    const message = buildIsolationMessage(customer, invoiceRows, { ...options, baseUrl });
    const sent = await whatsappTemplateMedia.sendTemplateMessage(customer.phone, message, 'isolation', { ...options, baseUrl });
    if (!sent) {
      logger.warn(`[IsolationWA] WhatsApp isolir pelanggan ${customer.id || customer.name || '-'} tidak terkirim.`);
    }
    return Boolean(sent);
  } catch (error) {
    logger.warn(`[IsolationWA] Gagal kirim WhatsApp isolir pelanggan ${customer?.id || customer?.name || '-'}: ${error.message || String(error)}`);
    return false;
  }
}

module.exports = {
  buildIsolationMessage,
  sendIsolationNotification
};
