const db = require('../config/database');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const { normalizePhoneDigits } = require('./phoneService');
const {
  isPushConfigured,
  sendPushToAdmins
} = require('./pushNotificationService');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function getInvoicePaymentContext(invoiceId) {
  const id = Number(invoiceId || 0);
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare(`
    SELECT i.*,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE i.id = ?
  `).get(id);
}

function resolvePaymentSource({ invoice, paidByName, notes, actor }) {
  const actorType = normalizeText(actor && actor.type).toLowerCase();
  const actorName = normalizeText(actor && actor.name);
  const paidBy = normalizeText(paidByName || invoice?.paid_by_name);
  const noteText = normalizeText(notes || invoice?.notes).toLowerCase();
  const paidByLower = paidBy.toLowerCase();
  const gateway = normalizeText(invoice?.payment_gateway);

  if (actorType === 'technician') return actorName ? `Teknisi ${actorName}` : (paidBy || 'Teknisi');
  if (actorType === 'collector') return actorName || paidBy || 'Kolektor';
  if (actorType === 'cashier') return actorName ? `Kasir ${actorName}` : (paidBy || 'Kasir');
  if (actorType === 'admin') return actorName ? `Admin ${actorName}` : (paidBy || 'Admin');
  if (actorType === 'agent') return actorName ? `Agent ${actorName}` : (paidBy || 'Agent');

  if (paidByLower.includes('teknisi')) return paidBy;
  if (paidByLower.includes('kolektor')) return paidBy;
  if (paidByLower.includes('kasir')) return paidBy;
  if (paidByLower.includes('agent')) return paidBy;
  if (paidByLower.includes('wa bot')) return paidBy;

  if (paidByLower.includes('qris') || noteText.includes('auto-qris')) {
    return 'Online QRIS Kode Unik';
  }
  if (paidByLower.includes('tripay') || gateway.toLowerCase() === 'tripay') return 'Online Tripay';
  if (paidByLower.includes('midtrans') || gateway.toLowerCase() === 'midtrans') return 'Online Midtrans';
  if (paidByLower.includes('xendit') || gateway.toLowerCase() === 'xendit') return 'Online Xendit';
  if (paidByLower.includes('duitku') || gateway.toLowerCase() === 'duitku') return 'Online Duitku';

  return paidBy || 'Admin';
}

function resolvePaymentMethod(invoice, sourceLabel) {
  const qrisAmountUnique = Number(invoice?.qris_amount_unique || 0) || 0;
  const qrisCode = Number(invoice?.qris_unique_code || 0) || 0;
  if (sourceLabel.toLowerCase().includes('qris') || qrisAmountUnique > 0) {
    const parts = ['QRIS'];
    if (qrisCode > 0) parts.push(`kode unik ${String(qrisCode).padStart(3, '0')}`);
    if (qrisAmountUnique > 0) parts.push(`nominal ${formatRupiah(qrisAmountUnique)}`);
    return parts.join(' - ');
  }

  const gateway = normalizeText(invoice?.payment_gateway);
  const reference = normalizeText(invoice?.payment_reference || invoice?.payment_order_id);
  if (gateway) return reference ? `${gateway} - Ref ${reference}` : gateway;
  return sourceLabel;
}

function buildAdminPaymentNotificationPayload({ invoiceId, paidByName, notes, actor, paymentDate = new Date() } = {}) {
  const invoice = getInvoicePaymentContext(invoiceId);
  if (!invoice) return null;

  const sourceLabel = resolvePaymentSource({ invoice, paidByName, notes, actor });
  const methodLabel = resolvePaymentMethod(invoice, sourceLabel);
  const paidAt = paymentDate instanceof Date && !Number.isNaN(paymentDate.getTime())
    ? paymentDate
    : new Date();
  const paidAtText = paidAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const period = `${String(invoice.period_month || '').padStart(2, '0')}/${invoice.period_year || '-'}`;
  const amount = Number(invoice.amount || 0) || 0;

  const title = `Pembayaran lunas INV-${invoice.id}`;
  const body = `${invoice.customer_name || 'Pelanggan'} ${formatRupiah(amount)} via ${sourceLabel}`;
  const whatsappMessage = [
    '*PEMBAYARAN LUNAS*',
    '',
    `Pelanggan: ${invoice.customer_name || '-'}`,
    `Invoice: INV-${invoice.id}`,
    `Periode: ${period}`,
    `Paket: ${invoice.package_name || '-'}`,
    `Nominal tagihan: ${formatRupiah(amount)}`,
    `Lunas oleh: ${sourceLabel}`,
    `Metode: ${methodLabel}`,
    `Waktu: ${paidAtText}`
  ].join('\n');

  return {
    invoice,
    title,
    body,
    whatsappMessage,
    sourceLabel,
    methodLabel,
    paidAtText
  };
}

function getAdminPushRecipients(settings = {}) {
  const username = normalizeText(settings.admin_username) || 'admin';
  const recipients = [{ username }];
  if (username.toLowerCase() !== 'admin') recipients.push({ username: 'admin' });
  return recipients;
}

async function sendWhatsappToAdminNumbers(message, settings = {}) {
  const numbers = Array.isArray(settings.whatsapp_admin_numbers)
    ? settings.whatsapp_admin_numbers
    : [];
  const targets = [...new Set(numbers.map((phone) => normalizePhoneDigits(phone)).filter(Boolean))];
  if (!settings.whatsapp_enabled || !targets.length) {
    return { success: false, skipped: true, reason: 'no-admin-whatsapp' };
  }

  const { sendWA, ensureWhatsAppReady } = await import('./whatsappBot.mjs');
  const ready = await ensureWhatsAppReady(12000);
  if (!ready) return { success: false, skipped: true, reason: 'whatsapp-not-ready' };

  let sent = 0;
  const failed = [];
  for (const phone of targets) {
    try {
      const ok = await sendWA(phone, message);
      if (ok) sent += 1;
      else failed.push(phone);
    } catch (error) {
      failed.push(phone);
      logger.warn(`[AdminPaymentNotification] Gagal kirim WA admin ${phone}: ${error.message || String(error)}`);
    }
  }

  return { success: sent > 0, sent, failed };
}

async function notifyInvoicePaid(options = {}) {
  const payload = buildAdminPaymentNotificationPayload(options);
  if (!payload) return { success: false, skipped: true, reason: 'invoice-not-found' };

  const settings = getSettingsWithCache();
  const results = {};

  try {
    if (isPushConfigured(settings)) {
      results.push = await sendPushToAdmins(getAdminPushRecipients(settings), {
        settings,
        title: payload.title,
        message: payload.body,
        targetUrl: '/admin/billing',
        data: {
          kind: 'payment_paid',
          source: 'invoice-payment',
          invoiceId: Number(payload.invoice.id || 0) || null,
          customerId: Number(payload.invoice.customer_id || 0) || null,
          sourceLabel: payload.sourceLabel,
          methodLabel: payload.methodLabel
        }
      });
    }
  } catch (error) {
    logger.warn(`[AdminPaymentNotification] Gagal kirim push admin: ${error.message || String(error)}`);
    results.push = { success: false, error: error.message || String(error) };
  }

  try {
    results.whatsapp = await sendWhatsappToAdminNumbers(payload.whatsappMessage, settings);
  } catch (error) {
    logger.warn(`[AdminPaymentNotification] Gagal kirim WhatsApp admin: ${error.message || String(error)}`);
    results.whatsapp = { success: false, error: error.message || String(error) };
  }

  return {
    success: Boolean(results.push?.success || results.whatsapp?.success),
    ...results
  };
}

function buildAdminAgentVoucherNotificationPayload(txId) {
  const id = Number(txId || 0);
  if (!id) return null;
  const tx = db.prepare(`
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.id = ? AND t.type = 'voucher_sale'
  `).get(id);
  if (!tx) return null;

  const amount = Number(tx.amount_buy || 0) || 0;
  const sell = Number(tx.amount_sell || 0) || 0;
  const qtyLabel = tx.voucher_batch_id ? `Batch #${tx.voucher_batch_id}` : (tx.voucher_code || `Transaksi #${tx.id}`);
  const agentLabel = `${tx.agent_name || 'Agent'}${tx.agent_username ? ` (@${tx.agent_username})` : ''}`;
  return {
    tx,
    title: 'Pemasukan voucher agen',
    body: `${agentLabel} ${qtyLabel} masuk ${formatRupiah(amount)}`,
    whatsappMessage: [
      '*PEMASUKAN VOUCHER AGEN*',
      '',
      `Agent: ${agentLabel}`,
      `Transaksi: #${tx.id}`,
      `Voucher: ${qtyLabel}`,
      `Paket: ${tx.profile_name || '-'}`,
      `Modal agen: ${formatRupiah(amount)}`,
      `Harga jual: ${formatRupiah(sell)}`,
      `Waktu: ${tx.created_at ? new Date(tx.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
    ].join('\n')
  };
}

async function notifyAgentVoucherIncome(txId) {
  const payload = buildAdminAgentVoucherNotificationPayload(txId);
  if (!payload) return { success: false, skipped: true, reason: 'tx-not-found' };

  const settings = getSettingsWithCache();
  const results = {};

  try {
    if (isPushConfigured(settings)) {
      results.push = await sendPushToAdmins(getAdminPushRecipients(settings), {
        settings,
        title: payload.title,
        message: payload.body,
        targetUrl: '/admin/bookkeeping',
        data: {
          kind: 'agent_voucher_income',
          source: 'agent-voucher',
          txId: Number(payload.tx.id || 0) || null,
          agentId: Number(payload.tx.agent_id || 0) || null,
          voucherBatchId: Number(payload.tx.voucher_batch_id || 0) || null
        }
      });
    }
  } catch (error) {
    logger.warn(`[AdminPaymentNotification] Gagal kirim push voucher agent: ${error.message || String(error)}`);
    results.push = { success: false, error: error.message || String(error) };
  }

  return {
    success: Boolean(results.push?.success),
    ...results
  };
}

async function notifyApprovalRequired({
  type = 'customer',
  title = '',
  requester = '',
  subject = '',
  detail = '',
  targetUrl = '/admin/customer-requests'
} = {}) {
  const settings = getSettingsWithCache();
  const cleanTitle = normalizeText(title) || 'Approval diperlukan';
  const cleanRequester = normalizeText(requester) || '-';
  const cleanSubject = normalizeText(subject) || '-';
  const cleanDetail = normalizeText(detail);
  const cleanTargetUrl = normalizeText(targetUrl) || '/admin/customer-requests';
  const body = `${cleanSubject} menunggu persetujuan admin`;
  const whatsappMessage = [
    '*APPROVAL DIPERLUKAN*',
    '',
    `Jenis: ${cleanTitle}`,
    `Pengaju: ${cleanRequester}`,
    `Data: ${cleanSubject}`,
    cleanDetail ? `Detail: ${cleanDetail}` : '',
    `Buka: ${cleanTargetUrl}`
  ].filter(Boolean).join('\n');

  const results = {};
  try {
    if (isPushConfigured(settings)) {
      results.push = await sendPushToAdmins(getAdminPushRecipients(settings), {
        settings,
        title: cleanTitle,
        message: body,
        targetUrl: cleanTargetUrl,
        data: {
          kind: 'approval_required',
          source: String(type || 'approval'),
          targetUrl: cleanTargetUrl
        }
      });
    }
  } catch (error) {
    logger.warn(`[AdminApprovalNotification] Gagal kirim push admin: ${error.message || String(error)}`);
    results.push = { success: false, error: error.message || String(error) };
  }

  try {
    results.whatsapp = await sendWhatsappToAdminNumbers(whatsappMessage, settings);
  } catch (error) {
    logger.warn(`[AdminApprovalNotification] Gagal kirim WhatsApp admin: ${error.message || String(error)}`);
    results.whatsapp = { success: false, error: error.message || String(error) };
  }

  return {
    success: Boolean(results.push?.success || results.whatsapp?.success),
    ...results
  };
}

module.exports = {
  buildAdminPaymentNotificationPayload,
  buildAdminAgentVoucherNotificationPayload,
  notifyInvoicePaid,
  notifyAgentVoucherIncome,
  notifyApprovalRequired
};
