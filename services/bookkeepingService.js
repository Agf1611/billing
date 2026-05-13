const db = require('../config/database');

const DEFAULT_EXPENSE_CATEGORIES = [
  'Listrik',
  'Bandwidth',
  'Gaji',
  'Pemasangan Baru',
  'Perbaikan Alat',
  'Tukang Tagih',
  'PDAM',
  'Pulsa',
  'Marketing',
  'Teknisi',
  'Transport',
  'Maintenance',
  'Operasional',
  'Lainnya'
];

const DEFAULT_INCOME_CATEGORIES = [
  'Pembayaran Tagihan',
  'Tripay / QRIS',
  'Pendapatan Mitra',
  'Pemasangan Baru',
  'Penjualan Perangkat',
  'Deposit',
  'Pendapatan Lainnya'
];

const ONLINE_PAYMENT_ACTORS = ['tripay', 'midtrans', 'xendit', 'duitku', 'qris static', 'qris', 'online'];
const ONLINE_PAYMENT_NAME_SQL = `LOWER(TRIM(COALESCE(i.paid_by_name, ''))) IN (${ONLINE_PAYMENT_ACTORS.map((item) => `'${item}'`).join(', ')})`;
const ONLINE_PAYMENT_SQL = `(${ONLINE_PAYMENT_NAME_SQL} OR LOWER(COALESCE(i.notes, '')) LIKE '%webhook%')`;
const PARTNER_PAYMENT_SQL = `(COALESCE(i.paid_by_name, '') LIKE 'Agent %')`;
const CASH_PAYMENT_SQL = `(NOT ${ONLINE_PAYMENT_SQL} AND NOT ${PARTNER_PAYMENT_SQL})`;

function buildPeriodWhere(dateExpr, month = '', year = '', params = []) {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  let where = 'WHERE 1=1';
  if (Number.isFinite(yearNum) && yearNum > 2000) {
    where += ` AND CAST(strftime('%Y', ${dateExpr}) AS INTEGER) = ?`;
    params.push(yearNum);
  }
  if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
    where += ` AND CAST(strftime('%m', ${dateExpr}) AS INTEGER) = ?`;
    params.push(monthNum);
  }
  return where;
}

function normalizeDateInput(dateInput) {
  const raw = String(dateInput || '').trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return new Date().toISOString().slice(0, 10);
  return raw;
}

function normalizeType(type) {
  return String(type || '').trim().toLowerCase() === 'income' ? 'income' : 'expense';
}

function getCategories() {
  return {
    income: DEFAULT_INCOME_CATEGORIES.slice(),
    expense: DEFAULT_EXPENSE_CATEGORIES.slice()
  };
}

function resolveEntryCategory(type, category, customCategory = '') {
  const normalizedType = normalizeType(type);
  const fallback = normalizedType === 'income' ? 'Pendapatan Lainnya' : 'Lainnya';
  const custom = String(customCategory || '').trim();
  if (custom) return custom;
  const selected = String(category || '').trim();
  return selected || fallback;
}

function createEntry(data) {
  const type = normalizeType(data.type);
  const amount = Math.max(0, parseInt(data.amount, 10) || 0);
  const entryDate = normalizeDateInput(data.entry_date);
  const category = resolveEntryCategory(type, data.category, data.custom_category);
  const description = String(data.description || '').trim();
  const customerId = Number.isFinite(Number(data.customer_id)) && Number(data.customer_id) > 0 ? Number(data.customer_id) : null;
  const invoiceId = Number.isFinite(Number(data.invoice_id)) && Number(data.invoice_id) > 0 ? Number(data.invoice_id) : null;
  const sourceType = String(data.source_type || '').trim();
  const sourceId = Number.isFinite(Number(data.source_id)) && Number(data.source_id) > 0 ? Number(data.source_id) : null;
  const createdByRole = String(data.created_by_role || '').trim();
  const createdByName = String(data.created_by_name || '').trim();

  return db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description,
      customer_id, invoice_id, source_type, source_id,
      created_by_role, created_by_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type, category, amount, entryDate, description,
    customerId, invoiceId, sourceType, sourceId,
    createdByRole, createdByName
  );
}

function deleteEntry(id) {
  return db.prepare(`DELETE FROM bookkeeping_entries WHERE id = ? AND source_type != 'invoice'`).run(id);
}

function listEntries({ type = '', month = '', year = '', search = '', category = '', limit = 200 } = {}) {
  const normalizedType = String(type || '').trim().toLowerCase();
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));
  let q = `
    SELECT b.*, c.name as customer_name, i.period_month, i.period_year
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    WHERE 1=1
  `;
  const params = [];
  if (normalizedType === 'income' || normalizedType === 'expense') {
    q += ' AND b.type = ?';
    params.push(normalizedType);
  }
  if (category) {
    q += ' AND b.category = ?';
    params.push(String(category).trim());
  }
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (Number.isFinite(yearNum) && yearNum > 2000) {
    q += " AND CAST(strftime('%Y', b.entry_date) AS INTEGER) = ?";
    params.push(yearNum);
  }
  if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
    q += " AND CAST(strftime('%m', b.entry_date) AS INTEGER) = ?";
    params.push(monthNum);
  }
  if (search) {
    const like = `%${String(search).trim()}%`;
    q += ' AND (b.description LIKE ? OR b.category LIKE ? OR c.name LIKE ? OR b.created_by_name LIKE ?)';
    params.push(like, like, like, like);
  }
  q += ` ORDER BY b.entry_date DESC, b.id DESC LIMIT ${maxLimit}`;
  return db.prepare(q).all(...params);
}

function getSummary({ month = '', year = '' } = {}) {
  const params = [];
  const where = buildPeriodWhere('entry_date', month, year, params);
  return db.prepare(`
    SELECT
      SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as total_income,
      SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as total_expense,
      COUNT(CASE WHEN type='income' THEN 1 END) as income_count,
      COUNT(CASE WHEN type='expense' THEN 1 END) as expense_count
    FROM bookkeeping_entries
    ${where}
  `).get(...params) || { total_income: 0, total_expense: 0, income_count: 0, expense_count: 0 };
}

function resolveExpenseBucketName(entry = {}) {
  const haystack = `${entry.category || ''} ${entry.description || ''}`.toLowerCase();
  if (/(gaji|karyawan|salary|insentif)/.test(haystack)) return 'salary';
  if (/(pasang|pemasangan|install)/.test(haystack)) return 'installation';
  if (/(perbaikan|alat|maintenance|sparepart|repair|teknisi)/.test(haystack)) return 'repair_tools';
  if (/(bandwidth|internet upstream|ppoe upstream)/.test(haystack)) return 'bandwidth';
  if (/(tagih|kolektor|collector)/.test(haystack)) return 'collection';
  if (/(listrik|pdam|pulsa|token|air)/.test(haystack)) return 'utilities';
  if (/(marketing|promosi|iklan|ads)/.test(haystack)) return 'marketing';
  return 'other';
}

function normalizePaymentActor(name = '') {
  const raw = String(name || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return { role: 'system', label: 'Sistem' };
  if (lower.startsWith('kasir')) return { role: 'cashier', label: raw };
  if (lower.startsWith('kolektor')) return { role: 'collector', label: raw };
  if (lower.startsWith('teknisi')) return { role: 'technician', label: raw };
  if (lower.startsWith('agent')) return { role: 'agent', label: raw };
  if (lower.startsWith('admin')) return { role: 'admin', label: raw };
  return { role: 'other', label: raw };
}

function isInvoiceOnlinePayment(row = {}) {
  const paidBy = String(row.paid_by_name || row.paidByName || '').trim().toLowerCase();
  const notes = String(row.notes || '').trim().toLowerCase();
  return ONLINE_PAYMENT_ACTORS.includes(paidBy) || notes.includes('webhook');
}

function isInvoicePartnerPayment(row = {}) {
  return String(row.paid_by_name || row.paidByName || '').trim().startsWith('Agent ');
}

function resolveInvoicePaymentChannelLabel(row = {}) {
  if (isInvoicePartnerPayment(row)) return 'Mitra / Agent';
  if (isInvoiceOnlinePayment(row)) {
    const gateway = String(row.payment_gateway || row.gateway || '').trim();
    return gateway || String(row.paid_by_name || row.paidByName || '').trim() || 'Online / QRIS';
  }
  return 'Cash / Manual';
}

function getDashboardDetails({ month = '', year = '' } = {}) {
  const summary = getSummary({ month, year });

  const invoiceParams = [];
  const invoiceWhere = buildPeriodWhere('i.paid_at', month, year, invoiceParams);
  const invoiceChannelSummary = db.prepare(`
    SELECT
      SUM(CASE
        WHEN ${CASH_PAYMENT_SQL}
        THEN i.amount ELSE 0 END) AS cash_amount,
      COUNT(CASE
        WHEN ${CASH_PAYMENT_SQL}
        THEN 1 END) AS cash_count,
      SUM(CASE
        WHEN ${ONLINE_PAYMENT_SQL}
        THEN i.amount ELSE 0 END) AS online_amount,
      COUNT(CASE
        WHEN ${ONLINE_PAYMENT_SQL}
        THEN 1 END) AS online_count,
      SUM(CASE
        WHEN ${PARTNER_PAYMENT_SQL}
        THEN i.amount ELSE 0 END) AS partner_amount,
      COUNT(CASE
        WHEN ${PARTNER_PAYMENT_SQL}
        THEN 1 END) AS partner_count
    FROM invoices i
    WHERE LOWER(COALESCE(i.status, '')) = 'paid'
      ${invoiceWhere.slice('WHERE 1=1'.length)}
  `).get(...invoiceParams) || {};

  const otherIncomeParams = [];
  const otherIncomeWhere = buildPeriodWhere('entry_date', month, year, otherIncomeParams);
  const otherIncomeSummary = db.prepare(`
    SELECT
      SUM(amount) AS total_amount,
      COUNT(*) AS total_count
    FROM bookkeeping_entries
    ${otherIncomeWhere}
      AND type = 'income'
      AND COALESCE(source_type, '') != 'invoice'
  `).get(...otherIncomeParams) || {};

  const incomeBreakdown = {
    total: Number(summary.total_income || 0),
    cash: {
      amount: Number(invoiceChannelSummary.cash_amount || 0),
      count: Number(invoiceChannelSummary.cash_count || 0)
    },
    online: {
      amount: Number(invoiceChannelSummary.online_amount || 0),
      count: Number(invoiceChannelSummary.online_count || 0)
    },
    other: {
      amount: Number(otherIncomeSummary.total_amount || 0),
      count: Number(otherIncomeSummary.total_count || 0)
    },
    partner: {
      amount: Number(invoiceChannelSummary.partner_amount || 0),
      count: Number(invoiceChannelSummary.partner_count || 0)
    }
  };

  const expenseParams = [];
  const expenseWhere = buildPeriodWhere('entry_date', month, year, expenseParams);
  const expenseRows = db.prepare(`
    SELECT category, description, amount
    FROM bookkeeping_entries
    ${expenseWhere}
      AND type = 'expense'
  `).all(...expenseParams);

  const expenseBreakdown = {
    total: Number(summary.total_expense || 0),
    salary: { amount: 0, count: 0, label: 'Gaji Karyawan' },
    installation: { amount: 0, count: 0, label: 'Pasang Baru' },
    repair_tools: { amount: 0, count: 0, label: 'Perbaikan / Alat' },
    bandwidth: { amount: 0, count: 0, label: 'Bayar Bandwidth' },
    collection: { amount: 0, count: 0, label: 'Tukang Tagih' },
    utilities: { amount: 0, count: 0, label: 'Listrik / PDAM / Pulsa' },
    marketing: { amount: 0, count: 0, label: 'Marketing' },
    other: { amount: 0, count: 0, label: 'Lainnya' }
  };

  for (const row of expenseRows) {
    const bucket = resolveExpenseBucketName(row);
    expenseBreakdown[bucket].amount += Number(row.amount || 0);
    expenseBreakdown[bucket].count += 1;
  }

  const actorRows = db.prepare(`
    SELECT
      COALESCE(i.paid_by_name, '') AS paid_by_name,
      SUM(i.amount) AS total_amount,
      COUNT(*) AS total_count,
      SUM(CASE WHEN ${ONLINE_PAYMENT_SQL} THEN i.amount ELSE 0 END) AS online_amount,
      SUM(CASE WHEN ${CASH_PAYMENT_SQL} THEN i.amount ELSE 0 END) AS cash_amount,
      MAX(i.paid_at) AS last_paid_at
    FROM invoices i
    WHERE LOWER(COALESCE(i.status, '')) = 'paid'
      ${invoiceWhere.slice('WHERE 1=1'.length)}
    GROUP BY COALESCE(i.paid_by_name, '')
    ORDER BY total_amount DESC, total_count DESC, paid_by_name ASC
  `).all(...invoiceParams).map((row) => {
    const actor = normalizePaymentActor(row.paid_by_name);
    return {
      role: actor.role,
      label: actor.label,
      amount: Number(row.total_amount || 0),
      count: Number(row.total_count || 0),
      cashAmount: Number(row.cash_amount || 0),
      onlineAmount: Number(row.online_amount || 0),
      lastPaidAt: row.last_paid_at || ''
    };
  });

  const recentPayments = db.prepare(`
    SELECT
      i.id,
      i.customer_id,
      i.amount,
      i.period_month,
      i.period_year,
      i.paid_at,
      i.paid_by_name,
      i.payment_gateway,
      i.notes,
      c.name AS customer_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE LOWER(COALESCE(i.status, '')) = 'paid'
      ${invoiceWhere.slice('WHERE 1=1'.length)}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 16
  `).all(...invoiceParams).map((row) => {
    const actor = normalizePaymentActor(row.paid_by_name);
    return {
      id: Number(row.id || 0),
      customerName: row.customer_name || 'Pelanggan',
      amount: Number(row.amount || 0),
      periodMonth: Number(row.period_month || 0),
      periodYear: Number(row.period_year || 0),
      paidAt: row.paid_at || '',
      actorLabel: actor.label,
      actorRole: actor.role,
      gateway: resolveInvoicePaymentChannelLabel(row)
    };
  });

  const approvalParams = [];
  const approvalWhere = buildPeriodWhere('decided_at', month, year, approvalParams);
  const approvalRows = db.prepare(`
    SELECT
      cpr.id,
      cpr.amount,
      cpr.decided_by_name,
      cpr.decided_at,
      col.name AS collector_name,
      c.name AS customer_name
    FROM collector_payment_requests cpr
    LEFT JOIN collectors col ON col.id = cpr.collector_id
    LEFT JOIN customers c ON c.id = cpr.customer_id
    ${approvalWhere}
      AND LOWER(COALESCE(cpr.status, '')) = 'approved'
    ORDER BY datetime(cpr.decided_at) DESC, cpr.id DESC
    LIMIT 12
  `).all(...approvalParams).map((row) => ({
    id: Number(row.id || 0),
    amount: Number(row.amount || 0),
    approvedBy: String(row.decided_by_name || '').trim() || 'Admin',
    collectorName: row.collector_name || '-',
    customerName: row.customer_name || 'Pelanggan',
    decidedAt: row.decided_at || ''
  }));

  const netAmount = Number(summary.total_income || 0) - Number(summary.total_expense || 0);
  const expenseVsIncomePercent = Number(summary.total_income || 0) > 0
    ? Math.min(999, Math.round((Number(summary.total_expense || 0) / Number(summary.total_income || 0)) * 100))
    : 0;
  const profitMarginPercent = Number(summary.total_income || 0) > 0
    ? Math.round((netAmount / Number(summary.total_income || 0)) * 100)
    : 0;

  return {
    income: incomeBreakdown,
    expense: expenseBreakdown,
    comparison: {
      incomeAmount: Number(summary.total_income || 0),
      expenseAmount: Number(summary.total_expense || 0),
      netAmount,
      expenseVsIncomePercent,
      profitMarginPercent
    },
    actors: actorRows,
    recentPayments,
    approvals: approvalRows
  };
}

function upsertInvoiceIncomeEntry(invoiceId, paidByName = '', paidAt = null) {
  const invoice = db.prepare(`
    SELECT i.id, i.amount, i.customer_id, i.period_month, i.period_year, i.paid_at, i.paid_by_name,
           c.name as customer_name
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ?
  `).get(invoiceId);
  if (!invoice) return null;

  const entryDate = normalizeDateInput((paidAt || invoice.paid_at || new Date().toISOString()).slice(0, 10));
  const description = [
    `Pembayaran tagihan ${invoice.customer_name || 'Pelanggan'}`,
    `periode ${invoice.period_month}/${invoice.period_year}`,
    paidByName || invoice.paid_by_name ? `oleh ${paidByName || invoice.paid_by_name}` : ''
  ].filter(Boolean).join(' • ');

  const existing = db.prepare(`SELECT id FROM bookkeeping_entries WHERE source_type='invoice' AND source_id = ? LIMIT 1`).get(invoiceId);
  if (existing) {
    db.prepare(`
      UPDATE bookkeeping_entries
      SET type='income',
          category='Pembayaran Tagihan',
          amount=?,
          entry_date=?,
          description=?,
          customer_id=?,
          invoice_id=?,
          created_by_name=?,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      Number(invoice.amount || 0),
      entryDate,
      description,
      Number(invoice.customer_id || 0) || null,
      Number(invoice.id || 0) || null,
      String(paidByName || invoice.paid_by_name || '').trim(),
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description,
      customer_id, invoice_id, source_type, source_id, created_by_role, created_by_name
    ) VALUES ('income', 'Pembayaran Tagihan', ?, ?, ?, ?, ?, 'invoice', ?, 'system', ?)
  `).run(
    Number(invoice.amount || 0),
    entryDate,
    description,
    Number(invoice.customer_id || 0) || null,
    Number(invoice.id || 0) || null,
    Number(invoice.id || 0) || null,
    String(paidByName || invoice.paid_by_name || '').trim()
  );
  return result.lastInsertRowid;
}

function removeInvoiceIncomeEntry(invoiceId) {
  return db.prepare(`DELETE FROM bookkeeping_entries WHERE source_type='invoice' AND source_id = ?`).run(invoiceId);
}

function syncPaidInvoiceIncomeEntries() {
  const staleDelete = db.prepare(`
    DELETE FROM bookkeeping_entries
    WHERE source_type = 'invoice'
      AND source_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM invoices i
        WHERE i.id = bookkeeping_entries.source_id
          AND LOWER(COALESCE(i.status, '')) = 'paid'
      )
  `);
  const paidRows = db.prepare(`
    SELECT id, paid_by_name, paid_at
    FROM invoices
    WHERE LOWER(COALESCE(status, '')) = 'paid'
    ORDER BY id ASC
  `).all();

  const result = {
    synced: 0,
    deleted: 0,
    totalPaid: paidRows.length
  };

  const run = db.transaction(() => {
    const deleted = staleDelete.run();
    result.deleted = Number(deleted?.changes || 0);

    for (const row of paidRows) {
      upsertInvoiceIncomeEntry(row.id, row.paid_by_name || '', row.paid_at || null);
      result.synced += 1;
    }
  });

  run();
  return result;
}

module.exports = {
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  getCategories,
  createEntry,
  deleteEntry,
  listEntries,
  getSummary,
  getDashboardDetails,
  upsertInvoiceIncomeEntry,
  removeInvoiceIncomeEntry,
  syncPaidInvoiceIncomeEntries,
  resolveEntryCategory
};
