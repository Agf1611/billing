/**
 * Service: Pelacakan Pemakaian Kuota (Usage Tracking)
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

function getUsage(customerId, month, year) {
  return db.prepare('SELECT * FROM customer_usage WHERE customer_id = ? AND period_month = ? AND period_year = ?')
    .get(customerId, month, year);
}

function getLatestUsageSnapshot(customerId) {
  return db.prepare(`
    SELECT *
    FROM customer_usage
    WHERE customer_id = ?
    ORDER BY period_year DESC, period_month DESC, id DESC
    LIMIT 1
  `).get(customerId);
}

function updateUsage(customerId, deltaIn, deltaOut, totalIn, totalOut) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const existing = getUsage(customerId, month, year);

  if (existing) {
    return db.prepare(`
      UPDATE customer_usage 
      SET bytes_in = bytes_in + ?, 
          bytes_out = bytes_out + ?, 
          last_total_bytes_in = ?, 
          last_total_bytes_out = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(deltaIn, deltaOut, totalIn, totalOut, existing.id);
  } else {
    return db.prepare(`
      INSERT INTO customer_usage (customer_id, period_month, period_year, bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(customerId, month, year, deltaIn, deltaOut, totalIn, totalOut);
  }
}

function resetUsageCounter(customerId) {
  const now = new Date();
  return db.prepare(`
    UPDATE customer_usage 
    SET last_total_bytes_in = 0, last_total_bytes_out = 0 
    WHERE customer_id = ? AND period_month = ? AND period_year = ?
  `).run(customerId, now.getMonth() + 1, now.getFullYear());
}

function syncUsageTotals(customerId, totalIn, totalOut, at = new Date()) {
  const normalizedIn = Math.max(0, Number(totalIn || 0));
  const normalizedOut = Math.max(0, Number(totalOut || 0));
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();

  const currentUsage = getUsage(customerId, month, year);
  const latestSnapshot = currentUsage || getLatestUsageSnapshot(customerId);

  let deltaIn = 0;
  let deltaOut = 0;

  if (latestSnapshot) {
    if (normalizedIn < Number(latestSnapshot.last_total_bytes_in || 0) || normalizedOut < Number(latestSnapshot.last_total_bytes_out || 0)) {
      deltaIn = normalizedIn;
      deltaOut = normalizedOut;
    } else {
      deltaIn = normalizedIn - Number(latestSnapshot.last_total_bytes_in || 0);
      deltaOut = normalizedOut - Number(latestSnapshot.last_total_bytes_out || 0);
    }
  } else {
    deltaIn = normalizedIn;
    deltaOut = normalizedOut;
  }

  if (deltaIn > 0 || deltaOut > 0 || !latestSnapshot) {
    updateUsage(customerId, deltaIn, deltaOut, normalizedIn, normalizedOut);
  }

  return {
    deltaIn,
    deltaOut,
    totalIn: normalizedIn,
    totalOut: normalizedOut
  };
}

module.exports = { getUsage, getLatestUsageSnapshot, updateUsage, resetUsageCounter, syncUsageTotals };
