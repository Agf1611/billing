function registerPublicPortalRoutes(router, deps) {
  const {
    getSettingsWithCache,
    customerSvc,
    billingSvc,
    getCustomerPaymentChannels,
    signPublicToken
  } = deps;

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
    const settings = getSettingsWithCache();
    res.render('login', { error: null, settings, form: { rememberMe: true } });
  });

  router.get('/check-billing', async (req, res) => {
    const settings = getSettingsWithCache();
    const query = String(req.query.q || '').trim();
    const error = String(req.query.err || '').trim() || null;
    const info = String(req.query.info || '').trim() || null;

    let customer = null;
    let invoices = [];
    let unpaidInvoices = [];
    let invoiceTokens = {};
    let matches = [];
    const paymentChannels = await getCustomerPaymentChannels(settings);

    if (query) {
      customer = customerSvc.findCustomerByAny(query);
      if (customer) {
        const lookup = customer.pppoe_username || customer.genieacs_tag || customer.phone || String(customer.id);
        invoices = billingSvc.getInvoicesByAny(lookup) || [];
        unpaidInvoices = invoices.filter((item) => item.status === 'unpaid');

        const secret = settings.session_secret || '';
        const exp = Date.now() + 15 * 60 * 1000;
        invoiceTokens = unpaidInvoices.reduce((acc, inv) => {
          acc[String(inv.id)] = signPublicToken(
            { invoiceId: Number(inv.id), customerId: Number(inv.customer_id), lookup, exp },
            secret
          );
          return acc;
        }, {});
      } else {
        const invs = billingSvc.getInvoicesByAny(query) || [];
        const unpaid = (Array.isArray(invs) ? invs : []).filter((item) => item && item.status === 'unpaid');
        const map = new Map();
        for (const inv of unpaid) {
          const customerId = Number(inv.customer_id || 0);
          if (!Number.isFinite(customerId) || customerId <= 0) continue;
          const prev = map.get(customerId) || {
            customer_id: customerId,
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
      matches,
      paymentChannels,
      error,
      info
    });
  });
}

module.exports = { registerPublicPortalRoutes };
