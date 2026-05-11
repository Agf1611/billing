const db = require('../config/database');
const { hashPassword, validateNewPassword, verifyPassword } = require('../config/passwords');
const OPERATIONAL_PASSWORD_MIN_LENGTH = 4;

function authenticate(username, password) {
  const tech = db.prepare('SELECT * FROM technicians WHERE username = ? AND is_active = 1').get(String(username || '').trim());
  if (!tech) return null;

  const storedHash = String(tech.password_hash || '').trim();
  const legacyPassword = String(tech.password || '');
  const storedCredential = storedHash || legacyPassword;
  if (!verifyPassword(password, storedCredential)) return null;

  if (!storedHash && legacyPassword) {
    const upgradedHash = hashPassword(password);
    db.prepare("UPDATE technicians SET password_hash = ?, password = '' WHERE id = ?").run(upgradedHash, tech.id);
    tech.password_hash = upgradedHash;
    tech.password = '';
  }

  delete tech.password;
  delete tech.password_hash;
  return tech;
}

function getTechById(id) {
  return db.prepare('SELECT id, username, name, phone, area FROM technicians WHERE id = ?').get(id);
}

function getOperationalTaskStats(techId) {
  const assigned = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE technician_id = ? AND status = 'assigned'").get(techId).count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE technician_id = ? AND status = 'in_progress'").get(techId).count;
  const done = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE technician_id = ? AND status = 'done'").get(techId).count;
  const today = new Date().toISOString().slice(0, 10);
  const dueToday = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE technician_id = ? AND status IN ('assigned','in_progress') AND due_date = ?").get(techId, today).count;
  return { assigned, inProgress, done, dueToday };
}

function getTechStats(techId) {
  const total = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ?").get(techId).count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'in_progress'").get(techId).count;
  const resolved = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'resolved'").get(techId).count;
  
  // Ambil open tickets yang belum ada teknisinya atau di-assign ke teknisi ini
  const open = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'open'").get().count;
  const taskStats = getOperationalTaskStats(techId);

  return {
    total,
    open,
    inProgress,
    resolved,
    taskAssigned: Number(taskStats.assigned || 0),
    taskInProgress: Number(taskStats.inProgress || 0),
    taskDone: Number(taskStats.done || 0),
    taskDueToday: Number(taskStats.dueToday || 0)
  };
}

function getAssignedTickets(techId) {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address 
    FROM tickets t 
    JOIN customers c ON t.customer_id = c.id 
    WHERE t.technician_id = ? AND t.status != 'resolved'
    ORDER BY t.created_at DESC
  `).all(techId);
}

function getOpenTickets() {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address 
    FROM tickets t 
    JOIN customers c ON t.customer_id = c.id 
    WHERE t.status = 'open'
    ORDER BY t.created_at DESC
  `).all();
}

function getResolvedTickets(techId) {
  return db.prepare(`
    SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address 
    FROM tickets t 
    JOIN customers c ON t.customer_id = c.id 
    WHERE t.technician_id = ? AND t.status = 'resolved'
    ORDER BY t.updated_at DESC LIMIT 50
  `).all(techId);
}

function takeTicket(ticketId, techId) {
  db.prepare("UPDATE tickets SET technician_id = ?, status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(techId, ticketId);
}

function updateTicketStatus(ticketId, techId, status) {
  db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND technician_id = ?').run(status, ticketId, techId);
}

function listAdminTechnicianTasks(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status && filters.status !== 'all') {
    where.push('tt.status = ?');
    params.push(String(filters.status));
  }
  if (filters.taskType && filters.taskType !== 'all') {
    where.push('tt.task_type = ?');
    params.push(String(filters.taskType));
  }
  if (filters.technicianId && Number(filters.technicianId) > 0) {
    where.push('tt.technician_id = ?');
    params.push(Number(filters.technicianId));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT tt.*,
           tech.name AS technician_name,
           tech.phone AS technician_phone,
           c.name AS linked_customer_name,
           c.phone AS linked_customer_phone
    FROM technician_tasks tt
    LEFT JOIN technicians tech ON tech.id = tt.technician_id
    LEFT JOIN customers c ON c.id = tt.customer_id
    ${clause}
    ORDER BY
      CASE tt.status
        WHEN 'in_progress' THEN 0
        WHEN 'assigned' THEN 1
        WHEN 'done' THEN 2
        ELSE 3
      END,
      COALESCE(tt.due_date, tt.scheduled_date, date(tt.created_at)) ASC,
      tt.created_at DESC
  `).all(...params);
}

function getAdminTechnicianTaskStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM technician_tasks').get().count;
  const assigned = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE status = 'assigned'").get().count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE status = 'in_progress'").get().count;
  const done = db.prepare("SELECT COUNT(*) as count FROM technician_tasks WHERE status = 'done'").get().count;
  return { total, assigned, inProgress, done };
}

function createTechnicianTask(data = {}) {
  const title = String(data.title || '').trim();
  const technicianId = Number(data.technician_id || 0);
  if (!title) throw new Error('Judul tugas wajib diisi');
  if (!technicianId) throw new Error('Teknisi wajib dipilih');

  const customerId = Number(data.customer_id || 0) || null;
  const customerName = String(data.customer_name || '').trim();
  const customerPhone = String(data.customer_phone || '').trim();
  const customerAddress = String(data.customer_address || '').trim();

  return db.prepare(`
    INSERT INTO technician_tasks (
      title, task_type, description, customer_id, customer_name, customer_phone, customer_address,
      location_note, technician_id, priority, status, scheduled_date, due_date,
      create_pppoe_secret, pppoe_username, pppoe_password, normal_pppoe_profile,
      created_by_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    String(data.task_type || 'repair').trim() || 'repair',
    String(data.description || '').trim(),
    customerId,
    customerName,
    customerPhone,
    customerAddress,
    String(data.location_note || '').trim(),
    technicianId,
    String(data.priority || 'medium').trim() || 'medium',
    String(data.status || 'assigned').trim() || 'assigned',
    data.scheduled_date || null,
    data.due_date || null,
    Number(data.create_pppoe_secret || 0) || 0,
    String(data.pppoe_username || '').trim(),
    String(data.pppoe_password || '').trim(),
    String(data.normal_pppoe_profile || '').trim(),
    String(data.created_by_name || '').trim()
  );
}

function updateTechnicianTask(taskId, data = {}) {
  const id = Number(taskId || 0);
  if (!id) throw new Error('ID tugas tidak valid');
  const prev = db.prepare('SELECT * FROM technician_tasks WHERE id = ?').get(id);
  if (!prev) throw new Error('Tugas teknisi tidak ditemukan');

  const nextStatus = String(data.status || prev.status || 'assigned').trim() || 'assigned';
  const nextTechId = Number(data.technician_id || prev.technician_id || 0) || null;
  const completionNote = String(data.completion_note != null ? data.completion_note : prev.completion_note || '').trim();
  const startedAt = nextStatus === 'in_progress'
    ? (prev.started_at || new Date().toISOString())
    : (nextStatus === 'done' ? (prev.started_at || new Date().toISOString()) : null);
  const completedAt = nextStatus === 'done' ? new Date().toISOString() : null;

  return db.prepare(`
    UPDATE technician_tasks
    SET title = ?,
        task_type = ?,
        description = ?,
        customer_id = ?,
        customer_name = ?,
        customer_phone = ?,
        customer_address = ?,
        location_note = ?,
        technician_id = ?,
        priority = ?,
        status = ?,
        scheduled_date = ?,
        due_date = ?,
        create_pppoe_secret = ?,
        pppoe_username = ?,
        pppoe_password = ?,
        normal_pppoe_profile = ?,
        completion_note = ?,
        started_at = ?,
        completed_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    String(data.title || prev.title || '').trim(),
    String(data.task_type || prev.task_type || 'repair').trim() || 'repair',
    String(data.description != null ? data.description : prev.description || '').trim(),
    Number(data.customer_id || prev.customer_id || 0) || null,
    String(data.customer_name != null ? data.customer_name : prev.customer_name || '').trim(),
    String(data.customer_phone != null ? data.customer_phone : prev.customer_phone || '').trim(),
    String(data.customer_address != null ? data.customer_address : prev.customer_address || '').trim(),
    String(data.location_note != null ? data.location_note : prev.location_note || '').trim(),
    nextTechId,
    String(data.priority || prev.priority || 'medium').trim() || 'medium',
    nextStatus,
    data.scheduled_date || prev.scheduled_date || null,
    data.due_date || prev.due_date || null,
    Number(data.create_pppoe_secret || prev.create_pppoe_secret || 0) || 0,
    String(data.pppoe_username != null ? data.pppoe_username : prev.pppoe_username || '').trim(),
    String(data.pppoe_password != null ? data.pppoe_password : prev.pppoe_password || '').trim(),
    String(data.normal_pppoe_profile != null ? data.normal_pppoe_profile : prev.normal_pppoe_profile || '').trim(),
    completionNote,
    startedAt,
    completedAt,
    id
  );
}

function getTechnicianTasks(techId, filters = {}) {
  const where = ['tt.technician_id = ?'];
  const params = [Number(techId || 0)];
  if (filters.status && filters.status !== 'all') {
    where.push('tt.status = ?');
    params.push(String(filters.status));
  }
  return db.prepare(`
    SELECT tt.*,
           c.name AS linked_customer_name,
           c.phone AS linked_customer_phone
    FROM technician_tasks tt
    LEFT JOIN customers c ON c.id = tt.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE tt.status
        WHEN 'in_progress' THEN 0
        WHEN 'assigned' THEN 1
        WHEN 'done' THEN 2
        ELSE 3
      END,
      COALESCE(tt.due_date, tt.scheduled_date, date(tt.created_at)) ASC,
      tt.created_at DESC
  `).all(...params);
}

function getTechnicianTaskById(taskId, techId = null) {
  const id = Number(taskId || 0);
  if (!id) return null;
  if (techId != null) {
    return db.prepare('SELECT * FROM technician_tasks WHERE id = ? AND technician_id = ?').get(id, Number(techId || 0));
  }
  return db.prepare('SELECT * FROM technician_tasks WHERE id = ?').get(id);
}

function startTechnicianTask(taskId, techId) {
  const task = getTechnicianTaskById(taskId, techId);
  if (!task) throw new Error('Tugas teknisi tidak ditemukan');
  if (String(task.status) === 'done') throw new Error('Tugas ini sudah selesai');
  return db.prepare(`
    UPDATE technician_tasks
    SET status = 'in_progress',
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND technician_id = ?
  `).run(Number(taskId), Number(techId));
}

function completeTechnicianTask(taskId, techId, completionNote = '') {
  const task = getTechnicianTaskById(taskId, techId);
  if (!task) throw new Error('Tugas teknisi tidak ditemukan');
  return db.prepare(`
    UPDATE technician_tasks
    SET status = 'done',
        completion_note = ?,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND technician_id = ?
  `).run(String(completionNote || '').trim(), Number(taskId), Number(techId));
}

// Admin helper
function getAllTechnicians() {
  return db.prepare('SELECT id, username, name, phone, area, is_active FROM technicians').all();
}

function createTechnician(data) {
  const stmt = db.prepare('INSERT INTO technicians (username, password, password_hash, name, phone, area) VALUES (?, ?, ?, ?, ?, ?)');
  const passwordHash = hashPassword(validateNewPassword(data.password, 'Password teknisi', OPERATIONAL_PASSWORD_MIN_LENGTH));
  return stmt.run(data.username, '', passwordHash, data.name, data.phone || '', data.area || '');
}

module.exports = {
  authenticate,
  getTechById,
  getTechStats,
  getOperationalTaskStats,
  getAssignedTickets,
  getOpenTickets,
  getResolvedTickets,
  takeTicket,
  updateTicketStatus,
  listAdminTechnicianTasks,
  getAdminTechnicianTaskStats,
  createTechnicianTask,
  updateTechnicianTask,
  getTechnicianTasks,
  getTechnicianTaskById,
  startTechnicianTask,
  completeTechnicianTask,
  getAllTechnicians,
  createTechnician
};
