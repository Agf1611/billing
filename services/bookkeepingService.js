const db = require('../config/database');

const DEFAULT_EXPENSE_CATEGORIES = [
  'Listrik',
  'Bandwidth',
  'Gaji',
  'Teknisi',
  'Transport',
  'Maintenance',
  'Operasional',
  'Lainnya'
];

const DEFAULT_INCOME_CATEGORIES = [
  'Pembayaran Tagihan',
  'Pemasangan Baru',
  'Penjualan Perangkat',
  'Deposit',
  'Pendapatan Lainnya'
];

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
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  let where = 'WHERE 1=1';
  const params = [];
  if (Number.isFinite(yearNum) && yearNum > 2000) {
    where += " AND CAST(strftime('%Y', entry_date) AS INTEGER) = ?";
    params.push(yearNum);
  }
  if (Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12) {
    where += " AND CAST(strftime('%m', entry_date) AS INTEGER) = ?";
    params.push(monthNum);
  }
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
  upsertInvoiceIncomeEntry,
  removeInvoiceIncomeEntry,
  syncPaidInvoiceIncomeEntries,
  resolveEntryCategory
};
