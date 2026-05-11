/**
 * Service: Logika Billing & Tagihan
 */
const db = require('../config/database');
const auditTrail = require('./auditTrailService');
const bookkeepingSvc = require('./bookkeepingService');

function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

function parseInstallYMD(installDate) {
  if (!installDate || typeof installDate !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(installDate.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function normalizeBillingAnchorDay(day, fallback = 10) {
  const n = parseInt(day, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(31, n));
}

function getEffectiveBillingDay(day, month1to12, year) {
  const month = Math.max(1, Math.min(12, parseInt(month1to12, 10) || 1));
  const y = Math.max(2000, parseInt(year, 10) || new Date().getFullYear());
  const normalized = normalizeBillingAnchorDay(day, 10);
  return Math.min(normalized, daysInMonth(y, month));
}

function resolveInvoiceDueDay(customer, periodMonth, periodYear) {
  return getEffectiveBillingDay(customer?.isolate_day, periodMonth, periodYear);
}

function getInvoiceDueDate(invoice, fallbackDay = 10) {
  if (!invoice) return null;
  const periodMonth = Number(invoice.period_month || 0);
  const periodYear = Number(invoice.period_year || 0);
  if (!periodMonth || !periodYear) return null;
  const snapshotDay = invoice.due_day_snapshot != null
    ? normalizeBillingAnchorDay(invoice.due_day_snapshot, fallbackDay)
    : normalizeBillingAnchorDay(fallbackDay, 10);
  const dueDay = getEffectiveBillingDay(snapshotDay, periodMonth, periodYear);
  return new Date(periodYear, periodMonth - 1, dueDay, 23, 59, 59, 999);
}

function isInvoiceLateForCustomer(invoice, customer, paymentDate = new Date()) {
  if (!invoice || !customer) return false;
  const dueAt = getInvoiceDueDate(invoice, customer.isolate_day);
  if (!dueAt) return false;
  return paymentDate.getTime() > dueAt.getTime();
}

function shiftCustomerBillingAnchorAfterLatePayment(customerId, invoiceLike, paymentDate = new Date()) {
  const cid = Number(customerId || 0);
  if (!Number.isFinite(cid) || cid <= 0) return { shifted: false };

  const customer = db.prepare('SELECT id, isolate_day FROM customers WHERE id=?').get(cid);
  if (!customer) return { shifted: false };
  if (!isInvoiceLateForCustomer(invoiceLike, customer, paymentDate)) {
    return {
      shifted: false,
      previousDay: normalizeBillingAnchorDay(customer.isolate_day, 10)
    };
  }

  const paymentDay = normalizeBillingAnchorDay(paymentDate.getDate(), 10);
  const previousDay = normalizeBillingAnchorDay(customer.isolate_day, 10);
  if (paymentDay === previousDay) {
    return { shifted: false, previousDay, newDay: paymentDay };
  }

  db.prepare('UPDATE customers SET isolate_day=? WHERE id=?').run(paymentDay, cid);
  return { shifted: true, previousDay, newDay: paymentDay };
}

function countInvoicesForCustomer(customerId) {
  const r = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE customer_id=?').get(customerId);
  return r ? Number(r.c) || 0 : 0;
}

/**
 * Hitung nominal tagihan + catatan otomatis (promo siklus & prorata bulan pertama).
 * Promo: pakai promo_price untuk N invoice pertama per pelanggan (promo_cycles), lalu harga normal.
 * Prorata: jika paket mengaktifkan prorate_first_invoice, belum pernah ada invoice,
 *          tanggal pasang (install_date) di bulan/tahun tagihan yang sama → proporsi sisa hari bulan.
 */
function computeInvoiceAmountAndMeta(customer, pkg, periodMonth, periodYear) {
  const price = Number(pkg.price) || 0;
  const promoRaw = pkg.promo_price;
  const promoPrice = promoRaw != null && promoRaw !== '' ? Number(promoRaw) : null;
  const promoCycles = Math.max(0, parseInt(pkg.promo_cycles, 10) || 0);
  const promoUsed = Math.max(0, parseInt(customer.promo_cycles_used, 10) || 0);
  const prorateEnabled = !!pkg.prorate_first_invoice;

  const usePromo = promoPrice != null && Number.isFinite(promoPrice) && promoCycles > 0 && promoUsed < promoCycles;
  let amount = usePromo ? promoPrice : price;

  const priorCount = countInvoicesForCustomer(customer.id);
  const isFirstEverInvoice = priorCount === 0;
  let prorated = false;
  let billableDays = null;
  let dim = null;

  if (prorateEnabled && isFirstEverInvoice && customer.install_date) {
    const inst = parseInstallYMD(String(customer.install_date));
    if (inst && inst.y === periodYear && inst.m === periodMonth) {
      dim = daysInMonth(periodYear, periodMonth);
      billableDays = Math.min(dim, Math.max(1, dim - inst.d + 1));
      amount = Math.round(amount * (billableDays / dim));
      prorated = billableDays < dim;
    }
  }

  const metaParts = [];
  if (usePromo) {
    metaParts.push(`Promo siklus ${promoUsed + 1}/${promoCycles} @ Rp ${Number(promoPrice).toLocaleString('id-ID')}`);
  }
  if (prorated && billableDays != null && dim != null) {
    metaParts.push(`Prorata ${billableDays}/${dim} hari`);
  }
  const notesAuto = metaParts.length ? `AUTO: ${metaParts.join(' | ')}` : '';

  return {
    amount: Math.max(0, Math.round(amount)),
    bumpPromo: usePromo,
    notesAuto
  };
}

function generateMonthlyInvoices(month, year) {
  const customers = db.prepare("SELECT * FROM customers WHERE status IN ('active','suspended') AND package_id IS NOT NULL").all();
  const existing  = db.prepare('SELECT customer_id FROM invoices WHERE period_month=? AND period_year=?').all(month, year);
  const existingIds = new Set(existing.map(e => e.customer_id));
  const insert = db.prepare(`INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)`);
  const bumpPromo = db.prepare('UPDATE customers SET promo_cycles_used = COALESCE(promo_cycles_used,0) + 1 WHERE id=?');
  let created = 0;
  const createdInvoiceIds = [];
  const run = db.transaction(() => {
    for (const c of customers) {
      if (existingIds.has(c.id)) continue;
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(c.package_id);
      if (!pkg) continue;
      const { amount, bumpPromo: bump, notesAuto } = computeInvoiceAmountAndMeta(c, pkg, month, year);
      const result = insert.run(c.id, month, year, amount, notesAuto, resolveInvoiceDueDay(c, month, year));
      if (bump) bumpPromo.run(c.id);
      createdInvoiceIds.push(result.lastInsertRowid);
      created++;
    }
  });
  run();
  return {
    count: created,
    createdInvoiceIds
  };
}

function generateInvoiceForCustomer(customerId, month, year) {
  const cid = Number(customerId);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');
  if (!Number.isFinite(m) || m < 1 || m > 12) throw new Error('Bulan tidak valid');
  if (!Number.isFinite(y) || y < 2000 || y > 3000) throw new Error('Tahun tidak valid');

  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  if (!customer.package_id) throw new Error('Pelanggan belum memiliki paket');

  const exists = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND period_month=? AND period_year=? LIMIT 1').get(cid, m, y);
  if (exists) {
    return { created: false, invoiceId: exists.id, customerName: customer.name };
  }

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(customer.package_id);
  if (!pkg) throw new Error('Paket pelanggan tidak ditemukan');

  const { amount, bumpPromo: bump, notesAuto } = computeInvoiceAmountAndMeta(customer, pkg, m, y);
  const r = db.prepare('INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(
    cid, m, y, amount, notesAuto, resolveInvoiceDueDay(customer, m, y)
  );
  if (bump) {
    db.prepare('UPDATE customers SET promo_cycles_used = COALESCE(promo_cycles_used,0) + 1 WHERE id=?').run(cid);
  }
  return { created: true, invoiceId: r.lastInsertRowid, customerName: customer.name };
}

function payInvoiceForCustomerPeriod(customerId, month, year, paidByName, notes) {
  const cid = Number(customerId);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');
  if (!Number.isFinite(m) || m < 1 || m > 12) throw new Error('Bulan tidak valid');
  if (!Number.isFinite(y) || y < 2000 || y > 3000) throw new Error('Tahun tidak valid');

  const customer = db.prepare('SELECT id, name FROM customers WHERE id=?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const inv = db.prepare('SELECT id, status FROM invoices WHERE customer_id=? AND period_month=? AND period_year=? LIMIT 1').get(cid, m, y);
  if (inv && inv.status === 'paid') {
    return { created: false, paid: false, alreadyPaid: true, invoiceId: inv.id, customerName: customer.name };
  }

  const ensure = generateInvoiceForCustomer(cid, m, y);
  markAsPaid(ensure.invoiceId, paidByName, notes);
  return { created: ensure.created, paid: true, alreadyPaid: false, invoiceId: ensure.invoiceId, customerName: ensure.customerName };
}

function payInvoicesForCustomerMonths(customerId, year, months, paidByName, notes) {
  const cid = Number(customerId);
  const y = Number(year);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');
  if (!Number.isFinite(y) || y < 2000 || y > 3000) throw new Error('Tahun tidak valid');

  const rawMonths = Array.isArray(months) ? months : (months == null ? [] : [months]);
  const selectedMonths = [...new Set(rawMonths.map(m => parseInt(m)).filter(m => Number.isFinite(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  if (selectedMonths.length === 0) throw new Error('Pilih minimal 1 bulan');

  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  if (!customer.package_id) throw new Error('Pelanggan belum memiliki paket');

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(customer.package_id);
  if (!pkg) throw new Error('Paket pelanggan tidak ditemukan');

  const selectInv = db.prepare('SELECT id, status, amount, due_day_snapshot, period_month, period_year FROM invoices WHERE customer_id=? AND period_month=? AND period_year=? LIMIT 1');
  const insertInv = db.prepare('INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)');
  const bumpPromo = db.prepare('UPDATE customers SET promo_cycles_used = COALESCE(promo_cycles_used,0) + 1 WHERE id=?');
  const payInv = db.prepare(`UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, paid_by_name=?, notes=? WHERE id=?`);

  const summary = { customerName: customer.name, year: y, paidMonths: [], alreadyPaidMonths: [], createdMonths: [], totalAmount: 0, totalMonths: 0 };
  const paymentDate = new Date();
  let latePaymentDetected = false;
  const paidInvoiceIds = [];
  const run = db.transaction(() => {
    for (const m of selectedMonths) {
      const inv = selectInv.get(cid, m, y);
      if (inv && inv.status === 'paid') {
        summary.alreadyPaidMonths.push(m);
        continue;
      }
      let invoiceId = inv ? inv.id : null;
      let amount = inv ? Number(inv.amount) : 0;
      if (!invoiceId) {
        const { amount: computed, bumpPromo: bump, notesAuto } = computeInvoiceAmountAndMeta(customer, pkg, m, y);
        const r = insertInv.run(cid, m, y, computed, notesAuto, resolveInvoiceDueDay(customer, m, y));
        invoiceId = r.lastInsertRowid;
        summary.createdMonths.push(m);
        amount = computed;
        if (bump) bumpPromo.run(cid);
      }
      payInv.run(paidByName || 'Admin', notes || '', invoiceId);
      paidInvoiceIds.push(invoiceId);
      if (isInvoiceLateForCustomer({ period_month: m, period_year: y }, customer, paymentDate)) {
        latePaymentDetected = true;
      }
      summary.paidMonths.push(m);
      summary.totalAmount += (Number.isFinite(amount) ? amount : 0);
      summary.totalMonths += 1;
    }
  });
  run();

  if (latePaymentDetected && summary.totalMonths > 0) {
    const currentAnchor = normalizeBillingAnchorDay(customer.isolate_day, 10);
    const paymentDay = normalizeBillingAnchorDay(paymentDate.getDate(), 10);
    if (paymentDay !== currentAnchor) {
      db.prepare('UPDATE customers SET isolate_day=? WHERE id=?').run(paymentDay, cid);
    }
  }

  for (const invoiceId of paidInvoiceIds) {
    bookkeepingSvc.upsertInvoiceIncomeEntry(invoiceId, paidByName || 'Admin', paymentDate.toISOString());
  }

  return summary;
}

function getPaidMonthsForCustomerYear(customerId, year) {
  const cid = Number(customerId);
  const y = Number(year);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');
  if (!Number.isFinite(y) || y < 2000 || y > 3000) throw new Error('Tahun tidak valid');
  const rows = db.prepare(`
    SELECT period_month
    FROM invoices
    WHERE customer_id=? AND period_year=? AND status='paid'
    ORDER BY period_month ASC
  `).all(cid, y);
  return rows.map(r => r.period_month);
}

function getCustomerBillingYearSummary(customerId, year) {
  const cid = Number(customerId);
  const y = Number(year);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');
  if (!Number.isFinite(y) || y < 2000 || y > 3000) throw new Error('Tahun tidak valid');

  const customer = db.prepare(`
    SELECT c.id, c.name, p.price as package_price
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE c.id=?
  `).get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const invoices = db.prepare(`
    SELECT period_month as month, status, amount
    FROM invoices
    WHERE customer_id=? AND period_year=?
    ORDER BY period_month ASC
  `).all(cid, y);

  return {
    customerId: customer.id,
    customerName: customer.name,
    year: y,
    packagePrice: customer.package_price || 0,
    invoices
  };
}

function getAllInvoices({ month, year, status, search, limit = 300 } = {}) {
  let q = `
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.genieacs_tag, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (month)  { q += ' AND i.period_month=?'; params.push(parseInt(month)); }
  if (year)   { q += ' AND i.period_year=?';  params.push(parseInt(year)); }
  if (status && status !== 'all') { q += ' AND i.status=?'; params.push(status); }
  if (search) {
    q += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  q += ` ORDER BY i.period_year DESC, i.period_month DESC, c.name ASC LIMIT ${parseInt(limit)}`;
  return db.prepare(q).all(...params);
}

function getInvoiceById(id) {
  return db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address, c.genieacs_tag,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.id = ?
  `).get(id);
}

function markAsPaid(invoiceId, paidByName, notes, actor = null) {
  const invoiceBefore = db.prepare('SELECT id, customer_id, period_month, period_year, amount, status, due_day_snapshot FROM invoices WHERE id=?').get(invoiceId);
  const paymentDate = new Date();
  const result = db.prepare(`
    UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, paid_by_name=?, notes=? WHERE id=?
  `).run(paidByName || 'Admin', notes || '', invoiceId);

  const wasPaid = String(invoiceBefore?.status || '').toLowerCase() === 'paid';
  if (result.changes > 0 && invoiceBefore && !wasPaid) {
    shiftCustomerBillingAnchorAfterLatePayment(invoiceBefore.customer_id, invoiceBefore, paymentDate);
    bookkeepingSvc.upsertInvoiceIncomeEntry(invoiceId, paidByName || 'Admin', paymentDate.toISOString());
  }

  // Catat audit trail jika berhasil
  if (result.changes > 0 && actor) {
    const invoice = db.prepare('SELECT id, customer_id, period_month, period_year, amount FROM invoices WHERE id=?').get(invoiceId);
    if (invoice) {
      auditTrail.logAuditTrail({
        action: 'MARK_INVOICE_PAID',
        entity_type: 'invoice',
        entity_id: String(invoiceId),
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          customer_id: invoice.customer_id,
          period: `${invoice.period_month}/${invoice.period_year}`,
          amount: invoice.amount,
          paid_by: paidByName || 'Admin',
          notes: notes || ''
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }
  }

  return result;
}

function markAsUnpaid(invoiceId) {
  const result = db.prepare(`UPDATE invoices SET status='unpaid', paid_at=NULL, paid_by_name='', notes='' WHERE id=?`).run(invoiceId);
  if (result.changes > 0) bookkeepingSvc.removeInvoiceIncomeEntry(invoiceId);
  return result;
}

function deleteInvoice(id, actor = null) {
  const invoice = db.prepare('SELECT id, customer_id, period_month, period_year, amount FROM invoices WHERE id=?').get(id);
  const result = db.prepare('DELETE FROM invoices WHERE id=?').run(id);

  // Catat audit trail jika berhasil
  if (result.changes > 0 && actor && invoice) {
    auditTrail.logAuditTrail({
      action: 'DELETE_INVOICE',
      entity_type: 'invoice',
      entity_id: String(id),
      actor_type: actor.type || 'unknown',
      actor_id: actor.id || null,
      actor_name: actor.name || null,
      details: {
        customer_id: invoice.customer_id,
        period: `${invoice.period_month}/${invoice.period_year}`,
        amount: invoice.amount
      },
      ip_address: actor.ip || null,
      user_agent: actor.userAgent || null
    });
  }

  return result;
}

function getInvoiceSummary(month, year) {
  const total  = db.prepare('SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=?').get(month, year);
  const paid   = db.prepare("SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=? AND status='paid'").get(month, year);
  const unpaid = db.prepare("SELECT COUNT(*) as count, SUM(amount) as total FROM invoices WHERE period_month=? AND period_year=? AND status='unpaid'").get(month, year);
  return { total, paid, unpaid };
}

function getMonthlyRevenue(year) {
  const rows = db.prepare(`
    SELECT i.id, i.period_month, i.period_year, i.amount, i.status, i.paid_at, i.due_day_snapshot,
           c.isolate_day
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.period_year=?
    ORDER BY i.period_month ASC, i.id ASC
  `).all(year);

  const monthlyMap = new Map();
  for (let month = 1; month <= 12; month++) {
    monthlyMap.set(month, {
      month,
      revenue: 0,
      paid_amount: 0,
      unpaid_amount: 0,
      total_invoices: 0,
      paid_count: 0,
      unpaid_count: 0,
      ontime_paid_count: 0,
      ontime_paid_amount: 0,
      late_paid_count: 0,
      late_paid_amount: 0
    });
  }

  for (const row of rows) {
    const month = Number(row.period_month || 0);
    if (!monthlyMap.has(month)) continue;
    const bucket = monthlyMap.get(month);
    const amount = Number(row.amount || 0) || 0;
    bucket.total_invoices += 1;
    if (String(row.status || '').toLowerCase() === 'paid') {
      bucket.revenue += amount;
      bucket.paid_amount += amount;
      bucket.paid_count += 1;
      const dueAt = getInvoiceDueDate(row, row.isolate_day);
      const paidAt = row.paid_at ? new Date(row.paid_at) : null;
      const isLate = dueAt && paidAt ? paidAt.getTime() > dueAt.getTime() : false;
      if (isLate) {
        bucket.late_paid_count += 1;
        bucket.late_paid_amount += amount;
      } else {
        bucket.ontime_paid_count += 1;
        bucket.ontime_paid_amount += amount;
      }
    } else {
      bucket.unpaid_amount += amount;
      bucket.unpaid_count += 1;
    }
  }

  return Array.from(monthlyMap.values()).filter((item) =>
    item.total_invoices > 0 || item.paid_amount > 0 || item.unpaid_amount > 0
  );
}

function getDashboardStats() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const totalRevenue  = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid'").get();
  const thisMonth     = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND period_month=? AND period_year=?").get(m, y);
  const pendingAmount = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid'").get();
  const unpaidCount   = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='unpaid'").get();
  return {
    totalRevenue:  totalRevenue.t  || 0,
    thisMonth:     thisMonth.t     || 0,
    pendingAmount: pendingAmount.t || 0,
    unpaidCount:   unpaidCount.c   || 0,
  };
}

function getRecentPayments(limit = 8) {
  return db.prepare(`
    SELECT i.*, c.name as customer_name FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    WHERE i.status='paid' ORDER BY i.paid_at DESC LIMIT ?
  `).all(limit);
}

function getTopUnpaid(limit = 5) {
  return db.prepare(`
    SELECT c.name, c.phone, COUNT(*) as unpaid_count, SUM(i.amount) as total_unpaid
    FROM invoices i JOIN customers c ON i.customer_id = c.id
    WHERE i.status='unpaid'
    GROUP BY c.id ORDER BY unpaid_count DESC LIMIT ?
  `).all(limit);
}

function getInvoicesByAny(val) {
  if (!val) return [];
  const raw = String(val || '').trim();
  const cleanVal = raw.replace(/\D/g, '');
  
  // Find customer ID first using phone, pppoe, or genieacs_tag
  let customer = null;
  
  if (cleanVal.length >= 8) {
    customer = db.prepare(`SELECT id FROM customers WHERE phone LIKE ?`).get(`%${cleanVal}%`);
  }
  
  if (!customer) {
    customer = db.prepare(`SELECT id FROM customers WHERE pppoe_username = ? OR genieacs_tag = ?`).get(raw, raw);
  }

  if (customer) {
    return db.prepare(`
      SELECT i.*,
             c.name as customer_name,
             c.phone as customer_phone,
             c.address as customer_address,
             c.pppoe_username,
             c.genieacs_tag,
             c.connection_type,
             c.static_ip,
             c.status as customer_status,
             c.router_id,
             c.install_date,
             c.isolate_day,
             c.isolir_profile,
             p.name as package_name,
             p.price as package_price,
             r.name as router_name
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      LEFT JOIN packages p ON c.package_id = p.id
      LEFT JOIN routers r ON c.router_id = r.id
      WHERE i.customer_id = ?
      ORDER BY i.period_year DESC, i.period_month DESC
    `).all(customer.id);
  }

  const keyword = raw.toLowerCase();
  if (keyword.length < 3) return [];
  
  return db.prepare(`
    SELECT i.*,
           c.name as customer_name,
           c.phone as customer_phone,
           c.address as customer_address,
           c.pppoe_username,
           c.genieacs_tag,
           c.connection_type,
           c.static_ip,
           c.status as customer_status,
           c.router_id,
           c.install_date,
           c.isolate_day,
           c.isolir_profile,
           p.name as package_name,
           p.price as package_price,
           r.name as router_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    WHERE lower(c.name) LIKE ?
       OR lower(c.phone) LIKE ?
       OR lower(c.genieacs_tag) LIKE ?
       OR lower(c.pppoe_username) LIKE ?
    ORDER BY i.period_year DESC, i.period_month DESC
    LIMIT 300
  `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
}

function getUnpaidInvoicesByCustomerId(customerId) {
  return db.prepare(`
    SELECT i.*, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.customer_id = ? AND i.status = 'unpaid'
    ORDER BY i.period_year ASC, i.period_month ASC
  `).all(customerId);
}

function getTodayRevenue() {
  return db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count 
    FROM invoices 
    WHERE status='paid' AND date(paid_at, 'localtime') = date('now', 'localtime')
  `).get();
}

/**
 * Buat tagihan susulan untuk bulan kalender **tanggal pasang** (prorata sisa hari),
 * hanya jika belum ada invoice periode itu. Dasar nominal: **harga reguler** paket (bukan harga promo).
 */
function createInstallProrataCatchUpInvoice(customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('ID pelanggan tidak valid');

  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  if (!customer.package_id) throw new Error('Pelanggan belum memiliki paket');
  if (!customer.install_date) throw new Error('Isi tanggal pasang (install_date) di data pelanggan');

  const inst = parseInstallYMD(String(customer.install_date));
  if (!inst) throw new Error('Format tanggal pasang tidak valid (gunakan YYYY-MM-DD)');

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(customer.package_id);
  if (!pkg) throw new Error('Paket tidak ditemukan');
  if (!pkg.prorate_first_invoice) throw new Error('Paket ini belum mengaktifkan opsi prorata tagihan pertama');

  const periodMonth = inst.m;
  const periodYear = inst.y;

  const exists = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND period_month=? AND period_year=? LIMIT 1').get(cid, periodMonth, periodYear);
  if (exists) {
    throw new Error(`Sudah ada tagihan untuk periode pasang ${String(periodMonth).padStart(2, '0')}/${periodYear}`);
  }

  const dim = daysInMonth(periodYear, periodMonth);
  const billableDays = Math.min(dim, Math.max(1, dim - inst.d + 1));
  const basePrice = Number(pkg.price) || 0;
  const amount = Math.max(0, Math.round(basePrice * (billableDays / dim)));
  const notesAuto = `AUTO: Susulan prorata bulan pasang (${billableDays}/${dim} hari, dasar harga reguler Rp ${basePrice.toLocaleString('id-ID')})`;

  const r = db.prepare('INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(
    cid, periodMonth, periodYear, amount, notesAuto, resolveInvoiceDueDay(customer, periodMonth, periodYear)
  );

  return {
    invoiceId: r.lastInsertRowid,
    amount,
    periodMonth,
    periodYear,
    customerName: customer.name,
    billableDays,
    daysInMonth: dim
  };
}

function updatePaymentInfo(invoiceId, data) {
  const { 
    gateway, order_id, link, reference, payload, expires_at 
  } = data;
  
  return db.prepare(`
    UPDATE invoices SET 
      payment_gateway = ?,
      payment_order_id = ?,
      payment_link = ?,
      payment_reference = ?,
      payment_payload = ?,
      payment_expires_at = ?
    WHERE id = ?
  `).run(gateway, order_id, link, reference, payload ? JSON.stringify(payload) : null, expires_at, invoiceId);
}

module.exports = {
  getInvoicesByAny,
  getUnpaidInvoicesByCustomerId,
  generateMonthlyInvoices, generateInvoiceForCustomer, createInstallProrataCatchUpInvoice, payInvoiceForCustomerPeriod, payInvoicesForCustomerMonths, getPaidMonthsForCustomerYear, getCustomerBillingYearSummary, getAllInvoices, getInvoiceById,
  markAsPaid, markAsUnpaid, deleteInvoice,
  getInvoiceSummary, getMonthlyRevenue,
  getDashboardStats, getRecentPayments, getTopUnpaid,
  getTodayRevenue,
  getEffectiveBillingDay,
  normalizeBillingAnchorDay,
  updatePaymentInfo
};
