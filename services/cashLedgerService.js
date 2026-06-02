const db = require('../config/database');

const TRACKED_ROLES = ['admin', 'cashier', 'collector', 'technician'];
const STAFF_ROLES = ['cashier', 'collector', 'technician'];
const ROLE_META = {
  admin: { label: 'Admin', prefix: 'Admin', table: null },
  cashier: { label: 'Kasir', prefix: 'Kasir', table: 'cashiers' },
  collector: { label: 'Kolektor', prefix: 'Kolektor', table: 'collectors' },
  technician: { label: 'Teknisi', prefix: 'Teknisi', table: 'technicians' },
  other: { label: 'Lainnya', prefix: '', table: null },
  agent: { label: 'Agent', prefix: 'Agent', table: null }
};

function normalizeDateInput(dateInput) {
  const raw = String(dateInput || '').trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) return new Date().toISOString().slice(0, 10);
  return raw;
}

function roleLabel(role) {
  return ROLE_META[String(role || '').trim().toLowerCase()]?.label || 'Lainnya';
}

function extractUsername(raw = '') {
  const matched = String(raw || '').match(/\(@([^)]+)\)/i);
  if (matched && matched[1]) return String(matched[1]).trim();
  return '';
}

function stripRolePrefix(raw = '', role = '') {
  const prefix = ROLE_META[String(role || '').trim().toLowerCase()]?.prefix || '';
  let label = String(raw || '').trim();
  if (prefix) {
    label = label.replace(new RegExp(`^${prefix}\\s+`, 'i'), '').trim();
  }
  label = label.replace(/\s*\(@[^)]+\)\s*$/i, '').trim();
  return label;
}

function buildManagedLabel(role, row = {}) {
  const meta = ROLE_META[String(role || '').trim().toLowerCase()] || ROLE_META.other;
  const name = String(row.name || '').trim();
  const username = String(row.username || '').trim();
  if (name && username) return `${meta.prefix} ${name} (@${username})`.trim();
  if (name) return `${meta.prefix} ${name}`.trim();
  if (username) return `${meta.prefix} @${username}`.trim();
  return meta.label;
}

function findManagedEntity(role, label = '') {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const table = ROLE_META[normalizedRole]?.table;
  if (!table) return null;

  const username = extractUsername(label);
  if (username) {
    const byUsername = db.prepare(`SELECT id, username, name, is_active FROM ${table} WHERE LOWER(username) = LOWER(?) LIMIT 1`).get(username);
    if (byUsername) return byUsername;
  }

  const strippedName = stripRolePrefix(label, normalizedRole);
  if (!strippedName) return null;
  return db.prepare(`SELECT id, username, name, is_active FROM ${table} WHERE LOWER(name) = LOWER(?) LIMIT 1`).get(strippedName) || null;
}

function normalizeHolderFromPaidByName(name = '') {
  const raw = String(name || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return { role: 'other', entityId: null, label: 'Lainnya', known: false };
  }
  if (lower === 'admin' || lower.startsWith('admin')) {
    return { role: 'admin', entityId: 0, label: raw || 'Admin', known: true };
  }
  if (lower.startsWith('kasir')) {
    const entity = findManagedEntity('cashier', raw);
    return { role: 'cashier', entityId: entity ? Number(entity.id || 0) : null, label: entity ? buildManagedLabel('cashier', entity) : raw, known: Boolean(entity) };
  }
  if (lower.startsWith('kolektor')) {
    const entity = findManagedEntity('collector', raw);
    return { role: 'collector', entityId: entity ? Number(entity.id || 0) : null, label: entity ? buildManagedLabel('collector', entity) : raw, known: Boolean(entity) };
  }
  if (lower.startsWith('teknisi')) {
    const entity = findManagedEntity('technician', raw);
    return { role: 'technician', entityId: entity ? Number(entity.id || 0) : null, label: entity ? buildManagedLabel('technician', entity) : raw, known: Boolean(entity) };
  }
  if (lower.startsWith('agent')) {
    return { role: 'agent', entityId: null, label: raw, known: false };
  }
  return { role: 'other', entityId: null, label: raw, known: false };
}

function normalizeHolderFromContext(data = {}) {
  const explicitRole = String(data.holder_role || '').trim().toLowerCase();
  const explicitLabel = String(data.holder_label || '').trim();
  const explicitEntity = Number(data.holder_entity_id || 0);
  if (explicitRole) {
    return {
      role: explicitRole,
      entityId: Number.isFinite(explicitEntity) && explicitEntity > 0 ? explicitEntity : explicitRole === 'admin' ? 0 : null,
      label: explicitLabel || roleLabel(explicitRole),
      known: true
    };
  }

  const sourceType = String(data.source_type || '').trim().toLowerCase();
  if (sourceType === 'invoice') {
    return normalizeHolderFromPaidByName(String(data.paid_by_name || data.created_by_name || '').trim());
  }

  const createdRole = String(data.created_by_role || '').trim().toLowerCase();
  const createdName = String(data.created_by_name || '').trim();
  if (TRACKED_ROLES.includes(createdRole)) {
    if (createdRole === 'admin') return { role: 'admin', entityId: 0, label: createdName || 'Admin', known: true };
    const fromName = normalizeHolderFromPaidByName(createdName || roleLabel(createdRole));
    if (fromName.role === createdRole) return fromName;
  }

  if (createdName) {
    const fromName = normalizeHolderFromPaidByName(createdName);
    if (TRACKED_ROLES.includes(fromName.role)) return fromName;
  }

  return { role: 'admin', entityId: 0, label: 'Admin', known: true };
}

function listManagedCashHolders({ includeInactive = true } = {}) {
  const holders = [{ role: 'admin', entityId: 0, label: 'Admin', name: 'Admin', username: '', isActive: true }];
  for (const role of STAFF_ROLES) {
    const table = ROLE_META[role].table;
    const rows = db.prepare(`SELECT id, username, name, is_active, created_at FROM ${table} ORDER BY COALESCE(name, username, '') ASC`).all();
    for (const row of rows) {
      const isActive = Number(row.is_active ?? 1) === 1;
      if (!includeInactive && !isActive) continue;
      holders.push({
        role,
        entityId: Number(row.id || 0),
        label: buildManagedLabel(role, row),
        name: String(row.name || '').trim(),
        username: String(row.username || '').trim(),
        isActive,
        createdAt: row.created_at || ''
      });
    }
  }
  return holders;
}

function buildBalanceMap({ month = '', year = '' } = {}) {
  const holderSeed = new Map();
  for (const holder of listManagedCashHolders({ includeInactive: true })) {
    const key = `${holder.role}:${holder.entityId == null ? 'null' : holder.entityId}`;
    holderSeed.set(key, {
      role: holder.role,
      entityId: holder.entityId,
      label: holder.label,
      name: holder.name || holder.label,
      username: holder.username || '',
      isActive: holder.isActive !== false,
      invoiceIncome: 0,
      manualIncome: 0,
      expense: 0,
      settlementIn: 0,
      settlementOut: 0,
      periodInvoiceIncome: 0,
      periodExpense: 0,
      invoiceCount: 0,
      manualCount: 0,
      expenseCount: 0,
      settlementInCount: 0,
      settlementOutCount: 0
    });
  }

  const ensureBucket = (role, entityId, label) => {
    const normalizedRole = String(role || '').trim().toLowerCase() || 'other';
    const normalizedEntityId = Number.isFinite(Number(entityId)) ? Number(entityId) : (normalizedRole === 'admin' ? 0 : null);
    const key = `${normalizedRole}:${normalizedEntityId == null ? 'null' : normalizedEntityId}`;
    if (!holderSeed.has(key)) {
      holderSeed.set(key, {
        role: normalizedRole,
        entityId: normalizedEntityId,
        label: String(label || roleLabel(normalizedRole)).trim() || roleLabel(normalizedRole),
        name: String(label || roleLabel(normalizedRole)).trim() || roleLabel(normalizedRole),
        username: '',
        isActive: normalizedRole === 'admin',
        invoiceIncome: 0,
        manualIncome: 0,
        expense: 0,
        settlementIn: 0,
        settlementOut: 0,
        periodInvoiceIncome: 0,
        periodExpense: 0,
        invoiceCount: 0,
        manualCount: 0,
        expenseCount: 0,
        settlementInCount: 0,
        settlementOutCount: 0
      });
    } else if (label && !holderSeed.get(key).label) {
      holderSeed.get(key).label = label;
    }
    return holderSeed.get(key);
  };

  const entryParams = [];
  const entryWhere = buildPeriodWhere('entry_date', month, year, entryParams);
  const entries = db.prepare(`
    SELECT
      id, type, amount, entry_date, source_type,
      holder_role, holder_entity_id, holder_label
    FROM bookkeeping_entries
    ${entryWhere}
      AND COALESCE(holder_role, '') != ''
  `).all(...entryParams);

  for (const entry of entries) {
    const bucket = ensureBucket(entry.holder_role, entry.holder_entity_id, entry.holder_label);
    const amount = Number(entry.amount || 0);
    if (String(entry.type || '').trim().toLowerCase() === 'income') {
      if (String(entry.source_type || '').trim().toLowerCase() === 'invoice') {
        bucket.invoiceIncome += amount;
        bucket.invoiceCount += 1;
      } else {
        bucket.manualIncome += amount;
        bucket.manualCount += 1;
      }
    } else {
      bucket.expense += amount;
      bucket.expenseCount += 1;
    }
  }

  const settlementParams = [];
  const settlementWhere = buildPeriodWhere('settlement_date', month, year, settlementParams);
  const settlements = db.prepare(`
    SELECT id, from_role, from_entity_id, from_label, to_role, to_entity_id, to_label, amount
    FROM cash_settlements
    ${settlementWhere}
  `).all(...settlementParams);

  for (const row of settlements) {
    const amount = Number(row.amount || 0);
    const fromBucket = ensureBucket(row.from_role, row.from_entity_id, row.from_label);
    const toBucket = ensureBucket(row.to_role, row.to_entity_id, row.to_label);
    fromBucket.settlementOut += amount;
    fromBucket.settlementOutCount += 1;
    toBucket.settlementIn += amount;
    toBucket.settlementInCount += 1;
  }

  return holderSeed;
}

function getCashBalances({ month = '', year = '' } = {}) {
  const balanceMap = buildBalanceMap({ month, year });
  const rows = [];
  for (const bucket of balanceMap.values()) {
    const incomeTotal = Number(bucket.invoiceIncome || 0) + Number(bucket.manualIncome || 0);
    const currentBalance = incomeTotal + Number(bucket.settlementIn || 0) - Number(bucket.expense || 0) - Number(bucket.settlementOut || 0);
    const hasActivity = incomeTotal > 0 || Number(bucket.expense || 0) > 0 || Number(bucket.settlementIn || 0) > 0 || Number(bucket.settlementOut || 0) > 0;
    if (bucket.role !== 'admin' && !bucket.isActive && !hasActivity && currentBalance === 0) continue;
    if (bucket.role !== 'admin' && !bucket.isActive && currentBalance === 0) continue;
    const statusLabel = currentBalance <= 0
      ? 'Saldo 0'
      : Number(bucket.settlementOut || 0) <= 0
        ? 'Belum setor'
        : 'Sudah setor sebagian';
    rows.push({
      role: bucket.role,
      roleLabel: roleLabel(bucket.role),
      entityId: bucket.entityId,
      label: bucket.label || roleLabel(bucket.role),
      name: bucket.name || bucket.label || roleLabel(bucket.role),
      username: bucket.username || '',
      isActive: bucket.role === 'admin' ? true : bucket.isActive !== false,
      invoiceIncome: Number(bucket.invoiceIncome || 0),
      manualIncome: Number(bucket.manualIncome || 0),
      expense: Number(bucket.expense || 0),
      settlementIn: Number(bucket.settlementIn || 0),
      settlementOut: Number(bucket.settlementOut || 0),
      invoiceCount: Number(bucket.invoiceCount || 0),
      manualCount: Number(bucket.manualCount || 0),
      expenseCount: Number(bucket.expenseCount || 0),
      settlementInCount: Number(bucket.settlementInCount || 0),
      settlementOutCount: Number(bucket.settlementOutCount || 0),
      currentBalance,
      statusLabel
    });
  }

  rows.sort((a, b) => {
    if (a.role === 'admin') return -1;
    if (b.role === 'admin') return 1;
    if (a.currentBalance !== b.currentBalance) return b.currentBalance - a.currentBalance;
    return String(a.label || '').localeCompare(String(b.label || ''), 'id');
  });

  return rows;
}

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

function getPeriodPaymentBreakdown({ month = '', year = '' } = {}) {
  const params = [];
  const where = buildPeriodWhere('i.paid_at', month, year, params);
  const payments = db.prepare(`
    SELECT
      i.id,
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
    ${where}
      AND LOWER(COALESCE(i.status, '')) = 'paid'
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
  `).all(...params);

  const roleMap = new Map();
  const actorMap = new Map();
  const details = [];

  for (const row of payments) {
    const holder = normalizeHolderFromPaidByName(row.paid_by_name || '');
    const amount = Number(row.amount || 0);
    const roleKey = holder.role;
    if (!roleMap.has(roleKey)) {
      roleMap.set(roleKey, { role: roleKey, label: roleLabel(roleKey), amount: 0, count: 0, actors: new Set() });
    }
    const roleBucket = roleMap.get(roleKey);
    roleBucket.amount += amount;
    roleBucket.count += 1;
    roleBucket.actors.add(holder.label || roleLabel(roleKey));

    const actorKey = `${holder.role}|${holder.entityId == null ? 'null' : holder.entityId}|${holder.label || ''}`;
    if (!actorMap.has(actorKey)) {
      actorMap.set(actorKey, {
        role: holder.role,
        entityId: holder.entityId,
        label: holder.label || roleLabel(holder.role),
        amount: 0,
        count: 0,
        lastPaidAt: ''
      });
    }
    const actorBucket = actorMap.get(actorKey);
    actorBucket.amount += amount;
    actorBucket.count += 1;
    if (!actorBucket.lastPaidAt || String(row.paid_at || '').localeCompare(String(actorBucket.lastPaidAt || '')) > 0) {
      actorBucket.lastPaidAt = row.paid_at || '';
    }

    details.push({
      invoiceId: Number(row.id || 0),
      paidAt: row.paid_at || '',
      paidByName: row.paid_by_name || '',
      holderRole: holder.role,
      holderLabel: holder.label || roleLabel(holder.role),
      customerName: row.customer_name || 'Pelanggan',
      amount,
      periodMonth: Number(row.period_month || 0),
      periodYear: Number(row.period_year || 0),
      gateway: row.payment_gateway || '',
      notes: row.notes || ''
    });
  }

  const roleRows = Array.from(roleMap.values()).map((row) => ({
    role: row.role,
    label: row.label,
    amount: row.amount,
    count: row.count,
    actorCount: row.actors.size
  })).sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label, 'id'));

  const actorRows = Array.from(actorMap.values()).sort((a, b) => b.amount - a.amount || String(a.label || '').localeCompare(String(b.label || ''), 'id'));

  return { roleRows, actorRows, details };
}

function getSettlementSummary({ month = '', year = '' } = {}) {
  const params = [];
  const where = buildPeriodWhere('settlement_date', month, year, params);
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(amount) AS total_amount,
      COUNT(DISTINCT from_role || ':' || COALESCE(CAST(from_entity_id AS TEXT), 'null')) AS staff_count
    FROM cash_settlements
    ${where}
  `).get(...params) || {};
  return {
    totalCount: Number(summary.total_count || 0),
    totalAmount: Number(summary.total_amount || 0),
    staffCount: Number(summary.staff_count || 0)
  };
}

function listSettlements({ month = '', year = '', limit = 120 } = {}) {
  const params = [];
  const where = buildPeriodWhere('settlement_date', month, year, params);
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 120, 500));
  return db.prepare(`
    SELECT *
    FROM cash_settlements
    ${where}
    ORDER BY settlement_date DESC, id DESC
    LIMIT ${maxLimit}
  `).all(...params).map((row) => ({
    id: Number(row.id || 0),
    settlementDate: row.settlement_date || '',
    fromRole: row.from_role || '',
    fromEntityId: Number(row.from_entity_id || 0) || null,
    fromLabel: row.from_label || '',
    toRole: row.to_role || '',
    toEntityId: Number(row.to_entity_id || 0) || null,
    toLabel: row.to_label || '',
    amount: Number(row.amount || 0),
    notes: row.notes || '',
    createdByRole: row.created_by_role || '',
    createdByName: row.created_by_name || '',
    createdAt: row.created_at || ''
  }));
}

function listCashHolderTransactions({ role = '', entityId = null, month = '', year = '', limit = 200 } = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const normalizedEntityId = Number.isFinite(Number(entityId)) ? Number(entityId) : (normalizedRole === 'admin' ? 0 : null);
  if (!normalizedRole) return [];
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));

  const entryParams = [];
  const entryWhere = buildPeriodWhere('b.entry_date', month, year, entryParams);
  entryParams.push(normalizedRole);
  entryParams.push(normalizedEntityId == null ? -1 : normalizedEntityId);
  const entryRows = db.prepare(`
    SELECT b.*, c.name AS customer_name
    FROM bookkeeping_entries b
    LEFT JOIN customers c ON c.id = b.customer_id
    ${entryWhere}
      AND LOWER(COALESCE(b.holder_role, '')) = ?
      AND COALESCE(b.holder_entity_id, -1) = ?
    ORDER BY date(b.entry_date) DESC, b.id DESC
    LIMIT ${maxLimit}
  `).all(...entryParams).map((row) => ({
    id: Number(row.id || 0),
    date: row.entry_date || '',
    title: row.description || row.customer_name || row.category || '-',
    subtitle: [
      row.category || '',
      row.customer_name ? `Pelanggan ${row.customer_name}` : '',
      row.source_type || 'manual'
    ].filter(Boolean).join(' - '),
    amount: Number(row.amount || 0),
    type: String(row.type || '').trim().toLowerCase() === 'expense' ? 'expense' : 'income',
    source: row.source_type || 'manual'
  }));

  const settlementParams = [];
  const settlementWhere = buildPeriodWhere('s.settlement_date', month, year, settlementParams);
  settlementParams.push(normalizedRole, normalizedEntityId == null ? -1 : normalizedEntityId, normalizedRole, normalizedEntityId == null ? -1 : normalizedEntityId);
  const settlementRows = db.prepare(`
    SELECT s.*
    FROM cash_settlements s
    ${settlementWhere}
      AND (
        (LOWER(COALESCE(s.from_role, '')) = ? AND COALESCE(s.from_entity_id, -1) = ?)
        OR
        (LOWER(COALESCE(s.to_role, '')) = ? AND COALESCE(s.to_entity_id, -1) = ?)
      )
    ORDER BY date(s.settlement_date) DESC, s.id DESC
    LIMIT ${maxLimit}
  `).all(...settlementParams).map((row) => {
    const isOut = String(row.from_role || '').trim().toLowerCase() === normalizedRole
      && Number(row.from_entity_id ?? -1) === (normalizedEntityId == null ? -1 : normalizedEntityId);
    return {
      id: Number(row.id || 0),
      date: row.settlement_date || '',
      title: isOut ? `Setor ke ${row.to_label || 'Admin'}` : `Setor dari ${row.from_label || 'Petugas'}`,
      subtitle: [
        row.notes || 'Setoran kas',
        row.created_by_name ? `dicatat ${row.created_by_name}` : ''
      ].filter(Boolean).join(' - '),
      amount: Number(row.amount || 0),
      type: isOut ? 'expense' : 'income',
      source: 'settlement'
    };
  });

  return entryRows.concat(settlementRows)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id || 0) - Number(a.id || 0))
    .slice(0, maxLimit);
}

function createSettlement(data = {}) {
  const fromRole = String(data.from_role || '').trim().toLowerCase();
  const fromEntityId = Number(data.from_entity_id || 0);
  if (!STAFF_ROLES.includes(fromRole)) throw new Error('Petugas sumber setor tidak valid.');
  if (!Number.isFinite(fromEntityId) || fromEntityId <= 0) throw new Error('Petugas sumber setor tidak valid.');

  const source = listManagedCashHolders({ includeInactive: true }).find((item) => item.role === fromRole && Number(item.entityId || 0) === fromEntityId);
  if (!source) throw new Error('Petugas sumber setor tidak ditemukan.');

  const amount = Math.max(0, parseInt(data.amount, 10) || 0);
  if (!amount) throw new Error('Nominal setor wajib diisi.');

  const balances = getCashBalances();
  const sourceBalance = balances.find((item) => item.role === fromRole && Number(item.entityId || 0) === fromEntityId);
  const available = Number(sourceBalance?.currentBalance || 0);
  if (available <= 0) throw new Error('Saldo petugas saat ini sudah 0.');
  if (amount > available) throw new Error(`Nominal setor melebihi saldo petugas saat ini (Rp ${available.toLocaleString('id-ID')}).`);

  const settlementDate = normalizeDateInput(data.settlement_date);
  const notes = String(data.notes || '').trim();
  const createdByRole = String(data.created_by_role || 'admin').trim().toLowerCase() || 'admin';
  const createdByName = String(data.created_by_name || 'Admin').trim() || 'Admin';

  return db.prepare(`
    INSERT INTO cash_settlements (
      settlement_date,
      from_role, from_entity_id, from_label,
      to_role, to_entity_id, to_label,
      amount, notes, created_by_role, created_by_name
    ) VALUES (?, ?, ?, ?, 'admin', 0, 'Admin', ?, ?, ?, ?)
  `).run(
    settlementDate,
    fromRole,
    fromEntityId,
    source.label,
    amount,
    notes,
    createdByRole,
    createdByName
  );
}

function backfillBookkeepingHolders() {
  const rows = db.prepare(`
    SELECT
      b.id,
      b.source_type,
      b.created_by_role,
      b.created_by_name,
      b.holder_role,
      b.holder_entity_id,
      b.holder_label,
      i.paid_by_name
    FROM bookkeeping_entries b
    LEFT JOIN invoices i ON i.id = b.source_id AND b.source_type = 'invoice'
    WHERE COALESCE(b.holder_role, '') = ''
       OR COALESCE(b.holder_label, '') = ''
       OR (b.source_type = 'invoice' AND COALESCE(i.paid_by_name, '') != '')
  `).all();

  const updateStmt = db.prepare(`
    UPDATE bookkeeping_entries
    SET holder_role = ?, holder_entity_id = ?, holder_label = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let updated = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const holder = normalizeHolderFromContext({
        source_type: row.source_type,
        created_by_role: row.created_by_role,
        created_by_name: row.created_by_name,
        paid_by_name: row.paid_by_name,
        holder_role: row.holder_role,
        holder_entity_id: row.holder_entity_id,
        holder_label: row.holder_label
      });
      const currentRole = String(row.holder_role || '').trim().toLowerCase();
      const currentEntityId = Number.isFinite(Number(row.holder_entity_id)) ? Number(row.holder_entity_id) : null;
      const currentLabel = String(row.holder_label || '').trim();
      if (currentRole !== holder.role || currentEntityId !== holder.entityId || currentLabel !== holder.label) {
        updateStmt.run(holder.role, holder.entityId, holder.label, row.id);
        updated += 1;
      }
    }
  });
  run();
  return { updated };
}

function getBookkeepingDashboard({ month = '', year = '' } = {}) {
  const periodPayments = getPeriodPaymentBreakdown({ month, year });
  const balances = getCashBalances({ month, year });
  const adminBalance = balances.find((item) => item.role === 'admin') || null;
  const settlementSummary = getSettlementSummary({ month, year });
  const settlements = listSettlements({ month, year, limit: 40 });
  return {
    rolePayments: periodPayments.roleRows,
    actorPayments: periodPayments.actorRows,
    paymentDetails: periodPayments.details,
    balances,
    adminBalance,
    settlementSummary,
    settlements
  };
}

function buildExportData({ month = '', year = '' } = {}) {
  const dashboard = getBookkeepingDashboard({ month, year });
  const entries = db.prepare(`
    SELECT
      entry_date, type, category, description, amount,
      source_type, created_by_name, holder_role, holder_label
    FROM bookkeeping_entries
    ${buildPeriodWhere('entry_date', month, year, [])}
    ORDER BY entry_date DESC, id DESC
  `).all(...(() => {
    const params = [];
    buildPeriodWhere('entry_date', month, year, params);
    return params;
  })());

  return {
    rolePayments: dashboard.rolePayments.map((row) => ({
      Peran: row.label,
      Total: row.amount,
      Transaksi: row.count,
      Petugas: row.actorCount
    })),
    actorPayments: dashboard.actorPayments.map((row) => ({
      Peran: roleLabel(row.role),
      Petugas: row.label,
      Total: row.amount,
      Transaksi: row.count,
      Terakhir: row.lastPaidAt || ''
    })),
    paymentDetails: dashboard.paymentDetails.map((row) => ({
      Invoice: row.invoiceId,
      Tanggal: row.paidAt,
      Pelanggan: row.customerName,
      Periode: `${row.periodMonth}/${row.periodYear}`,
      Peran: roleLabel(row.holderRole),
      Petugas: row.holderLabel,
      DiterimaOleh: row.paidByName,
      Gateway: row.gateway || '',
      Nominal: row.amount,
      Catatan: row.notes || ''
    })),
    settlements: dashboard.settlements.map((row) => ({
      Tanggal: row.settlementDate,
      DariPeran: roleLabel(row.fromRole),
      DariPetugas: row.fromLabel,
      KePeran: roleLabel(row.toRole),
      KePetugas: row.toLabel,
      Nominal: row.amount,
      Catatan: row.notes || '',
      DicatatOleh: row.createdByName || '',
      Dibuat: row.createdAt || ''
    })),
    balances: dashboard.balances.map((row) => ({
      Peran: row.roleLabel,
      Petugas: row.label,
      Aktif: row.isActive ? 'Ya' : 'Nonaktif',
      InvoiceMasuk: row.invoiceIncome,
      ManualMasuk: row.manualIncome,
      Pengeluaran: row.expense,
      SetorMasuk: row.settlementIn,
      SetorKeluar: row.settlementOut,
      Saldo: row.currentBalance,
      Status: row.statusLabel
    })),
    entries: entries.map((row) => ({
      Tanggal: row.entry_date || '',
      Jenis: String(row.type || '').toLowerCase() === 'income' ? 'Masuk' : 'Keluar',
      Kategori: row.category || '',
      Keterangan: row.description || '',
      PetugasInput: row.created_by_name || '',
      PemegangKas: row.holder_label || '',
      PeranKas: roleLabel(row.holder_role),
      Sumber: row.source_type || '',
      Nominal: Number(row.amount || 0)
    })),
    summaryRows: [
      { Metrik: 'Total Petugas Bersaldo', Nilai: dashboard.balances.filter((row) => row.role !== 'admin' && row.currentBalance > 0).length },
      { Metrik: 'Kas Admin Bersih', Nilai: Number(dashboard.adminBalance?.currentBalance || 0) },
      { Metrik: 'Total Setor Periode', Nilai: Number(dashboard.settlementSummary.totalAmount || 0) },
      { Metrik: 'Jumlah Setor Periode', Nilai: Number(dashboard.settlementSummary.totalCount || 0) }
    ]
  };
}

module.exports = {
  TRACKED_ROLES,
  STAFF_ROLES,
  roleLabel,
  normalizeHolderFromPaidByName,
  normalizeHolderFromContext,
  listManagedCashHolders,
  getCashBalances,
  getSettlementSummary,
  listSettlements,
  listCashHolderTransactions,
  createSettlement,
  backfillBookkeepingHolders,
  getBookkeepingDashboard,
  buildExportData
};
