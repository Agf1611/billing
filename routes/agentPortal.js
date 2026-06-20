const express = require('express');
const router = express.Router();
const { getSetting, getSettingsWithCache } = require('../config/settingsManager');
const agentSvc = require('../services/agentService');
const billingSvc = require('../services/billingService');
const customerSvc = require('../services/customerService');
const employeeLocationSvc = require('../services/employeeLocationService');
const { buildDynamicQrisDataUrl, hasStaticQrisEnabled } = require('../services/qrisService');
const whatsappGateway = require('../services/whatsappGatewayService');
const paymentWhatsappNotificationSvc = require('../services/paymentWhatsappNotificationService');

function requireAgentSession(req, res, next) {
  if (req.session && req.session.isAgent && req.session.agentId) return next();
  return res.redirect('/agent/login');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function popReceipt(req) {
  const r = req.session._agentReceipt;
  delete req.session._agentReceipt;
  return r || null;
}

function company() {
  return getSetting('company_header', 'PT Media Solusi Sukses');
}
function companyLogo() {
  return String(getSetting('company_logo_url', '/img/mss-logo.png') || '/img/mss-logo.png').trim() || '/img/mss-logo.png';
}

function normalizePhoneDigits(v) {
  let digits = String(v || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  return digits;
}

function getAdminContact() {
  const nums = getSetting('whatsapp_admin_numbers', []);
  const first = Array.isArray(nums) ? nums.find(Boolean) : nums;
  const phone = normalizePhoneDigits(first || getSetting('company_phone', ''));
  return {
    phone,
    display: phone ? `+${phone}` : String(getSetting('company_phone', '') || '-')
  };
}

function buildWaUrl(phone, message) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(String(message || '').trim())}`;
}

function getAgentPricesSorted(agentId) {
  return agentSvc
    .getAgentPrices(agentId)
    .filter(p => p && p.is_active)
    .sort((a, b) => {
      const as = Number(a.sell_price || 0);
      const bs = Number(b.sell_price || 0);
      if (as !== bs) return as - bs;
      const ab = Number(a.buy_price || 0);
      const bb = Number(b.buy_price || 0);
      if (ab !== bb) return ab - bb;
      return String(a.profile_name || '').localeCompare(String(b.profile_name || ''));
    });
}

async function getAgentPricesForVoucherDisplay(agentId) {
  const prices = await agentSvc.getAgentPricesWithCurrentValidity(agentId);
  return prices
    .filter(p => p && p.is_active)
    .sort((a, b) => {
      const as = Number(a.sell_price || 0);
      const bs = Number(b.sell_price || 0);
      if (as !== bs) return as - bs;
      const ab = Number(a.buy_price || 0);
      const bb = Number(b.buy_price || 0);
      if (ab !== bb) return ab - bb;
      return String(a.profile_name || '').localeCompare(String(b.profile_name || ''));
    });
}

function calculateAgentProfit(txs = []) {
  return (Array.isArray(txs) ? txs : []).reduce((sum, tx) => {
    const type = String(tx?.type || '').toLowerCase();
    if (type === 'voucher_sale' || type === 'pulsa') {
      const gross = Number(tx?.amount_sell || 0);
      const cost = Number(tx?.amount_buy || 0);
      return sum + Math.max(0, gross - cost);
    }
    if (type === 'invoice_payment') return sum + Math.max(0, Number(tx?.fee || 0));
    return sum;
  }, 0);
}

function listAgentFinancialTransactions(agentId, limit = 200) {
  return agentSvc
    .listAgentTransactions({ agentId, limit })
    .filter(tx => String(tx?.type || '').toLowerCase() !== 'voucher_sale');
}

function recordAgentVoucherOperations(txId) {
  return Number(txId || 0) || 0;
}

router.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('application/manifest+json');
  return res.json({
    id: '/agent/',
    name: 'Portal Agent',
    short_name: 'Agent',
    description: `Portal Agent ${String(getSetting('company_header', 'PT Media Solusi Sukses') || 'PT Media Solusi Sukses').trim() || 'PT Media Solusi Sukses'}`,
    start_url: '/agent/login?source=pwa',
    scope: '/agent/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: '#f5f8ff',
    theme_color: '#073dcc',
    icons: [
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/mss-logo.png') || '/img/mss-logo.png').trim() || '/img/mss-logo.png', sizes: '192x192', purpose: 'any maskable' },
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/mss-logo.png') || '/img/mss-logo.png').trim() || '/img/mss-logo.png', sizes: '512x512', purpose: 'any maskable' },
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
});

router.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (req.session && req.session.isAgent) return res.redirect('/agent');
  res.render('agent/login', { title: 'Login Agent', company: company(), logoUrl: companyLogo(), error: null, form: {} });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const agent = agentSvc.authenticate(username, password);
  if (agent) {
    req.session.isAgent = true;
    req.session.agentId = agent.id;
    req.session.agentName = agent.name;
    return res.redirect('/agent');
  }
  return res.render('agent/login', { title: 'Login Agent', company: company(), logoUrl: companyLogo(), error: 'Username atau password salah!', form: { username } });
});

router.get('/logout', (req, res) => {
  const agentId = Number(req.session?.agentId || 0) || 0;
  if (agentId) {
    try {
      employeeLocationSvc.clearEmployeeLocation('agent', agentId, 'logout');
    } catch (_error) {}
  }
  req.session.destroy();
  res.redirect('/agent/login');
});

router.get('/', requireAgentSession, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const txs = listAgentFinancialTransactions(agentId, 40).slice(0, 8);
  const prices = getAgentPricesSorted(agentId);
  const batches = agentSvc.listAgentVoucherBatches(agentId, { limit: 5 });
  const topups = agentSvc.listAgentTopupOrders(agentId, { limit: 5 });
  const profit = calculateAgentProfit(agentSvc.listAgentTransactions({ agentId, limit: 200 }));

  res.render('agent/dashboard', {
    title: 'Dashboard Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    prices,
    batches,
    topups,
    txs,
    profit,
    msg: flashMsg(req),
    receipt: popReceipt(req)
  });
});

router.get('/billing', requireAgentSession, (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const q = String(req.query.q || '').trim();
  const invoices = q ? billingSvc.getInvoicesByAny(q) : [];
  res.render('agent/billing', {
    title: 'Tagihan Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    q,
    invoices: Array.isArray(invoices) ? invoices : [],
    msg: flashMsg(req),
    receipt: popReceipt(req)
  });
});

async function renderAgentVoucherPage(req, res, pageMode = 'single') {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const prices = await getAgentPricesForVoucherDisplay(agentId);
  res.render('agent/vouchers', {
    title: pageMode === 'batch' ? 'Voucher Banyak Agent' : 'Voucher Satuan Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    pageMode,
    prices,
    batches: agentSvc.listAgentVoucherBatches(agentId, { limit: 50 }),
    msg: flashMsg(req)
  });
}

router.get('/vouchers', requireAgentSession, (req, res) => {
  return res.redirect('/agent/vouchers/single');
});

router.get('/vouchers/single', requireAgentSession, async (req, res, next) => {
  try {
    return await renderAgentVoucherPage(req, res, 'single');
  } catch (error) {
    return next(error);
  }
});

router.get('/vouchers/batch', requireAgentSession, async (req, res, next) => {
  try {
    return await renderAgentVoucherPage(req, res, 'batch');
  } catch (error) {
    return next(error);
  }
});

router.post('/vouchers/create', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const result = await agentSvc.createVoucherBatchAsAgent(req.session.agentId, {
      price_id: req.body.price_id,
      qty: req.body.qty,
      prefix: req.body.prefix,
      code_length: req.body.code_length,
      charset: req.body.charset,
      mode: req.body.mode
    });
    const batchId = Number(result?.batch?.batch?.id || result?.tx?.batchId || 0);
    recordAgentVoucherOperations(result?.tx?.txId);
    const isSingleSale = String(req.body.sale_mode || '').trim() === 'single' || Number(req.body.qty || 1) === 1;
    req.session._msg = {
      type: result.failed > 0 ? 'warning' : 'success',
      text: isSingleSale
        ? 'Voucher satuan berhasil dibuat dan siap dibagikan.'
        : `Voucher berhasil dibuat: ${result.created}${result.failed ? `, gagal ${result.failed}` : ''}.`
    };
    return res.redirect(batchId ? `/agent/vouchers/batches/${batchId}` : `/agent/vouchers/${isSingleSale ? 'single' : 'batch'}`);
  } catch (e) {
    const fallbackMode = String(req.body.sale_mode || '').trim() === 'batch' ? 'batch' : 'single';
    req.session._msg = { type: 'error', text: 'Gagal membuat voucher: ' + e.message };
    return res.redirect(`/agent/vouchers/${fallbackMode}`);
  }
});

router.get('/vouchers/batches/:id', requireAgentSession, (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const data = agentSvc.getAgentVoucherBatch(agentId, req.params.id);
  if (!data) return res.status(404).send('Batch voucher tidak ditemukan');
  res.render('agent/voucher_batch', {
    title: 'Detail Voucher',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    batch: data.batch,
    vouchers: data.vouchers,
    adminContact: getAdminContact(),
    msg: flashMsg(req)
  });
});

router.post('/vouchers/batches/:id/sync', requireAgentSession, async (req, res) => {
  try {
    const result = await agentSvc.syncAgentVoucherBatch(req.session.agentId, req.params.id);
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || 'Gagal sync voucher' });
  }
});

router.post('/vouchers/:id/sold', requireAgentSession, express.json({ limit: '16kb' }), (req, res) => {
  try {
    const voucher = agentSvc.markAgentVoucherSold(req.session.agentId, req.params.id);
    return res.json({ success: true, voucher });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || 'Gagal tandai voucher terjual' });
  }
});

router.get('/vouchers/batches/:id/print', requireAgentSession, (req, res) => {
  let printResult = null;
  try {
    printResult = agentSvc.markAgentVoucherBatchPrinted(req.session.agentId, req.params.id);
  } catch (_error) {}
  const data = agentSvc.getAgentVoucherBatch(req.session.agentId, req.params.id);
  if (!data) return res.status(404).send('Batch voucher tidak ditemukan');
  const batchVouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
  let reprintMode = false;
  let printableVouchers = Array.isArray(printResult?.vouchers) ? printResult.vouchers : [];
  if (!printableVouchers.length) {
    printableVouchers = batchVouchers.filter((v) => !v.sold_at && !v.used_at && !v.printed_at);
  }
  if (!printableVouchers.length) {
    printableVouchers = batchVouchers.filter((v) => !v.sold_at && !v.used_at && v.printed_at);
    reprintMode = printableVouchers.length > 0;
  }
  const blockedCount = batchVouchers.filter((v) => v.sold_at || v.used_at).length;
  res.render('agent/print_vouchers_a4', {
    title: 'Print Voucher Agent',
    company: company(),
    settings: {
      company_header: company(),
      company_logo_url: companyLogo(),
      company_phone: getSetting('company_phone', ''),
      whatsapp_admin_numbers: getSetting('whatsapp_admin_numbers', [])
    },
    batch: data.batch,
    vouchers: printableVouchers,
    skippedCount: blockedCount,
    reprintMode
  });
});

router.get('/vouchers/batches/:id/export.csv', requireAgentSession, (req, res) => {
  const data = agentSvc.getAgentVoucherBatch(req.session.agentId, req.params.id);
  if (!data) return res.status(404).send('Batch voucher tidak ditemukan');
  const { batch, vouchers } = data;
  const lines = [['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at'].join(',')];
  for (const v of vouchers) {
    lines.push([
      v.code,
      v.password,
      v.profile_name,
      batch.validity || '',
      Number(batch.price || 0),
      batch.router_name || '',
      batch.id,
      v.created_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=agent_vouchers_batch_${batch.id}.csv`);
  res.send(lines.join('\n'));
});

router.get('/topup', requireAgentSession, (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const settings = getSettingsWithCache();
  res.render('agent/topup', {
    title: 'Topup Saldo Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    qrisReady: hasStaticQrisEnabled(settings) && Boolean(String(settings.qris_static_payload || '').trim()),
    minTopup: 10000,
    maxTopup: 5000000,
    topups: agentSvc.listAgentTopupOrders(agentId, { limit: 20 }),
    msg: flashMsg(req)
  });
});

router.post('/topup/create', requireAgentSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const order = agentSvc.createAgentTopupOrder(req.session.agentId, req.body.amount, getSettingsWithCache());
    req.session._msg = { type: 'success', text: 'QRIS topup berhasil dibuat. Scan sesuai nominal unik.' };
    return res.redirect(`/agent/topup/${order.id}`);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat QRIS topup: ' + e.message };
    return res.redirect('/agent/topup');
  }
});

router.get('/topup/:id', requireAgentSession, async (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const order = agentSvc.getAgentTopupOrder(agentId, req.params.id);
  if (!order) return res.status(404).send('Order topup tidak ditemukan');
  const qrisDataUrl = order.qris_payload ? await buildDynamicQrisDataUrl(order.qris_payload, { width: 720 }) : '';
  res.render('agent/topup_order', {
    title: 'Bayar Topup QRIS',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    order,
    qrisDataUrl,
    msg: flashMsg(req)
  });
});

router.get('/history', requireAgentSession, (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const txs = agentSvc.listAgentTransactions({ agentId, limit: 300 });
  res.render('agent/history', {
    title: 'Riwayat Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    txs,
    profit: calculateAgentProfit(txs),
    msg: flashMsg(req)
  });
});

router.get('/help', requireAgentSession, (req, res) => {
  const agent = agentSvc.getAgentById(req.session.agentId);
  const adminContact = getAdminContact();
  const message = [
    'Halo Admin, saya butuh bantuan portal agen.',
    `Agent: ${agent?.name || '-'} (@${agent?.username || '-'})`,
    `Saldo: Rp ${Number(agent?.balance || 0).toLocaleString('id-ID')}`,
    'Kendala: voucher / transaksi'
  ].join('\n');
  res.render('agent/help', {
    title: 'Bantuan Agent',
    company: company(),
    logoUrl: companyLogo(),
    agent,
    adminContact,
    adminWaUrl: buildWaUrl(adminContact.phone, message),
    msg: flashMsg(req)
  });
});

router.post('/api/location', requireAgentSession, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const agentId = Number(req.session?.agentId || 0) || 0;
    if (!agentId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (req.body && req.body.enabled === false) {
      employeeLocationSvc.clearEmployeeLocation('agent', agentId, String(req.body.reason || 'disabled'));
      return res.json({ ok: true, disabled: true });
    }

    const agent = agentSvc.getAgentById(agentId);
    if (!agent) return res.status(404).json({ ok: false, error: 'agent_not_found' });

    const location = employeeLocationSvc.upsertEmployeeLocation({
      role: 'agent',
      employeeId: agentId,
      username: agent.username,
      name: agent.name || req.session?.agentName || 'Agent',
      phone: agent.phone || '',
      lat: req.body?.lat,
      lng: req.body?.lng,
      accuracy: req.body?.accuracy,
      source: 'portal-agent',
      userAgent: req.headers['user-agent'] || '',
      note: String(req.body?.note || '').trim()
    });

    return res.json({ ok: true, location });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Gagal menyimpan lokasi agent.' });
  }
});

router.post('/pay-invoice', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const invoiceId = Number(req.body.invoice_id || 0);
    if (!invoiceId) throw new Error('Invoice ID tidak valid');
    const note = String(req.body.note || '').trim();
    const result = await agentSvc.payInvoiceAsAgent(req.session.agentId, invoiceId, note);

    const customer = customerSvc.getCustomerById(result.invoice.customer_id);
    const waSent = await paymentWhatsappNotificationSvc.sendPaidInvoiceNotification(result.invoice.id, {
      customer,
      paidBy: `Agent ${result.agent.name}`,
      paidAt: new Date()
    });

    req.session._agentReceipt = {
      type: 'invoice',
      tx_id: Number(result.tx?.id || 0),
      created_at: new Date().toISOString(),
      invoice_id: result.invoice.id,
      customer_name: customer?.name || '',
      customer_phone: customer?.phone || '',
      period: `${result.invoice.period_month}/${result.invoice.period_year}`,
      amount: Number(result.invoice.amount || 0),
      cost: Number(result.tx.cost || 0),
      fee: Number(result.tx.fee || 0),
      waSent
    };

    req.session._msg = { type: 'success', text: 'Pembayaran berhasil diproses.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent/billing');
});

router.post('/sell-voucher', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const priceId = Number(req.body.price_id || 0);
    if (!priceId) throw new Error('Harga voucher tidak valid');
    const result = await agentSvc.sellVoucherAsAgent(req.session.agentId, priceId, {});
    recordAgentVoucherOperations(result?.tx?.id);

    req.session._agentReceipt = {
      type: 'voucher',
      tx_id: Number(result.tx?.id || 0),
      created_at: new Date().toISOString(),
      profile: result.receipt.profile,
      validity: result.receipt.validity,
      code: result.receipt.code,
      password: result.receipt.password,
      sell_price: Number(result.receipt.sell_price || 0),
      buy_price: Number(result.price.buy_price || 0),
      waSent: false,
      buyer_phone: ''
    };

    req.session._msg = { type: 'success', text: 'Voucher berhasil dibuat.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent/vouchers/single');
});

router.post('/pulsa', requireAgentSession, express.urlencoded({ extended: true }), (req, res, next) => {
  req.session._msg = { type: 'warning', text: 'Layanan produk digital sudah dinonaktifkan.' };
  return res.redirect('/agent');
});

router.post('/api/pulsa/order', requireAgentSession, express.json({ limit: '50kb' }), (req, res, next) => {
  return res.status(410).json({ success: false, message: 'Layanan produk digital sudah dinonaktifkan.' });
});

router.post('/pulsa/check', requireAgentSession, express.urlencoded({ extended: true }), (req, res, next) => {
  req.session._msg = { type: 'warning', text: 'Cek status produk digital sudah dinonaktifkan.' };
  return res.redirect('/agent');
});

router.post('/pulsa', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const target = String(req.body.target || '').trim();
    const buyerPhone = String(req.body.buyer_phone || '').trim();
    const sellPrice = req.body.sell_price !== undefined && String(req.body.sell_price).trim() !== ''
      ? Number(req.body.sell_price)
      : 0;

    const result = await agentSvc.buyPulsaAsAgent(req.session.agentId, sku, target, { sell_price: sellPrice });

    const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
    const isSuccess = status === 'success';
    const isFailed = status === 'failed';

    let waSent = false;
    if (getSetting('whatsapp_enabled', false) && buyerPhone) {
      try {
        if (await whatsappGateway.ensureReady(12000)) {
          const msg =
            `${isSuccess ? 'âœ…' : isFailed ? 'âŒ' : 'â³'} *TRANSAKSI PULSA*\n\n` +
            `ðŸ“¦ *SKU:* ${sku}\n` +
            `ðŸŽ¯ *Target:* ${target}\n` +
            `ðŸ§¾ *Ref ID:* ${result?.tx?.digi_ref_id || '-'}\n` +
            `ðŸ“¡ *Status:* ${status.toUpperCase()}\n` +
            `${result?.tx?.digi_sn ? `ðŸ”¢ *SN:* ${result.tx.digi_sn}\n` : ''}` +
            `${result?.tx?.digi_message ? `ðŸ’¬ *Pesan:* ${result.tx.digi_message}\n` : ''}` +
            `\nTerima kasih.`;
          await whatsappGateway.sendText(buyerPhone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'pulsa',
      tx_id: Number(result?.tx?.id || 0),
      created_at: new Date().toISOString(),
      sku,
      target,
      ref_id: result?.tx?.digi_ref_id || '',
      trx_id: result?.tx?.digi_trx_id || '',
      sn: result?.tx?.digi_sn || '',
      status,
      message: result?.tx?.digi_message || '',
      buy_price: Number(result?.tx?.amount_buy || 0),
      sell_price: Number(result?.tx?.amount_sell || 0),
      waSent,
      buyer_phone: buyerPhone
    };

    req.session._msg = { type: isFailed ? 'error' : isSuccess ? 'success' : 'warning', text: isFailed ? 'Transaksi gagal (saldo otomatis direfund jika gagal langsung).' : isSuccess ? 'Transaksi berhasil diproses.' : 'Transaksi dibuat (pending). Silakan cek status di riwayat.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/api/pulsa/order', requireAgentSession, express.json({ limit: '50kb' }), async (req, res) => {
  try {
    const sku = String(req.body?.sku || '').trim();
    const target = String(req.body?.target || '').trim();
    const buyerPhone = String(req.body?.buyer_phone || '').trim();
    const sellPrice = req.body?.sell_price !== undefined && String(req.body.sell_price).trim() !== ''
      ? Number(req.body.sell_price)
      : 0;

    const result = await agentSvc.buyPulsaAsAgent(req.session.agentId, sku, target, { sell_price: sellPrice });
    const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
    const agentNow = agentSvc.getAgentById(req.session.agentId);

    const isSuccess = status === 'success';
    const isFailed = status === 'failed';
    let waSent = false;
    if (getSetting('whatsapp_enabled', false) && buyerPhone) {
      try {
        if (await whatsappGateway.ensureReady(12000)) {
          const msg =
            `${isSuccess ? 'âœ…' : isFailed ? 'âŒ' : 'â³'} *TRANSAKSI PULSA*\n\n` +
            `ðŸ“¦ *SKU:* ${sku}\n` +
            `ðŸŽ¯ *Target:* ${target}\n` +
            `ðŸ’° *Harga:* Rp ${Number(result?.tx?.amount_sell || 0).toLocaleString('id-ID')}\n` +
            `ðŸ§¾ *Ref ID:* ${result?.tx?.digi_ref_id || '-'}\n` +
            `ðŸ“¡ *Status:* ${status.toUpperCase()}\n` +
            `${result?.tx?.digi_sn ? `ðŸ”¢ *SN:* ${result.tx.digi_sn}\n` : ''}` +
            `${result?.tx?.digi_message ? `ðŸ’¬ *Pesan:* ${result.tx.digi_message}\n` : ''}` +
            `\nTerima kasih.`;
          await whatsappGateway.sendText(buyerPhone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'pulsa',
      tx_id: Number(result?.tx?.id || 0),
      created_at: new Date().toISOString(),
      sku,
      target,
      ref_id: result?.tx?.digi_ref_id || '',
      trx_id: result?.tx?.digi_trx_id || '',
      sn: result?.tx?.digi_sn || '',
      status,
      message: result?.tx?.digi_message || '',
      buy_price: Number(result?.tx?.amount_buy || 0),
      sell_price: Number(result?.tx?.amount_sell || 0),
      waSent,
      buyer_phone: buyerPhone
    };

    return res.json({
      success: true,
      status,
      message: result?.tx?.digi_message || '',
      ref_id: result?.tx?.digi_ref_id || '',
      sn: result?.tx?.digi_sn || '',
      price: Number(result?.tx?.amount_sell || 0),
      wa_sent: waSent,
      balance_after: agentNow ? Number(agentNow.balance || 0) : null
    });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
});

router.post('/pulsa/check', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const txId = Number(req.body.tx_id || 0);
    if (!txId) throw new Error('ID transaksi tidak valid');
    const result = await agentSvc.checkPulsaStatusAsAgent(req.session.agentId, txId);
    const status = String(result?.tx?.digi_status || '').toLowerCase();
    req.session._msg = { type: status === 'success' ? 'success' : status === 'failed' ? 'error' : 'warning', text: `Status transaksi #${txId}: ${status || '-'}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek status: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/receipt/clear', requireAgentSession, (req, res) => {
  try {
    delete req.session._agentReceipt;
  } catch {}
  res.redirect('/agent');
});

router.get('/print/tx/:id', requireAgentSession, (req, res) => {
  try {
    const txId = Number(req.params.id || 0);
    if (!txId) return res.status(400).send('ID transaksi tidak valid');

    const tx = agentSvc.getAgentTransactionById(req.session.agentId, txId);
    if (!tx) return res.status(404).send('Transaksi tidak ditemukan');

    if (tx.type === 'voucher_sale') {
      const settings = {
        company_logo_url: companyLogo(),
        company_address: getSetting('company_address', ''),
        company_phone: getSetting('company_phone', ''),
        upstream_provider_name: getSetting('upstream_provider_name', ''),
        whatsapp_admin_numbers: getSetting('whatsapp_admin_numbers', [])
      };
      return res.render('agent/print_thermal_voucher', {
        company: company(),
        settings,
        tx
      });
    }

    if (tx.type === 'invoice_payment') {
      const invoice = billingSvc.getInvoiceById(tx.invoice_id);
      const customer = customerSvc.getCustomerById(tx.customer_id);
      const settings = {
        company_logo_url: companyLogo(),
        company_address: getSetting('company_address', ''),
        company_phone: getSetting('company_phone', ''),
        whatsapp_admin_numbers: getSetting('whatsapp_admin_numbers', [])
      };
      return res.render('agent/print_thermal_invoice', {
        company: company(),
        settings,
        tx,
        invoice,
        customer
      });
    }

    return res.status(400).send('Jenis transaksi belum didukung untuk print');
  } catch (e) {
    return res.status(500).send('Gagal print: ' + e.message);
  }
});

module.exports = router;
