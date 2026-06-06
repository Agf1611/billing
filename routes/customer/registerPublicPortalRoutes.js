function registerPublicPortalRoutes(router, deps) {
  const {
    getSettingsWithCache,
    customerSvc,
    billingSvc,
    getCustomerPaymentChannels,
    signPublicToken,
    verifyPublicToken
  } = deps;

  function resolveLoggedInCustomer(req) {
    const customerId = Number(req.session?.customerId || 0);
    if (Number.isFinite(customerId) && customerId > 0) {
      const byId = customerSvc.getCustomerById(customerId);
      if (byId) return byId;
    }

    const loginId = String(req.session?.phone || '').trim();
    if (!loginId) return null;
    return customerSvc.findCustomerByAny(loginId) || null;
  }

  function resolveCustomerLookup(customer, fallback = '') {
    return String(
      customer?.customer_code ||
      customer?.pppoe_username ||
      customer?.genieacs_tag ||
      customer?.phone ||
      customer?.id ||
      fallback ||
      ''
    ).trim();
  }

  function findCustomerForPublicBilling(query = '') {
    const raw = String(query || '').trim();
    if (!raw) return null;
    if (typeof customerSvc.findCustomerByPublicBillingLookup === 'function') {
      return customerSvc.findCustomerByPublicBillingLookup(raw);
    }
    return customerSvc.findCustomerByAny(raw);
  }

  function isUnpaidInvoice(invoice) {
    return String(invoice?.status || '').trim().toLowerCase() === 'unpaid';
  }

  function buildPublicInvoiceFlags(invoice, customer, now = new Date()) {
    const periodMonth = Number(invoice?.period_month || 0);
    const periodYear = Number(invoice?.period_year || 0);
    const periodKey = (periodYear * 100) + periodMonth;
    const currentKey = (now.getFullYear() * 100) + (now.getMonth() + 1);
    const status = String(invoice?.customer_status || customer?.status || '').trim().toLowerCase();
    const isCustomerIsolated = ['suspended', 'inactive', 'isolir', 'isolated', 'nonaktif', 'nonactive'].includes(status);
    const autoIsolate = Number(customer?.auto_isolate ?? invoice?.auto_isolate ?? 0) !== 0;
    const dueAt = typeof billingSvc.getInvoiceDueDate === 'function'
      ? billingSvc.getInvoiceDueDate(invoice, invoice?.due_day_snapshot || invoice?.isolate_day || customer?.isolate_day || 10)
      : null;
    const duePassed = dueAt instanceof Date && !Number.isNaN(dueAt.getTime()) && now.getTime() > dueAt.getTime();
    const pastPeriod = periodMonth > 0 && periodYear > 0 && periodKey < currentKey;
    const unpaid = isUnpaidInvoice(invoice);
    const isolated = unpaid && (isCustomerIsolated || (autoIsolate && duePassed));

    return {
      pastPeriod,
      duePassed: unpaid && duePassed,
      isolated,
      status
    };
  }

  function decorateInvoicesForPublic(invoices = [], customer = null) {
    const now = new Date();
    return (Array.isArray(invoices) ? invoices : []).map((invoice) => ({
      ...invoice,
      public_flags: buildPublicInvoiceFlags(invoice, customer, now)
    }));
  }

  function buildInvoicePaymentTokens(unpaidInvoices, customer, lookup, secret) {
    const exp = Date.now() + 15 * 60 * 1000;
    const invoiceTokens = (Array.isArray(unpaidInvoices) ? unpaidInvoices : []).reduce((acc, inv) => {
      acc[String(inv.id)] = signPublicToken(
        { invoiceId: Number(inv.id), customerId: Number(inv.customer_id), lookup, exp },
        secret
      );
      return acc;
    }, {});
    const invoiceIds = (Array.isArray(unpaidInvoices) ? unpaidInvoices : [])
      .map((inv) => Number(inv.id))
      .filter(Boolean);
    const bulkToken = invoiceIds.length > 1
      ? signPublicToken({ customerId: Number(customer?.id || 0), invoiceIds, lookup, exp }, secret)
      : '';
    return { invoiceTokens, bulkToken };
  }

  router.get('/tos', (req, res) => {
    const settings = getSettingsWithCache();
    res.render('tos', {
      settings,
      company: settings.company_header || 'ISP Kami',
      isLoggedIn: !!req.session.phone
    });
  });

  router.get('/privacy', (req, res) => {
    const settings = getSettingsWithCache();
    res.render('privacy', {
      settings,
      company: settings.company_header || 'ISP Kami',
      isLoggedIn: !!req.session.phone
    });
  });

  router.get('/about', (req, res) => {
    const settings = getSettingsWithCache();
    res.render('about', {
      settings,
      company: settings.company_header || 'ISP Kami',
      isLoggedIn: !!req.session.phone
    });
  });

  router.get('/contact', (req, res) => {
    const settings = getSettingsWithCache();
    res.render('contact', {
      settings,
      company: settings.company_header || 'ISP Kami',
      isLoggedIn: !!req.session.phone
    });
  });

  router.get('/login', (req, res) => {
    if (resolveLoggedInCustomer(req)) {
      return res.redirect('/customer/dashboard');
    }
    const settings = getSettingsWithCache();
    res.render('login', { error: null, settings, form: { rememberMe: true } });
  });

  router.get('/check-billing', async (req, res) => {
    const settings = getSettingsWithCache();
    const query = String(req.query.q || '').trim();
    const publicToken = String(req.query.t || req.query.token || '').trim();
    const error = String(req.query.err || '').trim() || null;
    const info = String(req.query.info || '').trim() || null;

    let customer = null;
    let invoices = [];
    let unpaidInvoices = [];
    let invoiceTokens = {};
    let bulkToken = '';
    let matches = [];
    let tokenError = '';
    const paymentChannels = await getCustomerPaymentChannels(settings);
    const secret = settings.session_secret || '';

    if (publicToken && verifyPublicToken) {
      const payload = verifyPublicToken(publicToken, secret);
      const invoiceId = Number(payload?.invoiceId || 0);
      const customerId = Number(payload?.customerId || 0);
      const invoiceIds = Array.isArray(payload?.invoiceIds)
        ? payload.invoiceIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
        : [];
      if (payload && customerId > 0 && (invoiceId > 0 || invoiceIds.length > 0)) {
        const tokenInvoiceIds = invoiceId > 0 ? [invoiceId] : invoiceIds;
        const tokenInvoices = tokenInvoiceIds
          .map((id) => billingSvc.getInvoiceById(id))
          .filter(Boolean)
          .filter((invoice) => Number(invoice.customer_id || 0) === customerId);
        if (tokenInvoices.length === tokenInvoiceIds.length) {
          customer = customerSvc.getCustomerById(customerId);
          if (customer) {
            const lookup = resolveCustomerLookup(customer, payload.lookup);
            invoices = billingSvc.getInvoicesByAny(lookup) || [];
            tokenInvoices.forEach((invoice) => {
              if (!invoices.some((item) => Number(item?.id || 0) === Number(invoice.id))) {
                invoices.unshift(invoice);
              }
            });
            invoices = decorateInvoicesForPublic(invoices, customer);
            unpaidInvoices = invoices.filter(isUnpaidInvoice);
            const paymentTokens = buildInvoicePaymentTokens(unpaidInvoices, customer, lookup, secret);
            invoiceTokens = paymentTokens.invoiceTokens;
            bulkToken = paymentTokens.bulkToken;
          }
        }
      }
      if (!customer && !error) {
        matches = [];
        tokenError = 'Link tagihan tidak valid atau sudah kadaluarsa.';
      }
    }

    if (!customer && query) {
      customer = findCustomerForPublicBilling(query);
      if (customer) {
        const lookup = resolveCustomerLookup(customer, query);
        invoices = decorateInvoicesForPublic(billingSvc.getInvoicesByAny(lookup) || [], customer);
        unpaidInvoices = invoices.filter(isUnpaidInvoice);
        const paymentTokens = buildInvoicePaymentTokens(unpaidInvoices, customer, lookup, secret);
        invoiceTokens = paymentTokens.invoiceTokens;
        bulkToken = paymentTokens.bulkToken;
      } else {
        const numericOnly = query.replace(/\D/g, '');
        const allowFuzzySearch = !numericOnly || /[a-z]/i.test(query);
        const invs = allowFuzzySearch ? (billingSvc.getInvoicesByAny(query) || []) : [];
        const unpaid = (Array.isArray(invs) ? invs : []).filter((item) => item && item.status === 'unpaid');
        const map = new Map();
        for (const inv of unpaid) {
          const customerId = Number(inv.customer_id || 0);
          if (!Number.isFinite(customerId) || customerId <= 0) continue;
          const prev = map.get(customerId) || {
            customer_id: customerId,
            customer_code: inv.customer_code || '',
            customer_name: inv.customer_name || '-',
            customer_phone: inv.customer_phone || '',
            unpaid_count: 0,
            total_amount: 0
          };
          prev.unpaid_count += 1;
          prev.total_amount += Number(inv.amount || 0) || 0;
          map.set(customerId, prev);
        }
        matches = Array.from(map.values()).sort((a, b) => {
          const au = Number(a.unpaid_count || 0);
          const bu = Number(b.unpaid_count || 0);
          if (au !== bu) return bu - au;
          return String(a.customer_name || '').localeCompare(String(b.customer_name || ''), 'id');
        });
      }
    }

    res.render('public_check_billing', {
      settings,
      query,
      customer,
      invoices,
      unpaidInvoices,
      invoiceTokens,
      bulkToken,
      matches,
      paymentChannels,
      error: error || tokenError || null,
      info
    });
  });
}

module.exports = { registerPublicPortalRoutes };
