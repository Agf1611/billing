/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { normalizePhoneDigits } = require('./phoneService');
const { getSetting } = require('../config/settingsManager');
const {
  buildCustomerPortalLoginLink,
  buildCustomerCheckBillingLink,
  defaultReactivationWhatsappTemplate,
  fillWhatsappTemplate
} = require('./publicLinkService');

async function trySendLifecycleWhatsapp(phone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(phone || '').trim();
    if (!to) return false;
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') return false;
    return Boolean(await sendWA(to, String(message || '').trim()));
  } catch (e) {
    logger.warn(`[customerService] Gagal kirim WhatsApp lifecycle: ${e.message}`);
    return false;
  }
}

// ─── CUSTOMERS ───────────────────────────────────────────────
function getAllCustomers(search = '') {
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
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count,
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
    return db.prepare(base + ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ? ORDER BY c.name ASC`).all(s, s, s, s);
  }
  return db.prepare(base + ` ORDER BY c.name ASC`).all();
}

function getCustomerSearchSuggestions(search = '', limit = 8) {
  const keyword = String(search || '').trim();
  if (!keyword) return [];
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 8, 20));
  const like = `%${keyword}%`;
  return db.prepare(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.pppoe_username,
      c.genieacs_tag,
      c.address
    FROM customers c
    WHERE c.name LIKE ?
       OR c.phone LIKE ?
       OR c.pppoe_username LIKE ?
       OR c.genieacs_tag LIKE ?
       OR c.address LIKE ?
    ORDER BY
      CASE
        WHEN c.name LIKE ? THEN 0
        WHEN c.phone LIKE ? THEN 1
        WHEN c.pppoe_username LIKE ? THEN 2
        WHEN c.genieacs_tag LIKE ? THEN 3
        ELSE 4
      END,
      c.name ASC
    LIMIT ${safeLimit}
  `).all(
    like, like, like, like, like,
    `${keyword}%`, `${keyword}%`, `${keyword}%`, `${keyword}%`
  );
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function getCustomerById(id) {
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
  const normalizedPhone = normalizePhoneDigits(data.phone || '');
  return db.prepare(`
    INSERT INTO customers (name, phone, email, address, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, normal_pppoe_profile, isolir_profile, status, install_date, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, normalizedPhone || '', data.email || '', data.address || '',
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
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || ''
  );
}

function updateCustomer(id, data) {
  const prev = db.prepare('SELECT package_id FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);
  const normalizedPhone = normalizePhoneDigits(data.phone || '');

  const result = db.prepare(`
    UPDATE customers SET name=?, phone=?, email=?, address=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, normal_pppoe_profile=?, isolir_profile=?, status=?, install_date=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?
    WHERE id=?
  `).run(
    data.name, normalizedPhone || '', data.email || '', data.address || '',
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
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.cable_path || null,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    id
  );

  if (pkgChanged) {
    db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
  }

  return result;
}

function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

function markPortalNotificationsSeen(customerId, seenAt = null) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  const ts = seenAt || new Date().toISOString();
  return db.prepare('UPDATE customers SET portal_notifications_seen_at = ? WHERE id = ?').run(ts, id);
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

function applyPortalPackageChange(customerId, targetPackageId) {
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
  if (Number(targetPackage.show_in_portal || 0) !== 1) {
    throw new Error('Paket ini belum dibuka untuk pelanggan');
  }
  if (Number(customer.package_id || 0) === pid) {
    throw new Error('Paket yang dipilih sudah menjadi paket aktif Anda');
  }

  const currentPackage = customer.package_id ? getPackageById(customer.package_id) : null;
  const note = `Paket diubah via portal pelanggan dari ${currentPackage?.name || '-'} ke ${targetPackage.name}`;
  const run = db.transaction(() => {
    db.prepare('UPDATE customers SET package_id = ?, promo_cycles_used = 0 WHERE id = ?').run(pid, cid);
    const updated = db.prepare(`
      UPDATE invoices
      SET amount = ?,
          notes = TRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' | ' END || ?)
      WHERE customer_id = ? AND status = 'unpaid'
    `).run(Number(targetPackage.price || 0), note, cid);
    return updated.changes || 0;
  });

  return {
    customer: getCustomerById(cid),
    currentPackage,
    targetPackage,
    updatedInvoiceCount: run()
  };
}

function findCustomerByAny(val) {
  if (!val) return null;
  const cleanVal = val.toString().trim();
  
  // 1. Try Phone (Priority for Login)
  const phoneDigits = cleanVal.replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    // Cari yang 8-10 digit terakhirnya sama (lebih akurat untuk 08 vs 62)
    const suffix = phoneDigits.slice(-9);
    const p1 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${suffix}`);
    if (p1) return getCustomerById(p1.id);
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

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'suspended' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: true
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const isolirProfile = customer.isolir_profile || 'BEATISOLIR';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, customer.router_id);
    if (customer.router_id) {
      try {
        await mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, customer.router_id);
      } catch (e) {
        logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${customer.router_id}: ${e.message}`);
      }
    }
  }
  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'active' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: false
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const pkg = getPackageById(customer.package_id);
    const targetProfile = customer.normal_pppoe_profile || (pkg ? (pkg.pppoe_profile || pkg.name) : 'default');
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id);
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
    await trySendLifecycleWhatsapp(customer.phone, message);
  }
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPortalPackages, getPackageById, createPackage, updatePackage, deletePackage, applyPortalPackageChange,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed, markPortalNotificationsSeen, getCustomerSearchSuggestions
};
