const db = require('../config/database');
const { hashPassword, validateNewPassword, verifyPassword } = require('../config/passwords');
const OPERATIONAL_PASSWORD_MIN_LENGTH = 4;
const MANAGED_ACCOUNT_ROLES = {
  technician: 'technicians',
  cashier: 'cashiers',
  collector: 'collectors'
};

function sanitizeUserRow(row) {
  if (!row) return null;
  const clean = { ...row };
  delete clean.password;
  delete clean.password_hash;
  return clean;
}

function listUsers(tableName, extraFields = '') {
  return db.prepare(`SELECT id, username, name, phone${extraFields}, is_active, created_at FROM ${tableName} ORDER BY created_at DESC`).all();
}

function getUserById(tableName, id) {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id);
}

function resolveNextPasswordHash(data, existing, label) {
  const rawInput = data.password;
  if (existing && (rawInput === undefined || rawInput === null || String(rawInput) === '')) {
    const existingHash = String(existing.password_hash || '').trim();
    if (existingHash) return existingHash;
    if (existing.password) return hashPassword(existing.password);
    throw new Error(`${label} wajib diisi.`);
  }

  const nextPassword = validateNewPassword(rawInput, label, OPERATIONAL_PASSWORD_MIN_LENGTH);
  return hashPassword(nextPassword);
}

function authenticateFromTable(tableName, username, password) {
  const user = db.prepare(`SELECT * FROM ${tableName} WHERE username = ? AND is_active = 1`).get(String(username || '').trim());
  if (!user) return null;

  const storedHash = String(user.password_hash || '').trim();
  const legacyPassword = String(user.password || '');
  const storedCredential = storedHash || legacyPassword;
  if (!verifyPassword(password, storedCredential)) return null;

  if (!storedHash && legacyPassword) {
    const upgradedHash = hashPassword(password);
    db.prepare(`UPDATE ${tableName} SET password_hash = ?, password = '' WHERE id = ?`).run(upgradedHash, user.id);
    user.password_hash = upgradedHash;
    user.password = '';
  }

  return sanitizeUserRow(user);
}

/**
 * TECHNICIANS
 */
function getAllTechnicians() {
  return listUsers('technicians', ', area');
}

function createTechnician(data) {
  const passwordHash = resolveNextPasswordHash(data, null, 'Password teknisi');
  const stmt = db.prepare('INSERT INTO technicians (username, password, password_hash, name, phone, area) VALUES (?, ?, ?, ?, ?, ?)');
  return stmt.run(
    String(data.username || '').trim(),
    '',
    passwordHash,
    String(data.name || '').trim(),
    data.phone || '',
    data.area || ''
  );
}

function updateTechnician(id, data) {
  const existing = getUserById('technicians', id);
  if (!existing) throw new Error('Teknisi tidak ditemukan');
  const passwordHash = resolveNextPasswordHash(data, existing, 'Password teknisi');
  const stmt = db.prepare('UPDATE technicians SET username = ?, password = ?, password_hash = ?, name = ?, phone = ?, area = ?, is_active = ? WHERE id = ?');
  return stmt.run(
    String(data.username || '').trim(),
    '',
    passwordHash,
    String(data.name || '').trim(),
    data.phone || '',
    data.area || '',
    data.is_active ? 1 : 0,
    id
  );
}

function deleteTechnician(id) {
  return db.prepare('DELETE FROM technicians WHERE id = ?').run(id);
}

/**
 * CASHIERS
 */
function getAllCashiers() {
  return listUsers('cashiers');
}

function createCashier(data) {
  const passwordHash = resolveNextPasswordHash(data, null, 'Password kasir');
  const stmt = db.prepare('INSERT INTO cashiers (username, password, password_hash, name, phone) VALUES (?, ?, ?, ?, ?)');
  return stmt.run(
    String(data.username || '').trim(),
    '',
    passwordHash,
    String(data.name || '').trim(),
    data.phone || ''
  );
}

function updateCashier(id, data) {
  const existing = getUserById('cashiers', id);
  if (!existing) throw new Error('Kasir tidak ditemukan');
  const passwordHash = resolveNextPasswordHash(data, existing, 'Password kasir');
  const stmt = db.prepare('UPDATE cashiers SET username = ?, password = ?, password_hash = ?, name = ?, phone = ?, is_active = ? WHERE id = ?');
  return stmt.run(
    String(data.username || '').trim(),
    '',
    passwordHash,
    String(data.name || '').trim(),
    data.phone || '',
    data.is_active ? 1 : 0,
    id
  );
}

function deleteCashier(id) {
  return db.prepare('DELETE FROM cashiers WHERE id = ?').run(id);
}

function authenticateCashier(username, password) {
  return authenticateFromTable('cashiers', username, password);
}

function getAllCollectors() {
  return listUsers('collectors');
}

function createCollector(data) {
  const passwordHash = resolveNextPasswordHash(data, null, 'Password kolektor');
  return db
    .prepare(
      'INSERT INTO collectors (username, password, password_hash, name, phone, is_active) VALUES (?, ?, ?, ?, ?, 1)'
    )
    .run(
      String(data.username || '').trim(),
      '',
      passwordHash,
      String(data.name || '').trim(),
      String(data.phone || '').trim()
    );
}

function updateCollector(id, data) {
  const existing = getUserById('collectors', id);
  if (!existing) throw new Error('Kolektor tidak ditemukan');
  const passwordHash = resolveNextPasswordHash(data, existing, 'Password kolektor');
  const stmt = db.prepare('UPDATE collectors SET username = ?, password = ?, password_hash = ?, name = ?, phone = ?, is_active = ? WHERE id = ?');
  return stmt.run(
    String(data.username || '').trim(),
    '',
    passwordHash,
    String(data.name || '').trim(),
    data.phone || '',
    data.is_active ? 1 : 0,
    id
  );
}

function deleteCollector(id) {
  return db.prepare('DELETE FROM collectors WHERE id = ?').run(id);
}

function authenticateCollector(username, password) {
  return authenticateFromTable('collectors', username, password);
}

function resolveManagedAccountTable(role) {
  const key = String(role || '').trim().toLowerCase();
  const table = MANAGED_ACCOUNT_ROLES[key];
  if (!table) throw new Error('Role akun tidak valid');
  return { key, table };
}

function mapManagedAccountRow(role, row) {
  if (!row) return null;
  return {
    ...sanitizeUserRow(row),
    role,
    role_label: role === 'technician' ? 'Teknisi' : role === 'cashier' ? 'Kasir' : 'Kolektor',
    area: row.area || ''
  };
}

function listManagedAccounts(role = 'all') {
  const rows = [];
  if (role === 'all' || role === 'technician') {
    rows.push(...getAllTechnicians().map((row) => mapManagedAccountRow('technician', row)));
  }
  if (role === 'all' || role === 'cashier') {
    rows.push(...getAllCashiers().map((row) => mapManagedAccountRow('cashier', row)));
  }
  if (role === 'all' || role === 'collector') {
    rows.push(...getAllCollectors().map((row) => mapManagedAccountRow('collector', row)));
  }
  return rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function createManagedAccount(role, data) {
  const { key } = resolveManagedAccountTable(role);
  if (key === 'technician') return createTechnician(data);
  if (key === 'cashier') return createCashier(data);
  return createCollector(data);
}

function updateManagedAccount(currentRole, id, data) {
  const current = resolveManagedAccountTable(currentRole);
  const next = resolveManagedAccountTable(data.role || currentRole);
  if (current.key === next.key) {
    if (current.key === 'technician') return updateTechnician(id, data);
    if (current.key === 'cashier') return updateCashier(id, data);
    return updateCollector(id, data);
  }

  const existing = getUserById(current.table, id);
  if (!existing) throw new Error('Akun tidak ditemukan');

  const passwordHash = resolveNextPasswordHash(data, existing, `Password ${next.key === 'technician' ? 'teknisi' : next.key === 'cashier' ? 'kasir' : 'kolektor'}`);
  const payload = {
    username: String(data.username || '').trim(),
    password: '',
    password_hash: passwordHash,
    name: String(data.name || '').trim(),
    phone: String(data.phone || '').trim(),
    area: next.key === 'technician' ? String(data.area || '').trim() : '',
    is_active: data.is_active ? 1 : 0
  };

  const run = db.transaction(() => {
    if (next.key === 'technician') {
      db.prepare('INSERT INTO technicians (username, password, password_hash, name, phone, area, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        payload.username, '', payload.password_hash, payload.name, payload.phone, payload.area, payload.is_active
      );
    } else if (next.key === 'cashier') {
      db.prepare('INSERT INTO cashiers (username, password, password_hash, name, phone, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(
        payload.username, '', payload.password_hash, payload.name, payload.phone, payload.is_active
      );
    } else {
      db.prepare('INSERT INTO collectors (username, password, password_hash, name, phone, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(
        payload.username, '', payload.password_hash, payload.name, payload.phone, payload.is_active
      );
    }
    db.prepare(`DELETE FROM ${current.table} WHERE id = ?`).run(id);
  });

  return run();
}

function deleteManagedAccount(role, id) {
  const { key } = resolveManagedAccountTable(role);
  if (key === 'technician') return deleteTechnician(id);
  if (key === 'cashier') return deleteCashier(id);
  return deleteCollector(id);
}

module.exports = {
  getAllTechnicians,
  createTechnician,
  updateTechnician,
  deleteTechnician,
  getAllCashiers,
  createCashier,
  updateCashier,
  deleteCashier,
  authenticateCashier,
  getAllCollectors,
  createCollector,
  updateCollector,
  deleteCollector,
  authenticateCollector,
  listManagedAccounts,
  createManagedAccount,
  updateManagedAccount,
  deleteManagedAccount
};
