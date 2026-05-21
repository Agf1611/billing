const axios = require('axios');
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const {
  isPushConfigured,
  sendPushToTechnicians
} = require('./pushNotificationService');

const evaluationLocks = new Map();

const DEFAULTS = {
  enabled: false,
  delayMinutes: 10,
  thresholdCount: 5,
  thresholdPercent: 20,
  sampleLimit: 5
};

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value) {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function parsePercent(value, fallback) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getRouterKey(routerId = null) {
  const normalized = Number(routerId);
  return Number.isFinite(normalized) && normalized > 0 ? `router:${normalized}` : 'default';
}

function getFeatureConfig() {
  return {
    enabled: getSetting('mass_outage_detection_enabled', DEFAULTS.enabled) === true,
    delayMinutes: parsePositiveInt(getSetting('mass_outage_delay_minutes', DEFAULTS.delayMinutes), DEFAULTS.delayMinutes),
    thresholdCount: parsePositiveInt(getSetting('mass_outage_threshold_count', DEFAULTS.thresholdCount), DEFAULTS.thresholdCount),
    thresholdPercent: parsePercent(getSetting('mass_outage_threshold_percent', DEFAULTS.thresholdPercent), DEFAULTS.thresholdPercent),
    zoneAliases: parseZoneAliasMap(getSetting('mass_outage_zone_aliases', ''))
  };
}

function parseZoneAliasMap(rawValue) {
  if (!rawValue) return new Map();
  if (typeof rawValue === 'object' && rawValue && !Array.isArray(rawValue)) {
    return new Map(
      Object.entries(rawValue)
        .map(([alias, canonical]) => [normalizeKey(alias), normalizeKey(canonical)])
        .filter(([alias, canonical]) => alias && canonical)
    );
  }

  const raw = String(rawValue || '').trim();
  if (!raw) return new Map();

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map(
        Object.entries(parsed)
          .map(([alias, canonical]) => [normalizeKey(alias), normalizeKey(canonical)])
          .filter(([alias, canonical]) => alias && canonical)
      );
    }
  } catch (_) {}

  return new Map(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('=');
        if (parts.length < 2) return null;
        return [normalizeKey(parts.shift()), normalizeKey(parts.join('='))];
      })
      .filter(Boolean)
  );
}

function normalizeZoneTokens(address = '') {
  const stopwords = new Set(['kp', 'kampung', 'ds', 'desa', 'jl', 'jalan', 'rt', 'rw', 'blok', 'block', 'no', 'nomor']);
  return normalizeKey(address)
    .split(' ')
    .filter((token) => token && !stopwords.has(token) && !/^\d+$/.test(token));
}

function resolveZone(address = '', aliases = new Map()) {
  const raw = normalizeKey(address);
  if (!raw) return null;

  const aliasHit = aliases.get(raw);
  if (aliasHit) {
    return { zoneKey: aliasHit, zoneLabel: titleCase(aliasHit) };
  }

  const tokens = normalizeZoneTokens(raw);
  if (!tokens.length) return { zoneKey: raw, zoneLabel: titleCase(raw) };

  const candidates = [
    tokens.join(' '),
    tokens.slice(0, 2).join(' '),
    tokens.slice(0, 1).join(' ')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const alias = aliases.get(candidate);
    if (alias) return { zoneKey: alias, zoneLabel: titleCase(alias) };
  }

  const zoneKey = candidates.find(Boolean) || raw;
  return { zoneKey, zoneLabel: titleCase(zoneKey) };
}

function shouldTriggerIncident(baselineCount, offlineCount, offlinePercent, config) {
  if (offlineCount < config.thresholdCount) {
    return baselineCount >= 10 && offlinePercent >= config.thresholdPercent;
  }
  if (baselineCount < 10) return offlineCount >= config.thresholdCount;
  return offlineCount >= config.thresholdCount || offlinePercent >= config.thresholdPercent;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}j ${minutes}m`;
  return `${minutes}m`;
}

function getTelegramConfig() {
  return {
    enabled: getSetting('telegram_enabled', false) === true,
    token: normalizeText(getSetting('telegram_bot_token', '')),
    adminId: normalizeText(getSetting('telegram_admin_id', ''))
  };
}

async function sendTelegramAdminMessage(text) {
  const config = getTelegramConfig();
  if (!config.enabled || !config.token || !config.adminId) return { success: false, skipped: true, reason: 'not-configured' };
  try {
    await axios.post(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      chat_id: config.adminId,
      text: String(text || '').trim(),
      parse_mode: 'Markdown'
    }, { timeout: 15000 });
    return { success: true };
  } catch (error) {
    logger.warn(`[MassOutage] Gagal kirim Telegram admin: ${error.message || error}`);
    return { success: false, error: error.message || String(error) };
  }
}

async function sendWhatsappMessages(numbers = [], text = '') {
  const targets = [...new Set((Array.isArray(numbers) ? numbers : []).map((item) => normalizeText(item)).filter(Boolean))];
  if (!targets.length || !normalizeText(text)) return [];
  const { sendWA } = await import('./whatsappBot.mjs');
  const results = [];
  for (const target of targets) {
    try {
      const ok = await sendWA(target, text);
      results.push({ target, ok: Boolean(ok) });
    } catch (error) {
      logger.warn(`[MassOutage] Gagal kirim WA ke ${target}: ${error.message || error}`);
      results.push({ target, ok: false, error: error.message || String(error) });
    }
  }
  return results;
}

function getAdminWhatsappNumbers() {
  const raw = getSetting('whatsapp_admin_numbers', []);
  if (Array.isArray(raw)) return raw.map((item) => normalizeText(item)).filter(Boolean);
  return String(raw || '')
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function getTechnicianWhatsappNumbers() {
  return db.prepare(`
    SELECT phone
    FROM technicians
    WHERE is_active = 1
      AND phone IS NOT NULL
      AND TRIM(phone) != ''
  `).all().map((row) => normalizeText(row.phone)).filter(Boolean);
}

function getActiveTechnicians() {
  return db.prepare(`
    SELECT id, username, name, phone, area, is_active
    FROM technicians
    WHERE is_active = 1
  `).all();
}

function getActivePppoeCustomers() {
  return db.prepare(`
    SELECT id, name, phone, address, pppoe_username
    FROM customers
    WHERE status = 'active'
      AND pppoe_username IS NOT NULL
      AND TRIM(pppoe_username) != ''
  `).all();
}

function getOpenIncidentsByRouter(routerId = null) {
  const routerKey = getRouterKey(routerId);
  return db.prepare(`
    SELECT *
    FROM mass_outage_incidents
    WHERE router_key = ? AND status = 'open'
    ORDER BY detected_at DESC
  `).all(routerKey);
}

function getIncidentSummaryRow(row) {
  const detectedAt = row?.detected_at ? new Date(row.detected_at) : null;
  const recoveredAt = row?.recovered_at ? new Date(row.recovered_at) : null;
  const durationMs = detectedAt ? ((recoveredAt || new Date()).getTime() - detectedAt.getTime()) : 0;
  return {
    id: Number(row?.id || 0) || 0,
    routerId: row?.router_id != null ? Number(row.router_id) : null,
    routerKey: row?.router_key || 'default',
    zoneKey: row?.zone_key || '',
    zoneLabel: row?.zone_label || row?.zone_key || '',
    status: row?.status || 'open',
    detectedAt: row?.detected_at || null,
    recoveredAt: row?.recovered_at || null,
    baselineCount: Number(row?.baseline_count || 0),
    offlineCount: Number(row?.offline_count || 0),
    offlinePercent: Number(row?.offline_percent || 0),
    sampleCustomers: JSON.parse(row?.sample_customers_json || '[]'),
    durationLabel: formatDuration(durationMs)
  };
}

function listOpenIncidents() {
  return db.prepare(`
    SELECT *
    FROM mass_outage_incidents
    WHERE status = 'open'
    ORDER BY detected_at DESC
  `).all().map(getIncidentSummaryRow);
}

function listRecentIncidents(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return db.prepare(`
    SELECT *
    FROM mass_outage_incidents
    ORDER BY COALESCE(recovered_at, detected_at) DESC
    LIMIT ${safeLimit}
  `).all().map(getIncidentSummaryRow);
}

function buildOutageMessage(kind, incident) {
  const sample = (incident.sampleCustomers || []).slice(0, DEFAULTS.sampleLimit);
  const sampleText = sample.length
    ? sample.map((item) => `- ${item.name || item.pppoe_username || item.id}`).join('\n')
    : '-';

  if (kind === 'recovered') {
    return [
      `✅ *Gangguan Pulih*`,
      `Area: *${incident.zoneLabel}*`,
      `Terdampak sebelumnya: *${incident.offlineCount}/${incident.baselineCount}* pelanggan aktif`,
      `Pulih: ${incident.recoveredAt ? new Date(incident.recoveredAt).toLocaleString('id-ID') : '-'}`,
      `Durasi: ${incident.durationLabel}`
    ].join('\n');
  }

  return [
    `🚨 *Gangguan Massal Terdeteksi*`,
    `Area: *${incident.zoneLabel}*`,
    `Dampak: *${incident.offlineCount}/${incident.baselineCount}* pelanggan aktif (${incident.offlinePercent.toFixed(1)}%)`,
    `Terdeteksi: ${incident.detectedAt ? new Date(incident.detectedAt).toLocaleString('id-ID') : '-'}`,
    '',
    '*Contoh pelanggan terdampak:*',
    sampleText
  ].join('\n');
}

async function notifyIncident(kind, incidentRow) {
  const incident = getIncidentSummaryRow(incidentRow);
  const message = buildOutageMessage(kind, incident);
  const adminNumbers = getAdminWhatsappNumbers();
  const technicianNumbers = getTechnicianWhatsappNumbers();
  const technicians = getActiveTechnicians();
  const pushTitle = kind === 'recovered' ? 'Gangguan pulih' : 'Gangguan massal terdeteksi';
  const pushMessage = `${incident.zoneLabel}: ${incident.offlineCount}/${incident.baselineCount} pelanggan terdampak (${incident.offlinePercent.toFixed(1)}%).`;
  await Promise.allSettled([
    sendWhatsappMessages(adminNumbers, message),
    sendWhatsappMessages(technicianNumbers, message),
    sendTelegramAdminMessage(message),
    isPushConfigured() ? sendPushToTechnicians(technicians, {
      title: pushTitle,
      message: pushMessage,
      targetUrl: '/tech',
      data: {
        kind: 'mass_outage',
        incidentId: incident.id,
        status: incident.status,
        zone: incident.zoneKey
      }
    }) : Promise.resolve({ skipped: true, reason: 'push-not-configured' })
  ]);
}

function buildZoneStats(snapshot, config) {
  const pppoeRows = Array.isArray(snapshot?.derived?.tables?.pppoe) ? snapshot.derived.tables.pppoe : [];
  const pppoeByUsername = new Map(
    pppoeRows
      .map((row) => [normalizeKey(row?.name), row])
      .filter(([key]) => key)
  );
  const customers = getActivePppoeCustomers();
  const zones = new Map();
  const delaySeconds = config.delayMinutes * 60;

  for (const customer of customers) {
    const zone = resolveZone(customer.address, config.zoneAliases);
    if (!zone) continue;
    const usernameKey = normalizeKey(customer.pppoe_username);
    const session = pppoeByUsername.get(usernameKey) || null;
    let offlineStable = false;
    if (session && session.displayStatus === 'offline') {
      offlineStable = Number(session.offlineSeconds || 0) >= delaySeconds;
    }
    if (!zones.has(zone.zoneKey)) {
      zones.set(zone.zoneKey, {
        zoneKey: zone.zoneKey,
        zoneLabel: zone.zoneLabel,
        baselineCount: 0,
        offlineCount: 0,
        affectedCustomerIds: [],
        sampleCustomers: []
      });
    }
    const target = zones.get(zone.zoneKey);
    target.baselineCount += 1;
    if (offlineStable) {
      target.offlineCount += 1;
      target.affectedCustomerIds.push(customer.id);
      if (target.sampleCustomers.length < DEFAULTS.sampleLimit) {
        target.sampleCustomers.push({
          id: customer.id,
          name: customer.name,
          pppoe_username: customer.pppoe_username
        });
      }
    }
  }

  const zoneStats = [];
  for (const zone of zones.values()) {
    const offlinePercent = zone.baselineCount > 0
      ? (zone.offlineCount / zone.baselineCount) * 100
      : 0;
    zoneStats.push({
      ...zone,
      offlinePercent,
      shouldTrigger: shouldTriggerIncident(zone.baselineCount, zone.offlineCount, offlinePercent, config)
    });
  }
  return zoneStats;
}

async function evaluateSnapshot(routerId = null, snapshot = null) {
  const config = getFeatureConfig();
  if (!config.enabled) return { skipped: true, reason: 'disabled' };
  if (!snapshot || snapshot.collectorStatus !== 'ready' || snapshot.partialFailure) {
    return { skipped: true, reason: 'snapshot-not-ready' };
  }

  const routerKey = getRouterKey(routerId);
  if (evaluationLocks.get(routerKey)) return { skipped: true, reason: 'busy' };
  evaluationLocks.set(routerKey, true);

  try {
    const zoneStats = buildZoneStats(snapshot, config);
    const openIncidents = new Map(getOpenIncidentsByRouter(routerId).map((row) => [String(row.zone_key || ''), row]));
    const stamp = nowIso();
    const created = [];
    const recovered = [];

    const createStmt = db.prepare(`
      INSERT INTO mass_outage_incidents (
        router_key, router_id, zone_key, zone_label, status, detected_at, baseline_count, offline_count, offline_percent,
        affected_customer_ids_json, sample_customers_json, first_snapshot_at, last_snapshot_at, opened_by_system
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const updateOpenStmt = db.prepare(`
      UPDATE mass_outage_incidents
      SET zone_label = ?,
          baseline_count = ?,
          offline_count = ?,
          offline_percent = ?,
          affected_customer_ids_json = ?,
          sample_customers_json = ?,
          last_snapshot_at = ?
      WHERE id = ?
    `);
    const recoverStmt = db.prepare(`
      UPDATE mass_outage_incidents
      SET status = 'recovered',
          recovered_at = ?,
          last_snapshot_at = ?,
          offline_count = ?,
          offline_percent = ?,
          affected_customer_ids_json = ?,
          sample_customers_json = ?
      WHERE id = ?
    `);

    const txn = db.transaction(() => {
      for (const zone of zoneStats) {
        const existing = openIncidents.get(zone.zoneKey) || null;
        const affectedJson = JSON.stringify(zone.affectedCustomerIds);
        const sampleJson = JSON.stringify(zone.sampleCustomers);
        if (zone.shouldTrigger) {
          if (existing) {
            updateOpenStmt.run(
              zone.zoneLabel,
              zone.baselineCount,
              zone.offlineCount,
              zone.offlinePercent,
              affectedJson,
              sampleJson,
              stamp,
              existing.id
            );
          } else {
            const result = createStmt.run(
              routerKey,
              Number.isFinite(Number(routerId)) && Number(routerId) > 0 ? Number(routerId) : null,
              zone.zoneKey,
              zone.zoneLabel,
              stamp,
              zone.baselineCount,
              zone.offlineCount,
              zone.offlinePercent,
              affectedJson,
              sampleJson,
              snapshot.snapshotAt || stamp,
              snapshot.snapshotAt || stamp
            );
            created.push(result.lastInsertRowid);
          }
          openIncidents.delete(zone.zoneKey);
        } else if (existing) {
          recoverStmt.run(
            stamp,
            stamp,
            zone.offlineCount,
            zone.offlinePercent,
            affectedJson,
            sampleJson,
            existing.id
          );
          recovered.push(existing.id);
          openIncidents.delete(zone.zoneKey);
        }
      }

      for (const leftover of openIncidents.values()) {
        recoverStmt.run(
          stamp,
          stamp,
          0,
          0,
          '[]',
          '[]',
          leftover.id
        );
        recovered.push(leftover.id);
      }
    });

    txn();

    if (created.length) {
      for (const incidentId of created) {
        const row = db.prepare('SELECT * FROM mass_outage_incidents WHERE id = ?').get(incidentId);
        if (row) {
          notifyIncident('open', row).catch((error) => {
            logger.warn(`[MassOutage] Gagal kirim notif open #${incidentId}: ${error.message || error}`);
          });
        }
      }
    }
    if (recovered.length) {
      for (const incidentId of recovered) {
        const row = db.prepare('SELECT * FROM mass_outage_incidents WHERE id = ?').get(incidentId);
        if (row) {
          notifyIncident('recovered', row).catch((error) => {
            logger.warn(`[MassOutage] Gagal kirim notif recovery #${incidentId}: ${error.message || error}`);
          });
        }
      }
    }

    return { ok: true, created: created.length, recovered: recovered.length };
  } finally {
    evaluationLocks.delete(routerKey);
  }
}

module.exports = {
  evaluateSnapshot,
  listOpenIncidents,
  listRecentIncidents,
  parseZoneAliasMap,
  resolveZone
};
