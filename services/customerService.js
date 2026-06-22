/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { normalizePhoneDigits } = require('./phoneService');
const { getSetting } = require('../config/settingsManager');
const whatsappGateway = require('./whatsappGatewayService');
const whatsappTemplateMedia = require('./whatsappTemplateMediaService');
const {
  buildCustomerPortalLoginLink,
  buildCustomerCheckBillingLink,
  defaultReactivationWhatsappTemplate,
  fillWhatsappTemplate
} = require('./publicLinkService');

let portalNotificationsSchemaReady = false;
let customerCodeSchemaReady = false;
let customerCodeBackfillDone = false;
let hotspotBindingSchemaReady = false;

function normalizeBillingAnchorDay(day, fallback = 10) {
  const n = parseInt(day, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(31, n));
}

function getEffectiveBillingDay(day, month1to12, year) {
  const month = Math.max(1, Math.min(12, parseInt(month1to12, 10) || 1));
  const y = Math.max(2000, parseInt(year, 10) || new Date().getFullYear());
  const normalized = normalizeBillingAnchorDay(day, 10);
  return Math.min(normalized, new Date(y, month, 0).getDate());
}

function syncUnpaidInvoiceDueDaySnapshots(customerId, dueDay) {
  const cid = Number(customerId || 0);
  if (!Number.isFinite(cid) || cid <= 0) return 0;
  const normalizedDueDay = normalizeBillingAnchorDay(dueDay, 10);
  const invoices = db.prepare(`
    SELECT id, period_month, period_year
    FROM invoices
    WHERE customer_id = ? AND status = 'unpaid'
  `).all(cid);
  if (!invoices.length) return 0;

  const update = db.prepare('UPDATE invoices SET due_day_snapshot = ? WHERE id = ?');
  let changed = 0;
  for (const invoice of invoices) {
    const effectiveDueDay = getEffectiveBillingDay(normalizedDueDay, invoice.period_month, invoice.period_year);
    changed += update.run(effectiveDueDay, invoice.id).changes || 0;
  }
  return changed;
}

function ensureHotspotBindingSchema() {
  if (hotspotBindingSchemaReady) return;
  try { db.exec("ALTER TABLE customers ADD COLUMN hotspot_username TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE customers ADD COLUMN hotspot_profile TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE customers ADD COLUMN hotspot_binding_id TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customers_hotspot_username ON customers(router_id, hotspot_username)"); } catch (_) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customers_hotspot_mac ON customers(router_id, mac_address)"); } catch (_) {}
  hotspotBindingSchemaReady = true;
}

function ensurePortalNotificationsSchema() {
  if (portalNotificationsSchemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_portal_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'system',
      tab TEXT NOT NULL DEFAULT 'home',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_customer_portal_notifications_customer_created
    ON customer_portal_notifications(customer_id, created_at DESC);
  `);
  try {
    db.exec('ALTER TABLE customers ADD COLUMN portal_notifications_seen_at DATETIME');
  } catch (_) {}
  portalNotificationsSchemaReady = true;
}

function parseSqliteUtcTimestampMs(value, fallback = Date.now()) {
  if (!value) return Number(fallback || Date.now());
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number(fallback || Date.now());
  const raw = String(value || '').trim();
  if (!raw) return Number(fallback || Date.now());
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : Number(fallback || Date.now());
}

async function trySendLifecycleWhatsapp(phone, message, templateKey = '') {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(phone || '').trim();
    if (!to) return false;
    const ready = await whatsappGateway.ensureReady(10000);
    if (!ready) return false;
    return Boolean(await whatsappTemplateMedia.sendTemplateMessage(to, String(message || '').trim(), templateKey));
  } catch (e) {
    logger.warn(`[customerService] Gagal kirim WhatsApp lifecycle: ${e.message}`);
    return false;
  }
}

function withOperationalTimeout(promise, timeoutMs, label = 'operasi') {
  const ms = Math.max(1000, Number(timeoutMs || 0) || 0);
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`${label} timeout ${ms}ms`));
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    })
  ]);
}

async function runCustomerNetworkSync(label, fn, timeoutMs = 9000) {
  try {
    await withOperationalTimeout(Promise.resolve().then(fn), timeoutMs, label);
    return true;
  } catch (error) {
    logger.warn(`[customerService] ${label} gagal/timeout: ${error.message || String(error)}`);
    return false;
  }
}

// ─── CUSTOMERS ───────────────────────────────────────────────
function getAllCustomers(search = '') {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price, p.price_before_tax as package_price_before_tax,
           p.include_ppn as package_include_ppn, p.ppn_percent as package_ppn_percent, p.pppoe_profile as package_pppoe_profile,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name,
           o.name as olt_name,
           odp.name as odp_name,
           (
             SELECT COUNT(*)
             FROM invoices
             WHERE customer_id=c.id
               AND status='unpaid'
               AND ((period_year * 100) + period_month) <= (${year} * 100 + ${month})
           ) as unpaid_count,
           u.bytes_in, u.bytes_out
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
  `;
  if (search) {
    const s = `%${search}%`;
    return db.prepare(base + ` WHERE c.name LIKE ? OR c.customer_code LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.pppoe_username LIKE ? OR c.hotspot_username LIKE ? OR c.mac_address LIKE ? OR c.static_ip LIKE ? OR c.address LIKE ? ORDER BY c.name ASC`).all(s, s, s, s, s, s, s, s, s);
  }
  return db.prepare(base + ` ORDER BY c.name ASC`).all();
}

function getCustomerSearchSuggestions(search = '', limit = 8) {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  const keyword = String(search || '').trim();
  if (!keyword) return [];
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 8, 20));
  const like = `%${keyword}%`;
  return db.prepare(`
    SELECT
      c.id,
      c.customer_code,
      c.name,
      c.phone,
      c.pppoe_username,
      c.hotspot_username,
      c.mac_address,
      c.genieacs_tag,
      c.address
    FROM customers c
    WHERE c.name LIKE ?
       OR c.customer_code LIKE ?
       OR c.phone LIKE ?
       OR c.pppoe_username LIKE ?
       OR c.hotspot_username LIKE ?
       OR c.mac_address LIKE ?
       OR c.genieacs_tag LIKE ?
       OR c.address LIKE ?
    ORDER BY
      CASE
        WHEN c.name LIKE ? THEN 0
        WHEN c.customer_code LIKE ? THEN 1
        WHEN c.phone LIKE ? THEN 2
        WHEN c.pppoe_username LIKE ? THEN 3
        WHEN c.hotspot_username LIKE ? THEN 4
        WHEN c.mac_address LIKE ? THEN 5
        WHEN c.genieacs_tag LIKE ? THEN 6
        ELSE 6
      END,
      c.name ASC
    LIMIT ${safeLimit}
  `).all(
    like, like, like, like, like, like, like, like,
    `${keyword}%`, `${keyword}%`, `${keyword}%`, `${keyword}%`, `${keyword}%`, `${keyword}%`, `${keyword}%`
  );
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function parseMoneyInput(value) {
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const numeric = Number(raw.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function normalizeCustomerDiscount(data = {}) {
  const enabled = data.discount_enabled === true
    || data.discount_enabled === 1
    || data.discount_enabled === '1'
    || data.discount_enabled === 'on'
    || data.discount_enabled === 'true';
  const amount = parseMoneyInput(data.discount_amount);
  return {
    discountEnabled: enabled && amount > 0 ? 1 : 0,
    discountAmount: enabled ? amount : 0
  };
}

function hasOwn(data, key) {
  return Object.prototype.hasOwnProperty.call(data || {}, key);
}

function normalizeDateTimeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function normalizeSpeedBoost(data = {}, current = {}) {
  const hasBoostInput = ['speed_boost_profile', 'speed_boost_until', 'speed_boost_days', 'speed_boost_note']
    .some((key) => hasOwn(data, key));
  if (!hasBoostInput) {
    return {
      profile: String(current.speed_boost_profile || '').trim(),
      until: String(current.speed_boost_until || '').trim(),
      startedAt: String(current.speed_boost_started_at || '').trim(),
      note: String(current.speed_boost_note || '').trim()
    };
  }

  const profile = String(data.speed_boost_profile || '').trim();
  if (!profile) {
    return { profile: '', until: '', startedAt: '', note: '' };
  }

  let until = normalizeDateTimeInput(data.speed_boost_until);
  const days = Number(data.speed_boost_days || 0);
  if (!until && Number.isFinite(days) && days > 0) {
    const untilDate = new Date();
    untilDate.setDate(untilDate.getDate() + Math.min(365, Math.max(1, Math.round(days))));
    until = untilDate.toISOString();
  }

  return {
    profile,
    until,
    startedAt: String(current.speed_boost_started_at || '').trim() || new Date().toISOString(),
    note: String(data.speed_boost_note || '').trim()
  };
}

function applyCustomerDiscountToAmount(customer = {}, amount = 0) {
  const base = Math.max(0, Math.round(Number(amount || 0) || 0));
  if (Number(customer.discount_enabled || 0) !== 1) return base;
  const discount = Math.max(0, Math.round(Number(customer.discount_amount || 0) || 0));
  return Math.max(0, base - Math.min(discount, base));
}

function normalizeCustomerCodePrefix(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (raw || 'SCK').slice(0, 10);
}

function normalizeCustomerCodeValue(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getCustomerCodePrefix() {
  return normalizeCustomerCodePrefix(getSetting('customer_id_prefix', 'SCK'));
}

function ensureCustomerCodeSchema() {
  if (customerCodeSchemaReady) return;
  try {
    db.exec("ALTER TABLE customers ADD COLUMN customer_code TEXT DEFAULT ''");
  } catch (_) {}
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_code_unique ON customers(customer_code) WHERE customer_code IS NOT NULL AND TRIM(customer_code) <> ''");
  } catch (_) {}
  customerCodeSchemaReady = true;
}

function resolveCustomerCodeSuffix(code, prefix) {
  const raw = String(code || '').trim().toUpperCase();
  const safePrefix = normalizeCustomerCodePrefix(prefix);
  if (!raw.startsWith(safePrefix)) return 0;
  const suffix = raw.slice(safePrefix.length);
  if (!/^\d+$/.test(suffix)) return 0;
  return Math.max(0, parseInt(suffix, 10) || 0);
}

function getNextCustomerCode(prefix = getCustomerCodePrefix(), usedCodes = null) {
  ensureCustomerCodeSchema();
  const safePrefix = normalizeCustomerCodePrefix(prefix);
  const rows = db.prepare(`
    SELECT customer_code
    FROM customers
    WHERE customer_code IS NOT NULL
      AND TRIM(customer_code) <> ''
      AND UPPER(customer_code) LIKE ?
  `).all(`${safePrefix}%`);
  let maxSuffix = 0;
  for (const row of rows) {
    maxSuffix = Math.max(maxSuffix, resolveCustomerCodeSuffix(row.customer_code, safePrefix));
  }

  let next = maxSuffix + 1;
  const isUsed = (code) => {
    if (usedCodes && usedCodes.has(code)) return true;
    return Boolean(db.prepare('SELECT id FROM customers WHERE customer_code = ? LIMIT 1').get(code));
  };
  let code = `${safePrefix}${next}`;
  while (isUsed(code)) {
    next += 1;
    code = `${safePrefix}${next}`;
  }
  return code;
}

function ensureMissingCustomerCodes() {
  ensureCustomerCodeSchema();
  if (customerCodeBackfillDone) return;
  const prefix = getCustomerCodePrefix();
  const rows = db.prepare(`
    SELECT id
    FROM customers
    WHERE customer_code IS NULL OR TRIM(customer_code) = ''
    ORDER BY id ASC
  `).all();
  if (!rows.length) {
    customerCodeBackfillDone = true;
    return;
  }

  const usedRows = db.prepare(`
    SELECT customer_code
    FROM customers
    WHERE customer_code IS NOT NULL AND TRIM(customer_code) <> ''
  `).all();
  const usedCodes = new Set(usedRows.map((row) => String(row.customer_code || '').trim()).filter(Boolean));
  const updateStmt = db.prepare('UPDATE customers SET customer_code = ? WHERE id = ?');
  const backfill = db.transaction((items) => {
    for (const item of items) {
      const code = getNextCustomerCode(prefix, usedCodes);
      usedCodes.add(code);
      updateStmt.run(code, item.id);
    }
  });
  backfill(rows);
  customerCodeBackfillDone = true;
}

function getCustomerById(id) {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price, p.price_before_tax as package_price_before_tax,
           p.include_ppn as package_include_ppn, p.ppn_percent as package_ppn_percent, p.pppoe_profile as package_pppoe_profile,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name, o.name as olt_name, odp.name as odp_name
           ,u.bytes_in, u.bytes_out
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
    WHERE c.id = ?
  `).get(id);
}

function createCustomer(data) {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  const normalizedPhone = normalizePhoneDigits(data.phone || '');
  const discount = normalizeCustomerDiscount(data);
  const speedBoost = normalizeSpeedBoost(data, {});
  const customerCode = normalizeCustomerCodeValue(data.customer_code) || getNextCustomerCode();
  return db.prepare(`
    INSERT INTO customers (customer_code, name, phone, email, address, nik, npwp, house_photo_url, ktp_photo_url, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, normal_pppoe_profile, isolir_profile, status, install_date, discount_enabled, discount_amount, speed_boost_profile, speed_boost_until, speed_boost_started_at, speed_boost_note, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address, hotspot_username, hotspot_profile, hotspot_binding_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customerCode,
    data.name, normalizedPhone || '', data.email || '', data.address || '',
    data.nik || '', data.npwp || '', data.house_photo_url || '', data.ktp_photo_url || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.normal_pppoe_profile || '',
    data.isolir_profile || 'BEATISOLIR',
    data.status || 'active',
    data.install_date || null,
    discount.discountEnabled,
    discount.discountAmount,
    speedBoost.profile,
    speedBoost.until || null,
    speedBoost.startedAt || null,
    speedBoost.note,
    data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_profile || '',
    data.hotspot_binding_id || ''
  );
}

function updateCustomer(id, data) {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  const current = db.prepare('SELECT nik, npwp, house_photo_url, ktp_photo_url, discount_enabled, discount_amount, speed_boost_profile, speed_boost_until, speed_boost_started_at, speed_boost_note, isolate_day FROM customers WHERE id=?').get(id) || {};
  const prev = db.prepare('SELECT package_id, discount_enabled, discount_amount FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);
  const hasDiscountInput = Object.prototype.hasOwnProperty.call(data, 'discount_enabled') || Object.prototype.hasOwnProperty.call(data, 'discount_amount');
  const discount = hasDiscountInput
    ? normalizeCustomerDiscount(data)
    : {
        discountEnabled: Number(current.discount_enabled || 0) === 1 ? 1 : 0,
        discountAmount: Math.max(0, Math.round(Number(current.discount_amount || 0) || 0))
      };
  const normalizedPhone = normalizePhoneDigits(data.phone || '');
  const speedBoost = normalizeSpeedBoost(data, current);
  const previousDueDay = normalizeBillingAnchorDay(current.isolate_day, 10);
  const nextDueDay = data.isolate_day !== undefined
    ? normalizeBillingAnchorDay(data.isolate_day, 10)
    : previousDueDay;

  const persistCustomer = db.transaction(() => {
    const result = db.prepare(`
      UPDATE customers SET name=?, phone=?, email=?, address=?, nik=?, npwp=?, house_photo_url=?, ktp_photo_url=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, normal_pppoe_profile=?, isolir_profile=?, status=?, install_date=?, discount_enabled=?, discount_amount=?, speed_boost_profile=?, speed_boost_until=?, speed_boost_started_at=?, speed_boost_note=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?, hotspot_username=?, hotspot_profile=?, hotspot_binding_id=?
      WHERE id=?
    `).run(
      data.name, normalizedPhone || '', data.email || '', data.address || '',
      data.nik !== undefined ? (data.nik || '') : (current.nik || ''),
      data.npwp !== undefined ? (data.npwp || '') : (current.npwp || ''),
      data.house_photo_url !== undefined ? (data.house_photo_url || '') : (current.house_photo_url || ''),
      data.ktp_photo_url !== undefined ? (data.ktp_photo_url || '') : (current.ktp_photo_url || ''),
      data.package_id ? parseInt(data.package_id) : null,
      data.router_id ? parseInt(data.router_id) : null,
      data.olt_id ? parseInt(data.olt_id) : null,
      data.odp_id ? parseInt(data.odp_id) : null,
      data.pon_port || '',
      data.lat || '',
      data.lng || '',
      data.genieacs_tag || '', data.pppoe_username || '',
      data.normal_pppoe_profile || '',
      data.isolir_profile || 'BEATISOLIR',
      data.status || 'active',
      data.install_date || null,
      discount.discountEnabled,
      discount.discountAmount,
      speedBoost.profile,
      speedBoost.until || null,
      speedBoost.startedAt || null,
      speedBoost.note,
      data.notes || '',
      data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
      nextDueDay,
      data.cable_path || null,
      data.connection_type || 'pppoe',
      data.static_ip || '',
      data.mac_address || '',
      data.hotspot_username || '',
      data.hotspot_profile || '',
      data.hotspot_binding_id || '',
      id
    );

    if (pkgChanged) {
      db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
    }

    result.dueDayChanged = nextDueDay !== previousDueDay;
    result.invoiceDueDatesUpdated = result.dueDayChanged
      ? syncUnpaidInvoiceDueDaySnapshots(id, nextDueDay)
      : 0;
    return result;
  });

  return persistCustomer();
}

function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

function updateCustomerMapLocation(id, lat, lng, options = {}) {
  const customerId = Number(id);
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(customerId) || customerId <= 0) throw new Error('ID pelanggan tidak valid');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Koordinat pelanggan tidak valid');
  const clearCablePath = options.clearCablePath !== false;
  return db.prepare(`
    UPDATE customers
    SET lat = ?, lng = ?, cable_path = CASE WHEN ? = 1 THEN NULL ELSE cable_path END
    WHERE id = ?
  `).run(latitude.toFixed(6), longitude.toFixed(6), clearCablePath ? 1 : 0, customerId);
}

function updateCustomerOdpLink(id, odpId, options = {}) {
  const customerId = Number(id);
  const normalizedOdpId = odpId == null || odpId === '' ? null : Number(odpId);
  if (!Number.isFinite(customerId) || customerId <= 0) throw new Error('ID pelanggan tidak valid');
  if (normalizedOdpId !== null && (!Number.isFinite(normalizedOdpId) || normalizedOdpId <= 0)) {
    throw new Error('ID ODP tidak valid');
  }
  const clearCablePath = options.clearCablePath !== false;
  return db.prepare(`
    UPDATE customers
    SET odp_id = ?, cable_path = CASE WHEN ? = 1 THEN NULL ELSE cable_path END
    WHERE id = ?
  `).run(normalizedOdpId, clearCablePath ? 1 : 0, customerId);
}

function markPortalNotificationsSeen(customerId, seenAt = null) {
  ensurePortalNotificationsSchema();
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  const ts = seenAt || new Date().toISOString();
  return db.prepare('UPDATE customers SET portal_notifications_seen_at = ? WHERE id = ?').run(ts, id);
}

function pruneOldPortalNotifications(retentionDays = 30) {
  ensurePortalNotificationsSchema();
  const days = Math.max(1, Math.min(Number(retentionDays || 30) || 30, 365));
  return db.prepare(`
    DELETE FROM customer_portal_notifications
    WHERE datetime(created_at) < datetime('now', ?)
  `).run(`-${days} days`);
}

function getPortalNotifications(customerId, limit = 20) {
  ensurePortalNotificationsSchema();
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
  return db.prepare(`
    SELECT id, customer_id, kind, tab, title, body, payload_json, created_at
    FROM customer_portal_notifications
    WHERE customer_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ${safeLimit}
  `).all(id);
}

function deletePortalNotification(customerId, notificationId) {
  ensurePortalNotificationsSchema();
  const cid = Number(customerId);
  const nid = Number(notificationId);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('ID pelanggan tidak valid');
  if (!Number.isFinite(nid) || nid <= 0) throw new Error('ID pesan tidak valid');
  return db.prepare(`
    DELETE FROM customer_portal_notifications
    WHERE id = ? AND customer_id = ?
  `).run(nid, cid);
}

function addPortalNotification(customerId, data = {}, options = {}) {
  ensurePortalNotificationsSchema();
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const kind = String(data.kind || 'system').trim() || 'system';
  const tab = String(data.tab || 'home').trim() || 'home';
  const title = String(data.title || '').trim();
  const body = String(data.body || '').trim();
  if (!title) return null;

  const dedupeWindowMs = Math.max(0, Number(options.dedupeWindowMs || 0) || 0);
  if (dedupeWindowMs > 0) {
    const existing = db.prepare(`
      SELECT id, created_at
      FROM customer_portal_notifications
      WHERE customer_id = ? AND kind = ? AND title = ? AND body = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `).get(id, kind, title, body);
    if (existing?.created_at) {
      const ageMs = Date.now() - parseSqliteUtcTimestampMs(existing.created_at, Date.now());
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < dedupeWindowMs) {
        return existing;
      }
    }
  }

  const payloadJson = data.payload == null ? null : JSON.stringify(data.payload);
  const result = db.prepare(`
    INSERT INTO customer_portal_notifications (customer_id, kind, tab, title, body, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, kind, tab, title, body, payloadJson);
  const row = db.prepare(`
    SELECT id, customer_id, kind, tab, title, body, payload_json, created_at
    FROM customer_portal_notifications
    WHERE id = ?
  `).get(result.lastInsertRowid);

  if (row?.id && options.push === true) {
    setImmediate(() => {
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const { isPushConfigured, sendPushToCustomer } = require('./pushNotificationService');
        const settings = getSettingsWithCache();
        if (!isPushConfigured(settings)) return;
        const targetTab = String(tab || 'home').replace(/^#/, '') || 'home';
        Promise.resolve(sendPushToCustomer({ id }, {
          settings,
          title,
          message: body || title,
          targetUrl: `/customer/dashboard#${targetTab}`,
          data: {
            kind,
            source: 'portal-notification',
            notificationId: Number(row.id || 0) || null,
            customerId: id,
            ...(data.payload && typeof data.payload === 'object' ? data.payload : {})
          },
          timeoutMs: Number(options.pushTimeoutMs || 7000)
        })).catch((error) => {
          try {
            const { logger } = require('../config/logger');
            logger.warn(`[CustomerPortal] Gagal kirim push pelanggan ${id}: ${error.message || String(error)}`);
          } catch (_) {}
        });
      } catch (error) {
        try {
          const { logger } = require('../config/logger');
          logger.warn(`[CustomerPortal] Gagal menyiapkan push pelanggan ${id}: ${error.message || String(error)}`);
        } catch (_) {}
      }
    });
  }

  return row;
}

function addPortalNotificationsBulk(customerIds = [], data = {}, options = {}) {
  ensurePortalNotificationsSchema();
  const ids = Array.from(new Set((Array.isArray(customerIds) ? customerIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)));
  if (!ids.length) return 0;

  const tx = db.transaction((resolvedIds) => {
    let inserted = 0;
    resolvedIds.forEach((customerId) => {
      const row = addPortalNotification(customerId, data, options);
      if (row?.id) inserted += 1;
    });
    return inserted;
  });

  return tx(ids);
}

async function deleteCustomer(id) {
  const customer = getCustomerById(id);
  if (customer && customer.connection_type === 'static' && customer.static_ip) {
    const mikrotikSvc = require('./mikrotikService');
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

function getCustomerStats() {
  return {
    total:     db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    active:    db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,
    suspended: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='suspended'").get().c,
    inactive:  db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='inactive'").get().c,
  };
}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages() {
  return db.prepare(`
    SELECT p.*, COUNT(c.id) as customer_count
    FROM packages p LEFT JOIN customers c ON c.package_id = p.id
    GROUP BY p.id ORDER BY p.price ASC
  `).all();
}

function getPortalPackages(currentPackageId = null) {
  const currentId = Number(currentPackageId || 0) || 0;
  return db.prepare(`
    SELECT *
    FROM packages
    WHERE is_active = 1
      AND (show_in_portal = 1 OR id = ?)
    ORDER BY price ASC, name ASC
  `).all(currentId);
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}

function parseTaxInclusiveFields(data) {
  const grossPrice = Math.max(0, parseInt(data.price, 10) || 0);
  const includePpn =
    data.include_ppn === 1 ||
    data.include_ppn === '1' ||
    data.include_ppn === true ||
    data.include_ppn === 'true' ||
    data.include_ppn === 'on';
  const ppnPercent = includePpn ? Math.max(0, parseFloat(data.ppn_percent) || 0) : 0;
  const divisor = 1 + (ppnPercent / 100);
  const basePrice = includePpn && divisor > 0
    ? Math.round(grossPrice / divisor)
    : grossPrice;
  return {
    grossPrice,
    includePpn: includePpn ? 1 : 0,
    ppnPercent,
    basePrice
  };
}

function createPackage(data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const normalProfile = String(data.pppoe_profile || data.name || '').trim();

  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const tax = parseTaxInclusiveFields(data);

  return db.prepare(`
    INSERT INTO packages (
      name, pppoe_profile, price, price_before_tax, include_ppn, ppn_percent, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, 
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description, show_in_portal
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, normalProfile, tax.grossPrice, tax.basePrice, tax.includePpn, tax.ppnPercent, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '',
    data.show_in_portal ? 1 : 0
  );
}

function parsePromoPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updatePackage(id, data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const normalProfile = String(data.pppoe_profile || data.name || '').trim();
  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const tax = parseTaxInclusiveFields(data);

  return db.prepare(`
    UPDATE packages 
    SET name=?, pppoe_profile=?, price=?, price_before_tax=?, include_ppn=?, ppn_percent=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, 
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=?, show_in_portal=? 
    WHERE id=?
  `).run(
    data.name, normalProfile, tax.grossPrice, tax.basePrice, tax.includePpn, tax.ppnPercent, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0, data.show_in_portal ? 1 : 0, id
  );
}

function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function resolvePackageNormalProfile(targetPackage) {
  const packageProfile = String(targetPackage?.pppoe_profile || targetPackage?.name || '').trim();
  return packageProfile || 'default';
}

function normalizeInvoiceAdjustmentMode(mode) {
  const raw = String(mode || 'all_unpaid').trim().toLowerCase();
  if (['all_unpaid', 'from_effective_period', 'none'].includes(raw)) return raw;
  return 'all_unpaid';
}

async function applyCustomerPackageChange(customerId, targetPackageId, options = {}) {
  const cid = Number(customerId || 0);
  const pid = Number(targetPackageId || 0);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Pelanggan tidak valid');
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('Paket tujuan tidak valid');

  const customer = getCustomerById(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const targetPackage = getPackageById(pid);
  if (!targetPackage || Number(targetPackage.is_active || 0) !== 1) {
    throw new Error('Paket tujuan tidak tersedia');
  }
  if (options.requirePortalVisibility !== false && Number(targetPackage.show_in_portal || 0) !== 1) {
    throw new Error('Paket ini belum dibuka untuk pelanggan');
  }
  if (Number(customer.package_id || 0) === pid) {
    throw new Error('Paket yang dipilih sudah menjadi paket aktif Anda');
  }

  const currentPackage = customer.package_id ? getPackageById(customer.package_id) : null;
  const targetProfile = resolvePackageNormalProfile(targetPackage);
  const targetInvoiceAmount = applyCustomerDiscountToAmount(customer, targetPackage.price);
  const note = String(options.changeNote || `Paket diubah dari ${currentPackage?.name || '-'} ke ${targetPackage.name}`).trim();
  const invoiceAdjustmentMode = normalizeInvoiceAdjustmentMode(options.invoiceAdjustmentMode);
  const effectiveMonth = Number(options.effectiveMonth || 0) || null;
  const effectiveYear = Number(options.effectiveYear || 0) || null;
  const updatePendingInvoices = db.transaction(() => {
    db.prepare('UPDATE customers SET package_id = ?, normal_pppoe_profile = ?, promo_cycles_used = 0 WHERE id = ?').run(pid, targetProfile, cid);
    if (invoiceAdjustmentMode === 'none') return 0;

    if (invoiceAdjustmentMode === 'from_effective_period' && effectiveMonth && effectiveYear) {
      const updated = db.prepare(`
        UPDATE invoices
        SET amount = ?,
            notes = TRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' | ' END || ?)
        WHERE customer_id = ?
          AND status = 'unpaid'
          AND (
            period_year > ?
            OR (period_year = ? AND period_month >= ?)
          )
      `).run(targetInvoiceAmount, note, cid, effectiveYear, effectiveYear, effectiveMonth);
      return updated.changes || 0;
    }

    const updated = db.prepare(`
      UPDATE invoices
      SET amount = ?,
          notes = TRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' | ' END || ?)
      WHERE customer_id = ? AND status = 'unpaid'
    `).run(targetInvoiceAmount, note, cid);
    return updated.changes || 0;
  });

  const updatedInvoiceCount = updatePendingInvoices();
  const refreshedCustomer = getCustomerById(cid);
  let mikrotikProfileSynced = false;
  let mikrotikSyncSkipped = false;
  let mikrotikSyncMessage = '';
  let mikrotikSessionReset = false;
  let mikrotikSessionResetMessage = '';

  if (refreshedCustomer?.pppoe_username && refreshedCustomer?.router_id) {
    if (String(refreshedCustomer.status || '').toLowerCase() === 'active') {
      try {
        const mikrotikSvc = require('./mikrotikService');
        await mikrotikSvc.setPppoeProfile(refreshedCustomer.pppoe_username, targetProfile, refreshedCustomer.router_id);
        mikrotikProfileSynced = true;
        if (options.resetActiveSession !== false) {
          const kicked = await mikrotikSvc.kickPppoeUser(refreshedCustomer.pppoe_username, refreshedCustomer.router_id);
          mikrotikSessionReset = Boolean(kicked);
          mikrotikSessionResetMessage = kicked
            ? 'Koneksi aktif PPPoE diputus agar pelanggan reconnect dengan profil paket terbaru.'
            : 'Tidak ada sesi PPPoE aktif yang perlu diputus saat perubahan paket diterapkan.';
        }
      } catch (error) {
        mikrotikSyncMessage = error.message || 'Sinkron profil MikroTik gagal';
        logger.warn(`[customerService] Gagal sinkron profil PPPoE saat pindah paket customer ${cid}: ${mikrotikSyncMessage}`);
      }
    } else {
      mikrotikSyncSkipped = true;
      mikrotikSyncMessage = 'Pelanggan sedang tidak aktif/suspend, profil normal disimpan dan akan dipakai saat layanan aktif kembali.';
    }
  } else if (refreshedCustomer?.pppoe_username) {
    mikrotikSyncSkipped = true;
    mikrotikSyncMessage = 'Router pelanggan belum terhubung, jadi profil normal hanya diperbarui di database.';
  }

  return {
    customer: refreshedCustomer,
    currentPackage,
    targetPackage,
    targetProfile,
    updatedInvoiceCount,
    mikrotikProfileSynced,
    mikrotikSyncSkipped,
    mikrotikSyncMessage,
    mikrotikSessionReset,
    mikrotikSessionResetMessage
  };
}

async function applyPortalPackageChange(customerId, targetPackageId) {
  return applyCustomerPackageChange(customerId, targetPackageId, {
    requirePortalVisibility: true,
    invoiceAdjustmentMode: 'all_unpaid',
    changeNote: undefined
  });
}

function findCustomerByAny(val) {
  ensureMissingCustomerCodes();
  if (!val) return null;
  const cleanVal = val.toString().trim();

  const byCode = db.prepare('SELECT id FROM customers WHERE UPPER(customer_code) = UPPER(?)').get(cleanVal);
  if (byCode) return getCustomerById(byCode.id);
  
  // 1. Try Phone (Priority for Login)
  const normalizedPhone = normalizePhoneDigits(cleanVal);
  const rawPhoneDigits = cleanVal.replace(/\D/g, '');
  const phoneCandidates = Array.from(new Set([
    normalizedPhone,
    rawPhoneDigits,
    normalizedPhone ? normalizedPhone.slice(-12) : '',
    normalizedPhone ? normalizedPhone.slice(-11) : '',
    normalizedPhone ? normalizedPhone.slice(-10) : '',
    normalizedPhone ? normalizedPhone.slice(-9) : ''
  ].filter(Boolean)));

  for (const candidate of phoneCandidates) {
    const p1 = db.prepare('SELECT id FROM customers WHERE phone = ?').get(candidate);
    if (p1) return getCustomerById(p1.id);
  }

  if (phoneCandidates.length) {
    for (const candidate of phoneCandidates) {
      const p2 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${candidate}`);
      if (p2) return getCustomerById(p2.id);
    }
  }

  // 2. Try GenieACS Tag atau PPPoE Username (Exact Match)
  const t = db.prepare('SELECT id FROM customers WHERE genieacs_tag = ? OR pppoe_username = ?').get(cleanVal, cleanVal);
  if (t) return getCustomerById(t.id);

  // 3. Try ID if numeric
  if (/^\d+$/.test(cleanVal) && cleanVal.length < 8) {
    const c = getCustomerById(parseInt(cleanVal));
    if (c) return c;
  }
  
  return null;
}

function findCustomerByPublicBillingLookup(val) {
  ensureMissingCustomerCodes();
  ensureHotspotBindingSchema();
  if (!val) return null;
  const raw = String(val || '').trim();
  if (!raw) return null;

  const byCode = db.prepare('SELECT id FROM customers WHERE UPPER(customer_code) = UPPER(?)').get(raw);
  if (byCode) return getCustomerById(byCode.id);

  const normalizedPhone = normalizePhoneDigits(raw);
  const rawPhoneDigits = raw.replace(/\D/g, '');
  const phoneCandidates = Array.from(new Set([
    normalizedPhone,
    rawPhoneDigits,
    normalizedPhone && normalizedPhone.startsWith('62') ? `0${normalizedPhone.slice(2)}` : '',
    rawPhoneDigits && rawPhoneDigits.startsWith('62') ? `0${rawPhoneDigits.slice(2)}` : ''
  ].filter(Boolean)));

  for (const candidate of phoneCandidates) {
    const phoneMatch = db.prepare('SELECT id FROM customers WHERE phone = ?').get(candidate);
    if (phoneMatch) return getCustomerById(phoneMatch.id);
  }

  const exact = db.prepare(`
    SELECT id
    FROM customers
    WHERE genieacs_tag = ?
       OR pppoe_username = ?
       OR hotspot_username = ?
       OR static_ip = ?
       OR mac_address = ?
  `).get(raw, raw, raw, raw, raw);
  if (exact) return getCustomerById(exact.id);

  if (/^\d+$/.test(raw) && raw.length < 8) {
    const byId = getCustomerById(Number(raw));
    if (byId) return byId;
  }

  return null;
}

function getExpiredSpeedBoostCustomers(now = new Date()) {
  ensureCustomerCodeSchema();
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  return db.prepare(`
    SELECT c.*, p.pppoe_profile AS package_pppoe_profile, p.name AS package_name
    FROM customers c
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE TRIM(COALESCE(c.speed_boost_profile, '')) <> ''
      AND c.speed_boost_until IS NOT NULL
      AND TRIM(c.speed_boost_until) <> ''
      AND datetime(c.speed_boost_until) <= datetime(?)
      AND TRIM(COALESCE(c.pppoe_username, '')) <> ''
  `).all(iso);
}

function clearSpeedBoost(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare(`
    UPDATE customers
    SET speed_boost_profile = '',
        speed_boost_until = NULL,
        speed_boost_started_at = NULL,
        speed_boost_note = ''
    WHERE id = ?
  `).run(id);
}

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'suspended' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'hotspot_binding') {
    await runCustomerNetworkSync(`Sinkron isolir hotspot pelanggan ${customer.id}`, () => mikrotikSvc.setHotspotBindingCustomerAccess(customer, false));
  } else if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await runCustomerNetworkSync(`Sinkron isolir IP statis pelanggan ${customer.id}`, () => mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: true
    }, customer.router_id));
  } else if (customer.pppoe_username) {
    const isolirProfile = customer.isolir_profile || 'BEATISOLIR';
    await runCustomerNetworkSync(`Sinkron isolir PPPoE pelanggan ${customer.id}`, () => mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, customer.router_id));
    if (customer.router_id) {
      try {
        await withOperationalTimeout(
          mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, customer.router_id),
          9000,
          `Hook profil isolir ${isolirProfile}`
        );
      } catch (e) {
        logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${customer.router_id}: ${e.message}`);
      }
    }
  }
  addPortalNotification(id, {
    kind: 'suspension',
    tab: 'billing',
    title: 'Layanan diisolir sementara',
    body: 'Masih ada tagihan yang belum lunas. Silakan cek tagihan atau hubungi admin untuk bantuan.'
  }, { dedupeWindowMs: 6 * 60 * 60 * 1000 });
  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'active' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'hotspot_binding') {
    await runCustomerNetworkSync(`Sinkron aktif hotspot pelanggan ${customer.id}`, () => mikrotikSvc.setHotspotBindingCustomerAccess(customer, true));
  } else if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await runCustomerNetworkSync(`Sinkron aktif IP statis pelanggan ${customer.id}`, () => mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: false
    }, customer.router_id));
  } else if (customer.pppoe_username) {
    const pkg = getPackageById(customer.package_id);
    const targetProfile = customer.normal_pppoe_profile || (pkg ? (pkg.pppoe_profile || pkg.name) : 'default');
    await runCustomerNetworkSync(`Sinkron aktif PPPoE pelanggan ${customer.id}`, () => mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id, { forceKick: true }));
  }

  if (customer.phone) {
    const groupLink = String(getSetting('whatsapp_group_invite_link', '') || '').trim();
    const template = String(
      getSetting('whatsapp_reactivation_message', defaultReactivationWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
      defaultReactivationWhatsappTemplate(getSetting('company_header', 'ISP'))
    ).trim();
    const message = fillWhatsappTemplate(template, {
      nama: customer.name || 'Pelanggan',
      paket: customer.package_name || '-',
      link: buildCustomerCheckBillingLink(customer),
      portal_link: buildCustomerPortalLoginLink(),
      login_id: String(customer.pppoe_username || customer.genieacs_tag || customer.phone || customer.id || '').trim(),
      group_link: groupLink,
      group_line: groupLink ? `Grup pelanggan: ${groupLink}` : '',
      company: getSetting('company_header', 'ISP')
    });
    withOperationalTimeout(
      trySendLifecycleWhatsapp(customer.phone, message, 'reactivation'),
      12000,
      `WhatsApp reaktivasi pelanggan ${customer.id}`
    ).catch((error) => {
      logger.warn(`[customerService] WhatsApp reaktivasi pelanggan ${customer.id} gagal/timeout: ${error.message || String(error)}`);
    });
  }
  addPortalNotification(id, {
    kind: 'reactivation',
    tab: 'home',
    title: 'Layanan aktif kembali',
    body: 'Pembayaran atau aktivasi Anda sudah kami terima. Internet bisa dipakai kembali seperti biasa.'
  }, { dedupeWindowMs: 6 * 60 * 60 * 1000 });
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPortalPackages, getPackageById, createPackage, updatePackage, deletePackage, applyCustomerPackageChange, applyPortalPackageChange,
  suspendCustomer, activateCustomer, findCustomerByAny, findCustomerByPublicBillingLookup, updateCustomerCablePath, updateCustomerMapLocation, updateCustomerOdpLink,
  resetPromoCyclesUsed, markPortalNotificationsSeen, pruneOldPortalNotifications, getPortalNotifications, deletePortalNotification, addPortalNotification, addPortalNotificationsBulk,
  getCustomerSearchSuggestions, getExpiredSpeedBoostCustomers, clearSpeedBoost
};
