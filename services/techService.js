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

function getTechStats(techId) {
  const total = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ?").get(techId).count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'in_progress'").get(techId).count;
  const resolved = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE technician_id = ? AND status = 'resolved'").get(techId).count;
  
  // Ambil open tickets yang belum ada teknisinya atau di-assign ke teknisi ini
  const open = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'open'").get().count;

  return { total, open, inProgress, resolved };
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
  getAssignedTickets,
  getOpenTickets,
  getResolvedTickets,
  takeTicket,
  updateTicketStatus,
  getAllTechnicians,
  createTechnician
};
