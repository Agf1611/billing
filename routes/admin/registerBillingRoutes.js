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

  router.get('/billing', requireAdminSession, (req, res) => {
    const {
      month: filterMonth,
      year: rawFilterYear = new Date().getFullYear(),
      status: filterStatus = 'all',
      search = '',
      billingDayStart = '',
      billingDayEnd = '',
      page: rawPage = '1'
    } = req.query;
    const filterYear = parseInt(rawFilterYear, 10) || new Date().getFullYear();
    const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = 25;
    let invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search });
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
    const summary = buildInvoiceSummaryFromList(invoices);
    const totalInvoicesCount = invoices.length;
    const totalPages = Math.max(1, Math.ceil(totalInvoicesCount / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const paginatedInvoices = invoices.slice((safePage - 1) * pageSize, safePage * pageSize);
    res.render('admin/billing', {
      title: 'Tagihan',
      company: company(),
      activePage: 'billing',
      invoices: paginatedInvoices,
      summary,
      filterMonth,
      filterYear,
      filterStatus,
      search,
      billingDayStart: normalizedBillingDayStart || '',
      billingDayEnd: normalizedBillingDayEnd || '',
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
      const inv = db.prepare('SELECT id, status, amount, qris_amount_unique FROM invoices WHERE id=?').get(invId);
      if (!inv) throw new Error('Tagihan tidak ditemukan');
      if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

      if (!force && inv.qris_amount_unique) {
        req.session._msg = { type: 'success', text: 'Kode QRIS sudah ada untuk tagihan ini.' };
        return redirectBack(res, '/admin/billing');
      }

      const baseAmount = Number(inv.amount || 0);
      if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

      const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
      const update = db.prepare(`
        UPDATE invoices
        SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=CURRENT_TIMESTAMP
        WHERE id=?
      `);

      let chosenCode = 0;
      let chosenAmount = 0;

      for (let i = 0; i < 50; i += 1) {
        const code = 1 + Math.floor(Math.random() * 999);
        const amount = baseAmount + code;
        if (!exists.get('unpaid', amount, invId)) {
          chosenCode = code;
          chosenAmount = amount;
          break;
        }
      }

      if (!chosenAmount) {
        for (let code = 1; code <= 999; code += 1) {
          const amount = baseAmount + code;
          if (!exists.get('unpaid', amount, invId)) {
            chosenCode = code;
            chosenAmount = amount;
            break;
          }
        }
      }

      if (!chosenAmount) throw new Error('Gagal membuat nominal unik (slot 1-999 penuh).');

      update.run(chosenCode, chosenAmount, invId);
      req.session._msg = { type: 'success', text: `Kode QRIS dibuat: Rp ${Number(chosenAmount).toLocaleString('id-ID')} (kode ${chosenCode}).` };
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
      const inv = billingSvc.getInvoiceById(req.params.id);
      if (!inv) throw new Error('Tagihan tidak ditemukan');

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

      const { sendWA, whatsappStatus } = await import('../../services/whatsappBot.mjs');

      if (whatsappStatus.connection !== 'open') {
        throw new Error('Bot WhatsApp belum terhubung. Silakan cek status WhatsApp di menu Admin.');
      }

      const qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
      const qrisCode = Number(inv.qris_unique_code || 0) || 0;
      const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();
      const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
      const requestBaseUrl = resolveRequestBaseUrl(req);
      let finalMessage = buildBillingWhatsappMessage(customer, unpaidInvoices, inv, { baseUrl: requestBaseUrl });

      if (qrisAmountUnique > 0 && qrisCode > 0) {
        const qrisLines = [
          '',
          'Pembayaran QRIS',
          `Nominal tepat: Rp ${Number(qrisAmountUnique).toLocaleString('id-ID')}`,
          `Kode unik: ${String(qrisCode).padStart(3, '0')}`
        ];
        if (qrisQrUrl) qrisLines.push(`QRIS: ${qrisQrUrl}`);
        finalMessage += `\n${qrisLines.join('\n')}`;
      }

      const manualPaymentInfo = buildManualPaymentMessage();
      if (manualPaymentInfo) finalMessage += `\n${manualPaymentInfo}`;

      const sent = await sendWA(customer.phone, finalMessage);
      if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

      req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name}.` };
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
