/**
 * Service: Logika Billing & Tagihan
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const auditTrail = require('./auditTrailService');
const bookkeepingSvc = require('./bookkeepingService');
const { getSettingsWithCache } = require('../config/settingsManager');
const { resolveQrisUniqueCodeRange, hasStaticQrisEnabled } = require('./qrisService');

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

function addCalendarDays(date, days) {
  const base = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + Number(days || 0));
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

function invoicePeriodKey(year, month) {
  return (Number(year || 0) * 100) + Number(month || 0);
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

function assignUniqueQrisForInvoice(invoiceId, { force = false } = {}) {
  const invId = Number(invoiceId || 0);
  if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

  const current = db.prepare(`
    SELECT id, customer_id, status, amount, qris_unique_code, qris_amount_unique, qris_assigned_at
    FROM invoices
    WHERE id = ?
  `).get(invId);
  if (!current) throw new Error('Tagihan tidak ditemukan');
  if (String(current.status || '').toLowerCase() !== 'unpaid') {
    throw new Error('Hanya tagihan belum bayar yang bisa dibuat QRIS unik.');
  }

  if (!force && Number(current.qris_amount_unique || 0) > 0 && Number(current.qris_unique_code || 0) > 0) {
    return getInvoiceById(invId);
  }

  const baseAmount = Number(current.amount || 0);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

  const currentSettings = getSettingsWithCache();
  const codeRange = resolveQrisUniqueCodeRange(currentSettings);
  const minCode = Math.max(1, Number(codeRange.min || 1) || 1);
  const maxCode = Math.max(minCode, Number(codeRange.max || minCode) || minCode);
  const exists = db.prepare('SELECT id FROM invoices WHERE status = ? AND qris_amount_unique = ? AND id != ? LIMIT 1');
  const update = db.prepare(`
    UPDATE invoices
    SET qris_unique_code = ?, qris_amount_unique = ?, qris_assigned_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let chosenCode = 0;
  let chosenAmount = 0;

  for (let i = 0; i < 50; i += 1) {
    const code = minCode + Math.floor(Math.random() * ((maxCode - minCode) + 1));
    const amount = baseAmount + code;
    if (!exists.get('unpaid', amount, invId)) {
      chosenCode = code;
      chosenAmount = amount;
      break;
    }
  }

  if (!chosenAmount) {
    for (let code = minCode; code <= maxCode; code += 1) {
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }
  }

  if (!chosenAmount) throw new Error('Gagal membuat nominal unik QRIS untuk tagihan ini.');
  update.run(chosenCode, chosenAmount, invId);
  return getInvoiceById(invId);
}

function backfillUniqueQrisForUnpaidInvoices(invoiceIds = []) {
  if (!hasStaticQrisEnabled(getSettingsWithCache())) {
    return {
      assigned: 0,
      failed: [],
      scanned: 0
    };
  }
  const normalizedIds = Array.isArray(invoiceIds)
    ? [...new Set(invoiceIds.map((id) => Number(id || 0)).filter((id) => Number.isFinite(id) && id > 0))]
    : [];
  const targets = normalizedIds.length
    ? normalizedIds
    : db.prepare(`
        SELECT id
        FROM invoices
        WHERE status = 'unpaid'
          AND (qris_amount_unique IS NULL OR qris_amount_unique <= 0 OR qris_unique_code IS NULL OR qris_unique_code <= 0)
        ORDER BY period_year DESC, period_month DESC, id DESC
      `).all().map((row) => Number(row.id || 0)).filter((id) => id > 0);

  let assigned = 0;
  const failed = [];
  for (const id of targets) {
    try {
      assignUniqueQrisForInvoice(id);
      assigned += 1;
    } catch (error) {
      failed.push({ id, error: String(error?.message || error || '') });
    }
  }

  return {
    assigned,
    failed,
    scanned: targets.length
  };
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
  if (createdInvoiceIds.length) {
    backfillUniqueQrisForUnpaidInvoices(createdInvoiceIds);
    createdInvoiceIds.forEach((invoiceId) => pushPortalInvoiceNotification(invoiceId));
  }
  return {
    count: created,
    createdInvoiceIds
  };
}

function generateInvoicesDueInDays(leadDays = 7, fromDate = new Date()) {
  const safeLeadDays = Math.max(0, parseInt(leadDays, 10) || 0);
  const dueDate = addCalendarDays(fromDate, safeLeadDays);
  const periodMonth = dueDate.getMonth() + 1;
  const periodYear = dueDate.getFullYear();
  const targetDueDay = dueDate.getDate();

  const customers = db.prepare("SELECT * FROM customers WHERE status IN ('active','suspended') AND package_id IS NOT NULL").all();
  const existing = db.prepare('SELECT customer_id FROM invoices WHERE period_month=? AND period_year=?').all(periodMonth, periodYear);
  const existingIds = new Set(existing.map(e => e.customer_id));
  const insert = db.prepare(`INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)`);
  const bumpPromo = db.prepare('UPDATE customers SET promo_cycles_used = COALESCE(promo_cycles_used,0) + 1 WHERE id=?');
  let created = 0;
  let eligible = 0;
  const createdInvoiceIds = [];

  const run = db.transaction(() => {
    for (const c of customers) {
      if (existingIds.has(c.id)) continue;
      const customerDueDay = resolveInvoiceDueDay(c, periodMonth, periodYear);
      if (customerDueDay !== targetDueDay) continue;

      eligible++;
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(c.package_id);
      if (!pkg) continue;
      const { amount, bumpPromo: bump, notesAuto } = computeInvoiceAmountAndMeta(c, pkg, periodMonth, periodYear);
      const result = insert.run(c.id, periodMonth, periodYear, amount, notesAuto, customerDueDay);
      if (bump) bumpPromo.run(c.id);
      createdInvoiceIds.push(result.lastInsertRowid);
      created++;
    }
  });
  run();

  if (createdInvoiceIds.length) {
    backfillUniqueQrisForUnpaidInvoices(createdInvoiceIds);
    createdInvoiceIds.forEach((invoiceId) => pushPortalInvoiceNotification(invoiceId));
  }

  return {
    count: created,
    eligible,
    createdInvoiceIds,
    leadDays: safeLeadDays,
    periodMonth,
    periodYear,
    dueDay: targetDueDay
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
  if (hasStaticQrisEnabled(getSettingsWithCache())) {
    assignUniqueQrisForInvoice(r.lastInsertRowid);
  }
  pushPortalInvoiceNotification(r.lastInsertRowid);
  return { created: true, invoiceId: r.lastInsertRowid, customerName: customer.name };
}

function ensurePortalReactivationInvoice(customerId, atDate = new Date()) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return { created: false, skipped: true, reason: 'invalid-customer' };

  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  if (!customer) return { created: false, skipped: true, reason: 'customer-not-found' };

  const status = String(customer.status || '').trim().toLowerCase();
  if (!['suspended', 'inactive'].includes(status)) {
    return { created: false, skipped: true, reason: 'customer-active' };
  }
  if (!customer.package_id) {
    return { created: false, skipped: true, reason: 'missing-package' };
  }

  const existingUnpaid = db.prepare(`
    SELECT id, period_month, period_year
    FROM invoices
    WHERE customer_id=? AND lower(trim(status))='unpaid'
    ORDER BY period_year ASC, period_month ASC, id ASC
    LIMIT 1
  `).get(cid);
  if (existingUnpaid) {
    return { created: false, invoiceId: existingUnpaid.id, reason: 'unpaid-exists' };
  }

  const date = atDate instanceof Date && !Number.isNaN(atDate.getTime()) ? atDate : new Date();
  const periodMonth = date.getMonth() + 1;
  const periodYear = date.getFullYear();
  const existingCurrent = db.prepare(`
    SELECT id, status
    FROM invoices
    WHERE customer_id=? AND period_month=? AND period_year=?
    ORDER BY id DESC
    LIMIT 1
  `).get(cid, periodMonth, periodYear);
  const existingStatus = String(existingCurrent?.status || '').trim().toLowerCase();
  if (existingCurrent && ['unpaid', 'paid'].includes(existingStatus)) {
    return {
      created: false,
      invoiceId: existingCurrent.id,
      reason: existingStatus === 'paid' ? 'current-period-paid' : 'current-period-unpaid'
    };
  }

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(customer.package_id);
  if (!pkg) return { created: false, skipped: true, reason: 'package-not-found' };

  const { amount, bumpPromo, notesAuto } = computeInvoiceAmountAndMeta(customer, pkg, periodMonth, periodYear);
  const notes = [notesAuto, 'AUTO: Tagihan aktivasi portal prabayar'].filter(Boolean).join(' | ');
  const r = db.prepare('INSERT INTO invoices (customer_id, period_month, period_year, amount, notes, due_day_snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(
    cid,
    periodMonth,
    periodYear,
    amount,
    notes,
    resolveInvoiceDueDay(customer, periodMonth, periodYear)
  );
  if (bumpPromo) {
    db.prepare('UPDATE customers SET promo_cycles_used = COALESCE(promo_cycles_used,0) + 1 WHERE id=?').run(cid);
  }
  if (hasStaticQrisEnabled(getSettingsWithCache())) {
    assignUniqueQrisForInvoice(r.lastInsertRowid);
  }
  pushPortalInvoiceNotification(r.lastInsertRowid);

  return {
    created: true,
    invoiceId: r.lastInsertRowid,
    customerName: customer.name,
    periodMonth,
    periodYear,
    amount
  };
}

function pushPortalInvoiceNotification(invoiceId) {
  try {
    const invoice = getInvoiceById(invoiceId);
    if (!invoice || !invoice.customer_id) return null;
    const customerSvc = require('./customerService');
    return customerSvc.addPortalNotification(invoice.customer_id, {
      kind: 'invoice',
      tab: 'billing',
      title: `Tagihan baru INV-${invoice.id} tersedia`,
      body: `Periode ${invoice.period_month}/${invoice.period_year} - Rp ${Number(invoice.amount || 0).toLocaleString('id-ID')}`,
      payload: {
        senderName: 'Billing',
        senderRole: 'Tagihan',
        invoiceId: Number(invoice.id || 0) || null
      }
    }, { dedupeWindowMs: 30 * 24 * 60 * 60 * 1000 });
  } catch (_) {
    return null;
  }
}

function queueAdminPaidNotification(invoiceId, paidByName, notes, actor = null, paymentDate = new Date()) {
  try {
    const adminPaymentNotificationSvc = require('./adminPaymentNotificationService');
    Promise.resolve(adminPaymentNotificationSvc.notifyInvoicePaid({
      invoiceId,
      paidByName,
      notes,
      actor,
      paymentDate
    })).catch((error) => {
      logger.warn(`[Billing] Notifikasi admin pembayaran lunas gagal: ${error.message || String(error)}`);
    });
  } catch (error) {
    logger.warn(`[Billing] Gagal menyiapkan notifikasi admin pembayaran lunas: ${error.message || String(error)}`);
  }
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

function voidPreviousUnpaidForPrepaidRestart(customerId, year, month, paidByName = 'Admin', paymentDate = new Date()) {
  const cid = Number(customerId || 0);
  const y = Number(year || 0);
  const m = Number(month || 0);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(y) || !Number.isFinite(m)) {
    return { voided: 0, invoiceIds: [] };
  }

  const customer = db.prepare('SELECT id, status FROM customers WHERE id=?').get(cid);
  const customerStatus = String(customer?.status || '').trim().toLowerCase();
  if (!['suspended', 'inactive'].includes(customerStatus)) return { voided: 0, invoiceIds: [] };

  const cutoff = invoicePeriodKey(y, m);
  const rows = db.prepare(`
    SELECT id, period_month, period_year, notes
    FROM invoices
    WHERE customer_id = ?
      AND lower(trim(status)) = 'unpaid'
      AND ((period_year * 100) + period_month) < ?
    ORDER BY period_year ASC, period_month ASC, id ASC
  `).all(cid, cutoff);
  if (!rows.length) return { voided: 0, invoiceIds: [] };

  const noteSuffix = `AUTO: Hangus prabayar karena pelanggan mulai bayar periode ${String(m).padStart(2, '0')}/${y} (${paidByName || 'Admin'})`;
  const update = db.prepare(`
    UPDATE invoices
    SET status='void',
        paid_at=NULL,
        paid_by_name=?,
        notes=trim(COALESCE(NULLIF(notes, ''), '') || CASE WHEN COALESCE(NULLIF(notes, ''), '') = '' THEN '' ELSE ' | ' END || ?)
    WHERE id=?
      AND lower(trim(status))='unpaid'
  `);
  const run = db.transaction(() => {
    for (const row of rows) {
      update.run(paidByName || 'Admin', noteSuffix, row.id);
      bookkeepingSvc.removeInvoiceIncomeEntry(row.id);
    }
  });
  run();

  return { voided: rows.length, invoiceIds: rows.map((row) => row.id), paymentDate };
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

  const summary = {
    customerName: customer.name,
    year: y,
    paidMonths: [],
    alreadyPaidMonths: [],
    createdMonths: [],
    voidedMonths: 0,
    voidedInvoiceIds: [],
    totalAmount: 0,
    totalMonths: 0
  };
  const paymentDate = new Date();
  let latePaymentDetected = false;
  const paidInvoiceIds = [];
  let earliestPaidPeriod = null;
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
      const key = invoicePeriodKey(y, m);
      earliestPaidPeriod = earliestPaidPeriod == null ? key : Math.min(earliestPaidPeriod, key);
    }
  });
  run();

  if (earliestPaidPeriod != null && summary.totalMonths > 0) {
    const firstPaidMonth = earliestPaidPeriod % 100;
    const firstPaidYear = Math.floor(earliestPaidPeriod / 100);
    const voided = voidPreviousUnpaidForPrepaidRestart(cid, firstPaidYear, firstPaidMonth, paidByName, paymentDate);
    summary.voidedMonths = voided.invoiceIds.length;
    summary.voidedInvoiceIds = voided.invoiceIds;
  }

  if (latePaymentDetected && summary.totalMonths > 0) {
    const currentAnchor = normalizeBillingAnchorDay(customer.isolate_day, 10);
    const paymentDay = normalizeBillingAnchorDay(paymentDate.getDate(), 10);
    if (paymentDay !== currentAnchor) {
      db.prepare('UPDATE customers SET isolate_day=? WHERE id=?').run(paymentDay, cid);
    }
  }

  for (const invoiceId of paidInvoiceIds) {
    bookkeepingSvc.upsertInvoiceIncomeEntry(invoiceId, paidByName || 'Admin', paymentDate.toISOString());
    queueAdminPaidNotification(invoiceId, paidByName || 'Admin', notes || '', null, paymentDate);
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
    WHERE customer_id=? AND period_year=? AND lower(trim(status))='paid'
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
    SELECT
      id,
      period_month as month,
      period_month,
      period_year,
      status,
      amount,
      paid_at,
      due_day_snapshot,
      notes
    FROM invoices
    WHERE customer_id=? AND period_year=?
    ORDER BY period_month ASC, id ASC
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
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.genieacs_tag, c.status as customer_status, p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (month)  { q += ' AND i.period_month=?'; params.push(parseInt(month)); }
  if (year)   { q += ' AND i.period_year=?';  params.push(parseInt(year)); }
  if (status && status !== 'all') { q += ' AND lower(trim(i.status))=?'; params.push(String(status).trim().toLowerCase()); }
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
  const invId = Number(invoiceId || 0);
  if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

  const invoiceBefore = db.prepare('SELECT id, customer_id, period_month, period_year, amount, status, due_day_snapshot FROM invoices WHERE id=?').get(invId);
  if (!invoiceBefore) throw new Error('Tagihan tidak ditemukan');

  const paymentDate = new Date();
  const result = db.prepare(`
    UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, paid_by_name=?, notes=? WHERE id=?
  `).run(paidByName || 'Admin', notes || '', invId);

  const invoiceAfter = db.prepare('SELECT id, status FROM invoices WHERE id=?').get(invId);
  if (String(invoiceAfter?.status || '').trim().toLowerCase() !== 'paid') {
    throw new Error('Status tagihan gagal disimpan sebagai lunas');
  }

  const wasPaid = String(invoiceBefore?.status || '').toLowerCase() === 'paid';
  if (result.changes > 0 && invoiceBefore && !wasPaid) {
    voidPreviousUnpaidForPrepaidRestart(
      invoiceBefore.customer_id,
      invoiceBefore.period_year,
      invoiceBefore.period_month,
      paidByName || 'Admin',
      paymentDate
    );
    shiftCustomerBillingAnchorAfterLatePayment(invoiceBefore.customer_id, invoiceBefore, paymentDate);
    bookkeepingSvc.upsertInvoiceIncomeEntry(invId, paidByName || 'Admin', paymentDate.toISOString());
    queueAdminPaidNotification(invId, paidByName || 'Admin', notes || '', actor, paymentDate);
  }

  // Catat audit trail jika berhasil
  if (result.changes > 0 && actor) {
    const invoice = db.prepare('SELECT id, customer_id, period_month, period_year, amount FROM invoices WHERE id=?').get(invId);
    if (invoice) {
      auditTrail.logAuditTrail({
        action: 'MARK_INVOICE_PAID',
        entity_type: 'invoice',
        entity_id: String(invId),
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
    } else if (String(row.status || '').toLowerCase() === 'unpaid') {
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

function computeInvoiceTaxBreakdown(amount, pkg = {}) {
  const nominalInvoice = Math.max(0, Number(amount || 0) || 0);
  const includePpn = Number(pkg.include_ppn || 0) === 1;
  const ppnPercent = includePpn ? Math.max(0, Number(pkg.ppn_percent || 0) || 0) : 0;

  if (!includePpn || ppnPercent <= 0) {
    return {
      saleAmount: nominalInvoice,
      ppnAmount: 0,
      nominalInvoice
    };
  }

  const divisor = 1 + (ppnPercent / 100);
  const saleAmount = Math.round(nominalInvoice / divisor);
  const ppnAmount = Math.max(0, nominalInvoice - saleAmount);

  return {
    saleAmount,
    ppnAmount,
    nominalInvoice
  };
}

function getPaidInvoiceReport({ year, month = 0 } = {}) {
  const filterYear = Math.max(2000, parseInt(year, 10) || new Date().getFullYear());
  const filterMonth = Math.max(0, Math.min(12, parseInt(month, 10) || 0));
  const yearStr = String(filterYear);
  const monthStr = String(filterMonth).padStart(2, '0');

  const rows = db.prepare(`
    SELECT
      i.id,
      i.customer_id,
      i.period_month,
      i.period_year,
      i.amount,
      i.status,
      i.paid_at,
      i.paid_by_name,
      i.notes,
      c.name AS customer_name,
      c.nik,
      c.npwp,
      c.address,
      p.name AS package_name,
      p.include_ppn,
      p.ppn_percent
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE i.status = 'paid'
      AND strftime('%Y', i.paid_at, 'localtime') = ?
      AND (? = 0 OR strftime('%m', i.paid_at, 'localtime') = ?)
    ORDER BY datetime(i.paid_at) ASC, c.name ASC, i.id ASC
  `).all(yearStr, filterMonth, monthStr);

  const items = [];
  let totalSaleAmount = 0;
  let totalPpnAmount = 0;
  let totalInvoiceAmount = 0;

  for (const [index, row] of rows.entries()) {
    const breakdown = computeInvoiceTaxBreakdown(row.amount, row);
    totalSaleAmount += breakdown.saleAmount;
    totalPpnAmount += breakdown.ppnAmount;
    totalInvoiceAmount += breakdown.nominalInvoice;

    const descriptionParts = [];
    if (row.package_name) descriptionParts.push(`Paket ${row.package_name}`);
    if (row.paid_by_name) descriptionParts.push(`Lunas oleh ${row.paid_by_name}`);
    if (row.notes) descriptionParts.push(String(row.notes).trim());

    items.push({
      no: index + 1,
      customerId: Number(row.customer_id || 0) || null,
      customerName: String(row.customer_name || '').trim(),
      nik: String(row.nik || '').trim(),
      npwp: String(row.npwp || '').trim(),
      address: String(row.address || '').trim(),
      saleAmount: breakdown.saleAmount,
      ppnAmount: breakdown.ppnAmount,
      nominalInvoice: breakdown.nominalInvoice,
      description: descriptionParts.filter(Boolean).join(' | '),
      paidAt: row.paid_at || '',
      invoiceId: Number(row.id || 0) || null,
      periodMonth: Number(row.period_month || 0) || null,
      periodYear: Number(row.period_year || 0) || null
    });
  }

  return {
    year: filterYear,
    month: filterMonth,
    items,
    totalSaleAmount,
    totalPpnAmount,
    totalInvoiceAmount
  };
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
    WHERE i.customer_id = ? AND lower(trim(i.status)) = 'unpaid'
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
  if (hasStaticQrisEnabled(getSettingsWithCache())) {
    assignUniqueQrisForInvoice(r.lastInsertRowid);
  }

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
  generateMonthlyInvoices, generateInvoicesDueInDays, generateInvoiceForCustomer, ensurePortalReactivationInvoice, createInstallProrataCatchUpInvoice, payInvoiceForCustomerPeriod, payInvoicesForCustomerMonths, getPaidMonthsForCustomerYear, getCustomerBillingYearSummary, getAllInvoices, getInvoiceById,
  markAsPaid, markAsUnpaid, deleteInvoice,
  getInvoiceSummary, getMonthlyRevenue,
  getDashboardStats, getRecentPayments, getTopUnpaid,
  getTodayRevenue,
  assignUniqueQrisForInvoice,
  backfillUniqueQrisForUnpaidInvoices,
  getInvoiceDueDate,
  resolveInvoiceDueDay,
  getEffectiveBillingDay,
  normalizeBillingAnchorDay,
  updatePaymentInfo,
  getPaidInvoiceReport
};
