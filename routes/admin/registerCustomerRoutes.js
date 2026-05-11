module.exports = function registerCustomerRoutes(router, deps = {}) {
  const {
    express,
    upload,
    requireAdminSession,
    restrictToAdmin,
    company,
    flashMsg,
    getSettings,
    customerSvc,
    mikrotikService,
    oltSvc,
    odpSvc,
    billingSvc,
    db,
    logger,
    XLSX,
    isTruthyFormValue,
    getExistingPppoeSecretByUsername,
    resolveCustomerPppoeProfile,
    resolveAvailablePppoeProfile,
    buildWelcomeWhatsappMessage,
    buildIsolationWhatsappMessage,
    resolveRequestBaseUrl,
    trySendWhatsappPayment,
    redirectBack,
    resolvePaidByName,
    sendPaidWhatsappNotification
  } = deps;

  router.get('/customers', requireAdminSession, (req, res) => {
    const {
      search = '',
      status: filterStatus = '',
      billingDayStart = '',
      billingDayEnd = '',
      month: rawMonth = '',
      year: rawYear = '',
      page: rawPage = '1'
    } = req.query;
    const now = new Date();
    const selectedMonth = Math.min(12, Math.max(1, parseInt(rawMonth, 10) || (now.getMonth() + 1)));
    const selectedYear = parseInt(rawYear, 10) || now.getFullYear();
    const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = 25;
    const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
    const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
    const monthKey = String(selectedMonth).padStart(2, '0');
    const yearKey = String(selectedYear);
    const customers = customerSvc.getAllCustomers(search);
    const stats = customerSvc.getCustomerStats();
    const packages = customerSvc.getAllPackages();
    const routers = mikrotikService.getAllRouters();
    const olts = oltSvc.getAllOlts();
    const odps = odpSvc.getAllOdps();

    let filteredCustomers = filterStatus
      ? customers.filter((customer) => customer.status === filterStatus)
      : customers;

    if (normalizedBillingDayStart || normalizedBillingDayEnd) {
      filteredCustomers = filteredCustomers.filter((customer) => {
        const dueDay = Number(customer?.isolate_day || 0);
        if (!Number.isFinite(dueDay) || dueDay <= 0) return false;
        if (normalizedBillingDayStart && dueDay < normalizedBillingDayStart) return false;
        if (normalizedBillingDayEnd && dueDay > normalizedBillingDayEnd) return false;
        return true;
      });
    }

    const activeRevenue = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(p.price, 0)), 0) AS total
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.status = 'active'
    `).get();
    const newCustomers = db.prepare(`
      SELECT COUNT(*) AS c
      FROM customers
      WHERE strftime('%m', created_at) = ? AND strftime('%Y', created_at) = ?
    `).get(monthKey, yearKey);
    const unpaidInvoices = db.prepare(`
      SELECT COUNT(DISTINCT customer_id) AS count, COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE period_month = ? AND period_year = ? AND status = 'unpaid'
    `).get(selectedMonth, selectedYear);
    const paidInvoices = db.prepare(`
      SELECT COUNT(DISTINCT customer_id) AS count, COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE period_month = ? AND period_year = ? AND status = 'paid'
    `).get(selectedMonth, selectedYear);
    const cashPayments = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE status = 'paid'
        AND strftime('%m', paid_at) = ?
        AND strftime('%Y', paid_at) = ?
        AND (payment_gateway IS NULL OR TRIM(payment_gateway) = '')
    `).get(monthKey, yearKey);
    const onlinePayments = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE status = 'paid'
        AND strftime('%m', paid_at) = ?
        AND strftime('%Y', paid_at) = ?
        AND payment_gateway IS NOT NULL
        AND TRIM(payment_gateway) <> ''
    `).get(monthKey, yearKey);

    const customerOverview = {
      month: selectedMonth,
      year: selectedYear,
      totalCustomers: Number(stats.total || 0),
      activeCustomers: Number(stats.active || 0),
      activeRevenue: Number(activeRevenue?.total || 0),
      newCustomers: Number(newCustomers?.c || 0),
      unpaidCustomers: Number(unpaidInvoices?.count || 0),
      unpaidAmount: Number(unpaidInvoices?.total || 0),
      paidCustomers: Number(paidInvoices?.count || 0),
      paidAmount: Number(paidInvoices?.total || 0),
      cashTransactions: Number(cashPayments?.count || 0),
      cashAmount: Number(cashPayments?.total || 0),
      onlineTransactions: Number(onlinePayments?.count || 0),
      onlineAmount: Number(onlinePayments?.total || 0),
      suspendedCustomers: Number(stats.suspended || 0),
      inactiveCustomers: Number(stats.inactive || 0)
    };

    const totalCustomersCount = filteredCustomers.length;
    const totalPages = Math.max(1, Math.ceil(totalCustomersCount / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const paginatedCustomers = filteredCustomers.slice((safePage - 1) * pageSize, safePage * pageSize);

    res.render('admin/customers', {
      title: 'Data Pelanggan',
      company: company(),
      activePage: 'customers',
      customers: paginatedCustomers,
      stats,
      packages,
      routers,
      olts,
      odps,
      search,
      filterStatus,
      selectedMonth,
      selectedYear,
      customerOverview,
      billingDayStart: normalizedBillingDayStart || '',
      billingDayEnd: normalizedBillingDayEnd || '',
      currentPage: safePage,
      totalPages,
      totalCustomersCount,
      pageSize,
      msg: flashMsg(req),
      settings: getSettings()
    });
  });

  router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const syncWarnings = [];
      if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
        const routerId = req.body.router_id ? Number(req.body.router_id) : null;
        const username = String(req.body.pppoe_username || '').trim();
        const shouldCreateSecret = isTruthyFormValue(req.body.create_pppoe_secret);
        const pppoePassword = String(req.body.pppoe_password || '').trim();
        req.body.pppoe_username = username;
        if (!username) throw new Error('PPPoE Username tidak boleh kosong');
        const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId, username);
        if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

        let existingSecret = null;
        let lookupFailed = false;
        try {
          existingSecret = await getExistingPppoeSecretByUsername(username, routerId);
        } catch (lookupErr) {
          lookupFailed = true;
          syncWarnings.push(`Secret PPPoE belum bisa dicek ke MikroTik: ${lookupErr.message}`);
        }

        if (!existingSecret && !lookupFailed) {
          if (!shouldCreateSecret) {
            syncWarnings.push('PPPoE Username belum ditemukan di MikroTik, tetapi data pelanggan tetap disimpan.');
          } else {
            const desiredProfile = resolveCustomerPppoeProfile(
              req.body.package_id,
              req.body.status,
              req.body.isolir_profile,
              req.body.normal_pppoe_profile
            );
            const targetProfile = await resolveAvailablePppoeProfile(desiredProfile, routerId, 'default');
            const secretPassword = pppoePassword || username;
            try {
              await mikrotikService.addPppoeSecret({
                name: username,
                password: secretPassword,
                service: 'pppoe',
                profile: targetProfile,
                comment: req.body.name ? `Customer: ${String(req.body.name).trim()}` : ''
              }, routerId);
              if (targetProfile !== desiredProfile) {
                syncWarnings.push(`Secret PPPoE dibuat dengan profile "${targetProfile}" karena profile "${desiredProfile}" belum tersedia di router.`);
              }
            } catch (secretErr) {
              syncWarnings.push(`Secret PPPoE belum berhasil dibuat otomatis: ${secretErr.message}`);
            }
          }
        }
      }

      const createResult = customerSvc.createCustomer(req.body);
      const createdCustomer = customerSvc.getCustomerById(createResult.lastInsertRowid);

      if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
        const desiredProfile = resolveCustomerPppoeProfile(
          req.body.package_id,
          req.body.status,
          req.body.isolir_profile,
          req.body.normal_pppoe_profile
        );
        const targetProfile = await resolveAvailablePppoeProfile(
          desiredProfile,
          req.body.router_id ? Number(req.body.router_id) : null,
          'default'
        );
        if (targetProfile) {
          try {
            await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
            if (targetProfile !== desiredProfile) {
              syncWarnings.push(`Profile PPPoE pelanggan disetel ke "${targetProfile}" karena profile "${desiredProfile}" belum tersedia di router.`);
            }
          } catch (mErr) {
            console.error('Mikrotik sync error (create):', mErr);
            syncWarnings.push(`Profil PPPoE belum berhasil disinkronkan: ${mErr.message}`);
          }
        }
      }

      if (createdCustomer && createdCustomer.phone) {
        const welcomeMessage = buildWelcomeWhatsappMessage(createdCustomer, { baseUrl: resolveRequestBaseUrl(req) });
        if (welcomeMessage) {
          await trySendWhatsappPayment(createdCustomer.phone, welcomeMessage);
        }
      }

      const warningText = syncWarnings.length ? ` Catatan: ${syncWarnings.join(' | ')}` : '';
      req.session._msg = { type: 'success', text: `Pelanggan "${req.body.name}" berhasil ditambahkan.${warningText}` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
        const customerId = Number(req.params.id);
        const routerId = req.body.router_id ? Number(req.body.router_id) : null;
        const username = String(req.body.pppoe_username || '').trim();
        req.body.pppoe_username = username;
        if (!username) throw new Error('PPPoE Username tidak boleh kosong');
        const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(routerId, username, customerId);
        if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

        let conn = null;
        try {
          conn = await mikrotikService.getConnection(routerId);
          const results = await conn.client.menu('/ppp/secret')
            .where('service', 'pppoe')
            .where('name', username)
            .get();
          if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
        } finally {
          if (conn && conn.api) conn.api.close();
        }
      }

      customerSvc.updateCustomer(req.params.id, req.body);

      if (req.body.connection_type !== 'static' && req.body.pppoe_username) {
        const desiredProfile = resolveCustomerPppoeProfile(
          req.body.package_id,
          req.body.status,
          req.body.isolir_profile,
          req.body.normal_pppoe_profile
        );
        const targetProfile = await resolveAvailablePppoeProfile(
          desiredProfile,
          req.body.router_id ? Number(req.body.router_id) : null,
          'default'
        );
        if (targetProfile) {
          try {
            await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
          } catch (mErr) {
            console.error('Mikrotik sync error (update):', mErr);
          }
        }
      }

      req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
    try {
      await customerSvc.deleteCustomer(req.params.id);
      req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.get('/customers/export', requireAdminSession, (req, res) => {
    try {
      const customers = customerSvc.getAllCustomers();
      const data = customers.map((customer) => ({
        ID: customer.id,
        Nama: customer.name,
        Telepon: customer.phone,
        Email: customer.email || '',
        Alamat: customer.address,
        Paket: customer.package_name || '-',
        'Tag ONU': customer.genieacs_tag,
        'PPPoE Username': customer.pppoe_username,
        'PPPoE Profile': customer.normal_pppoe_profile || customer.package_pppoe_profile || customer.package_name || '',
        'Isolir Profile': customer.isolir_profile,
        Status: customer.status,
        'Tanggal Pasang': customer.install_date,
        'Auto Isolir': customer.auto_isolate === 1 ? 'YA' : 'TIDAK',
        'Tgl Isolir': customer.isolate_day,
        ODP: customer.odp_name || '-',
        Latitude: customer.lat || '',
        Longitude: customer.lng || '',
        Catatan: customer.notes
      }));

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    } catch (e) {
      logger.error('Export error:', e);
      res.status(500).send('Gagal export data.');
    }
  });

  router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) throw new Error('File tidak ditemukan');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);
      logger.info(`[Import] Found ${rows.length} rows in Excel file.`);

      const packages = customerSvc.getAllPackages();
      const odps = odpSvc.getAllOdps();
      let count = 0;

      for (const row of rows) {
        const cleanRow = {};
        Object.keys(row).forEach((key) => {
          cleanRow[key.trim()] = row[key];
        });

        const name = cleanRow.Nama || cleanRow.name || cleanRow.Name;
        if (!name) {
          logger.debug('[Import] Skipping row - Name is empty.');
          continue;
        }

        const pkgName = cleanRow.Paket || cleanRow.package || cleanRow.Package;
        const pkg = packages.find((item) => item.name === pkgName);
        const odpName = cleanRow.ODP || cleanRow.odp || cleanRow['ODP Name'];
        const odp = odps.find((item) => item.name === odpName);

        const data = {
          name,
          phone: cleanRow.Telepon || cleanRow.phone || cleanRow.Phone,
          email: cleanRow.Email || cleanRow.email || cleanRow.email_address,
          address: cleanRow.Alamat || cleanRow.address || cleanRow.Address,
          package_id: pkg ? pkg.id : null,
          odp_id: odp ? odp.id : null,
          lat: cleanRow.Latitude || cleanRow.latitude || cleanRow.Lat || '',
          lng: cleanRow.Longitude || cleanRow.longitude || cleanRow.Lng || '',
          genieacs_tag: cleanRow['Tag ONU'] || cleanRow.genieacs_tag,
          pppoe_username: cleanRow['PPPoE Username'] || cleanRow.pppoe_username,
          normal_pppoe_profile: cleanRow['PPPoE Profile'] || cleanRow.pppoe_profile || '',
          isolir_profile: cleanRow['Isolir Profile'] || cleanRow.isolir_profile || 'BEATISOLIR',
          status: (cleanRow.Status || cleanRow.status || 'active').toLowerCase(),
          install_date: cleanRow['Tanggal Pasang'] || cleanRow.install_date,
          auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow.auto_isolate === 0) ? 0 : 1,
          isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow.isolate_day, 10) || 10,
          notes: cleanRow.Catatan || cleanRow.notes
        };

        const id = cleanRow.ID || cleanRow.id;
        if (id && !Number.isNaN(Number(id)) && id !== '') {
          logger.info(`[Import] Updating customer ID: ${id}`);
          customerSvc.updateCustomer(id, data);
        } else {
          logger.info(`[Import] Creating new customer: ${name}`);
          customerSvc.createCustomer(data);
        }
        count += 1;
      }

      logger.info(`[Import] Finished. Total processed: ${count}`);
      req.session._msg = { type: 'success', text: `Berhasil mengimpor ${count} data pelanggan.` };
    } catch (e) {
      logger.error('Import error:', e);
      req.session._msg = { type: 'error', text: 'Gagal impor: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
    try {
      await customerSvc.suspendCustomer(req.params.id);
      const customer = customerSvc.getCustomerById(req.params.id);
      const unpaidInvoices = customer ? billingSvc.getUnpaidInvoicesByCustomerId(customer.id) : [];
      if (customer && customer.phone) {
        const requestBaseUrl = resolveRequestBaseUrl(req);
        await trySendWhatsappPayment(
          customer.phone,
          buildIsolationWhatsappMessage(
            customer,
            unpaidInvoices,
            'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.',
            { baseUrl: requestBaseUrl }
          )
        );
      }
      req.session._msg = { type: 'success', text: `Pelanggan "${customer.name}" berhasil di-isolir manual.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
    try {
      await customerSvc.activateCustomer(req.params.id);
      const customer = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Layanan pelanggan "${customer.name}" berhasil diaktifkan kembali.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      const { month, year } = req.body;
      const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month, 10), parseInt(year, 10));
      if (result.created) {
        req.session._msg = { type: 'success', text: `Tagihan berhasil dibuat untuk "${result.customerName}" periode ${month}/${year}.` };
      } else {
        req.session._msg = { type: 'success', text: `Tagihan sudah ada untuk "${result.customerName}" periode ${month}/${year}.` };
      }
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal generate tagihan: ' + e.message };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
    try {
      const result = customerSvc.resetPromoCyclesUsed(req.params.id);
      if (!result.changes) {
        req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
      } else {
        const customer = customerSvc.getCustomerById(req.params.id);
        req.session._msg = { type: 'success', text: `Counter promo untuk "${customer ? customer.name : req.params.id}" di-reset (siklus promo dihitung ulang dari awal).` };
      }
    } catch (e) {
      req.session._msg = { type: 'error', text: e.message || String(e) };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
    try {
      const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
      req.session._msg = {
        type: 'success',
        text: `Tagihan susulan prorata untuk "${out.customerName}" periode ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sebesar Rp ${Number(out.amount).toLocaleString('id-ID')} (${out.billableDays}/${out.daysInMonth} hari).`
      };
    } catch (e) {
      req.session._msg = { type: 'error', text: e.message || String(e) };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const { month, months, year, paid_by_name, notes } = req.body;
      const y = parseInt(year, 10);
      const paidBy = resolvePaidByName(req, paid_by_name);
      const customer = customerSvc.getCustomerById(req.params.id);

      if (months != null) {
        const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
        const done = sum.paidMonths.length;
        const already = sum.alreadyPaidMonths.length;
        const created = sum.createdMonths.length;
        const total = Number(sum.totalAmount) || 0;
        req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}.` };

        if (customer && customer.phone && done > 0) {
          const paidInvoices = (Array.isArray(sum.paidMonths) ? sum.paidMonths : [])
            .map((paidMonth) => {
              const allInvoices = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
              return (Array.isArray(allInvoices) ? allInvoices : []).find(
                (item) => Number(item?.period_month) === Number(paidMonth) && Number(item?.period_year) === Number(sum.year)
              ) || null;
            })
            .filter(Boolean);
          await sendPaidWhatsappNotification(customer, paidInvoices, paidInvoices[0] || null, {
            baseUrl: resolveRequestBaseUrl(req),
            paidBy,
            paidAt: new Date().toLocaleString('id-ID')
          });
        }
      } else {
        const m = parseInt(month, 10);
        const result = billingSvc.payInvoiceForCustomerPeriod(req.params.id, m, y, paidBy, notes);
        if (result.alreadyPaid) {
          req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" sudah lunas.` };
        } else {
          const verb = result.created ? 'dibuat & dilunasi' : 'dilunasi';
          req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" berhasil ${verb}.` };

          if (customer && customer.phone) {
            const invoices = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
            const inv = (Array.isArray(invoices) ? invoices : []).find((item) => Number(item?.period_month) === Number(m) && Number(item?.period_year) === Number(y)) || null;
            await sendPaidWhatsappNotification(customer, inv ? [inv] : [], inv, {
              baseUrl: resolveRequestBaseUrl(req),
              paidBy,
              paidAt: new Date().toLocaleString('id-ID')
            });
          }
        }
      }

      const freshCustomer = customerSvc.getAllCustomers().find((item) => String(item.id) === String(req.params.id));
      if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(req.params.id);
      }
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal bayar: ' + e.message };
    }
    return redirectBack(res, '/admin/customers');
  });

  router.get('/packages', requireAdminSession, (req, res) => {
    res.render('admin/packages', {
      title: 'Paket Internet',
      company: company(),
      activePage: 'packages',
      packages: customerSvc.getAllPackages(),
      msg: flashMsg(req)
    });
  });

  router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      customerSvc.createPackage(req.body);
      req.session._msg = { type: 'success', text: `Paket "${req.body.name}" berhasil ditambahkan.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    res.redirect('/admin/packages');
  });

  router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      customerSvc.updatePackage(req.params.id, req.body);
      req.session._msg = { type: 'success', text: 'Paket berhasil diperbarui.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    res.redirect('/admin/packages');
  });

  router.post('/packages/:id/delete', requireAdminSession, (req, res) => {
    try {
      customerSvc.deletePackage(req.params.id);
      req.session._msg = { type: 'success', text: 'Paket berhasil dihapus.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    res.redirect('/admin/packages');
  });
};
