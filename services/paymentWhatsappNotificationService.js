const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const billingSvc = require('./billingService');
const customerSvc = require('./customerService');
const whatsappTemplateMedia = require('./whatsappTemplateMediaService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerInvoiceCheckBillingLink,
  buildPublicInvoiceReceiptLink,
  defaultPaidWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine,
  formatInvoiceDueDate,
  resolveAppBaseUrl
} = require('./publicLinkService');

function formatRupiahValue(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function formatPeriod(invoice = {}) {
  const month = Number(invoice.period_month || 0);
  const year = Number(invoice.period_year || 0);
  if (!month || !year) return '-';
  return `${String(month).padStart(2, '0')}/${year}`;
}

function formatPublicPaidByName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Admin';
  const cashierMatch = raw.match(/^Kasir(?:\s+(.+?))?(?:\s+\(@[^)]*\))?(\s*-\s*.+)?$/i);
  if (!cashierMatch) return raw;
  const name = String(cashierMatch[1] || '').trim();
  const suffix = String(cashierMatch[2] || '').trim();
  return `Admin${name ? ` ${name}` : ''}${suffix ? ` ${suffix}` : ''}`.trim();
}

function normalizePaidAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toLocaleString('id-ID');
  const raw = String(value || '').trim();
  return raw || new Date().toLocaleString('id-ID');
}

function normalizeInvoiceList(invoices = [], fallbackInvoice = null) {
  const rows = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  if (!rows.length && fallbackInvoice) rows.push(fallbackInvoice);
  return rows;
}

function buildPaidMessage(customer, invoices = [], options = {}) {
  const invoiceRows = normalizeInvoiceList(invoices, options.fallbackInvoice);
  const primary = invoiceRows[0] || {};
  const companyName = getSetting('company_header', 'ISP');
  const template = String(
    getSetting('whatsapp_paid_message', defaultPaidWhatsappTemplate(companyName)) ||
    defaultPaidWhatsappTemplate(companyName)
  ).trim();

  const invoiceLink = primary.id
    ? buildCustomerInvoiceCheckBillingLink(primary, customer, undefined, options)
    : buildCustomerCheckBillingLink(customer, options);
  const receiptLink = primary.id
    ? buildPublicInvoiceReceiptLink(primary, customer, undefined, options)
    : invoiceLink;
  const totalAmount = invoiceRows.reduce((sum, row) => sum + (Number(row.amount || 0) || 0), 0);
  const periods = invoiceRows.map(formatPeriod).filter((item) => item && item !== '-');
  const invoiceNumbers = invoiceRows.map((row) => row.id ? `INV-${row.id}` : '').filter(Boolean);
  const dueDates = invoiceRows
    .map((row) => formatInvoiceDueDate(row, customer))
    .filter((item) => item && item !== '-');

  const payload = {
    nama: customer?.name || customer?.customer_name || 'Pelanggan',
    pelanggan: customer?.name || customer?.customer_name || 'Pelanggan',
    paket: primary.package_name || customer?.package_name || customer?.package || '-',
    rincian: periods.length ? periods.join(', ') : '-',
    periode: periods.length ? periods.join(', ') : '-',
    jatuh_tempo: dueDates[0] || '-',
    tagihan: formatRupiahValue(totalAmount || primary.amount || 0),
    total: formatRupiahValue(totalAmount || primary.amount || 0),
    link: receiptLink || invoiceLink,
    receipt_link: receiptLink || invoiceLink,
    invoice_link: invoiceLink,
    billing_link: buildCustomerCheckBillingLink(customer, options),
    invoice_no: invoiceNumbers.length ? invoiceNumbers.join(', ') : '-',
    company: companyName,
    paid_by: formatPublicPaidByName(options.paidBy || primary.paid_by_name || 'Admin'),
    paid_at: normalizePaidAt(options.paidAt || primary.paid_at)
  };

  return ensureDueDateLine(fillWhatsappTemplate(template, payload), payload.jatuh_tempo);
}

async function sendPaidInvoiceNotification(invoiceId, options = {}) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const invoice = billingSvc.getInvoiceById(invoiceId);
    if (!invoice || String(invoice.status || '').trim().toLowerCase() !== 'paid') return false;
    const customer = options.customer || customerSvc.getCustomerById(invoice.customer_id);
    if (!customer || !customer.phone) return false;
    const baseUrl = String(options.baseUrl || resolveAppBaseUrl() || '').trim();
    const message = buildPaidMessage(
      {
        ...customer,
        package_name: customer.package_name || invoice.package_name || ''
      },
      [invoice],
      {
        ...options,
        baseUrl,
        paidBy: options.paidBy || invoice.paid_by_name || 'Admin',
        paidAt: options.paidAt || invoice.paid_at || new Date()
      }
    );
    return Boolean(await whatsappTemplateMedia.sendTemplateMessage(customer.phone, message, 'paid', { ...options, baseUrl }));
  } catch (error) {
    logger.warn(`[PaymentWA] Notifikasi lunas invoice ${invoiceId} gagal: ${error.message || String(error)}`);
    return false;
  }
}

module.exports = {
  buildPaidMessage,
  sendPaidInvoiceNotification,
  formatPublicPaidByName
};
