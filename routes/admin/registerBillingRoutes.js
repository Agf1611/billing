const { buildDynamicQrisPayload, buildDynamicQrisBuffer } = require('../../services/qrisService');

module.exports = function registerBillingRoutes(router, deps = {}) {
  const {
    express,
    requireAdmin,
    requireAdminSession,
    billingSvc,
    customerSvc,
    db,
    getSetting,
    company,
    flashMsg,
    buildInvoiceSummaryFromList,
    resolvePaidByName,
    sendPaidWhatsappNotification,
    buildBillingWhatsappMessage,
    buildManualPaymentMessage,
    resolveRequestBaseUrl,
    redirectBack
  } = deps;

  function getInvoiceDueDateLocal(invoiceLike) {
    const month = Math.max(1, Math.min(12, Number(invoiceLike?.period_month || 0) || 1));
    const year = Math.max(2000, Number(invoiceLike?.period_year || 0) || new Date().getFullYear());
    const fallbackDay = Math.max(1, Math.min(31, Number(invoiceLike?.due_day_snapshot || 10) || 10));
    const maxDay = new Date(year, month, 0).getDate() || 31;
    const day = Math.min(fallbackDay, maxDay);
    return new Date(year, month - 1, day, 23, 59, 59, 999);
  }

  function hasDynamicQrisSource() {
    return Boolean(String(getSetting('qris_static_payload', '') || '').trim());
  }

  async function buildInvoiceQrisImageBuffer(invoice) {
    const exactAmount = Number(invoice?.qris_amount_unique || invoice?.amount || 0) || 0;
    const basePayload = String(getSetting('qris_static_payload', '') || '').trim();
    if (!exactAmount || !basePayload) return Buffer.alloc(0);
    const qrisPayload = buildDynamicQrisPayload(basePayload, exactAmount);
    if (!qrisPayload) return Buffer.alloc(0);
    return buildDynamicQrisBuffer(qrisPayload, { width: 720, margin: 1 });
  }

  router.get('/billing', requireAdminSession, (req, res) => {
    const now = new Date();
    const {
      month: rawFilterMonth,
      year: rawFilterYear = now.getFullYear(),
      status: filterStatus = 'all',
      search = '',
      billingDayStart = '',
      billingDayEnd = '',
      page: rawPage = '1'
    } = req.query;
    const monthQueryProvided = Object.prototype.hasOwnProperty.call(req.query, 'month');
    const defaultMonth = now.getMonth() + 1;
    const normalizedRawMonth = monthQueryProvided ? String(rawFilterMonth ?? '').trim() : String(defaultMonth);
    const filterMonth = normalizedRawMonth === ''
      ? ''
      : Math.max(1, Math.min(12, parseInt(normalizedRawMonth, 10) || defaultMonth));
    const filterYear = parseInt(rawFilterYear, 10) || now.getFullYear();
    const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = 25;
    const nativeStatusFilter = ['paid', 'unpaid'].includes(filterStatus) ? filterStatus : 'all';
    let invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: nativeStatusFilter, search });
    const isIsolatedInvoice = (inv) => String(inv?.customer_status || '').toLowerCase() === 'suspended';
    const isOpenUnpaidInvoice = (inv) => String(inv?.status || '').toLowerCase() === 'unpaid' && !isIsolatedInvoice(inv);
    const isIsolatedUnpaidInvoice = (inv) => String(inv?.status || '').toLowerCase() === 'unpaid' && isIsolatedInvoice(inv);
    const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
    const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
    if (normalizedBillingDayStart || normalizedBillingDayEnd) {
      invoices = invoices.filter((inv) => {
        const day = Number(inv?.due_day_snapshot || 0);
        if (!Number.isFinite(day) || day <= 0) return false;
        if (normalizedBillingDayStart && day < normalizedBillingDayStart) return false;
        if (normalizedBillingDayEnd && day > normalizedBillingDayEnd) return false;
        return true;
      });
    }
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const overdueCountBase = invoices.filter((inv) =>
      isOpenUnpaidInvoice(inv) &&
      getInvoiceDueDateLocal(inv).getTime() < todayStart.getTime()
    ).length;
    const isolatedCountBase = invoices.filter((inv) => isIsolatedUnpaidInvoice(inv)).length;
    if (filterStatus === 'unpaid') {
      invoices = invoices.filter((inv) => isOpenUnpaidInvoice(inv));
    } else if (filterStatus === 'overdue') {
      invoices = invoices.filter((inv) =>
        isOpenUnpaidInvoice(inv) &&
        getInvoiceDueDateLocal(inv).getTime() < todayStart.getTime()
      );
    } else if (filterStatus === 'isolated') {
      invoices = invoices.filter((inv) => isIsolatedUnpaidInvoice(inv));
    }
    const summary = buildInvoiceSummaryFromList(invoices);
    const totalInvoicesCount = invoices.length;
    const totalPages = Math.max(1, Math.ceil(totalInvoicesCount / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const paginatedInvoices = invoices.slice((safePage - 1) * pageSize, safePage * pageSize);
    const invoiceGroups = [];
    let currentGroup = null;
    for (const inv of paginatedInvoices) {
      const key = `${inv.period_year}-${String(inv.period_month).padStart(2, '0')}`;
      if (!currentGroup || currentGroup.key !== key) {
        currentGroup = {
          key,
          month: Number(inv.period_month || 0) || 0,
          year: Number(inv.period_year || 0) || filterYear,
          invoices: []
        };
        invoiceGroups.push(currentGroup);
      }
      currentGroup.invoices.push(inv);
    }
    res.render('admin/billing', {
      title: 'Tagihan',
      company: company(),
      activePage: 'billing',
      invoices: paginatedInvoices,
      invoiceGroups,
      summary,
      filterMonth,
      filterYear,
      filterStatus,
      search,
      billingDayStart: normalizedBillingDayStart || '',
      billingDayEnd: normalizedBillingDayEnd || '',
      defaultMonth,
      defaultYear: now.getFullYear(),
      showingAllMonths: filterMonth === '',
      overdueCountBase,
      isolatedCountBase,
      currentPage: safePage,
      totalPages,
      totalInvoicesCount,
      pageSize,
      msg: flashMsg(req)
    });
  });

  router.get('/billing/:id/print', requireAdminSession, (req, res) => {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).send('Invoice tidak ditemukan');

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

    const settings = deps.getSettings();
    const printStyle = String(req.query.style || 'a4').toLowerCase() === 'receipt' ? 'receipt' : 'a4';
    res.render('admin/print_invoice', {
      invoice: inv,
      customer,
      company: settings.company_header || 'Billing ISP',
      settings,
      printStyle,
      viewerRole: 'admin',
      printBasePath: `/admin/billing/${inv.id}/print`
    });
  });

  router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      const { month, year } = req.body;
      const count = billingSvc.generateMonthlyInvoices(parseInt(month, 10), parseInt(year, 10));
      req.session._msg = { type: 'success', text: `${count} tagihan baru berhasil digenerate untuk periode ${month}/${year}.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal generate: ' + e.message };
    }
    res.redirect('/admin/billing');
  });

  router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
    try {
      const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
      res.json(invoices);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
    try {
      const year = parseInt(req.query.year || new Date().getFullYear(), 10);
      const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
      res.json({ year, months });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
    try {
      const year = parseInt(req.query.year || new Date().getFullYear(), 10);
      const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/customers/suggest', requireAdmin, (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json([]);
      const suggestions = customerSvc.getCustomerSearchSuggestions(q, 8).map((row) => ({
        id: Number(row.id || 0) || 0,
        name: String(row.name || '').trim(),
        phone: String(row.phone || '').trim(),
        pppoe_username: String(row.pppoe_username || '').trim(),
        genieacs_tag: String(row.genieacs_tag || '').trim(),
        address: String(row.address || '').trim()
      }));
      res.json(suggestions);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const { invoice_ids, paid_by_name, notes } = req.body;
      const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
      const paidBy = resolvePaidByName(req, paid_by_name);
      let whatsappWarning = '';

      if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

      let customerId = null;
      const paidInvoices = [];
      for (const id of ids) {
        const inv = billingSvc.getInvoiceById(id);
        if (inv) {
          customerId = inv.customer_id;
          const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
          billingSvc.markAsPaid(id, paidBy, notes);
          if (!wasPaid) {
            paidInvoices.push({
              id: inv.id,
              amount: Number(inv.amount || 0),
              period_month: inv.period_month,
              period_year: inv.period_year
            });
          }
        }
      }

      if (customerId) {
        const freshCustomer = customerSvc.getAllCustomers().find((c) => c.id === customerId);
        if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
          await customerSvc.activateCustomer(customerId);
        }
      }

      if (customerId && paidInvoices.length > 0) {
        const customer = customerSvc.getCustomerById(customerId);
        if (customer && customer.phone) {
          try {
            await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
              baseUrl: resolveRequestBaseUrl(req),
              paidBy,
              paidAt: new Date().toLocaleString('id-ID')
            });
          } catch (notifyError) {
            whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
          }
        }
      }

      req.session._msg = { type: 'success', text: `${ids.length} tagihan berhasil dilunasi.${whatsappWarning}` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const inv = billingSvc.getInvoiceById(req.params.id);
      if (!inv) throw new Error('Tagihan tidak ditemukan');

      const paidBy = resolvePaidByName(req, req.body.paid_by_name);
      const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
      let whatsappWarning = '';
      billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (!wasPaid && customer && customer.phone) {
        try {
          await sendPaidWhatsappNotification(customer, [inv], inv, {
            baseUrl: resolveRequestBaseUrl(req),
            paidBy,
            paidAt: new Date().toLocaleString('id-ID')
          });
        } catch (notifyError) {
          whatsappWarning = ` Notifikasi WhatsApp gagal dikirim: ${notifyError.message || String(notifyError)}.`;
        }
      }
      if (customer && customer.status === 'suspended') {
        const freshCustomer = customerSvc.getAllCustomers().find((c) => c.id === inv.customer_id);
        if (freshCustomer && freshCustomer.unpaid_count === 0) {
          await customerSvc.activateCustomer(inv.customer_id);
        }
      }

      req.session._msg = { type: 'success', text: `Tagihan berhasil ditandai lunas.${whatsappWarning}` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
    try {
      billingSvc.markAsUnpaid(req.params.id);
      req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
    try {
      const invId = Number(req.params.id);
      if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
      const force = String(req.query.force || '') === '1';
      const assigned = billingSvc.assignUniqueQrisForInvoice(invId, { force });
      req.session._msg = {
        type: 'success',
        text: `Kode QRIS dibuat: Rp ${Number(assigned?.qris_amount_unique || 0).toLocaleString('id-ID')} (kode ${String(assigned?.qris_unique_code || '').padStart(3, '0')}).`
      };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal membuat kode QRIS: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
    try {
      const invId = Number(req.params.id);
      if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
      db.prepare(`
        UPDATE invoices
        SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
        WHERE id=?
      `).run(invId);
      req.session._msg = { type: 'success', text: 'Kode QRIS dihapus dari tagihan.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal menghapus kode QRIS: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
    try {
      const startedAt = Date.now();
      let inv = billingSvc.getInvoiceById(req.params.id);
      if (!inv) throw new Error('Tagihan tidak ditemukan');
      if (String(inv.status || '').toLowerCase() === 'unpaid' && hasDynamicQrisSource()) {
        inv = billingSvc.assignUniqueQrisForInvoice(inv.id);
      }

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

      const { sendWA, sendWAImage, ensureWhatsAppReady } = await import('../../services/whatsappBot.mjs');
      const ready = await ensureWhatsAppReady(25000);
      if (!ready) {
        throw new Error('Bot WhatsApp belum terhubung. Silakan cek status WhatsApp di menu Admin.');
      }

      const qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
      const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
      const requestBaseUrl = resolveRequestBaseUrl(req);
      let finalMessage = buildBillingWhatsappMessage(customer, unpaidInvoices, inv, { baseUrl: requestBaseUrl });

      const manualPaymentInfo = buildManualPaymentMessage();
      if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

      const qrisImageBuffer = qrisAmountUnique > 0 ? await buildInvoiceQrisImageBuffer(inv) : Buffer.alloc(0);
      if (qrisImageBuffer.length) {
        finalMessage += '\n\n*QRIS*\nScan gambar ini dan bayar sesuai total.';
      }
      const sent = qrisImageBuffer.length
        ? await sendWAImage(customer.phone, qrisImageBuffer, finalMessage)
        : await sendWA(customer.phone, finalMessage);
      if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

      const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name} dalam sekitar ${durationSec} detik.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
    try {
      billingSvc.deleteInvoice(req.params.id);
      req.session._msg = { type: 'success', text: 'Tagihan berhasil dihapus.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });
};
