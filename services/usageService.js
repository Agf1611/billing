/**
 * Service: Pelacakan Pemakaian Kuota (Usage Tracking)
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const SEMI_LIVE_SYNC_THROTTLE_MS = 20 * 1000;
const SESSION_RESET_TOLERANCE_SECONDS = 120;
const SESSION_RESET_FRESH_UPTIME_SECONDS = 15 * 60;
const USAGE_REPLAY_MIN_BYTES = 1024 * 1024 * 1024;
const USAGE_REPLAY_TOLERANCE_BYTES = 64 * 1024 * 1024;

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

function parseDateMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasMeaningfulUptime(value) {
  return Number.isFinite(value) && Number(value) > 0;
}

function didUptimeReset(currentSeconds, previousSeconds) {
  return hasMeaningfulUptime(currentSeconds)
    && hasMeaningfulUptime(previousSeconds)
    && (Number(currentSeconds) + SESSION_RESET_TOLERANCE_SECONDS) < Number(previousSeconds);
}

function getSessionResetState({
  runtimeSnapshot,
  incomingSessionId,
  incomingUptimeSeconds
} = {}) {
  const previousSessionId = String(runtimeSnapshot?.last_session_id || '').trim();
  const previousUptimeSeconds = Number(runtimeSnapshot?.last_uptime_seconds || 0) || 0;
  const sessionChanged = Boolean(incomingSessionId && previousSessionId && incomingSessionId !== previousSessionId);
  const uptimeReset = didUptimeReset(incomingUptimeSeconds, previousUptimeSeconds);
  const freshSessionByUptime = hasMeaningfulUptime(incomingUptimeSeconds) && (
    !hasMeaningfulUptime(previousUptimeSeconds) ||
    Number(incomingUptimeSeconds) <= SESSION_RESET_FRESH_UPTIME_SECONDS ||
    uptimeReset
  );
  const sessionReset = sessionChanged && freshSessionByUptime;
  return {
    previousSessionId,
    previousUptimeSeconds,
    sessionChanged,
    uptimeReset,
    freshSessionByUptime,
    looksLikeRealReset: Boolean(!runtimeSnapshot || uptimeReset || sessionReset)
  };
}

function getUsageSnapshotMeta(customerId, at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  const usage = getCurrentPeriodUsage(customerId, refDate) || null;
  const runtime = getRuntimeSnapshot(customerId) || null;
  const updatedAt = runtime?.last_seen_at || runtime?.updated_at || usage?.updated_at || '';
  const updatedAtMs = parseDateMs(updatedAt);
  const freshnessSeconds = updatedAtMs
    ? Math.max(0, Math.floor((refDate.getTime() - updatedAtMs) / 1000))
    : null;
  return {
    usage,
    runtime,
    updatedAt,
    updatedAtMs,
    freshnessSeconds,
    usageLagSeconds: freshnessSeconds,
    usageSource: usage ? 'customer_usage' : 'customer_usage_empty',
    isAuthoritative: true
  };
}

function getCurrentPeriod(customerId, at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  return {
    refDate,
    month: refDate.getMonth() + 1,
    year: refDate.getFullYear(),
    usage: getCurrentPeriodUsage(customerId, refDate),
    runtime: getRuntimeSnapshot(customerId)
  };
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

function setUsageForCurrentPeriod(customerId, usageIn, usageOut, totalIn, totalOut, at = new Date()) {
  const normalizedUsageIn = Math.max(0, Number(usageIn || 0));
  const normalizedUsageOut = Math.max(0, Number(usageOut || 0));
  const normalizedTotalIn = Math.max(0, Number(totalIn || 0));
  const normalizedTotalOut = Math.max(0, Number(totalOut || 0));
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const existing = getUsage(customerId, month, year);

  if (existing) {
    return db.prepare(`
      UPDATE customer_usage
      SET bytes_in = ?,
          bytes_out = ?,
          last_total_bytes_in = ?,
          last_total_bytes_out = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedUsageIn, normalizedUsageOut, normalizedTotalIn, normalizedTotalOut, existing.id);
  }

  return db.prepare(`
    INSERT INTO customer_usage (
      customer_id, period_month, period_year,
      bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    customerId,
    month,
    year,
    normalizedUsageIn,
    normalizedUsageOut,
    normalizedTotalIn,
    normalizedTotalOut
  );
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

function isUsageSourceTrusted(source) {
  const raw = String(source || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('fallback')) return false;
  if (raw.includes('snapshot-cache')) return false;
  if (raw.includes('cache')) return false;
  if (raw.includes('error')) return false;
  return true;
}

function findUsageReplayAnchor(customerId, month, year, runtimeIn, runtimeOut, sessionStartMs = 0) {
  const runtimeTotal = Math.max(0, Number(runtimeIn || 0)) + Math.max(0, Number(runtimeOut || 0));
  if (runtimeTotal <= 0) return null;

  const logs = db.prepare(`
    SELECT
      id,
      created_at,
      stored_bytes_in,
      stored_bytes_out,
      observed_bytes_in,
      observed_bytes_out,
      delta_bytes_in,
      delta_bytes_out
    FROM usage_audit_logs
    WHERE customer_id = ?
      AND period_month = ?
      AND period_year = ?
      AND event_type = 'large_delta'
    ORDER BY id ASC
  `).all(customerId, month, year);

  for (const log of logs) {
    const createdAtMs = parseDateMs(log.created_at);
    if (sessionStartMs && createdAtMs && (createdAtMs + (2 * 60 * 1000)) < sessionStartMs) continue;

    const storedBeforeIn = Math.max(0, Number(log.stored_bytes_in || 0));
    const storedBeforeOut = Math.max(0, Number(log.stored_bytes_out || 0));
    const observedIn = Math.max(0, Number(log.observed_bytes_in || 0));
    const observedOut = Math.max(0, Number(log.observed_bytes_out || 0));
    const deltaIn = Math.max(0, Number(log.delta_bytes_in || 0));
    const deltaOut = Math.max(0, Number(log.delta_bytes_out || 0));
    const storedBeforeTotal = storedBeforeIn + storedBeforeOut;
    const observedTotal = observedIn + observedOut;
    const deltaTotal = deltaIn + deltaOut;

    if (storedBeforeTotal <= 0 || observedTotal < USAGE_REPLAY_MIN_BYTES) continue;
    if (runtimeTotal + USAGE_REPLAY_TOLERANCE_BYTES < observedTotal) continue;

    const replayTolerance = Math.max(USAGE_REPLAY_TOLERANCE_BYTES, observedTotal * 0.03);
    if (Math.abs(deltaTotal - observedTotal) > replayTolerance) continue;

    const anchorTolerance = Math.max(USAGE_REPLAY_TOLERANCE_BYTES, observedTotal * 0.1);
    if (Math.abs(storedBeforeTotal - observedTotal) > anchorTolerance) continue;

    return {
      createdAt: log.created_at,
      storedBeforeIn,
      storedBeforeOut,
      observedIn,
      observedOut,
      deltaIn,
      deltaOut
    };
  }

  return null;
}

function getUsageReplayCorrection(customerId, at = new Date(), snapshot = {}) {
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const usage = snapshot.usage || getUsage(customerId, month, year);
  const runtime = snapshot.runtime || getRuntimeSnapshot(customerId);

  if (!usage || !runtime) return null;

  const currentUsageIn = Math.max(0, Number(usage.bytes_in || 0));
  const currentUsageOut = Math.max(0, Number(usage.bytes_out || 0));
  const runtimeIn = Math.max(0, Number(runtime.last_total_bytes_in || 0));
  const runtimeOut = Math.max(0, Number(runtime.last_total_bytes_out || 0));
  const currentUsageTotal = currentUsageIn + currentUsageOut;
  const runtimeTotal = runtimeIn + runtimeOut;

  if (runtimeTotal <= 0 || currentUsageTotal <= runtimeTotal) return null;

  const lastSeenAtMs = parseDateMs(runtime.last_seen_at || runtime.updated_at);
  const uptimeSeconds = Number(runtime.last_uptime_seconds || 0) || 0;
  const sessionStartMs = (lastSeenAtMs && uptimeSeconds > 0)
    ? (lastSeenAtMs - (uptimeSeconds * 1000))
    : 0;

  const anchor = findUsageReplayAnchor(customerId, month, year, runtimeIn, runtimeOut, sessionStartMs);
  if (!anchor) return null;

  const correctedUsageIn = Math.max(
    anchor.storedBeforeIn,
    anchor.storedBeforeIn + Math.max(0, runtimeIn - anchor.observedIn)
  );
  const correctedUsageOut = Math.max(
    anchor.storedBeforeOut,
    anchor.storedBeforeOut + Math.max(0, runtimeOut - anchor.observedOut)
  );
  const correctedTotal = correctedUsageIn + correctedUsageOut;
  const savedBytes = currentUsageTotal - correctedTotal;

  if (correctedTotal >= currentUsageTotal) return null;
  if (savedBytes < (512 * 1024 * 1024)) return null;

  return {
    refDate,
    usage,
    runtime,
    anchor,
    correctedUsageIn,
    correctedUsageOut,
    correctedTotal,
    savedBytes
  };
}

function canPerformSemiLiveSync(customerId, at = new Date(), meta = {}) {
  const refDate = at instanceof Date ? at : new Date(at);
  const snapshotMeta = getUsageSnapshotMeta(customerId, refDate);
  const runtime = snapshotMeta.runtime || null;
  const normalizedIn = Math.max(0, Number(meta.totalIn ?? meta.bytesIn ?? 0) || 0);
  const normalizedOut = Math.max(0, Number(meta.totalOut ?? meta.bytesOut ?? 0) || 0);
  const incomingSessionId = String(meta.sessionId || '').trim();
  const incomingUptimeSeconds = Number.isFinite(meta.uptimeSeconds)
    ? Number(meta.uptimeSeconds)
    : parseUptimeToSeconds(meta.uptime);
  const resetState = getSessionResetState({
    runtimeSnapshot: runtime,
    incomingSessionId,
    incomingUptimeSeconds
  });
  const previousTotalIn = Math.max(0, Number(runtime?.last_total_bytes_in || 0) || 0);
  const previousTotalOut = Math.max(0, Number(runtime?.last_total_bytes_out || 0) || 0);
  const lagMs = snapshotMeta.updatedAtMs
    ? Math.max(0, refDate.getTime() - snapshotMeta.updatedAtMs)
    : Number.POSITIVE_INFINITY;
  const suspiciousSessionChange = resetState.sessionChanged && !resetState.looksLikeRealReset;

  if (!incomingSessionId) {
    return { allowed: false, reason: 'missing-session-id', snapshotMeta };
  }
  if (incomingUptimeSeconds <= 0) {
    return { allowed: false, reason: 'missing-uptime', snapshotMeta };
  }
  if ((normalizedIn + normalizedOut) <= 0) {
    return { allowed: false, reason: 'zero-counters', snapshotMeta };
  }
  if (runtime && normalizedIn === previousTotalIn && normalizedOut === previousTotalOut) {
    return { allowed: false, reason: 'zero-delta', snapshotMeta };
  }
  if (!isUsageSourceTrusted(meta.source)) {
    return { allowed: false, reason: 'untrusted-source', snapshotMeta };
  }
  if (suspiciousSessionChange) {
    return { allowed: false, reason: 'invalid-session-change', snapshotMeta };
  }
  if (Number.isFinite(lagMs) && lagMs < SEMI_LIVE_SYNC_THROTTLE_MS) {
    return { allowed: false, reason: 'throttled', snapshotMeta };
  }
  return { allowed: true, reason: 'ok', snapshotMeta };
}

const syncUsageTotalsTx = db.transaction((customerId, totalIn, totalOut, at = new Date(), meta = {}) => {
  const normalizedIn = Math.max(0, Number(totalIn || 0));
  const normalizedOut = Math.max(0, Number(totalOut || 0));
  const normalizedTotal = normalizedIn + normalizedOut;
  const refDate = at instanceof Date ? at : new Date(at);
  const runtimeSnapshot = getRuntimeSnapshot(customerId);
  const fallbackSnapshot = runtimeSnapshot || getLatestUsageSnapshot(customerId);
  const currentUsage = getCurrentPeriodUsage(customerId, refDate);
  const incomingSessionId = String(meta.sessionId || '').trim();
  const incomingUptimeSeconds = Number.isFinite(meta.uptimeSeconds)
    ? Number(meta.uptimeSeconds)
    : parseUptimeToSeconds(meta.uptime);
  const resetState = getSessionResetState({
    runtimeSnapshot,
    incomingSessionId,
    incomingUptimeSeconds
  });
  const previousObservedTotal = Math.max(0, Number(runtimeSnapshot?.last_total_bytes_in || 0) || 0)
    + Math.max(0, Number(runtimeSnapshot?.last_total_bytes_out || 0) || 0);

  let deltaIn = 0;
  let deltaOut = 0;
  let anomalyGuardApplied = false;
  let healedByOverwrite = false;
  let effectiveSnapshotIn = normalizedIn;
  let effectiveSnapshotOut = normalizedOut;

  if (fallbackSnapshot) {
    if (normalizedIn < Number(fallbackSnapshot.last_total_bytes_in || 0) || normalizedOut < Number(fallbackSnapshot.last_total_bytes_out || 0)) {
      let looksLikeRealReset = resetState.looksLikeRealReset;
      if (looksLikeRealReset && normalizedTotal === 0 && previousObservedTotal > 0) {
        looksLikeRealReset = false;
      }

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
    const currentObservedTotal = normalizedTotal;
    const deltaTotal = deltaIn + deltaOut;
    const replayCorrection = getUsageReplayCorrection(customerId, refDate, {
      usage: currentUsage,
      runtime: {
        ...runtimeSnapshot,
        last_total_bytes_in: normalizedIn,
        last_total_bytes_out: normalizedOut,
        last_seen_at: runtimeSnapshot.last_seen_at || runtimeSnapshot.updated_at,
        updated_at: runtimeSnapshot.updated_at
      }
    });

    if (replayCorrection) {
      anomalyGuardApplied = true;
      const savedGb = (Number(replayCorrection.savedBytes || 0) / (1024 * 1024 * 1024)).toFixed(2);
      logger.warn(`[usage] Replay usage terdeteksi untuk customer ${customerId}. Menormalkan total bulanan dan menghapus duplikasi sekitar ${savedGb} GB.`);
      setUsageForCurrentPeriod(
        customerId,
        replayCorrection.correctedUsageIn,
        replayCorrection.correctedUsageOut,
        normalizedIn,
        normalizedOut,
        refDate
      );
      createAuditLog(customerId, 'auto_heal_replay', {
        storedBytesIn: Number(currentUsage.bytes_in || 0),
        storedBytesOut: Number(currentUsage.bytes_out || 0),
        observedBytesIn: normalizedIn,
        observedBytesOut: normalizedOut,
        deltaBytesIn: Math.max(0, Number(currentUsage.bytes_in || 0) - replayCorrection.correctedUsageIn),
        deltaBytesOut: Math.max(0, Number(currentUsage.bytes_out || 0) - replayCorrection.correctedUsageOut),
        note: `Replay anchor ${replayCorrection.anchor.createdAt}. savedBytes=${replayCorrection.savedBytes}`
      }, refDate);
      saveRuntimeSnapshot(customerId, normalizedIn, normalizedOut, refDate, {
        ...meta,
        uptimeSeconds: incomingUptimeSeconds
      });
      return {
        deltaIn: 0,
        deltaOut: 0,
        totalIn: normalizedIn,
        totalOut: normalizedOut,
        anomalyGuardApplied,
        healedByOverwrite: true
      };
    }

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

function syncUsageTotalsSemiLive(customerId, totalIn, totalOut, at = new Date(), meta = {}) {
  const gate = canPerformSemiLiveSync(customerId, at, {
    ...meta,
    totalIn,
    totalOut
  });
  if (!gate.allowed) {
    return {
      written: false,
      skipped: true,
      reason: gate.reason,
      usageMeta: gate.snapshotMeta
    };
  }

  const result = syncUsageTotalsTx(customerId, totalIn, totalOut, at, meta);
  createAuditLog(customerId, 'semi_live_sync', {
    storedBytesIn: Number(gate.snapshotMeta?.usage?.bytes_in || 0),
    storedBytesOut: Number(gate.snapshotMeta?.usage?.bytes_out || 0),
    observedBytesIn: Math.max(0, Number(totalIn || 0)),
    observedBytesOut: Math.max(0, Number(totalOut || 0)),
    deltaBytesIn: Math.max(0, Number(result?.deltaIn || 0)),
    deltaBytesOut: Math.max(0, Number(result?.deltaOut || 0)),
    note: `Semi-live sync accepted. source=${String(meta.source || '').trim() || '-'}`
  }, at);
  return {
    written: true,
    skipped: false,
    reason: 'written',
    result,
    usageMeta: getUsageSnapshotMeta(customerId, at)
  };
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

function repairUsageReplayForCurrentPeriod(customerId, at = new Date()) {
  const correction = getUsageReplayCorrection(customerId, at);
  if (!correction) {
    return { repaired: false, reason: 'no-correction' };
  }

  const { usage, runtime, correctedUsageIn, correctedUsageOut, refDate, savedBytes, anchor } = correction;
  setUsageForCurrentPeriod(
    customerId,
    correctedUsageIn,
    correctedUsageOut,
    Number(runtime.last_total_bytes_in || 0),
    Number(runtime.last_total_bytes_out || 0),
    refDate
  );
  createAuditLog(customerId, 'admin_repair_replay', {
    storedBytesIn: Number(usage.bytes_in || 0),
    storedBytesOut: Number(usage.bytes_out || 0),
    observedBytesIn: Number(runtime.last_total_bytes_in || 0),
    observedBytesOut: Number(runtime.last_total_bytes_out || 0),
    deltaBytesIn: Math.max(0, Number(usage.bytes_in || 0) - correctedUsageIn),
    deltaBytesOut: Math.max(0, Number(usage.bytes_out || 0) - correctedUsageOut),
    note: `Replay anchor ${anchor.createdAt}. savedBytes=${savedBytes}`
  }, refDate);

  return {
    repaired: true,
    customerId,
    beforeBytesIn: Number(usage.bytes_in || 0),
    beforeBytesOut: Number(usage.bytes_out || 0),
    afterBytesIn: correctedUsageIn,
    afterBytesOut: correctedUsageOut,
    savedBytes,
    anchorCreatedAt: anchor.createdAt
  };
}

function repairUsageReplayForAllCurrentCustomers(at = new Date()) {
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const rows = db.prepare(`
    SELECT DISTINCT customer_id
    FROM customer_usage
    WHERE period_month = ? AND period_year = ?
    ORDER BY customer_id ASC
  `).all(month, year);

  const results = [];
  for (const row of rows) {
    const result = repairUsageReplayForCurrentPeriod(row.customer_id, refDate);
    if (result?.repaired) results.push(result);
  }
  return results;
}

function listUsageReplayAuditCurrentPeriod(at = new Date(), options = {}) {
  const refDate = at instanceof Date ? at : new Date(at);
  const month = refDate.getMonth() + 1;
  const year = refDate.getFullYear();
  const minDiffBytes = Math.max(256 * 1024 * 1024, Number(options.minDiffBytes || 1024 * 1024 * 1024) || 0);
  const minRatio = Math.max(1, Number(options.minRatio || 1.25) || 1.25);
  const limit = Math.max(1, Number(options.limit || 300) || 300);
  const rows = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.pppoe_username,
      c.status,
      c.router_id,
      u.bytes_in,
      u.bytes_out,
      u.updated_at AS usage_updated_at,
      r.last_total_bytes_in,
      r.last_total_bytes_out,
      r.last_seen_at,
      r.updated_at AS runtime_updated_at,
      r.last_session_id,
      r.last_uptime_seconds
    FROM customer_usage u
    JOIN customers c ON c.id = u.customer_id
    LEFT JOIN customer_usage_runtime r ON r.customer_id = c.id
    WHERE u.period_month = ? AND u.period_year = ?
    ORDER BY u.updated_at DESC, c.name COLLATE NOCASE ASC
  `).all(month, year);

  const results = [];

  for (const row of rows) {
    const storedBytesIn = Math.max(0, Number(row.bytes_in || 0));
    const storedBytesOut = Math.max(0, Number(row.bytes_out || 0));
    const runtimeBytesIn = Math.max(0, Number(row.last_total_bytes_in || 0));
    const runtimeBytesOut = Math.max(0, Number(row.last_total_bytes_out || 0));
    const storedTotalBytes = storedBytesIn + storedBytesOut;
    const runtimeTotalBytes = runtimeBytesIn + runtimeBytesOut;
    const diffBytes = Math.max(0, storedTotalBytes - runtimeTotalBytes);
    const ratio = runtimeTotalBytes > 0
      ? (storedTotalBytes / runtimeTotalBytes)
      : (storedTotalBytes > 0 ? Number.POSITIVE_INFINITY : 1);
    const correction = getUsageReplayCorrection(row.id, refDate, {
      usage: {
        bytes_in: storedBytesIn,
        bytes_out: storedBytesOut,
        updated_at: row.usage_updated_at
      },
      runtime: {
        last_total_bytes_in: runtimeBytesIn,
        last_total_bytes_out: runtimeBytesOut,
        last_seen_at: row.last_seen_at,
        updated_at: row.runtime_updated_at,
        last_session_id: row.last_session_id,
        last_uptime_seconds: row.last_uptime_seconds
      }
    });
    const repairable = Boolean(correction);
    const suspicious = repairable || (
      storedTotalBytes > 0 &&
      runtimeTotalBytes > 0 &&
      diffBytes >= minDiffBytes &&
      ratio >= minRatio
    );

    if (!suspicious) continue;

    results.push({
      customerId: row.id,
      name: String(row.name || '').trim(),
      username: String(row.pppoe_username || '').trim(),
      status: String(row.status || '').trim(),
      routerId: row.router_id == null ? null : Number(row.router_id),
      storedBytesIn,
      storedBytesOut,
      storedTotalBytes,
      runtimeBytesIn,
      runtimeBytesOut,
      runtimeTotalBytes,
      diffBytes,
      ratio: Number.isFinite(ratio) ? ratio : null,
      usageUpdatedAt: row.usage_updated_at || '',
      runtimeUpdatedAt: row.last_seen_at || row.runtime_updated_at || '',
      sessionId: String(row.last_session_id || '').trim(),
      uptimeSeconds: Number(row.last_uptime_seconds || 0) || 0,
      repairable,
      repairSavedBytes: Math.max(0, Number(correction?.savedBytes || 0)),
      repairAfterBytes: Math.max(0, Number(correction?.correctedTotal || runtimeTotalBytes || 0)),
      anchorCreatedAt: String(correction?.anchor?.createdAt || '').trim()
    });
  }

  results.sort((a, b) => {
    if (Number(b.repairable) !== Number(a.repairable)) return Number(b.repairable) - Number(a.repairable);
    if (b.repairSavedBytes !== a.repairSavedBytes) return b.repairSavedBytes - a.repairSavedBytes;
    if (b.diffBytes !== a.diffBytes) return b.diffBytes - a.diffBytes;
    return String(a.name || '').localeCompare(String(b.name || ''), 'id');
  });

  return results.slice(0, limit);
}

module.exports = {
  getUsage,
  getLatestUsageSnapshot,
  getRuntimeSnapshot,
  getUsageSnapshotMeta,
  updateUsage,
  resetUsageCounter,
  canPerformSemiLiveSync,
  syncUsageTotals,
  syncUsageTotalsSemiLive,
  overwriteUsageForCurrentPeriod,
  resetUsageForCurrentPeriod,
  createAuditLog,
  getUsageReplayCorrection,
  repairUsageReplayForCurrentPeriod,
  repairUsageReplayForAllCurrentCustomers,
  listUsageReplayAuditCurrentPeriod
};
