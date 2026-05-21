const db = require('../config/database');

const ROLE_META = {
  technician: { label: 'Teknisi', color: '#2563eb', icon: 'bi-person-workspace' },
  agent: { label: 'Agent', color: '#10b981', icon: 'bi-person-badge' },
  collector: { label: 'Kolektor', color: '#f59e0b', icon: 'bi-person-walking' },
  cashier: { label: 'Kasir', color: '#8b5cf6', icon: 'bi-person-vcard' }
};

function normalizeRole(role) {
  const key = String(role || '').trim().toLowerCase();
  if (!ROLE_META[key]) throw new Error('Role lokasi karyawan tidak valid');
  return key;
}

function normalizeCoordinate(value, kind) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`Koordinat ${kind} tidak valid`);
  if (kind === 'lat' && (num < -90 || num > 90)) throw new Error('Latitude tidak valid');
  if (kind === 'lng' && (num < -180 || num > 180)) throw new Error('Longitude tidak valid');
  return num;
}

function normalizeAccuracy(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function upsertEmployeeLocation(payload = {}) {
  const role = normalizeRole(payload.role);
  const employeeId = Number(payload.employeeId || 0);
  if (!employeeId) throw new Error('ID karyawan tidak valid');

  const lat = normalizeCoordinate(payload.lat, 'lat');
  const lng = normalizeCoordinate(payload.lng, 'lng');
  const accuracy = normalizeAccuracy(payload.accuracy);
  const username = String(payload.username || '').trim();
  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  const source = String(payload.source || 'device').trim() || 'device';
  const userAgent = String(payload.userAgent || '').trim();
  const note = String(payload.note || '').trim();

  if (!name) throw new Error('Nama karyawan tidak valid');

  db.prepare(`
    INSERT INTO employee_live_locations (
      role, employee_id, username, name, phone, lat, lng, accuracy,
      source, sharing_enabled, user_agent, note, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(role, employee_id) DO UPDATE SET
      username = excluded.username,
      name = excluded.name,
      phone = excluded.phone,
      lat = excluded.lat,
      lng = excluded.lng,
      accuracy = excluded.accuracy,
      source = excluded.source,
      sharing_enabled = 1,
      user_agent = excluded.user_agent,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    role,
    employeeId,
    username,
    name,
    phone,
    lat,
    lng,
    accuracy,
    source,
    userAgent,
    note
  );

  return getEmployeeLocation(role, employeeId);
}

function clearEmployeeLocation(role, employeeId, note = 'inactive') {
  const safeRole = normalizeRole(role);
  const safeEmployeeId = Number(employeeId || 0);
  if (!safeEmployeeId) return null;

  db.prepare(`
    UPDATE employee_live_locations
    SET
      sharing_enabled = 0,
      lat = NULL,
      lng = NULL,
      accuracy = 0,
      note = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE role = ? AND employee_id = ?
  `).run(String(note || '').trim() || 'inactive', safeRole, safeEmployeeId);

  return getEmployeeLocation(safeRole, safeEmployeeId);
}

function getEmployeeLocation(role, employeeId) {
  const safeRole = normalizeRole(role);
  const safeEmployeeId = Number(employeeId || 0);
  const row = db.prepare(`
    SELECT *
    FROM employee_live_locations
    WHERE role = ? AND employee_id = ?
    LIMIT 1
  `).get(safeRole, safeEmployeeId);
  return mapLocationRow(row);
}

function getLiveEmployeeLocations({ maxAgeMinutes = 180 } = {}) {
  const ageMinutes = Math.max(1, Number(maxAgeMinutes || 180) || 180);
  const rows = db.prepare(`
    SELECT
      role,
      employee_id,
      username,
      name,
      phone,
      lat,
      lng,
      accuracy,
      source,
      sharing_enabled,
      user_agent,
      note,
      created_at,
      updated_at,
      CAST((julianday('now') - julianday(updated_at)) * 86400 AS INTEGER) AS last_seen_seconds
    FROM employee_live_locations
    WHERE sharing_enabled = 1
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND updated_at >= datetime('now', ?)
    ORDER BY role ASC, name COLLATE NOCASE ASC
  `).all(`-${ageMinutes} minutes`);

  return (Array.isArray(rows) ? rows : []).map(mapLocationRow);
}

function mapLocationRow(row) {
  if (!row) return null;
  const role = String(row.role || '').trim().toLowerCase();
  const meta = ROLE_META[role] || ROLE_META.technician;
  return {
    role,
    employee_id: Number(row.employee_id || 0) || 0,
    username: String(row.username || '').trim(),
    name: String(row.name || '').trim(),
    phone: String(row.phone || '').trim(),
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    accuracy: normalizeAccuracy(row.accuracy),
    source: String(row.source || '').trim() || 'device',
    sharing_enabled: Number(row.sharing_enabled || 0) === 1,
    user_agent: String(row.user_agent || '').trim(),
    note: String(row.note || '').trim(),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_seen_seconds: Math.max(0, Number(row.last_seen_seconds || 0) || 0),
    role_label: meta.label,
    marker_color: meta.color,
    marker_icon: meta.icon
  };
}

module.exports = {
  ROLE_META,
  upsertEmployeeLocation,
  clearEmployeeLocation,
  getEmployeeLocation,
  getLiveEmployeeLocations
};
