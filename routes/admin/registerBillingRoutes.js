const {
  buildDynamicQrisPayload,
  buildDynamicQrisBuffer,
  hasStaticQrisEnabled
} = require('../../services/qrisService');
const { verifyPassword } = require('../../config/passwords');
const whatsappGateway = require('../../services/whatsappGatewayService');
const whatsappTemplateMedia = require('../../services/whatsappTemplateMediaService');

module.exports = function registerBillingRoutes(router, deps = {}) {
  const {
    express,
    requireAdmin,
    requireAdminSession,
    billingSvc,
    customerSvc,
    db,
    getSetting,
    getSettings,
    company,
    flashMsg,
    buildInvoiceSummaryFromList,
    resolvePaidByName,
    resolvePaymentActor,
    sendPaidWhatsappNotification,
    buildBillingWhatsappMessage,
    buildManualPaymentMessage,
    resolveRequestBaseUrl,
    redirectBack,
    isPushConfigured,
    sendPushToCustomer
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
    return hasStaticQrisEnabled({
      qris_static_enabled: getSetting('qris_static_enabled', undefined),
      qris_static_payload: getSetting('qris_static_payload', ''),
      qris_static_qr_url: getSetting('qris_static_qr_url', '')
    }) && Boolean(String(getSetting('qris_static_payload', '') || '').trim());
  }

  function wantsJsonResponse(req) {
    const accept = String(req?.headers?.accept || '').toLowerCase();
    const requestedWith = String(req?.headers?.['x-requested-with'] || '').toLowerCase();
    return requestedWith === 'xmlhttprequest' || accept.includes('application/json') || req?.body?.ajax === '1';
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
      page: rawPage = '1',
      sort: rawSort = 'smart',
      pay_channel: rawPayChannel = 'all'
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
    const nativeStatusFilter = ['paid'].includes(filterStatus)
      ? 'paid'
      : ['unpaid', 'overdue', 'isolated'].includes(filterStatus)
        ? 'unpaid'
        : 'all';
    const allowedSorts = new Set(['smart', 'paid_latest', 'due_today', 'due_latest', 'name']);
    const allowedPayChannels = new Set(['all', 'cash', 'online', 'staff', 'admin', 'cashier', 'collector', 'technician', 'agent']);
    const normalizedSort = allowedSorts.has(String(rawSort || '').trim()) ? String(rawSort).trim() : 'smart';
    const normalizedPayChannel = allowedPayChannels.has(String(rawPayChannel || '').trim()) ? String(rawPayChannel).trim() : 'all';
    const effectiveSort = normalizedSort !== 'smart'
      ? normalizedSort
      : filterStatus === 'paid'
        ? 'paid_latest'
        : filterStatus === 'overdue'
          ? 'due_latest'
          : 'smart';
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const applyBillingDayFilter = (rows) => {
      const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
      const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
      if (!normalizedBillingDayStart && !normalizedBillingDayEnd) return rows;
      return rows.filter((inv) => {
        const day = Number(inv?.due_day_snapshot || 0);
        if (!Number.isFinite(day) || day <= 0) return false;
        if (normalizedBillingDayStart && day < normalizedBillingDayStart) return false;
        if (normalizedBillingDayEnd && day > normalizedBillingDayEnd) return false;
        return true;
      });
    };

    const baseInvoices = applyBillingDayFilter(billingSvc.getAllInvoices({
      month: filterMonth,
      year: filterYear,
      status: 'all',
      search,
      sort: effectiveSort,
      today: now,
      limit: 0
    }));
    const summary = buildInvoiceSummaryFromList(baseInvoices, {
      todayStart,
      getDueDate: getInvoiceDueDateLocal
    });
    let invoices = applyBillingDayFilter(billingSvc.getAllInvoices({
      month: filterMonth,
      year: filterYear,
      status: nativeStatusFilter,
      search,
      sort: effectiveSort,
      payChannel: normalizedPayChannel,
      today: now,
      limit: 0
    }));
    const isIsolatedInvoice = (inv) => String(inv?.customer_status || '').toLowerCase() === 'suspended';
    const isOpenUnpaidInvoice = (inv) => String(inv?.status || '').toLowerCase() === 'unpaid' && !isIsolatedInvoice(inv);
    const isIsolatedUnpaidInvoice = (inv) => String(inv?.status || '').toLowerCase() === 'unpaid' && isIsolatedInvoice(inv);
    const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
    const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
    const dueTodayStartTime = todayStart.getTime();
    const dueTodayEndTime = dueTodayStartTime + 86400000;
    const isDueToday = (inv) => {
      const due = getInvoiceDueDateLocal(inv).getTime();
      return due >= dueTodayStartTime && due < dueTodayEndTime;
    };
    const overdueCountBase = baseInvoices.filter((inv) =>
      isOpenUnpaidInvoice(inv) &&
      getInvoiceDueDateLocal(inv).getTime() < todayStart.getTime()
    ).length;
    const isolatedCountBase = baseInvoices.filter((inv) => isIsolatedUnpaidInvoice(inv)).length;
    const payChannelCountBase = baseInvoices.filter((inv) => String(inv.status || '').toLowerCase() === 'paid');
    const chipCounts = {
      unpaid: baseInvoices.filter((inv) => isOpenUnpaidInvoice(inv)).length,
      dueToday: baseInvoices.filter((inv) => isOpenUnpaidInvoice(inv) && isDueToday(inv)).length,
      overdue: overdueCountBase,
      paid: payChannelCountBase.length,
      cash: payChannelCountBase.filter((inv) => ['cash', 'admin', 'cashier', 'collector', 'technician'].includes(String(inv.payment_channel || ''))).length,
      online: payChannelCountBase.filter((inv) => String(inv.payment_channel || '') === 'online').length,
      staff: payChannelCountBase.filter((inv) => ['admin', 'cashier', 'collector', 'technician'].includes(String(inv.payment_channel || ''))).length
    };
    if (filterStatus === 'unpaid') {
      invoices = invoices.filter((inv) => isOpenUnpaidInvoice(inv));
      if (effectiveSort === 'due_today') {
        invoices = invoices.filter((inv) => isDueToday(inv));
      }
    } else if (filterStatus === 'overdue') {
      invoices = invoices.filter((inv) =>
        isOpenUnpaidInvoice(inv) &&
        getInvoiceDueDateLocal(inv).getTime() < todayStart.getTime()
      );
    } else if (filterStatus === 'isolated') {
      invoices = invoices.filter((inv) => isIsolatedUnpaidInvoice(inv));
    }
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
      sort: normalizedSort,
      payChannel: normalizedPayChannel,
      chipCounts,
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
      company: settings.company_header || 'PT Media Solusi Sukses',
      settings,
      printStyle,
      viewerRole: 'admin',
      printBasePath: `/admin/billing/${inv.id}/print`
    });
  });

  router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      const { month, year } = req.body;
      const generated = billingSvc.generateMonthlyInvoices(parseInt(month, 10), parseInt(year, 10));
      const count = typeof generated === 'number' ? generated : Number(generated?.count || 0);
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
          billingSvc.markAsPaid(
            id,
            paidBy,
            notes,
            typeof resolvePaymentActor === 'function' ? resolvePaymentActor(req, paidBy) : null
          );
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
        if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && freshCustomer.unpaid_count === 0) {
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
      billingSvc.markAsPaid(
        req.params.id,
        paidBy,
        req.body.notes,
        typeof resolvePaymentActor === 'function' ? resolvePaymentActor(req, paidBy) : null
      );

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
      if (customer && ['suspended', 'inactive'].includes(String(customer.status || '').toLowerCase())) {
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

  router.post('/billing/:id/unpay', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      if (req.session?.isCashier && !req.session?.isAdmin) {
        throw new Error('Batalkan lunas hanya bisa dilakukan oleh admin utama.');
      }
      const confirmPassword = String(req.body.confirm_password || '').trim();
      if (!verifyPassword(confirmPassword, getSetting('admin_password', ''))) {
        throw new Error('Password admin salah. Batalkan lunas tidak diproses.');
      }
      billingSvc.markAsUnpaid(
        req.params.id,
        typeof resolvePaymentActor === 'function' ? resolvePaymentActor(req, 'Admin') : null
      );
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
        text: `Kode pembayaran dibuat: Rp ${Number(assigned?.qris_amount_unique || 0).toLocaleString('id-ID')} (kode ${String(assigned?.qris_unique_code || '').padStart(3, '0')}).`
      };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal membuat kode pembayaran: ' + e.message };
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
      req.session._msg = { type: 'success', text: 'Kode pembayaran dihapus dari tagihan.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal menghapus kode pembayaran: ' + e.message };
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
    const asJson = wantsJsonResponse(req);
    try {
      let inv = billingSvc.getInvoiceById(req.params.id);
      if (!inv) throw new Error('Tagihan tidak ditemukan');
      if (String(inv.status || '').toLowerCase() === 'unpaid' && hasDynamicQrisSource()) {
        inv = billingSvc.assignUniqueQrisForInvoice(inv.id);
      }

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

      const requestBaseUrl = resolveRequestBaseUrl(req);
      const queuedInvoice = { ...inv };
      const queuedCustomer = { ...customer };

      setImmediate(async () => {
        try {
          const whatsappStatus = await whatsappGateway.getStatus();
          const ready = await whatsappGateway.ensureReady(25000);
          if (!ready) {
            const waState = `${whatsappStatus?.provider || 'local'}:${whatsappStatus?.connection || 'unknown'}`;
            throw new Error(`WhatsApp belum siap (${waState}).`);
          }

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(queuedCustomer.id);
          let finalMessage = buildBillingWhatsappMessage(queuedCustomer, unpaidInvoices, queuedInvoice, { baseUrl: requestBaseUrl });
          const manualPaymentInfo = buildManualPaymentMessage();
          if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

          const qrisAmountUnique = Number(queuedInvoice.qris_amount_unique || 0) || 0;
          const qrisImageBuffer = qrisAmountUnique > 0 ? await buildInvoiceQrisImageBuffer(queuedInvoice) : Buffer.alloc(0);
          const sent = await whatsappTemplateMedia.sendTemplateMessage(
            queuedCustomer.phone,
            finalMessage,
            'billing',
            {
              baseUrl: requestBaseUrl,
              fallbackImageBuffer: qrisImageBuffer
            }
          );
          if (!sent) throw new Error('Gateway WhatsApp menolak pengiriman.');
        } catch (error) {
          console.warn(`[BillingWA] Gagal kirim tagihan invoice ${queuedInvoice.id}: ${error.message || String(error)}`);
        }
      });

      req.session._msg = { type: 'success', text: `Tagihan WhatsApp untuk ${customer.name} sedang dikirim di latar belakang.` };
      if (asJson) {
        return res.json({
          success: true,
          queued: true,
          message: req.session._msg.text,
          customerName: customer.name,
          invoiceId: Number(inv.id || 0) || null
        });
      }
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
      if (asJson) {
        return res.status(400).json({ success: false, error: req.session._msg.text });
      }
    }
    return redirectBack(res, '/admin/billing');
  });

  router.post('/billing/:id/push', requireAdminSession, async (req, res) => {
    try {
      let inv = billingSvc.getInvoiceById(req.params.id);
      if (!inv) throw new Error('Tagihan tidak ditemukan');
      if (String(inv.status || '').toLowerCase() === 'paid') throw new Error('Tagihan ini sudah lunas.');
      if (String(inv.status || '').toLowerCase() === 'unpaid' && hasDynamicQrisSource()) {
        inv = billingSvc.assignUniqueQrisForInvoice(inv.id);
      }

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (!customer) throw new Error('Pelanggan tidak ditemukan');

      const settings = typeof getSettings === 'function' ? getSettings() : {};
      if (typeof isPushConfigured !== 'function' || typeof sendPushToCustomer !== 'function' || !isPushConfigured(settings)) {
        throw new Error('OneSignal tagihan belum aktif atau belum lengkap.');
      }

      const requestBaseUrl = resolveRequestBaseUrl(req);
      const dueAt = getInvoiceDueDateLocal(inv);
      const dueText = dueAt ? dueAt.toLocaleDateString('id-ID') : '-';
      const title = `Tagihan INV-${inv.id}`;
      const body = `Tagihan ${inv.period_month}/${inv.period_year} sebesar Rp ${Number(inv.amount || 0).toLocaleString('id-ID')} jatuh tempo ${dueText}.`;
      const result = await sendPushToCustomer(customer, {
        settings,
        title,
        message: body,
        targetUrl: `${requestBaseUrl}/customer/dashboard#billing`,
        data: {
          kind: 'invoice',
          source: 'admin-manual-billing-push',
          invoiceId: Number(inv.id || 0) || null,
          customerId: Number(customer.id || 0) || null
        }
      });

      if (!result || result.success !== true) {
        throw new Error(result?.reason || result?.error || 'OneSignal tidak menerima push.');
      }

      customerSvc.addPortalNotification(customer.id, {
        kind: 'invoice',
        tab: 'billing',
        title,
        body,
        payload: {
          source: 'admin-manual-billing-push',
          senderName: 'Billing',
          senderRole: 'Tagihan',
          invoiceId: Number(inv.id || 0) || null
        }
      }, { dedupeWindowMs: 60 * 1000 });

      req.session._msg = { type: 'success', text: `Notifikasi tagihan push berhasil dikirim ke ${customer.name}.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim push tagihan: ' + e.message };
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
