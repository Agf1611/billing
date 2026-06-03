const db = require('../config/database');
const { normalizeHolderFromPaidByName, normalizeHolderFromContext } = require('./cashLedgerService');

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
const BANK_TRANSFER_KEYWORDS = ['transfer', 'bri', 'bank', 'brimo'];
const ONLINE_PAYMENT_NAME_SQL = `LOWER(TRIM(COALESCE(i.paid_by_name, ''))) IN (${ONLINE_PAYMENT_ACTORS.map((item) => `'${item}'`).join(', ')})`;
const BANK_TRANSFER_PAYMENT_SQL = `(${BANK_TRANSFER_KEYWORDS.map((item) => `LOWER(COALESCE(i.paid_by_name, '')) LIKE '%${item}%'`).join(' OR ')})`;
const ONLINE_PAYMENT_SQL = `(${ONLINE_PAYMENT_NAME_SQL} OR LOWER(COALESCE(i.paid_by_name, '')) LIKE '%payment gateway%' OR LOWER(COALESCE(i.notes, '')) LIKE '%webhook%')`;
const COMPANY_ACCOUNT_PAYMENT_SQL = `(${ONLINE_PAYMENT_SQL} OR ${BANK_TRANSFER_PAYMENT_SQL})`;
const PARTNER_PAYMENT_SQL = `(COALESCE(i.paid_by_name, '') LIKE 'Agent %')`;
const CASH_PAYMENT_SQL = `(NOT ${COMPANY_ACCOUNT_PAYMENT_SQL} AND NOT ${PARTNER_PAYMENT_SQL})`;

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

function normalizePaymentMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  const allowed = new Set(['cash', 'transfer', 'qris', 'bank', 'ewallet', 'other']);
  return allowed.has(raw) ? raw : 'cash';
}

function getPaymentMethods() {
  return [
    { value: 'cash', label: 'Cash' },
    { value: 'transfer', label: 'Transfer' },
    { value: 'qris', label: 'QRIS' },
    { value: 'bank', label: 'Bank' },
    { value: 'ewallet', label: 'E-Wallet' },
    { value: 'other', label: 'Lainnya' }
  ];
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
  const paymentMethod = normalizePaymentMethod(data.payment_method);
  const holder = normalizeHolderFromContext({
    ...data,
    source_type: sourceType,
    created_by_role: createdByRole,
    created_by_name: createdByName
  });

  return db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description,
      customer_id, invoice_id, source_type, source_id,
      created_by_role, created_by_name,
      holder_role, holder_entity_id, holder_label, payment_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type, category, amount, entryDate, description,
    customerId, invoiceId, sourceType, sourceId,
    createdByRole, createdByName,
    holder.role, holder.entityId, holder.label, paymentMethod
  );
}

function getEntryById(id) {
  return db.prepare(`
    SELECT b.*, c.name AS customer_name, i.period_month, i.period_year
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    WHERE b.id = ?
  `).get(id);
}

function updateEntry(id, data) {
  const entry = getEntryById(id);
  if (!entry) throw new Error('Data pembukuan tidak ditemukan');
  if (String(entry.source_type || '') === 'invoice') throw new Error('Pembukuan otomatis dari invoice tidak bisa diedit manual');

  const type = normalizeType(data.type);
  const amount = Math.max(0, parseInt(data.amount, 10) || 0);
  const entryDate = normalizeDateInput(data.entry_date);
  const category = resolveEntryCategory(type, data.category, data.custom_category);
  const description = String(data.description || '').trim();
  const paymentMethod = normalizePaymentMethod(data.payment_method);

  return db.prepare(`
    UPDATE bookkeeping_entries
    SET type = ?,
        category = ?,
        amount = ?,
        entry_date = ?,
        description = ?,
        payment_method = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND source_type != 'invoice'
  `).run(type, category, amount, entryDate, description, paymentMethod, id);
}

function deleteEntry(id) {
  return db.prepare(`DELETE FROM bookkeeping_entries WHERE id = ? AND source_type != 'invoice'`).run(id);
}

function buildEntryFilterWhere({ type = '', month = '', year = '', search = '', category = '' } = {}) {
  const normalizedType = String(type || '').trim().toLowerCase();
  let where = 'WHERE 1=1';
  const params = [];
  if (normalizedType === 'income' || normalizedType === 'expense') {
    where += ' AND b.type = ?';
    params.push(normalizedType);
  }
  if (category) {
    where += ' AND b.category = ?';
    params.push(String(category).trim());
  }
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (Number.isFinite(yearNum) && yearNum > 2000) {
    where += " AND CAST(strftime('%Y', b.entry_date) AS INTEGER) = ?";
    params.push(yearNum);
  }
  if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
    where += " AND CAST(strftime('%m', b.entry_date) AS INTEGER) = ?";
    params.push(monthNum);
  }
  if (search) {
    const like = `%${String(search).trim()}%`;
    where += ' AND (b.description LIKE ? OR b.category LIKE ? OR c.name LIKE ? OR b.created_by_name LIKE ? OR b.holder_label LIKE ?)';
    params.push(like, like, like, like, like);
  }
  return { where, params };
}

function countEntries(filters = {}) {
  const { where, params } = buildEntryFilterWhere(filters);
  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    ${where}
  `).get(...params);
  return Number(row?.count || 0);
}

function listEntries({ type = '', month = '', year = '', search = '', category = '', limit = 200, offset = 0 } = {}) {
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const { where, params } = buildEntryFilterWhere({ type, month, year, search, category });
  let q = `
    SELECT b.*, c.name as customer_name, i.period_month, i.period_year
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN invoices i ON i.id = b.invoice_id
    ${where}
  `;
  q += ` ORDER BY b.entry_date DESC, b.id DESC LIMIT ${maxLimit} OFFSET ${safeOffset}`;
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
  return ONLINE_PAYMENT_ACTORS.includes(paidBy) || paidBy.includes('payment gateway') || notes.includes('webhook');
}

function isInvoiceBankTransferPayment(row = {}) {
  const paidBy = String(row.paid_by_name || row.paidByName || '').trim().toLowerCase();
  return BANK_TRANSFER_KEYWORDS.some((keyword) => paidBy.includes(keyword));
}

function resolveInvoiceBookkeepingPaymentMethod(row = {}) {
  if (isInvoiceBankTransferPayment(row)) return 'transfer';
  if (isInvoiceOnlinePayment(row)) return 'qris';
  return 'cash';
}

function isInvoicePartnerPayment(row = {}) {
  return String(row.paid_by_name || row.paidByName || '').trim().startsWith('Agent ');
}

function resolveInvoicePaymentChannelLabel(row = {}) {
  if (isInvoicePartnerPayment(row)) return 'Mitra / Agent';
  if (isInvoiceBankTransferPayment(row)) return 'Transfer / Bank Perusahaan';
  if (isInvoiceOnlinePayment(row)) {
    const gateway = String(row.payment_gateway || row.gateway || '').trim();
    return gateway || String(row.paid_by_name || row.paidByName || '').trim() || 'Online / Payment Gateway';
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
        WHEN ${BANK_TRANSFER_PAYMENT_SQL}
        THEN i.amount ELSE 0 END) AS transfer_amount,
      COUNT(CASE
        WHEN ${BANK_TRANSFER_PAYMENT_SQL}
        THEN 1 END) AS transfer_count,
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
    transfer: {
      amount: Number(invoiceChannelSummary.transfer_amount || 0),
      count: Number(invoiceChannelSummary.transfer_count || 0)
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

const INCOME_DETAIL_META = {
  cash: {
    title: 'Transaksi Cash',
    subtitle: 'Pembayaran tagihan yang diterima manual oleh admin, kasir, kolektor, atau teknisi.',
    icon: 'bi-cash-stack'
  },
  online: {
    title: 'Transaksi Online',
    subtitle: 'Pembayaran dari QRIS, Tripay, webhook, atau kanal online lain.',
    icon: 'bi-qr-code-scan'
  },
  transfer: {
    title: 'Transfer / Bank Perusahaan',
    subtitle: 'Pembayaran manual via rekening perusahaan seperti BRI/BRImo.',
    icon: 'bi-bank2'
  },
  other: {
    title: 'Pemasukan Lain',
    subtitle: 'Pemasukan manual dan topup saldo agent yang bukan invoice pelanggan.',
    icon: 'bi-piggy-bank'
  },
  partner: {
    title: 'Mitra Bayar Bulan Ini',
    subtitle: 'Pembayaran yang diproses oleh agent atau mitra.',
    icon: 'bi-people-fill'
  }
};

const EXPENSE_DETAIL_META = {
  salary: { title: 'Gaji Karyawan', subtitle: 'Pengeluaran gaji, insentif, dan biaya karyawan.', icon: 'bi-person-vcard' },
  installation: { title: 'Pasang Baru', subtitle: 'Biaya material dan operasional pemasangan baru.', icon: 'bi-hammer' },
  repair_tools: { title: 'Perbaikan Alat', subtitle: 'Pengeluaran maintenance, alat, dan sparepart.', icon: 'bi-tools' },
  bandwidth: { title: 'Bayar Bandwidth', subtitle: 'Biaya upstream, bandwidth, dan internet utama.', icon: 'bi-router' },
  collection: { title: 'Bayar Kang Tagih', subtitle: 'Biaya kolektor, tukang tagih, dan operasional penagihan.', icon: 'bi-person-check' },
  utilities: { title: 'Listrik / PDAM / Pulsa', subtitle: 'Biaya utilitas seperti listrik, air, pulsa, dan token.', icon: 'bi-lightning-charge' },
  marketing: { title: 'Bayar Marketing', subtitle: 'Pengeluaran promosi, iklan, dan marketing.', icon: 'bi-megaphone' },
  other: { title: 'Lain Lain', subtitle: 'Pengeluaran lain yang belum masuk kategori khusus.', icon: 'bi-grid' }
};

function normalizeDetailRow(row = {}, fallback = {}) {
  return {
    id: Number(row.id || 0),
    date: row.date || row.entry_date || row.paid_at || row.created_at || '',
    title: row.title || row.customer_name || row.description || fallback.title || '-',
    subtitle: row.subtitle || fallback.subtitle || '',
    amount: Number(row.amount || 0),
    type: row.type || fallback.type || '',
    source: row.source || row.source_type || fallback.source || '',
    holderLabel: row.holder_label || row.paid_by_name || row.created_by_name || fallback.holderLabel || ''
  };
}

function mapInvoiceDetailRows(rows = []) {
  return rows.map((row) => {
    const actor = normalizePaymentActor(row.paid_by_name);
    return normalizeDetailRow({
      id: row.id,
      date: row.paid_at,
      title: row.customer_name || `Invoice #${row.id}`,
      subtitle: [
        `Tagihan ${row.period_month || '-'}/${row.period_year || '-'}`,
        `oleh ${actor.label}`,
        resolveInvoicePaymentChannelLabel(row)
      ].filter(Boolean).join(' - '),
      amount: row.amount,
      type: 'income',
      source: 'invoice',
      holder_label: actor.label
    });
  });
}

function getInvoiceDetailRows({ month = '', year = '', channelSql = '', limit = 80 } = {}) {
  const params = [];
  const periodWhere = buildPeriodWhere('i.paid_at', month, year, params);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 200));
  const channelClause = channelSql ? `AND ${channelSql}` : '';
  return mapInvoiceDetailRows(db.prepare(`
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
      ${periodWhere.slice('WHERE 1=1'.length)}
      ${channelClause}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT ${safeLimit}
  `).all(...params));
}

function getManualEntryDetailRows({ type = '', month = '', year = '', sourceNot = '', limit = 80 } = {}) {
  const params = [];
  const periodWhere = buildPeriodWhere('b.entry_date', month, year, params);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 200));
  const sourceClause = sourceNot ? `AND COALESCE(b.source_type, '') != ?` : '';
  const queryParams = params.concat(type);
  if (sourceNot) queryParams.push(sourceNot);
  const rows = db.prepare(`
    SELECT b.*, c.name AS customer_name
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    ${periodWhere}
      AND b.type = ?
      ${sourceClause}
    ORDER BY date(b.entry_date) DESC, b.id DESC
    LIMIT ${safeLimit}
  `).all(...queryParams);

  return rows.map((row) => normalizeDetailRow({
    ...row,
    date: row.entry_date,
    title: row.description || row.category || '-',
    subtitle: [
      row.category || '',
      row.customer_name ? `Pelanggan ${row.customer_name}` : '',
      row.created_by_name ? `oleh ${row.created_by_name}` : '',
      row.holder_label ? `kas ${row.holder_label}` : ''
    ].filter(Boolean).join(' - ')
  }, { type }));
}

function getExpenseDetailRows({ bucket = '', month = '', year = '', limit = 80 } = {}) {
  const params = [];
  const periodWhere = buildPeriodWhere('b.entry_date', month, year, params);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 200));
  const rows = db.prepare(`
    SELECT b.*, c.name AS customer_name
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    ${periodWhere}
      AND b.type = 'expense'
    ORDER BY date(b.entry_date) DESC, b.id DESC
  `).all(...params);

  return rows
    .filter((row) => resolveExpenseBucketName(row) === bucket)
    .slice(0, safeLimit)
    .map((row) => normalizeDetailRow({
      ...row,
      date: row.entry_date,
      title: row.description || row.category || '-',
      subtitle: [
        row.category || '',
        row.created_by_name ? `oleh ${row.created_by_name}` : '',
        row.holder_label ? `kas ${row.holder_label}` : ''
      ].filter(Boolean).join(' - ')
    }, { type: 'expense' }));
}

function getAdminCashDetailRows({ month = '', year = '', limit = 80 } = {}) {
  const entryParams = [];
  const entryWhere = buildPeriodWhere('b.entry_date', month, year, entryParams);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 200));
  const entryRows = db.prepare(`
    SELECT b.*, c.name AS customer_name
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    ${entryWhere}
      AND (LOWER(COALESCE(b.holder_role, '')) = 'admin' OR LOWER(COALESCE(b.created_by_role, '')) = 'admin')
    ORDER BY date(b.entry_date) DESC, b.id DESC
    LIMIT ${safeLimit}
  `).all(...entryParams).map((row) => normalizeDetailRow({
    ...row,
    date: row.entry_date,
    title: row.description || row.category || '-',
    subtitle: [
      row.type === 'expense' ? 'Pengeluaran admin' : 'Pemasukan admin',
      row.category || '',
      row.customer_name ? `Pelanggan ${row.customer_name}` : ''
    ].filter(Boolean).join(' - ')
  }, { type: row.type || '' }));

  const settlementParams = [];
  const settlementWhere = buildPeriodWhere('s.settlement_date', month, year, settlementParams);
  const settlementRows = db.prepare(`
    SELECT s.*
    FROM cash_settlements s
    ${settlementWhere}
      AND LOWER(COALESCE(s.to_role, '')) = 'admin'
    ORDER BY date(s.settlement_date) DESC, s.id DESC
    LIMIT ${safeLimit}
  `).all(...settlementParams).map((row) => normalizeDetailRow({
    id: row.id,
    date: row.settlement_date,
    title: `Setor dari ${row.from_label || 'Petugas'}`,
    subtitle: [
      row.notes || 'Setoran kas ke admin',
      row.created_by_name ? `dicatat ${row.created_by_name}` : ''
    ].filter(Boolean).join(' - '),
    amount: row.amount,
    type: 'income',
    source: 'settlement',
    holder_label: row.to_label || 'Admin'
  }));

  return entryRows.concat(settlementRows)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, safeLimit);
}

function getAdminPaymentDetailRows({ month = '', year = '', limit = 80 } = {}) {
  const params = [];
  const periodWhere = buildPeriodWhere('i.paid_at', month, year, params);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 200));
  return mapInvoiceDetailRows(db.prepare(`
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
      ${periodWhere.slice('WHERE 1=1'.length)}
      AND LOWER(COALESCE(i.paid_by_name, '')) LIKE 'admin%'
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT ${safeLimit}
  `).all(...params));
}

function listDashboardCategoryDetails({ section = '', bucket = '', month = '', year = '', limit = 80 } = {}) {
  const normalizedSection = String(section || '').trim().toLowerCase();
  const normalizedBucket = String(bucket || '').trim().toLowerCase();
  let meta = null;
  let rows = [];

  if (normalizedSection === 'income') {
    meta = INCOME_DETAIL_META[normalizedBucket] || null;
    if (normalizedBucket === 'cash') rows = getInvoiceDetailRows({ month, year, channelSql: CASH_PAYMENT_SQL, limit });
    if (normalizedBucket === 'online') rows = getInvoiceDetailRows({ month, year, channelSql: ONLINE_PAYMENT_SQL, limit });
    if (normalizedBucket === 'transfer') rows = getInvoiceDetailRows({ month, year, channelSql: BANK_TRANSFER_PAYMENT_SQL, limit });
    if (normalizedBucket === 'partner') rows = getInvoiceDetailRows({ month, year, channelSql: PARTNER_PAYMENT_SQL, limit });
    if (normalizedBucket === 'other') rows = getManualEntryDetailRows({ type: 'income', month, year, sourceNot: 'invoice', limit });
  } else if (normalizedSection === 'expense') {
    meta = EXPENSE_DETAIL_META[normalizedBucket] || null;
    if (meta) rows = getExpenseDetailRows({ bucket: normalizedBucket, month, year, limit });
  } else if (normalizedSection === 'admin') {
    if (normalizedBucket === 'cash') {
      meta = {
        title: 'Uang di Admin',
        subtitle: 'Pemasukan, pengeluaran, dan setoran yang berada di kas admin.',
        icon: 'bi-person-circle'
      };
      rows = getAdminCashDetailRows({ month, year, limit });
    } else if (normalizedBucket === 'payments') {
      meta = {
        title: 'Pembayaran By Admin',
        subtitle: 'Pembayaran pelanggan yang dilunaskan oleh admin pada periode ini.',
        icon: 'bi-person-check'
      };
      rows = getAdminPaymentDetailRows({ month, year, limit });
    }
  }

  if (!meta) return null;
  const amount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return {
    section: normalizedSection,
    bucket: normalizedBucket,
    title: meta.title,
    subtitle: meta.subtitle,
    icon: meta.icon,
    amount,
    count: rows.length,
    rows
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
  const holder = normalizeHolderFromPaidByName(String(paidByName || invoice.paid_by_name || '').trim());
  const paymentMethod = resolveInvoiceBookkeepingPaymentMethod({
    paid_by_name: paidByName || invoice.paid_by_name || ''
  });
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
          holder_role=?,
          holder_entity_id=?,
          holder_label=?,
          payment_method=?,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      Number(invoice.amount || 0),
      entryDate,
      description,
      Number(invoice.customer_id || 0) || null,
      Number(invoice.id || 0) || null,
      String(paidByName || invoice.paid_by_name || '').trim(),
      holder.role,
      holder.entityId,
      holder.label,
      paymentMethod,
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description,
      customer_id, invoice_id, source_type, source_id, created_by_role, created_by_name,
      holder_role, holder_entity_id, holder_label, payment_method
    ) VALUES ('income', 'Pembayaran Tagihan', ?, ?, ?, ?, ?, 'invoice', ?, 'system', ?, ?, ?, ?, ?)
  `).run(
    Number(invoice.amount || 0),
    entryDate,
    description,
    Number(invoice.customer_id || 0) || null,
    Number(invoice.id || 0) || null,
    Number(invoice.id || 0) || null,
    String(paidByName || invoice.paid_by_name || '').trim(),
    holder.role,
    holder.entityId,
    holder.label,
    paymentMethod
  );
  return result.lastInsertRowid;
}

function removeInvoiceIncomeEntry(invoiceId) {
  return db.prepare(`DELETE FROM bookkeeping_entries WHERE source_type='invoice' AND source_id = ?`).run(invoiceId);
}

function upsertAgentTopupIncomeEntry(txId) {
  const id = Number(txId || 0);
  if (!id) return null;

  const tx = db.prepare(`
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.id = ? AND t.type = 'topup'
  `).get(id);
  if (!tx) return null;

  const amount = Math.max(0, Number(tx.amount_buy || 0) || 0);
  if (amount <= 0) return null;

  const entryDate = normalizeDateInput(String(tx.created_at || new Date().toISOString()).slice(0, 10));
  const agentLabel = `${tx.agent_name || 'Agent'}${tx.agent_username ? ` (@${tx.agent_username})` : ''}`;
  const description = [
    `Topup saldo agent ${agentLabel}`,
    tx.agent_topup_order_id ? `order #${tx.agent_topup_order_id}` : '',
    tx.note ? String(tx.note).trim() : ''
  ].filter(Boolean).join(' - ');

  const existing = db.prepare(`SELECT id FROM bookkeeping_entries WHERE source_type='agent_topup' AND source_id = ? LIMIT 1`).get(id);
  if (existing) {
    db.prepare(`
      UPDATE bookkeeping_entries
      SET type='income',
          category='Pendapatan Lainnya',
          amount=?,
          entry_date=?,
          description=?,
          created_by_role='agent',
          created_by_name=?,
          holder_role='admin',
          holder_entity_id=0,
          holder_label='Admin',
          payment_method='qris',
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(amount, entryDate, description, agentLabel, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description,
      source_type, source_id, created_by_role, created_by_name,
      holder_role, holder_entity_id, holder_label, payment_method
    ) VALUES ('income', 'Pendapatan Lainnya', ?, ?, ?, 'agent_topup', ?, 'agent', ?, 'admin', 0, 'Admin', 'qris')
  `).run(amount, entryDate, description, id, agentLabel);
  return result.lastInsertRowid;
}

function upsertAgentVoucherIncomeEntry(txId) {
  return upsertAgentTopupIncomeEntry(txId);
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

function syncAgentVoucherIncomeEntries() {
  db.prepare("DELETE FROM bookkeeping_entries WHERE source_type = 'agent_voucher'").run();
  const rows = db.prepare(`
    SELECT id
    FROM agent_transactions
    WHERE type = 'topup'
    ORDER BY id ASC
  `).all();
  let synced = 0;
  for (const row of rows) {
    if (upsertAgentTopupIncomeEntry(row.id)) synced += 1;
  }
  return { synced, total: rows.length };
}

module.exports = {
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  getCategories,
  getPaymentMethods,
  createEntry,
  getEntryById,
  updateEntry,
  deleteEntry,
  listEntries,
  countEntries,
  getSummary,
  getDashboardDetails,
  listDashboardCategoryDetails,
  upsertInvoiceIncomeEntry,
  removeInvoiceIncomeEntry,
  upsertAgentTopupIncomeEntry,
  upsertAgentVoucherIncomeEntry,
  syncPaidInvoiceIncomeEntries,
  syncAgentVoucherIncomeEntries,
  resolveEntryCategory
};
