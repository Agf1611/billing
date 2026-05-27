const {
  DEFAULT_MAX_BYTES,
  persistCompressedImageUpload
} = require('../../services/imageUploadService');

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
    customerDetailSvc,
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
    sendPaidWhatsappNotification,
    usageSvc,
    isPushConfigured,
    sendPushToCustomer
  } = deps;

  const CUSTOMER_IMAGE_FIELDS = [
    { name: 'house_photo_file', maxCount: 1 },
    { name: 'ktp_photo_file', maxCount: 1 }
  ];

  function getUploadedFile(req, fieldName) {
    const files = req?.files;
    if (!files || !fieldName) return null;
    const bucket = files[fieldName];
    if (Array.isArray(bucket) && bucket[0] && bucket[0].buffer && Number(bucket[0].size || 0) > 0) return bucket[0];
    return null;
  }

  function isNewInstallForPeriod(customer, month, year) {
    const targetMonth = Number(month || 0) || 0;
    const targetYear = Number(year || 0) || 0;
    if (!targetMonth || !targetYear) return false;
    const rawValue = String(customer?.install_date || customer?.created_at || customer?.createdAt || '').trim();
    if (!rawValue) return false;
    const date = new Date(rawValue);
    if (Number.isNaN(date.getTime())) return false;
    return (date.getMonth() + 1) === targetMonth && date.getFullYear() === targetYear;
  }

  function isEnabledSwitch(value) {
    return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
  }

  function resolveAdminPathFromRequest(req, fallback = '/admin/customers') {
    const candidates = [
      req?.body?._admin_return_to,
      req?.body?.return_to,
      req?.query?._admin_return_to,
      req?.query?.return_to,
      req?.get ? req.get('referer') : '',
      fallback
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || '').trim();
      if (!raw) continue;
      try {
        const parsed = new URL(raw, 'http://admin.local');
        if (!parsed.pathname.startsWith('/admin')) continue;
        return `${parsed.pathname}${parsed.search || ''}`;
      } catch (_error) {
        if (raw.startsWith('/admin')) return raw;
      }
    }
    return fallback;
  }

  function buildPostIsolationRedirect(req, fallback = '/admin/customers?status=suspended') {
    const current = resolveAdminPathFromRequest(req, fallback);
    try {
      const parsed = new URL(current, 'http://admin.local');
      if (parsed.pathname === '/admin/billing') {
        parsed.searchParams.set('status', 'isolated');
        parsed.searchParams.set('page', '1');
        return `${parsed.pathname}${parsed.search}`;
      }
      if (parsed.pathname === '/admin/customers') {
        parsed.searchParams.set('status', 'suspended');
        parsed.searchParams.set('page', '1');
        return `${parsed.pathname}${parsed.search}`;
      }
    } catch (_error) {}
    return fallback;
  }

  function forceAdminRedirect(res, target) {
    res.statusCode = 302;
    res.setHeader('Location', target || '/admin');
    return res.end();
  }

  async function applySubmittedSpeedBoost(reqBody = {}, customer) {
    const profile = String(reqBody.speed_boost_profile || '').trim();
    if (!profile || !customer?.pppoe_username) return false;
    const untilRaw = String(reqBody.speed_boost_until || customer.speed_boost_until || '').trim();
    const untilDate = untilRaw ? new Date(untilRaw) : null;
    if (untilDate && !Number.isNaN(untilDate.getTime()) && untilDate.getTime() <= Date.now()) return false;
    await mikrotikService.setPppoeProfile(customer.pppoe_username, profile, customer.router_id, { forceKick: true });
    return true;
  }

  function queueManualIsolationNotifications({ req, customer, unpaidInvoices = [] }) {
    if (!customer?.id) return;
    const requestBaseUrl = resolveRequestBaseUrl(req);
    const unpaidTotal = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
    const periodLine = unpaidInvoices.length
      ? unpaidInvoices.map((inv) => `${inv.period_month}/${inv.period_year}`).join(', ')
      : 'tagihan aktif';
    const body = unpaidTotal > 0
      ? `Layanan internet Anda sementara diisolir. Tagihan belum lunas: Rp ${unpaidTotal.toLocaleString('id-ID')} (${periodLine}). Buka aplikasi pelanggan untuk bayar dan aktif kembali.`
      : 'Layanan internet Anda sementara diisolir. Buka aplikasi pelanggan untuk melihat status tagihan atau hubungi admin.';

    customerSvc.addPortalNotification(customer.id, {
      kind: 'suspension',
      tab: 'billing',
      title: 'Layanan internet diisolir',
      body,
      payload: {
        source: 'admin-manual-isolate',
        unpaidInvoiceIds: unpaidInvoices.map((inv) => Number(inv.id || 0)).filter(Boolean)
      }
    }, { dedupeWindowMs: 15 * 60 * 1000 });

    setImmediate(async () => {
      const settings = getSettings ? getSettings() : null;
      try {
        if (typeof isPushConfigured === 'function' && typeof sendPushToCustomer === 'function' && isPushConfigured(settings)) {
          await sendPushToCustomer(customer, {
            settings,
            title: 'Layanan Internet Diisolir',
            message: body,
            targetUrl: `${requestBaseUrl}/customer/dashboard#billing`,
            data: {
              kind: 'suspension',
              source: 'admin-manual-isolate',
              customerId: Number(customer.id || 0) || null
            },
            timeoutMs: 7000
          });
        }
      } catch (error) {
        logger.warn(`[ManualIsolation] Gagal kirim push pelanggan ${customer.id}: ${error.message || String(error)}`);
      }

      try {
        if (customer.phone) {
          const waSent = await trySendWhatsappPayment(
            customer.phone,
            buildIsolationWhatsappMessage(
              customer,
              unpaidInvoices,
              'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.',
              { baseUrl: requestBaseUrl }
            )
          );
          if (!waSent) logger.warn(`[ManualIsolation] WhatsApp isolir pelanggan ${customer.id} tidak terkirim.`);
        }
      } catch (error) {
        logger.warn(`[ManualIsolation] Gagal kirim WhatsApp pelanggan ${customer.id}: ${error.message || String(error)}`);
      }
    });
  }

  router.get('/customers', requireAdminSession, (req, res) => {
    const statusQueryProvided = Object.prototype.hasOwnProperty.call(req.query || {}, 'status');
    const {
      search = '',
      status: rawFilterStatus = '',
      segment: rawFilterSegment = '',
      billingDayStart = '',
      billingDayEnd = '',
      month: rawMonth = '',
      year: rawYear = '',
      page: rawPage = '1',
      sortBy: rawSortBy = 'name',
      sortDir: rawSortDir = 'asc',
      package_id: rawPackageId = ''
    } = req.query;
    const now = new Date();
    const selectedMonth = Math.min(12, Math.max(1, parseInt(rawMonth, 10) || (now.getMonth() + 1)));
    const selectedYear = parseInt(rawYear, 10) || now.getFullYear();
    const currentPage = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = 25;
    const normalizedBillingDayStart = Math.max(0, parseInt(billingDayStart, 10) || 0);
    const normalizedBillingDayEnd = Math.max(0, parseInt(billingDayEnd, 10) || 0);
    const filterPackageId = Math.max(0, parseInt(rawPackageId, 10) || 0);
    const allowedSortBy = new Set(['name', 'address', 'package', 'status', 'billing']);
    const sortBy = allowedSortBy.has(String(rawSortBy || '').trim()) ? String(rawSortBy).trim() : 'name';
    const sortDir = String(rawSortDir || '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
    const monthKey = String(selectedMonth).padStart(2, '0');
    const yearKey = String(selectedYear);
    const normalizedFilterStatus = statusQueryProvided
      ? (String(rawFilterStatus || '').trim().toLowerCase() === 'all' ? '' : String(rawFilterStatus || '').trim().toLowerCase())
      : 'active';
    const normalizedFilterSegment = String(rawFilterSegment || '').trim().toLowerCase() === 'new' ? 'new' : '';
    const customers = customerSvc.getAllCustomers(search);
    const stats = customerSvc.getCustomerStats();
    const packages = customerSvc.getAllPackages();
    const routers = mikrotikService.getAllRouters();
    const olts = oltSvc.getAllOlts();
    const odps = odpSvc.getAllOdps();

    let filteredCustomers = normalizedFilterStatus
      ? customers.filter((customer) => customer.status === normalizedFilterStatus)
      : customers;

    if (filterPackageId > 0) {
      filteredCustomers = filteredCustomers.filter((customer) => Number(customer.package_id || 0) === filterPackageId);
    }

    if (normalizedBillingDayStart || normalizedBillingDayEnd) {
      filteredCustomers = filteredCustomers.filter((customer) => {
        const dueDay = Number(customer?.isolate_day || 0);
        if (!Number.isFinite(dueDay) || dueDay <= 0) return false;
        if (normalizedBillingDayStart && dueDay < normalizedBillingDayStart) return false;
        if (normalizedBillingDayEnd && dueDay > normalizedBillingDayEnd) return false;
        return true;
      });
    }

    if (normalizedFilterSegment === 'new') {
      filteredCustomers = filteredCustomers.filter((customer) => isNewInstallForPeriod(customer, selectedMonth, selectedYear));
    }

    const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), 'id', { sensitivity: 'base' });
    const resolveStatusOrder = (customer) => {
      const statusKey = String(customer?.status || '').trim().toLowerCase();
      if (statusKey === 'suspended') return 0;
      if (statusKey === 'active') return 1;
      if (statusKey === 'inactive') return 2;
      return 3;
    };
    const resolveIsolateDay = (customer) => {
      if (Number(customer?.auto_isolate || 0) === 0) return 99;
      const day = Number(customer?.isolate_day || 0);
      return Number.isFinite(day) && day > 0 ? day : 99;
    };

    filteredCustomers = [...filteredCustomers].sort((left, right) => {
      let result = 0;
      if (sortBy === 'address') {
        result = compareText(left?.address, right?.address);
        if (result === 0) result = compareText(left?.name, right?.name);
      } else if (sortBy === 'package') {
        result = compareText(left?.package_name, right?.package_name);
        if (result === 0) result = compareText(left?.name, right?.name);
      } else if (sortBy === 'status') {
        result = resolveIsolateDay(left) - resolveIsolateDay(right);
        if (result === 0) result = resolveStatusOrder(left) - resolveStatusOrder(right);
        if (result === 0) result = compareText(left?.name, right?.name);
      } else if (sortBy === 'billing') {
        const leftUnpaid = Number(left?.unpaid_count || 0);
        const rightUnpaid = Number(right?.unpaid_count || 0);
        result = leftUnpaid - rightUnpaid;
        if (result === 0) result = resolveIsolateDay(left) - resolveIsolateDay(right);
        if (result === 0) result = compareText(left?.name, right?.name);
      } else {
        result = compareText(left?.name, right?.name);
        if (result === 0) result = compareText(left?.address, right?.address);
      }
      return sortDir === 'desc' ? (result * -1) : result;
    });

    const activeRevenue = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(p.price, 0)), 0) AS total
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.status = 'active'
    `).get();
    const newCustomers = db.prepare(`
      SELECT COUNT(*) AS c
      FROM customers
      WHERE strftime('%m', COALESCE(NULLIF(install_date, ''), created_at)) = ?
        AND strftime('%Y', COALESCE(NULLIF(install_date, ''), created_at)) = ?
    `).get(monthKey, yearKey);
    const unpaidInvoices = db.prepare(`
      SELECT COUNT(DISTINCT i.customer_id) AS count, COALESCE(SUM(i.amount), 0) AS total
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.period_month = ? AND i.period_year = ? AND i.status = 'unpaid'
        AND COALESCE(c.status, 'active') <> 'suspended'
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
      filterStatus: normalizedFilterStatus,
      filterSegment: normalizedFilterSegment,
      statusQueryProvided,
      selectedMonth,
      selectedYear,
      customerOverview,
      billingDayStart: normalizedBillingDayStart || '',
      billingDayEnd: normalizedBillingDayEnd || '',
      filterPackageId,
      sortBy,
      sortDir,
      currentPage: safePage,
      totalPages,
      totalCustomersCount,
      pageSize,
      msg: flashMsg(req),
      settings: getSettings()
    });
  });

  router.get('/api/customers/:id/detail', requireAdminSession, async (req, res) => {
    try {
      const year = parseInt(req.query.year || new Date().getFullYear(), 10);
      const forceNetworkRefresh = String(req.query.refreshNetwork || '') === '1';
      const detail = await customerDetailSvc.buildCustomerDetail(req.params.id, { year, forceNetworkRefresh });
      res.json(detail);
    } catch (e) {
      logger.error(`[AdminCustomers] Gagal memuat detail pelanggan ${req.params.id}: ${e.stack || e.message || e}`);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.post('/customers', requireAdminSession, upload.fields(CUSTOMER_IMAGE_FIELDS), async (req, res) => {
    try {
      req.body = req.body || {};
      const housePhotoFile = getUploadedFile(req, 'house_photo_file');
      const ktpPhotoFile = getUploadedFile(req, 'ktp_photo_file');
      const housePhotoResult = housePhotoFile
        ? await persistCompressedImageUpload(housePhotoFile, 'admin-house-photo', { maxBytes: DEFAULT_MAX_BYTES })
        : null;
      const ktpPhotoResult = ktpPhotoFile
        ? await persistCompressedImageUpload(ktpPhotoFile, 'admin-ktp-photo', { maxBytes: DEFAULT_MAX_BYTES })
        : null;
      const housePhotoUrl = housePhotoResult?.publicUrl || '';
      const ktpPhotoUrl = ktpPhotoResult?.publicUrl || '';
      req.body.nik = String(req.body.nik || '').trim();
      req.body.npwp = String(req.body.npwp || '').trim();
      req.body.house_photo_url = housePhotoUrl;
      req.body.ktp_photo_url = ktpPhotoUrl;
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

      try {
        if (await applySubmittedSpeedBoost(req.body, createdCustomer)) {
          syncWarnings.push(`Boost paket "${String(req.body.speed_boost_profile || '').trim()}" langsung diterapkan.`);
        }
      } catch (boostErr) {
        syncWarnings.push(`Boost paket belum berhasil diterapkan: ${boostErr.message}`);
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
      logger.error(`[AdminCustomers] Gagal menambahkan pelanggan: ${e.stack || e.message || e}`);
      req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/:id/update', requireAdminSession, upload.fields(CUSTOMER_IMAGE_FIELDS), async (req, res) => {
    try {
      req.body = req.body || {};
      const housePhotoFile = getUploadedFile(req, 'house_photo_file');
      const ktpPhotoFile = getUploadedFile(req, 'ktp_photo_file');
      req.body.nik = String(req.body.nik || '').trim();
      req.body.npwp = String(req.body.npwp || '').trim();
      if (housePhotoFile) {
        const housePhotoResult = await persistCompressedImageUpload(housePhotoFile, 'admin-house-photo', { maxBytes: DEFAULT_MAX_BYTES });
        req.body.house_photo_url = housePhotoResult.publicUrl;
      }
      if (ktpPhotoFile) {
        const ktpPhotoResult = await persistCompressedImageUpload(ktpPhotoFile, 'admin-ktp-photo', { maxBytes: DEFAULT_MAX_BYTES });
        req.body.ktp_photo_url = ktpPhotoResult.publicUrl;
      }
      const syncWarnings = [];
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
      const updatedCustomer = customerSvc.getCustomerById(req.params.id);

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
            syncWarnings.push(`Profil PPPoE belum berhasil disinkronkan: ${mErr.message}`);
          }
        }
      }

      try {
        if (await applySubmittedSpeedBoost(req.body, updatedCustomer)) {
          syncWarnings.push(`Boost paket "${String(req.body.speed_boost_profile || '').trim()}" langsung diterapkan.`);
        }
      } catch (boostErr) {
        syncWarnings.push(`Boost paket belum berhasil diterapkan: ${boostErr.message}`);
      }

      const warningText = syncWarnings.length ? ` Catatan: ${syncWarnings.join(' | ')}` : '';
      req.session._msg = { type: 'success', text: `Data pelanggan berhasil diperbarui.${warningText}` };
    } catch (e) {
      logger.error(`[AdminCustomers] Gagal memperbarui pelanggan ${req.params.id}: ${e.stack || e.message || e}`);
      req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
    try {
      await customerSvc.deleteCustomer(req.params.id);
      req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
    } catch (e) {
      logger.error(`[AdminCustomers] Gagal menghapus pelanggan ${req.params.id}: ${e.stack || e.message || e}`);
      req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    }
    res.redirect('/admin/customers');
  });

  function buildCustomerImportTemplateWorkbook() {
    const templateHeaders = [
      'ID Pelanggan',
      'Nama',
      'Telepon',
      'Email',
      'Alamat',
      'Paket',
      'Tag ONU',
      'PPPoE Username',
      'PPPoE Profile',
      'Isolir Profile',
      'Status',
      'Tanggal Pasang',
      'Auto Isolir',
      'Tgl Isolir',
      'ODP',
      'Latitude',
      'Longitude',
      'Catatan'
    ];

    const wsTemplate = XLSX.utils.aoa_to_sheet([
      templateHeaders,
      ['', '', '', '', '', '', '', '', '', 'BEATISOLIR', 'active', '', 'YA', '10', '', '', '', '']
    ]);
    wsTemplate['!cols'] = templateHeaders.map((header) => ({
      wch: Math.max(String(header).length + 4, 14)
    }));

    const wsGuide = XLSX.utils.aoa_to_sheet([
      ['Panduan Import Pelanggan'],
      ['1. Isi data mulai baris ke-2.'],
      ['2. Kolom wajib minimal: Nama. ID Pelanggan boleh dikosongkan agar dibuat otomatis.'],
      ['3. Kolom Paket harus sama persis dengan nama paket di aplikasi.'],
      ['4. Kolom ODP harus sama persis dengan nama ODP di aplikasi jika dipakai.'],
      ['5. Status yang disarankan: active, suspended, inactive.'],
      ['6. Auto Isolir isi YA atau TIDAK.'],
      ['7. Format tanggal pasang disarankan YYYY-MM-DD.'],
      ['8. Isolir Profile default yang dipakai sistem saat ini: BEATISOLIR.'],
      ['9. Hapus contoh kosong pada baris ke-2 jika tidak dipakai.']
    ]);
    wsGuide['!cols'] = [{ wch: 88 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsTemplate, 'Template Import');
    XLSX.utils.book_append_sheet(wb, wsGuide, 'Panduan');
    return wb;
  }

  router.get('/customers/import-template', requireAdminSession, (req, res) => {
    try {
      const wb = buildCustomerImportTemplateWorkbook();
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Disposition', 'attachment; filename=template_import_pelanggan.xlsx');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    } catch (e) {
      logger.error('Import template error:', e);
      res.status(500).send('Gagal membuat template import.');
    }
  });

  router.get('/customers/export', requireAdminSession, (req, res) => {
    try {
      const customers = customerSvc.getAllCustomers();
      const headers = [
        'ID Sistem',
        'ID Pelanggan',
        'Nama',
        'Telepon',
        'Email',
        'Alamat',
        'Paket',
        'Tag ONU',
        'PPPoE Username',
        'PPPoE Profile',
        'Isolir Profile',
        'Status',
        'Tanggal Pasang',
        'Auto Isolir',
        'Tgl Isolir',
        'ODP',
        'Latitude',
        'Longitude',
        'Catatan'
      ];
      const mapCustomerRow = (customer) => ([
        customer.id,
        customer.customer_code || '',
        customer.name,
        customer.phone,
        customer.email || '',
        customer.address,
        customer.package_name || '-',
        customer.genieacs_tag,
        customer.pppoe_username,
        customer.normal_pppoe_profile || customer.package_pppoe_profile || customer.package_name || '',
        customer.isolir_profile,
        customer.status,
        customer.install_date,
        customer.auto_isolate === 1 ? 'YA' : 'TIDAK',
        customer.isolate_day,
        customer.odp_name || '-',
        customer.lat || '',
        customer.lng || '',
        customer.notes
      ]);
      const buildCustomerSheet = (rows) => {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map(mapCustomerRow)]);
        ws['!cols'] = headers.map((header) => ({ wch: Math.max(String(header).length + 4, 14) }));
        return ws;
      };
      const normalizeStatus = (value) => String(value || '').trim().toLowerCase();
      const activeCustomers = customers.filter((customer) => normalizeStatus(customer.status) === 'active');
      const inactiveCustomers = customers.filter((customer) => normalizeStatus(customer.status) === 'inactive');
      const suspendedCustomers = customers.filter((customer) => normalizeStatus(customer.status) === 'suspended');
      const wb = buildCustomerImportTemplateWorkbook();
      XLSX.utils.book_append_sheet(wb, buildCustomerSheet(activeCustomers), 'Pelanggan Aktif');
      XLSX.utils.book_append_sheet(wb, buildCustomerSheet(inactiveCustomers), 'Pelanggan Nonaktif');
      XLSX.utils.book_append_sheet(wb, buildCustomerSheet(suspendedCustomers), 'Pelanggan Isolir');

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
          customer_code: cleanRow['ID Pelanggan'] || cleanRow.customer_code || cleanRow.kode_pelanggan || '',
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

        const id = cleanRow['ID Sistem'] || cleanRow.ID || cleanRow.id;
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
    let redirectTarget = buildPostIsolationRedirect(req);
    try {
      await customerSvc.suspendCustomer(req.params.id);
      const customer = customerSvc.getCustomerById(req.params.id);
      const unpaidInvoices = customer ? billingSvc.getUnpaidInvoicesByCustomerId(customer.id) : [];
      if (customer) {
        queueManualIsolationNotifications({ req, customer, unpaidInvoices });
      }
      req.session._msg = { type: 'success', text: `Pelanggan "${customer?.name || req.params.id}" berhasil di-isolir manual. Info internet dimatikan sudah masuk inbox pelanggan, push/WhatsApp sedang dikirim.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
      redirectTarget = resolveAdminPathFromRequest(req, '/admin/customers');
    }
    return forceAdminRedirect(res, redirectTarget);
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

  router.post('/customers/:id/usage/reset', requireAdminSession, restrictToAdmin, async (req, res) => {
    try {
      const customer = customerSvc.getCustomerById(req.params.id);
      if (!customer) throw new Error('Pelanggan tidak ditemukan.');

      let baselineIn = 0;
      let baselineOut = 0;
      let sessionId = '';
      let uptime = '';
      let baselineNote = 'Usage reset by admin without live baseline';

      if (customer.router_id && customer.pppoe_username) {
        try {
          const liveTraffic = await customerDetailSvc.resolvePppoeTrafficLive(
            String(customer.pppoe_username || '').trim(),
            Number(customer.router_id || 0) || null
          );

          if (liveTraffic && liveTraffic.online) {
            baselineIn = Math.max(0, Number(liveTraffic.bytesIn || 0) || 0);
            baselineOut = Math.max(0, Number(liveTraffic.bytesOut || 0) || 0);
            sessionId = String(liveTraffic.sessionId || '').trim();
            uptime = String(liveTraffic.uptime || '').trim();
            baselineNote = `Usage reset by admin with live baseline (${String(liveTraffic.source || 'live')})`;
          } else {
            const activeSessions = await mikrotikService.getPppoeActive(Number(customer.router_id));
            const username = String(customer.pppoe_username || '').trim().toLowerCase();
            const active = (Array.isArray(activeSessions) ? activeSessions : []).find((row) => {
              return String(row?.name || '').trim().toLowerCase() === username;
            });
            if (active) {
              baselineIn = Math.max(
                0,
                Number(
                  active['bytes-in']
                  ?? active.bytesIn
                  ?? active.bytes_in
                  ?? active.rxBytes
                  ?? 0
                ) || 0
              );
              baselineOut = Math.max(
                0,
                Number(
                  active['bytes-out']
                  ?? active.bytesOut
                  ?? active.bytes_out
                  ?? active.txBytes
                  ?? 0
                ) || 0
              );
              sessionId = String(active['session-id'] ?? active.sessionId ?? active['.id'] ?? active.id ?? '').trim();
              uptime = String(active.uptime || active['uptime'] || '').trim();
              baselineNote = 'Usage reset by admin with PPP active baseline';
            }
          }
        } catch (mikrotikErr) {
          logger.warn(`[AdminCustomers] Reset usage baseline live gagal untuk customer ${customer.id}: ${mikrotikErr.message}`);
        }
      }

      usageSvc.resetUsageForCurrentPeriod(customer.id, baselineIn, baselineOut, new Date(), {
        sessionId,
        uptime,
        note: baselineNote
      });

      const liveNote = baselineIn > 0 || baselineOut > 0
        ? ' Baseline live MikroTik ikut disimpan agar akumulasi berikutnya lanjut dari posisi sekarang.'
        : ' Baseline live tidak ditemukan, jadi usage bulan ini direset ke nol.';
      req.session._msg = {
        type: 'success',
        text: `Penggunaan data bulan ini untuk "${customer.name}" berhasil direset.${liveNote}`
      };
    } catch (e) {
      logger.error(`[AdminCustomers] Gagal reset usage pelanggan ${req.params.id}: ${e.stack || e.message || e}`);
      req.session._msg = { type: 'error', text: `Gagal reset penggunaan data: ${e.message || String(e)}` };
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
        const voided = Number(sum.voidedMonths || 0);
        const total = Number(sum.totalAmount) || 0;
        req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}, hangus prabayar: ${voided}.` };

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
      if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && freshCustomer.unpaid_count === 0) {
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
