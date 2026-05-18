/**
 * Service: Pelacakan Pemakaian Kuota (Usage Tracking)
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

function parseUptimeToSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  let total = 0;
  const regex = /(\d+)([wdhms])/gi;
  let match;
  while ((match = regex.exec(text))) {
    const amount = Number(match[1] || 0);
    const unit = String(match[2] || '').toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (unit === 'w') total += amount * 7 * 24 * 60 * 60;
    if (unit === 'd') total += amount * 24 * 60 * 60;
    if (unit === 'h') total += amount * 60 * 60;
    if (unit === 'm') total += amount * 60;
    if (unit === 's') total += amount;
  }
  return total;
}

function createAuditLog(customerId, eventType, payload = {}, at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  return db.prepare(`
    INSERT INTO usage_audit_logs (
      customer_id, period_month, period_year, event_type,
      stored_bytes_in, stored_bytes_out,
      observed_bytes_in, observed_bytes_out,
      delta_bytes_in, delta_bytes_out,
      note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customerId,
    month,
    year,
    eventType || 'sync',
    Math.max(0, Number(payload.storedBytesIn || 0)),
    Math.max(0, Number(payload.storedBytesOut || 0)),
    Math.max(0, Number(payload.observedBytesIn || 0)),
    Math.max(0, Number(payload.observedBytesOut || 0)),
    Math.max(0, Number(payload.deltaBytesIn || 0)),
    Math.max(0, Number(payload.deltaBytesOut || 0)),
    String(payload.note || '')
  );
}

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

function getRuntimeSnapshot(customerId) {
  return db.prepare(`
    SELECT *
    FROM customer_usage_runtime
    WHERE customer_id = ?
    LIMIT 1
  `).get(customerId);
}

function getCurrentPeriodUsage(customerId, at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  return getUsage(customerId, refDate.getMonth() + 1, refDate.getFullYear());
}

function saveRuntimeSnapshot(customerId, totalIn, totalOut, at = new Date(), meta = {}) {
  const refDate = at instanceof Date ? at : new Date(at);
  const sessionId = String(meta.sessionId || '').trim();
  const uptimeSeconds = Number.isFinite(meta.uptimeSeconds)
    ? Number(meta.uptimeSeconds)
    : parseUptimeToSeconds(meta.uptime);
  return db.prepare(`
    INSERT INTO customer_usage_runtime (
      customer_id, last_total_bytes_in, last_total_bytes_out, last_session_id, last_uptime_seconds, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(customer_id) DO UPDATE SET
      last_total_bytes_in = excluded.last_total_bytes_in,
      last_total_bytes_out = excluded.last_total_bytes_out,
      last_session_id = excluded.last_session_id,
      last_uptime_seconds = excluded.last_uptime_seconds,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(customerId, totalIn, totalOut, sessionId, uptimeSeconds);
}

function updateUsage(customerId, deltaIn, deltaOut, totalIn, totalOut, at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();

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

const syncUsageTotalsTx = db.transaction((customerId, totalIn, totalOut, at = new Date(), meta = {}) => {
  const normalizedIn = Math.max(0, Number(totalIn || 0));
  const normalizedOut = Math.max(0, Number(totalOut || 0));
  const refDate = at instanceof Date ? at : new Date(at);
  const runtimeSnapshot = getRuntimeSnapshot(customerId);
  const fallbackSnapshot = runtimeSnapshot || getLatestUsageSnapshot(customerId);
  const currentUsage = getCurrentPeriodUsage(customerId, refDate);
  const incomingSessionId = String(meta.sessionId || '').trim();
  const incomingUptimeSeconds = Number.isFinite(meta.uptimeSeconds)
    ? Number(meta.uptimeSeconds)
    : parseUptimeToSeconds(meta.uptime);
  const previousSessionId = String(runtimeSnapshot?.last_session_id || '').trim();
  const previousUptimeSeconds = Number(runtimeSnapshot?.last_uptime_seconds || 0) || 0;

  let deltaIn = 0;
  let deltaOut = 0;
  let anomalyGuardApplied = false;
  let healedByOverwrite = false;
  let effectiveSnapshotIn = normalizedIn;
  let effectiveSnapshotOut = normalizedOut;

  if (fallbackSnapshot) {
    if (normalizedIn < Number(fallbackSnapshot.last_total_bytes_in || 0) || normalizedOut < Number(fallbackSnapshot.last_total_bytes_out || 0)) {
      const sessionChanged = Boolean(incomingSessionId && previousSessionId && incomingSessionId !== previousSessionId);
      const uptimeReset = Boolean(incomingUptimeSeconds > 0 && previousUptimeSeconds > 0 && (incomingUptimeSeconds + 120) < previousUptimeSeconds);
      const looksLikeRealReset = sessionChanged || uptimeReset || !runtimeSnapshot;

      if (looksLikeRealReset) {
        deltaIn = normalizedIn;
        deltaOut = normalizedOut;
      } else {
        deltaIn = 0;
        deltaOut = 0;
        effectiveSnapshotIn = Number(fallbackSnapshot.last_total_bytes_in || 0);
        effectiveSnapshotOut = Number(fallbackSnapshot.last_total_bytes_out || 0);
        createAuditLog(customerId, 'counter_drop_ignored', {
          storedBytesIn: Number(currentUsage?.bytes_in || 0),
          storedBytesOut: Number(currentUsage?.bytes_out || 0),
          observedBytesIn: normalizedIn,
          observedBytesOut: normalizedOut,
          deltaBytesIn: 0,
          deltaBytesOut: 0,
          note: `Ignored lower counters without session reset. source=${String(meta.source || '')}`
        }, refDate);
      }
    } else {
      deltaIn = normalizedIn - Number(fallbackSnapshot.last_total_bytes_in || 0);
      deltaOut = normalizedOut - Number(fallbackSnapshot.last_total_bytes_out || 0);
    }
  } else {
    deltaIn = normalizedIn;
    deltaOut = normalizedOut;
  }

  if (currentUsage && runtimeSnapshot) {
    const currentStoredTotal = Number(currentUsage.bytes_in || 0) + Number(currentUsage.bytes_out || 0);
    const currentObservedTotal = normalizedIn + normalizedOut;
    const previousObservedTotal = Number(runtimeSnapshot.last_total_bytes_in || 0) + Number(runtimeSnapshot.last_total_bytes_out || 0);
    const deltaTotal = deltaIn + deltaOut;

    const suspiciousInflation =
      currentStoredTotal > (currentObservedTotal * 6) &&
      currentStoredTotal > 50 * 1024 * 1024 * 1024 &&
      currentObservedTotal > 0 &&
      previousObservedTotal > 0 &&
      currentObservedTotal <= (previousObservedTotal * 1.5) &&
      deltaTotal <= (1024 * 1024 * 1024);

    if (suspiciousInflation) {
      anomalyGuardApplied = true;
      logger.warn(`[usage] Anomali usage terdeteksi untuk customer ${customerId}. Menormalkan ulang total bulanan ke snapshot runtime terbaru. stored=${currentStoredTotal} observed=${currentObservedTotal} prev=${previousObservedTotal}`);
      createAuditLog(customerId, 'auto_heal', {
        storedBytesIn: Number(currentUsage.bytes_in || 0),
        storedBytesOut: Number(currentUsage.bytes_out || 0),
        observedBytesIn: normalizedIn,
        observedBytesOut: normalizedOut,
        deltaBytesIn: deltaIn,
        deltaBytesOut: deltaOut,
        note: `Auto-heal usage anomaly. previousObserved=${previousObservedTotal}`
      }, refDate);
      overwriteUsageForCurrentPeriod(customerId, normalizedIn, normalizedOut, refDate);
      return {
        deltaIn: 0,
        deltaOut: 0,
        totalIn: normalizedIn,
        totalOut: normalizedOut,
        anomalyGuardApplied,
        healedByOverwrite: true
      };
    }
  }

  if (deltaIn > 0 || deltaOut > 0 || !fallbackSnapshot) {
    updateUsage(customerId, deltaIn, deltaOut, normalizedIn, normalizedOut, refDate);

    const deltaTotal = deltaIn + deltaOut;
    if (deltaTotal >= (5 * 1024 * 1024 * 1024)) {
      createAuditLog(customerId, 'large_delta', {
        storedBytesIn: Number(currentUsage?.bytes_in || 0),
        storedBytesOut: Number(currentUsage?.bytes_out || 0),
        observedBytesIn: normalizedIn,
        observedBytesOut: normalizedOut,
        deltaBytesIn: deltaIn,
        deltaBytesOut: deltaOut,
        note: 'Large usage delta detected during sync'
      }, refDate);
    }
  }
  saveRuntimeSnapshot(customerId, effectiveSnapshotIn, effectiveSnapshotOut, refDate, {
    ...meta,
    uptimeSeconds: incomingUptimeSeconds
  });

  return {
    deltaIn,
    deltaOut,
    totalIn: effectiveSnapshotIn,
    totalOut: effectiveSnapshotOut,
    anomalyGuardApplied,
    healedByOverwrite
  };
});

function syncUsageTotals(customerId, totalIn, totalOut, at = new Date(), meta = {}) {
  return syncUsageTotalsTx(customerId, totalIn, totalOut, at, meta);
}

function overwriteUsageForCurrentPeriod(customerId, totalIn, totalOut, at = new Date()) {
  const normalizedIn = Math.max(0, Number(totalIn || 0));
  const normalizedOut = Math.max(0, Number(totalOut || 0));
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const existing = getUsage(customerId, month, year);
  const beforeIn = Number(existing?.bytes_in || 0);
  const beforeOut = Number(existing?.bytes_out || 0);

  if (existing) {
    db.prepare(`
      UPDATE customer_usage
      SET bytes_in = ?,
          bytes_out = ?,
          last_total_bytes_in = ?,
          last_total_bytes_out = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedIn, normalizedOut, normalizedIn, normalizedOut, existing.id);
  } else {
    db.prepare(`
      INSERT INTO customer_usage (customer_id, period_month, period_year, bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(customerId, month, year, normalizedIn, normalizedOut, normalizedIn, normalizedOut);
  }

  createAuditLog(customerId, 'overwrite', {
    storedBytesIn: beforeIn,
    storedBytesOut: beforeOut,
    observedBytesIn: normalizedIn,
    observedBytesOut: normalizedOut,
    deltaBytesIn: 0,
    deltaBytesOut: 0,
    note: 'Usage overwritten for current period'
  }, refDate);
  saveRuntimeSnapshot(customerId, normalizedIn, normalizedOut, refDate);
  return { totalIn: normalizedIn, totalOut: normalizedOut };
}

function resetUsageForCurrentPeriod(customerId, baselineIn = 0, baselineOut = 0, at = new Date(), meta = {}) {
  const normalizedBaselineIn = Math.max(0, Number(baselineIn || 0));
  const normalizedBaselineOut = Math.max(0, Number(baselineOut || 0));
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const existing = getUsage(customerId, month, year);
  const beforeIn = Number(existing?.bytes_in || 0);
  const beforeOut = Number(existing?.bytes_out || 0);

  if (existing) {
    db.prepare(`
      UPDATE customer_usage
      SET bytes_in = 0,
          bytes_out = 0,
          last_total_bytes_in = ?,
          last_total_bytes_out = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedBaselineIn, normalizedBaselineOut, existing.id);
  } else {
    db.prepare(`
      INSERT INTO customer_usage (
        customer_id, period_month, period_year,
        bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out
      ) VALUES (?, ?, ?, 0, 0, ?, ?)
    `).run(customerId, month, year, normalizedBaselineIn, normalizedBaselineOut);
  }

  createAuditLog(customerId, 'admin_reset', {
    storedBytesIn: beforeIn,
    storedBytesOut: beforeOut,
    observedBytesIn: normalizedBaselineIn,
    observedBytesOut: normalizedBaselineOut,
    deltaBytesIn: 0,
    deltaBytesOut: 0,
    note: String(meta.note || 'Usage reset by admin')
  }, refDate);

  saveRuntimeSnapshot(customerId, normalizedBaselineIn, normalizedBaselineOut, refDate, meta);
  return {
    totalIn: 0,
    totalOut: 0,
    baselineIn: normalizedBaselineIn,
    baselineOut: normalizedBaselineOut
  };
}

module.exports = { getUsage, getLatestUsageSnapshot, getRuntimeSnapshot, updateUsage, resetUsageCounter, syncUsageTotals, overwriteUsageForCurrentPeriod, resetUsageForCurrentPeriod, createAuditLog };
