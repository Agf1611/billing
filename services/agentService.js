const db = require('../config/database');
const billingSvc = require('./billingService');
const customerSvc = require('./customerService');
const mikrotikSvc = require('./mikrotikService');
const { hashPassword, validateNewPassword, verifyPassword } = require('../config/passwords');
const {
  buildDynamicQrisPayload,
  hasStaticQrisEnabled,
  resolveQrisUniqueCodeRange
} = require('./qrisService');
const OPERATIONAL_PASSWORD_MIN_LENGTH = 4;
const AGENT_TOPUP_MIN = 10000;
const AGENT_TOPUP_MAX = 5000000;
const AGENT_TOPUP_EXPIRE_HOURS = 24;

function sanitizeAgentRow(row) {
  if (!row) return null;
  const clean = { ...row };
  delete clean.password;
  delete clean.password_hash;
  return clean;
}

function authenticate(username, password) {
  const agent = db
    .prepare('SELECT * FROM agents WHERE username = ? AND is_active = 1')
    .get(String(username || '').trim());
  if (!agent) return null;

  const storedHash = String(agent.password_hash || '').trim();
  const legacyPassword = String(agent.password || '');
  const storedCredential = storedHash || legacyPassword;
  if (!verifyPassword(password, storedCredential)) return null;

  if (!storedHash && legacyPassword) {
    const upgradedHash = hashPassword(password);
    db.prepare("UPDATE agents SET password_hash = ?, password = '' WHERE id = ?").run(upgradedHash, agent.id);
    agent.password_hash = upgradedHash;
    agent.password = '';
  }

  return sanitizeAgentRow(agent);
}

function getAllAgents() {
  return db.prepare('SELECT id, username, name, phone, balance, billing_fee, is_active, created_at FROM agents ORDER BY created_at DESC').all();
}

function getAgentById(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

function normalizePhoneDigits(v) {
  let digits = String(v || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  return digits;
}

function getAgentByPhone(phone) {
  const input = normalizePhoneDigits(phone);
  if (!input) return null;
  const agents = getAllAgents();
  for (const a of (agents || [])) {
    if (!a || !a.is_active) continue;
    const ap = normalizePhoneDigits(a.phone);
    if (!ap) continue;
    if (ap === input) return a;
    if (ap.endsWith(input) || input.endsWith(ap)) return a;
  }
  return null;
}

function createAgent(data) {
  const passwordHash = hashPassword(validateNewPassword(data.password, 'Password agent', OPERATIONAL_PASSWORD_MIN_LENGTH));
  return db
    .prepare(
      'INSERT INTO agents (username, password, password_hash, name, phone, balance, billing_fee, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    )
    .run(
      String(data.username || '').trim(),
      '',
      passwordHash,
      String(data.name || '').trim(),
      String(data.phone || '').trim(),
      Math.max(0, Number(data.balance || 0) || 0),
      Math.max(0, Number(data.billing_fee || 0) || 0)
    );
}

function updateAgent(id, data) {
  const existing = getAgentById(id);
  if (!existing) throw new Error('Agent tidak ditemukan');

  let passwordHash = String(existing.password_hash || '').trim();
  if (data.password !== undefined && data.password !== null && String(data.password) !== '') {
    passwordHash = hashPassword(validateNewPassword(data.password, 'Password agent', OPERATIONAL_PASSWORD_MIN_LENGTH));
  } else if (!passwordHash && existing.password) {
    passwordHash = hashPassword(existing.password);
  }
  if (!passwordHash) throw new Error('Password agent wajib diisi');

  const next = {
    username: String(data.username ?? existing.username).trim(),
    name: String(data.name ?? existing.name).trim(),
    phone: String(data.phone ?? existing.phone).trim(),
    billing_fee: Math.max(0, Number(data.billing_fee ?? existing.billing_fee) || 0),
    is_active: data.is_active !== undefined ? (String(data.is_active) === '1' ? 1 : 0) : existing.is_active
  };

  return db
    .prepare(
      'UPDATE agents SET username=?, password=?, password_hash=?, name=?, phone=?, billing_fee=?, is_active=? WHERE id=?'
    )
    .run(next.username, '', passwordHash, next.name, next.phone, next.billing_fee, next.is_active, id);
}

function deleteAgent(id) {
  return db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function getAgentPrices(agentId) {
  return db
    .prepare(
      `
      SELECT p.*, r.name AS router_name
      FROM agent_hotspot_prices p
      LEFT JOIN routers r ON r.id = p.router_id
      WHERE p.agent_id = ?
      ORDER BY p.is_active DESC, r.name ASC, p.profile_name ASC
    `
    )
    .all(agentId);
}

function upsertAgentHotspotPrice(agentId, data) {
  const routerId = data.router_id !== undefined && data.router_id !== null && String(data.router_id).trim() !== ''
    ? Number(data.router_id)
    : null;
  const profileName = String(data.profile_name || '').trim();
  if (!profileName) throw new Error('Profile hotspot wajib diisi');

  const buyPrice = Math.max(0, Number(data.buy_price || 0) || 0);
  const sellPrice = Math.max(0, Number(data.sell_price || 0) || 0);
  const validity = String(data.validity || '').trim();
  const isActive = data.is_active !== undefined ? (String(data.is_active) === '1' ? 1 : 0) : 1;

  const existing = db
    .prepare(
      'SELECT id FROM agent_hotspot_prices WHERE agent_id = ? AND router_id IS ? AND profile_name = ?'
    )
    .get(agentId, routerId, profileName);

  if (existing) {
    return db
      .prepare(
        'UPDATE agent_hotspot_prices SET validity=?, buy_price=?, sell_price=?, is_active=? WHERE id=?'
      )
      .run(validity, buyPrice, sellPrice, isActive, existing.id);
  }

  return db
    .prepare(
      'INSERT INTO agent_hotspot_prices (agent_id, router_id, profile_name, validity, buy_price, sell_price, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(agentId, routerId, profileName, validity, buyPrice, sellPrice, isActive);
}

function deleteAgentHotspotPrice(agentId, priceId) {
  return db
    .prepare('DELETE FROM agent_hotspot_prices WHERE id = ? AND agent_id = ?')
    .run(priceId, agentId);
}

function listAgentTransactions({ agentId = null, limit = 300 } = {}) {
  const aId = agentId !== null && agentId !== undefined && String(agentId).trim() !== '' ? Number(agentId) : null;
  return db
    .prepare(
      `
      SELECT
        t.*,
        a.name AS agent_name,
        c.name AS customer_name,
        c.phone AS customer_phone,
        r.name AS router_name,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id) AS voucher_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND (v.sold_at IS NOT NULL OR v.used_at IS NOT NULL)) AS voucher_sold_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND v.printed_at IS NOT NULL AND v.sold_at IS NULL AND v.used_at IS NULL) AS voucher_printed_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND v.used_at IS NOT NULL) AS voucher_used_count
      FROM agent_transactions t
      JOIN agents a ON a.id = t.agent_id
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN routers r ON r.id = t.router_id
      WHERE (? IS NULL OR t.agent_id = ?)
      ORDER BY t.id DESC
      LIMIT ?
    `
    )
    .all(aId, aId, Math.max(1, Math.min(2000, Number(limit) || 300)));
}

function getAgentTransactionById(agentId, txId) {
  const aId = Number(agentId || 0);
  const tId = Number(txId || 0);
  if (!aId || !tId) return null;
  return db
    .prepare(
      `
      SELECT
        t.*,
        a.name AS agent_name,
        a.username AS agent_username,
        r.name AS router_name,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id) AS voucher_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND (v.sold_at IS NOT NULL OR v.used_at IS NOT NULL)) AS voucher_sold_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND v.printed_at IS NOT NULL AND v.sold_at IS NULL AND v.used_at IS NULL) AS voucher_printed_count,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = t.voucher_batch_id AND v.used_at IS NOT NULL) AS voucher_used_count
      FROM agent_transactions t
      JOIN agents a ON a.id = t.agent_id
      LEFT JOIN routers r ON r.id = t.router_id
      WHERE t.id = ? AND t.agent_id = ?
    `
    )
    .get(tId, aId);
}

function topupAgent(agentId, amount, note, actorName = 'Admin') {
  const delta = Math.floor(Number(amount) || 0);
  if (!Number.isFinite(delta) || delta <= 0) throw new Error('Nominal topup tidak valid');

  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agent tidak ditemukan');

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    const after = before + delta;

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    const tx = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
      ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
    `
    ).run(agentId, delta, delta, before, after, `${actorName}: ${note || 'Topup saldo'}`);

    return { before, after, txId: Number(tx.lastInsertRowid || 0) };
  });

  const result = run();
  try {
    if (result.txId) require('./bookkeepingService').upsertAgentTopupIncomeEntry(result.txId);
  } catch (error) {
    console.warn('[AGENT] Gagal catat pemasukan topup agent:', error.message);
  }
  return result;
}

function toSqlDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : null;
}

function normalizeTopupAmount(amount) {
  const value = Math.floor(Number(amount || 0));
  if (!Number.isFinite(value) || value < AGENT_TOPUP_MIN) {
    throw new Error(`Minimal topup Rp ${AGENT_TOPUP_MIN.toLocaleString('id-ID')}`);
  }
  if (value > AGENT_TOPUP_MAX) {
    throw new Error(`Maksimal topup Rp ${AGENT_TOPUP_MAX.toLocaleString('id-ID')}`);
  }
  return value;
}

function pickAgentTopupUniqueAmount(baseAmount, settings = {}) {
  const amount = normalizeTopupAmount(baseAmount);
  const range = resolveQrisUniqueCodeRange(settings);
  const min = Math.max(1, Number(range.min || 1) || 1);
  const max = Math.max(min, Number(range.max || 599) || 599);
  const pendingTopup = db.prepare(`
    SELECT id FROM agent_topup_orders
    WHERE status = 'pending'
      AND pay_amount = ?
      AND (expires_at IS NULL OR expires_at >= datetime('now'))
    LIMIT 1
  `);
  const unpaidInvoice = db.prepare(`
    SELECT id FROM invoices
    WHERE status = 'unpaid'
      AND qris_amount_unique = ?
    LIMIT 1
  `);

  const used = new Set();
  for (let i = 0; i < Math.max(30, (max - min + 1) * 2); i += 1) {
    const code = min + Math.floor(Math.random() * (max - min + 1));
    if (used.has(code)) continue;
    used.add(code);
    const payAmount = amount + code;
    if (pendingTopup.get(payAmount) || unpaidInvoice.get(payAmount)) continue;
    return { amount, uniqueCode: code, payAmount };
  }

  for (let code = min; code <= max; code += 1) {
    const payAmount = amount + code;
    if (pendingTopup.get(payAmount) || unpaidInvoice.get(payAmount)) continue;
    return { amount, uniqueCode: code, payAmount };
  }

  throw new Error('Kode unik QRIS sedang penuh, coba nominal lain.');
}

function createAgentTopupOrder(agentId, amount, settings = {}) {
  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');
  if (!hasStaticQrisEnabled(settings) || !String(settings.qris_static_payload || '').trim()) {
    throw new Error('QRIS dinamis belum siap. Isi payload QRIS statis di pengaturan admin.');
  }

  const unique = pickAgentTopupUniqueAmount(amount, settings);
  const qrisPayload = buildDynamicQrisPayload(settings.qris_static_payload, unique.payAmount);
  if (!qrisPayload) throw new Error('Payload QRIS tidak valid.');

  const expiresAt = toSqlDateTime(new Date(Date.now() + AGENT_TOPUP_EXPIRE_HOURS * 60 * 60 * 1000));
  const result = db.prepare(`
    INSERT INTO agent_topup_orders (
      agent_id, amount, unique_code, pay_amount, status, qris_payload, expires_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(agentId, unique.amount, unique.uniqueCode, unique.payAmount, qrisPayload, expiresAt);

  return getAgentTopupOrder(agentId, result.lastInsertRowid);
}

function getAgentTopupOrder(agentId, orderId) {
  const aId = Number(agentId || 0);
  const oId = Number(orderId || 0);
  if (!aId || !oId) return null;
  return db.prepare(`
    SELECT o.*, a.name AS agent_name, a.username AS agent_username, a.balance AS agent_balance
    FROM agent_topup_orders o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.id = ? AND o.agent_id = ?
  `).get(oId, aId);
}

function listAgentTopupOrders(agentId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT *
    FROM agent_topup_orders
    WHERE agent_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(Number(agentId || 0), Math.max(1, Math.min(100, Number(limit) || 20)));
}

function findPendingAgentTopupByPayAmounts(amounts = []) {
  const checked = [];
  const ambiguous = [];
  const selectByAmount = db.prepare(`
    SELECT o.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_topup_orders o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'pending'
      AND o.pay_amount = ?
      AND (o.expires_at IS NULL OR o.expires_at >= datetime('now'))
    ORDER BY o.id DESC
    LIMIT 2
  `);

  for (const amount of Array.isArray(amounts) ? amounts : []) {
    const candidates = selectByAmount.all(amount);
    checked.push({ amount, count: candidates.length, ids: candidates.map((row) => row.id) });
    if (candidates.length === 1) {
      return { amount, order: candidates[0], checked, ambiguous };
    }
    if (candidates.length > 1) {
      ambiguous.push({ amount, ids: candidates.map((row) => row.id) });
    }
  }
  return { amount: null, order: null, checked, ambiguous };
}

function completeAgentTopupOrder(orderId, notifId = null, sourceLabel = 'QRIS') {
  const oId = Number(orderId || 0);
  if (!oId) throw new Error('Order topup tidak valid');

  const run = db.transaction(() => {
    const order = db.prepare(`
      SELECT * FROM agent_topup_orders
      WHERE id = ? AND status = 'pending'
        AND (expires_at IS NULL OR expires_at >= datetime('now'))
    `).get(oId);
    if (!order) throw new Error('Order topup sudah diproses atau kedaluwarsa');

    const fresh = getAgentById(order.agent_id);
    if (!fresh || !fresh.is_active) throw new Error('Akun agent tidak aktif');
    const amount = Number(order.amount || 0);
    const before = Number(fresh.balance || 0);
    const after = before + amount;
    const note = [
      `Topup QRIS otomatis ${sourceLabel || ''}`.trim(),
      `Bayar Rp ${Number(order.pay_amount || 0).toLocaleString('id-ID')}`,
      `kode unik ${Number(order.unique_code || 0).toLocaleString('id-ID')}`,
      notifId ? `notif #${notifId}` : ''
    ].filter(Boolean).join(' - ');

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, order.agent_id);
    const tx = db.prepare(`
      INSERT INTO agent_transactions (
        agent_id, type, amount_buy, amount_sell, fee,
        balance_before, balance_after, note, agent_topup_order_id
      ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?, ?)
    `).run(order.agent_id, amount, amount, before, after, note, order.id);

    db.prepare(`
      UPDATE agent_topup_orders
      SET status = 'paid',
          paid_notif_id = ?,
          paid_tx_id = ?,
          paid_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(notifId || null, Number(tx.lastInsertRowid || 0), order.id);

    return { order: { ...order, status: 'paid' }, txId: Number(tx.lastInsertRowid || 0), before, after };
  });

  const result = run();
  try {
    if (result.txId) require('./bookkeepingService').upsertAgentTopupIncomeEntry(result.txId);
  } catch (error) {
    console.warn('[AGENT] Gagal catat pemasukan topup agent:', error.message);
  }
  return {
    ...result,
    agent: getAgentById(result.order.agent_id)
  };
}

async function payInvoiceAsAgent(agentId, invoiceId, note = '') {
  const inv = billingSvc.getInvoiceById(invoiceId);
  if (!inv) throw new Error('Tagihan tidak ditemukan');
  if (inv.status === 'paid') throw new Error('Tagihan sudah lunas');

  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  const fee = Math.max(0, Number(agent.billing_fee || 0) || 0);
  const cost = Math.max(0, Number(inv.amount || 0) - fee);
  const safeNote = String(note || '').trim();

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    if (before < cost) throw new Error('Saldo agent tidak cukup');

    const after = before - cost;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const ins = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, invoice_id, customer_id,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (?, 'invoice_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      agentId,
      inv.id,
      inv.customer_id,
      inv.amount,
      cost,
      inv.amount,
      fee,
      before,
      after,
      safeNote
    );

    const paidByName = `Agent ${agent.name} (@${agent.username})`;
    const notesParts = [
      'Via Agent',
      `Fee: Rp ${fee.toLocaleString('id-ID')}`,
      `Potong saldo: Rp ${cost.toLocaleString('id-ID')}`
    ];
    if (safeNote) notesParts.push(safeNote);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(inv.id, paidByName, notes);

    return { id: Number(ins.lastInsertRowid), before, after, cost, fee };
  });

  const tx = run();

  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (customer && ['suspended', 'inactive'].includes(String(customer.status || '').toLowerCase())) {
    const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
    if (freshCustomer && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }
  }

  return { invoice: inv, agent: getAgentById(agentId), tx };
}

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const m = String(script).match(/",rem,.*?,(.*?),(.*?),.*?"/);
  if (!m) return null;
  const validity = String(m[1] || '').trim();
  const priceStr = String(m[2] || '').trim();
  const price = Number(String(priceStr).replace(/[^\d]/g, '')) || 0;
  return { validity, price };
}

function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

function genCodeExact(len, charset) {
  const n = Math.max(1, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

function normalizeAgentVoucherOptions(options = {}) {
  const qty = Math.max(1, Math.min(200, Number(options.qty || 1) || 1));
  const prefix = String(options.prefix || '').trim().replace(/\s+/g, '').slice(0, 8);
  const codeLength = Math.max(4, Math.min(16, Number(options.code_length || options.codeLength || 6) || 6));
  const charset = ['numbers', 'letters', 'mixed'].includes(String(options.charset || '').trim())
    ? String(options.charset).trim()
    : 'numbers';
  const mode = String(options.mode || 'voucher').trim() === 'member' ? 'member' : 'voucher';
  if (prefix.length >= codeLength) throw new Error('Prefix terlalu panjang');
  return { qty, prefix, codeLength, charset, mode };
}

function getActiveAgentPrice(agentId, priceId) {
  return db
    .prepare(
      `
      SELECT p.*, r.name AS router_name
      FROM agent_hotspot_prices p
      LEFT JOIN routers r ON r.id = p.router_id
      WHERE p.id = ? AND p.agent_id = ? AND p.is_active = 1
    `
    )
    .get(priceId, agentId);
}

async function sellVoucherAsAgent(agentId, priceId, opts = {}) {
  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  const price = getActiveAgentPrice(agentId, priceId);

  if (!price) throw new Error('Harga/profile voucher tidak ditemukan');

  const buyPrice = Math.max(0, Number(price.buy_price || 0) || 0);
  const sellPrice = Math.max(0, Number(price.sell_price || 0) || 0);
  if (buyPrice <= 0) throw new Error('Harga beli belum valid');

  const routerId = price.router_id ?? null;
  const profileName = String(price.profile_name || '').trim();

  let validity = String(price.validity || '').trim();
  let profileMeta = null;
  try {
    const profiles = await mikrotikSvc.getHotspotUserProfiles(routerId);
    const prof = (profiles || []).find(p => p && p.name === profileName);
    profileMeta = parseMikhmonOnLogin(prof?.onLogin || prof?.['on-login'] || '');
    if (profileMeta?.validity) validity = profileMeta.validity;
  } catch (e) {}

  const charset = opts.charset || 'numbers';
  const length = Math.max(4, Math.min(16, Number(opts.code_length) || 6));

  let created = null;
  let attempt = 0;
  while (attempt < 10) {
    attempt++;
    const code = genCode(length, charset);
    const password = opts.mode === 'member' ? genCode(length, charset) : code;
    const comment = `ag-${agent.username}-${code}-${profileName}`;
    const userData = { server: 'all', name: code, password, profile: profileName, comment };
    if (validity) userData['limit-uptime'] = validity;

    try {
      await mikrotikSvc.addHotspotUser(userData, routerId);
      created = { code, password, comment };
      break;
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (isDup) continue;
      throw e;
    }
  }
  if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');

  const run = db.transaction(() => {
    const fresh = getAgentById(agentId);
    const before = Number(fresh.balance || 0);
    if (before < buyPrice) throw new Error('Saldo agent tidak cukup');

    const after = before - buyPrice;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const insertTx = db.prepare(
      `
      INSERT INTO agent_transactions (
        agent_id, type, router_id, profile_name,
        voucher_code, voucher_password,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (?, 'voucher_sale', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `
    );
    const ins = insertTx.run(
      agentId,
      routerId,
      profileName,
      created.code,
      created.password,
      buyPrice,
      sellPrice,
      Math.max(0, sellPrice - buyPrice),
      before,
      after,
      `Voucher hotspot ${profileName} (${price.router_name || 'router'})`
    );

    return { id: Number(ins.lastInsertRowid), before, after };
  });

  const tx = run();

  return {
    agent: getAgentById(agentId),
    price: { ...price, validity },
    voucher: created,
    tx,
    receipt: {
      profile: profileName,
      router: price.router_name || '',
      code: created.code,
      password: created.password,
      validity,
      sell_price: sellPrice
    }
  };
}

async function createVoucherBatchAsAgent(agentId, options = {}) {
  const agent = getAgentById(agentId);
  if (!agent || !agent.is_active) throw new Error('Akun agent tidak aktif');

  const priceId = Number(options.price_id || options.priceId || 0);
  if (!priceId) throw new Error('Harga voucher tidak valid');
  const price = getActiveAgentPrice(agentId, priceId);
  if (!price) throw new Error('Harga/profile voucher tidak ditemukan');

  const { qty, prefix, codeLength, charset, mode } = normalizeAgentVoucherOptions(options);
  const buyPrice = Math.max(0, Number(price.buy_price || 0) || 0);
  const sellPrice = Math.max(0, Number(price.sell_price || 0) || 0);
  if (buyPrice <= 0) throw new Error('Harga beli belum valid');

  const fresh = getAgentById(agentId);
  const expectedCost = buyPrice * qty;
  if (Number(fresh.balance || 0) < expectedCost) {
    throw new Error(`Saldo agent tidak cukup. Butuh Rp ${expectedCost.toLocaleString('id-ID')}`);
  }

  const routerId = price.router_id ?? null;
  const profileName = String(price.profile_name || '').trim();
  let validity = String(price.validity || '').trim();
  try {
    const profiles = await mikrotikSvc.getHotspotUserProfiles(routerId);
    const prof = (profiles || []).find(p => p && p.name === profileName);
    const meta = parseMikhmonOnLogin(prof?.onLogin || prof?.['on-login'] || '');
    if (meta?.validity) validity = meta.validity;
  } catch (_error) {}

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
  const localCodes = new Set();
  const successful = [];
  let attempts = 0;
  const maxAttempts = Math.max(30, qty * 8);

  while (successful.length < qty && attempts < maxAttempts) {
    attempts++;
    const coreLen = codeLength - prefix.length;
    const code = prefix + genCodeExact(coreLen, charset);
    if (localCodes.has(code) || existsCode.get(routerId, code)) continue;
    localCodes.add(code);
    const password = mode === 'member' ? genCodeExact(coreLen, charset) : code;
    const comment = `ag-${agent.username}-${code}-${profileName}`;
    const userData = { server: 'all', name: code, password, profile: profileName, comment };
    if (validity) userData['limit-uptime'] = validity;

    try {
      await mikrotikSvc.addHotspotUser(userData, routerId);
      successful.push({ code, password, comment });
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (!isDup && successful.length === 0 && attempts >= Math.min(3, maxAttempts)) {
        throw e;
      }
    }
  }

  if (successful.length === 0) throw new Error('Gagal membuat voucher di MikroTik');

  const failedCount = Math.max(0, qty - successful.length);
  const actualCost = buyPrice * successful.length;
  const actualSell = sellPrice * successful.length;
  const actualProfit = Math.max(0, actualSell - actualCost);

  const run = db.transaction(() => {
    const current = getAgentById(agentId);
    const before = Number(current.balance || 0);
    if (before < actualCost) throw new Error('Saldo agent tidak cukup');
    const after = before - actualCost;
    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);

    const batchRes = db.prepare(`
      INSERT INTO voucher_batches (
        router_id, agent_id, profile_name, qty_total, qty_created, qty_failed,
        price, validity, prefix, code_length, status, created_by, mode, charset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      routerId,
      agentId,
      profileName,
      qty,
      successful.length,
      failedCount,
      sellPrice,
      validity,
      prefix,
      codeLength,
      failedCount > 0 ? 'partial' : 'done',
      `agent:${agent.username}`,
      mode,
      charset
    );
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'created')
    `);
    for (const item of successful) {
      insertVoucher.run(batchId, routerId, item.code, item.password, profileName, item.comment);
    }

    const txRes = db.prepare(`
      INSERT INTO agent_transactions (
        agent_id, type, router_id, voucher_batch_id, profile_name,
        amount_invoice, amount_buy, amount_sell, fee,
        balance_before, balance_after, note
      ) VALUES (?, 'voucher_sale', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      routerId,
      batchId,
      profileName,
      actualCost,
      actualSell,
      actualProfit,
      before,
      after,
      `Batch voucher ${profileName}: ${successful.length}/${qty} berhasil`
    );

    return { batchId, txId: Number(txRes.lastInsertRowid), before, after };
  });

  const tx = run();
  const batch = getAgentVoucherBatch(agentId, tx.batchId);
  return {
    agent: getAgentById(agentId),
    price: { ...price, validity },
    batch,
    tx,
    created: successful.length,
    failed: failedCount
  };
}

function listAgentVoucherBatches(agentId, { limit = 50 } = {}) {
  const aId = Number(agentId || 0);
  return db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND (v.sold_at IS NOT NULL OR v.used_at IS NOT NULL)) AS sold_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.printed_at IS NOT NULL AND v.sold_at IS NULL AND v.used_at IS NULL) AS printed_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.sold_at IS NULL AND v.used_at IS NULL AND v.printed_at IS NULL) AS ready_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.agent_id = ?
    ORDER BY b.id DESC
    LIMIT ?
  `).all(aId, Math.max(1, Math.min(200, Number(limit) || 50)));
}

function getAgentVoucherBatch(agentId, batchId) {
  const aId = Number(agentId || 0);
  const bId = Number(batchId || 0);
  if (!aId || !bId) return null;
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      a.name AS agent_name,
      a.username AS agent_username,
      a.phone AS agent_phone,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND (v.sold_at IS NOT NULL OR v.used_at IS NOT NULL)) AS sold_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.printed_at IS NOT NULL AND v.sold_at IS NULL AND v.used_at IS NULL) AS printed_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.sold_at IS NULL AND v.used_at IS NULL AND v.printed_at IS NULL) AS ready_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    LEFT JOIN agents a ON a.id = b.agent_id
    WHERE b.id = ? AND b.agent_id = ?
  `).get(bId, aId);
  if (!batch) return null;
  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, comment, status, sold_at, printed_at, used_at, last_seen_comment, last_seen_uptime, last_seen_at, created_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY id ASC
  `).all(bId);
  return { batch, vouchers };
}

async function syncAgentVoucherBatch(agentId, batchId) {
  const aId = Number(agentId || 0);
  const bId = Number(batchId || 0);
  if (!aId || !bId) throw new Error('Batch voucher tidak valid');

  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ? AND agent_id = ?').get(bId, aId);
  if (!batch) throw new Error('Batch voucher tidak ditemukan');

  const routerId = batch.router_id ?? null;
  const users = await mikrotikSvc.getHotspotUsers(routerId, { bypassCache: true });
  const byName = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    if (u?.name) byName.set(String(u.name), u);
  }

  const list = db.prepare('SELECT id, code, comment, sold_at, used_at FROM vouchers WHERE batch_id = ?').all(bId);
  const updSeen = db.prepare(`
    UPDATE vouchers
    SET status = CASE
          WHEN used_at IS NOT NULL THEN 'used'
          WHEN sold_at IS NOT NULL THEN 'sold'
          WHEN printed_at IS NOT NULL THEN 'printed'
          ELSE 'created'
        END,
        last_seen_comment = ?,
        last_seen_uptime = ?,
        last_seen_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const markUsed = db.prepare(`
    UPDATE vouchers
    SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP),
        sold_at = COALESCE(sold_at, CURRENT_TIMESTAMP),
        status = 'used',
        last_seen_comment = ?,
        last_seen_uptime = ?,
        last_seen_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const markMissing = db.prepare(`
    UPDATE vouchers
    SET status = CASE
          WHEN used_at IS NOT NULL THEN 'used'
          WHEN printed_at IS NOT NULL THEN 'printed'
          ELSE 'missing'
        END,
        last_seen_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let usedNew = 0;
  let missing = 0;
  let seen = 0;

  const run = db.transaction(() => {
    for (const v of list) {
      const u = byName.get(String(v.code));
      if (!u) {
        markMissing.run(v.id);
        missing += 1;
        continue;
      }
      seen += 1;
      const comment = String(u.comment || '');
      const uptime = String(u.uptime || '');
      const normalizedUptime = uptime.trim().toLowerCase();
      const isUsedByUptime = normalizedUptime && !['0s', '0', '00:00:00'].includes(normalizedUptime);
      const storedComment = String(v.comment || '').trim();
      const lowerComment = comment.trim().toLowerCase();
      const commentChangedAfterLogin = comment.trim() &&
        comment.trim() !== storedComment &&
        !lowerComment.startsWith('ag-') &&
        !lowerComment.startsWith('vc-') &&
        !lowerComment.startsWith('up-');
      const usedNow = isUsedByUptime || commentChangedAfterLogin;
      if (usedNow && !v.used_at) {
        markUsed.run(comment, uptime, v.id);
        usedNew += 1;
      } else {
        updSeen.run(comment, uptime, v.id);
      }
    }
  });
  run();

  return { success: true, usedNew, missing, seen, total: list.length };
}

function markAgentVoucherSold(agentId, voucherId) {
  const aId = Number(agentId || 0);
  const vId = Number(voucherId || 0);
  if (!aId || !vId) throw new Error('Voucher tidak valid');

  const voucher = db.prepare(`
    SELECT v.*, b.agent_id, b.id AS batch_id
    FROM vouchers v
    JOIN voucher_batches b ON b.id = v.batch_id
    WHERE v.id = ? AND b.agent_id = ?
  `).get(vId, aId);
  if (!voucher) throw new Error('Voucher tidak ditemukan');
  if (voucher.printed_at && !voucher.sold_at && !voucher.used_at) {
    throw new Error('Voucher sudah dicetak A4 dan tidak bisa dijual digital lagi');
  }

  db.prepare(`
    UPDATE vouchers
    SET sold_at = COALESCE(sold_at, CURRENT_TIMESTAMP),
        status = CASE WHEN used_at IS NOT NULL THEN 'used' ELSE 'sold' END
    WHERE id = ?
  `).run(vId);

  return db.prepare('SELECT id, code, status, sold_at, used_at FROM vouchers WHERE id = ?').get(vId);
}

function markAgentVoucherBatchPrinted(agentId, batchId) {
  const aId = Number(agentId || 0);
  const bId = Number(batchId || 0);
  if (!aId || !bId) throw new Error('Batch voucher tidak valid');

  const batch = db.prepare('SELECT id FROM voucher_batches WHERE id = ? AND agent_id = ?').get(bId, aId);
  if (!batch) throw new Error('Batch voucher tidak ditemukan');

  const printableBefore = db.prepare(`
    SELECT id, code, password, profile_name, comment, status, sold_at, printed_at, used_at, last_seen_comment, last_seen_uptime, last_seen_at, created_at
    FROM vouchers
    WHERE batch_id = ?
      AND sold_at IS NULL
      AND used_at IS NULL
      AND printed_at IS NULL
    ORDER BY id ASC
  `).all(bId);

  const result = db.prepare(`
    UPDATE vouchers
    SET printed_at = COALESCE(printed_at, CURRENT_TIMESTAMP),
        status = CASE
          WHEN used_at IS NOT NULL THEN 'used'
          WHEN sold_at IS NOT NULL THEN 'sold'
          ELSE 'printed'
        END
    WHERE batch_id = ?
      AND sold_at IS NULL
      AND used_at IS NULL
      AND printed_at IS NULL
  `).run(bId);

  db.prepare('UPDATE voucher_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bId);
  return { success: true, printed: Number(result.changes || 0), batchId: bId, vouchers: printableBefore };
}

module.exports = {
  authenticate,
  getAllAgents,
  getAgentById,
  getAgentByPhone,
  createAgent,
  updateAgent,
  deleteAgent,
  topupAgent,
  getAgentPrices,
  upsertAgentHotspotPrice,
  deleteAgentHotspotPrice,
  listAgentTransactions,
  getAgentTransactionById,
  createAgentTopupOrder,
  getAgentTopupOrder,
  listAgentTopupOrders,
  findPendingAgentTopupByPayAmounts,
  completeAgentTopupOrder,
  payInvoiceAsAgent,
  sellVoucherAsAgent,
  createVoucherBatchAsAgent,
  listAgentVoucherBatches,
  getAgentVoucherBatch,
  syncAgentVoucherBatch,
  markAgentVoucherSold,
  markAgentVoucherBatchPrinted
};
