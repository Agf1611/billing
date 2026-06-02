const db = require('../config/database');
const { logger } = require('../config/logger');
const mikrotikService = require('./mikrotikService');
const massOutageService = require('./massOutageService');

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const LIVE_INTERVAL_MS = envNumber('MIKROTIK_COLLECTOR_LIVE_INTERVAL_MS', 60000, 15000);
const INVENTORY_INTERVAL_MS = envNumber('MIKROTIK_COLLECTOR_INVENTORY_INTERVAL_MS', 300000, 60000);
const STALE_AFTER_MS = envNumber('MIKROTIK_COLLECTOR_STALE_AFTER_MS', 600000, 60000);
const FAST_REPEAT_GUARD_MS = envNumber('MIKROTIK_COLLECTOR_FAST_GUARD_MS', 15000, 5000);
const REFRESH_TIMEOUT_MS = envNumber('MIKROTIK_COLLECTOR_REFRESH_TIMEOUT_MS', 75000, 30000);
const HUNG_REFRESH_GRACE_MS = envNumber('MIKROTIK_COLLECTOR_HUNG_GRACE_MS', 10000, 1000);

const routerCollectors = new Map();

function getRouterKey(routerId = null) {
  const normalizedRouterId = Number(routerId);
  return Number.isFinite(normalizedRouterId) && normalizedRouterId > 0
    ? `router:${normalizedRouterId}`
    : 'default';
}

function normalizeIdentity(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function countUnique(rows = [], keyBuilder) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = typeof keyBuilder === 'function' ? String(keyBuilder(row) || '').trim() : '';
    if (!key) continue;
    seen.add(key.toLowerCase());
  }
  return seen.size;
}

function isPppoeSecretRow(row = {}) {
  const service = String(row?.service || '').trim().toLowerCase();
  return !service || service === 'pppoe' || service === 'any';
}

function isPppoeActiveSession(row = {}) {
  const service = String(row?.service || '').trim().toLowerCase();
  if (service === 'pppoe') return true;
  const iface = String(row?.interface || row?.['interface-name'] || row?.name || '').trim().toLowerCase();
  return iface.startsWith('<pppoe-') || iface.includes('pppoe');
}

function toBooleanLike(value) {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === 'yes' || raw === '1';
}

function nowIso() {
  return new Date().toISOString();
}

function parseDateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAgeMs(snapshotAt) {
  const parsed = parseDateMs(snapshotAt);
  if (!parsed) return null;
  return Math.max(0, Date.now() - parsed);
}

function getCollectorEntry(routerId = null) {
  const key = getRouterKey(routerId);
  if (!routerCollectors.has(key)) {
    routerCollectors.set(key, {
      routerId: Number.isFinite(Number(routerId)) && Number(routerId) > 0 ? Number(routerId) : null,
      routerKey: key,
      snapshot: null,
      refreshPromise: null,
      liveTimer: null,
      inventoryTimer: null,
      started: false,
      lastRefreshStartedAt: 0,
      activeRefreshId: 0
    });
  }
  return routerCollectors.get(key);
}

function stopCollectorEntry(entry) {
  if (!entry) return;
  if (entry.liveTimer) clearInterval(entry.liveTimer);
  if (entry.inventoryTimer) clearInterval(entry.inventoryTimer);
  entry.liveTimer = null;
  entry.inventoryTimer = null;
  entry.refreshPromise = null;
  entry.started = false;
}

function removeCollectorEntry(routerId = null) {
  const key = getRouterKey(routerId);
  const entry = routerCollectors.get(key);
  if (!entry) return;
  stopCollectorEntry(entry);
  routerCollectors.delete(key);
}

function hasConfiguredRouter(routerId = null) {
  const normalizedRouterId = mikrotikService.normalizeRouterId(routerId);
  if (!normalizedRouterId) return true;
  return Boolean(mikrotikService.getRouterById(normalizedRouterId));
}

function buildMissingRouterSnapshot(routerId = null) {
  const normalizedRouterId = mikrotikService.normalizeRouterId(routerId);
  return {
    ...buildInitialSnapshot(normalizedRouterId),
    snapshotAt: nowIso(),
    source: 'router-missing',
    collectorStatus: 'missing',
    ageMs: 0
  };
}

function withRefreshTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildInitialSnapshot(routerId = null) {
  return {
    routerId: Number.isFinite(Number(routerId)) && Number(routerId) > 0 ? Number(routerId) : null,
    snapshotAt: null,
    source: 'collector-warming-up',
    routerReachable: false,
    collectorStatus: 'warming_up',
    partialFailure: false,
    ageMs: null,
    sections: {
      pppoeSecretsRaw: { ok: false, updatedAt: null, error: null },
      pppoeActiveRaw: { ok: false, updatedAt: null, error: null },
      hotspotUsersRaw: { ok: false, updatedAt: null, error: null },
      hotspotActiveRaw: { ok: false, updatedAt: null, error: null }
    },
    raw: {
      pppoeSecretsRaw: [],
      pppoeActiveRaw: [],
      hotspotUsersRaw: [],
      hotspotActiveRaw: []
    },
    derived: {
      summary: {
        pppoeOnline: 0,
        pppoeOffline: 0,
        pppoeDisabled: 0,
        totalSecrets: 0,
        totalSecretsActive: 0,
        hotspotOnline: 0,
        hotspotOffline: 0,
        hotspotDisabled: 0,
        totalHotspot: 0,
        totalHotspotActive: 0
      },
      tables: {
        pppoe: [],
        hotspot: []
      }
    }
  };
}

function getPppoeMonitoringState(routerId = null, usernames = []) {
  const routerKey = getRouterKey(routerId);
  const names = Array.from(new Set((Array.isArray(usernames) ? usernames : []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (!names.length) return new Map();
  const placeholders = names.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT router_key, router_id, username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
     FROM pppoe_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...names);
  return new Map(rows.map((row) => [String(row.username || '').trim(), row]));
}

function syncHotspotMonitoringState(routerId = null, users = [], activeSessions = []) {
  const routerKey = getRouterKey(routerId);
  const normalizedRouterId = Number(routerId);
  const routerIdValue = Number.isFinite(normalizedRouterId) && normalizedRouterId > 0 ? normalizedRouterId : null;
  const trackedNames = new Set();
  const activeNames = new Set();
  const activeByName = new Map();
  const stamp = nowIso();

  for (const user of Array.isArray(users) ? users : []) {
    const username = normalizeIdentity(user?.name, user?.user, user?.username);
    if (username) trackedNames.add(username);
  }
  for (const session of Array.isArray(activeSessions) ? activeSessions : []) {
    const username = normalizeIdentity(session?.user, session?.name, session?.username);
    if (!username) continue;
    trackedNames.add(username);
    activeNames.add(username);
    activeByName.set(username, session);
  }

  if (!trackedNames.size) return new Map();

  const usernames = Array.from(trackedNames);
  const placeholders = usernames.map(() => '?').join(', ');
  const existingRows = db.prepare(
    `SELECT router_key, router_id, username, is_online, profile_name, session_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
     FROM hotspot_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...usernames);
  const existingMap = new Map(existingRows.map((row) => [String(row.username || '').trim(), row]));

  const upsert = db.prepare(`
    INSERT INTO hotspot_monitoring_state (
      router_key, router_id, username, is_online, profile_name, session_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
    ) VALUES (
      @router_key, @router_id, @username, @is_online, @profile_name, @session_address, @session_uptime, @last_online_at, @offline_since, @last_logout_at, @updated_at
    )
    ON CONFLICT(router_key, username) DO UPDATE SET
      router_id = excluded.router_id,
      is_online = excluded.is_online,
      profile_name = excluded.profile_name,
      session_address = excluded.session_address,
      session_uptime = excluded.session_uptime,
      last_online_at = excluded.last_online_at,
      offline_since = excluded.offline_since,
      last_logout_at = excluded.last_logout_at,
      updated_at = excluded.updated_at
  `);

  const transaction = db.transaction((rows) => {
    for (const username of rows) {
      const existing = existingMap.get(username) || null;
      const active = activeByName.get(username) || null;
      const isOnline = activeNames.has(username);
      const wasOnline = Number(existing?.is_online || 0) === 1;
      let lastOnlineAt = existing?.last_online_at || null;
      let offlineSince = existing?.offline_since || null;
      let lastLogoutAt = existing?.last_logout_at || null;

      if (isOnline) {
        lastOnlineAt = stamp;
        offlineSince = null;
      } else {
        if (wasOnline) {
          offlineSince = stamp;
          lastLogoutAt = stamp;
        } else if (!offlineSince) {
          offlineSince = stamp;
        }
      }

      upsert.run({
        router_key: routerKey,
        router_id: routerIdValue,
        username,
        is_online: isOnline ? 1 : 0,
        profile_name: normalizeIdentity(active?.profile, existing?.profile_name) || null,
        session_address: normalizeIdentity(active?.address, existing?.session_address) || null,
        session_uptime: normalizeIdentity(active?.uptime, existing?.session_uptime) || null,
        last_online_at: lastOnlineAt,
        offline_since: offlineSince,
        last_logout_at: lastLogoutAt,
        updated_at: stamp
      });
    }
  });

  transaction(usernames);

  const rows = db.prepare(
    `SELECT router_key, router_id, username, is_online, profile_name, session_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
     FROM hotspot_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...usernames);
  return new Map(rows.map((row) => [String(row.username || '').trim(), row]));
}

function buildDerivedPppoe(routerId = null, secrets = [], activeSessions = []) {
  const rawSecrets = Array.isArray(secrets) ? secrets : [];
  const rawActive = Array.isArray(activeSessions) ? activeSessions : [];
  const normalizedSecrets = rawSecrets.filter(isPppoeSecretRow);
  const normalizedActive = rawActive.filter(isPppoeActiveSession);
  const activeByName = new Map(normalizedActive.map((session) => [normalizeIdentity(session?.name, session?.user), session]).filter(([key]) => key));
  const trackedState = mikrotikService.syncPppoeMonitoringState(routerId, normalizedSecrets, normalizedActive);
  const existingState = getPppoeMonitoringState(routerId, normalizedSecrets.map((row) => normalizeIdentity(row?.name)));
  const nowMs = Date.now();

  const rows = normalizedSecrets.map((secret) => {
    const username = normalizeIdentity(secret?.name);
    const active = activeByName.get(username) || null;
    const persisted = trackedState.get(username) || existingState.get(username) || null;
    const isDisabled = toBooleanLike(secret?.disabled);
    const displayStatus = active ? 'online' : (isDisabled ? 'disabled' : 'offline');
    let offlineSeconds = null;
    if (displayStatus === 'offline' && persisted?.offline_since) {
      const parsed = parseDateMs(persisted.offline_since);
      if (parsed) offlineSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
    }
    return {
      ...secret,
      name: username,
      session: active,
      sessionUptime: normalizeIdentity(active?.uptime, persisted?.session_uptime) || null,
      sessionRemoteAddress: normalizeIdentity(active?.address, persisted?.remote_address) || null,
      remoteAddress: normalizeIdentity(secret?.remoteAddress, secret?.['remote-address'], active?.address, persisted?.remote_address) || null,
      isOnline: Boolean(active),
      displayStatus,
      lastOnlineAt: persisted?.last_online_at || null,
      offlineSince: displayStatus === 'offline' ? (persisted?.offline_since || null) : null,
      offlineSeconds
    };
  });

  const knownNames = new Set(rows.map((row) => normalizeIdentity(row?.name)).filter(Boolean));
  for (const session of normalizedActive) {
    const username = normalizeIdentity(session?.name, session?.user);
    if (!username || knownNames.has(username)) continue;
    const persisted = trackedState.get(username) || existingState.get(username) || null;
    rows.push({
      id: session?.['.id'] || session?.id || username,
      name: username,
      profile: normalizeIdentity(session?.profile) || '-',
      session,
      sessionUptime: normalizeIdentity(session?.uptime, persisted?.session_uptime) || null,
      sessionRemoteAddress: normalizeIdentity(session?.address, persisted?.remote_address) || null,
      remoteAddress: normalizeIdentity(session?.address, persisted?.remote_address) || null,
      isOnline: true,
      displayStatus: 'online',
      lastOnlineAt: persisted?.last_online_at || null,
      offlineSince: null,
      offlineSeconds: null,
      comment: '',
      disabled: false,
      isSynthetic: true
    });
  }

  return {
    rows,
    summary: {
      pppoeOnline: countUnique(normalizedActive, (row) => normalizeIdentity(row?.name, row?.user)),
      pppoeOffline: countUnique(rows.filter((row) => row.displayStatus === 'offline'), (row) => normalizeIdentity(row?.name)),
      pppoeDisabled: countUnique(rows.filter((row) => row.displayStatus === 'disabled'), (row) => normalizeIdentity(row?.name)),
      totalSecrets: countUnique(normalizedSecrets, (row) => normalizeIdentity(row?.name)),
      totalSecretsActive: countUnique(
        normalizedSecrets.filter((row) => !toBooleanLike(row?.disabled)),
        (row) => normalizeIdentity(row?.name)
      ),
      pppoeSecretRaw: countUnique(rawSecrets, (row) => normalizeIdentity(row?.name)),
      pppoeSecretIgnored: countUnique(rawSecrets.filter((row) => !isPppoeSecretRow(row)), (row) => normalizeIdentity(row?.name)),
      pppoeActiveRaw: countUnique(rawActive, (row) => normalizeIdentity(row?.name, row?.user)),
      pppoeActiveIgnored: countUnique(rawActive.filter((row) => !isPppoeActiveSession(row)), (row) => normalizeIdentity(row?.name, row?.user))
    }
  };
}

function buildDerivedHotspot(routerId = null, users = [], activeSessions = []) {
  const normalizedUsers = Array.isArray(users) ? users : [];
  const normalizedActive = Array.isArray(activeSessions) ? activeSessions : [];
  const activeByName = new Map(normalizedActive.map((session) => [normalizeIdentity(session?.user, session?.name), session]).filter(([key]) => key));
  const trackedState = syncHotspotMonitoringState(routerId, normalizedUsers, normalizedActive);
  const nowMs = Date.now();

  const rows = normalizedUsers.map((user) => {
    const username = normalizeIdentity(user?.name, user?.user);
    const active = activeByName.get(username) || null;
    const persisted = trackedState.get(username) || null;
    const isDisabled = toBooleanLike(user?.disabled);
    const displayStatus = active ? 'online' : (isDisabled ? 'disabled' : 'offline');
    let offlineSeconds = null;
    if (displayStatus === 'offline' && persisted?.offline_since) {
      const parsed = parseDateMs(persisted.offline_since);
      if (parsed) offlineSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
    }
    return {
      ...user,
      name: username,
      session: active,
      sessionUptime: normalizeIdentity(active?.uptime, persisted?.session_uptime) || null,
      sessionAddress: normalizeIdentity(active?.address, persisted?.session_address) || null,
      isOnline: Boolean(active),
      displayStatus,
      lastOnlineAt: persisted?.last_online_at || null,
      offlineSince: displayStatus === 'offline' ? (persisted?.offline_since || null) : null,
      offlineSeconds
    };
  });

  const knownNames = new Set(rows.map((row) => normalizeIdentity(row?.name, row?.user)).filter(Boolean));
  for (const session of normalizedActive) {
    const username = normalizeIdentity(session?.user, session?.name);
    if (!username || knownNames.has(username)) continue;
    const persisted = trackedState.get(username) || null;
    rows.push({
      id: session?.['.id'] || session?.id || username,
      name: username,
      profile: normalizeIdentity(session?.profile) || '-',
      session,
      sessionUptime: normalizeIdentity(session?.uptime, persisted?.session_uptime) || null,
      sessionAddress: normalizeIdentity(session?.address, persisted?.session_address) || null,
      isOnline: true,
      displayStatus: 'online',
      lastOnlineAt: persisted?.last_online_at || null,
      offlineSince: null,
      offlineSeconds: null,
      comment: '',
      disabled: false,
      isSynthetic: true
    });
  }

  return {
    rows,
    summary: {
      hotspotOnline: countUnique(normalizedActive, (row) => normalizeIdentity(row?.user, row?.name)),
      hotspotOffline: countUnique(rows.filter((row) => row.displayStatus === 'offline'), (row) => normalizeIdentity(row?.name, row?.user)),
      hotspotDisabled: countUnique(rows.filter((row) => row.displayStatus === 'disabled'), (row) => normalizeIdentity(row?.name, row?.user)),
      totalHotspot: countUnique(normalizedUsers, (row) => normalizeIdentity(row?.name, row?.user)),
      totalHotspotActive: countUnique(
        normalizedUsers.filter((row) => !toBooleanLike(row?.disabled)),
        (row) => normalizeIdentity(row?.name, row?.user)
      )
    }
  };
}

function resolveCollectorStatus(snapshot) {
  if (!snapshot?.snapshotAt) return 'warming_up';
  if (!snapshot.routerReachable && !snapshot.partialFailure) return 'error';
  if (snapshot.partialFailure) return 'partial';
  const ageMs = getAgeMs(snapshot.snapshotAt);
  if (ageMs !== null && ageMs > STALE_AFTER_MS) return 'stale';
  return 'ready';
}

function mergeSection(previous, label, result, fallbackValue) {
  if (result.status === 'fulfilled') {
    return {
      data: Array.isArray(result.value) ? result.value : [],
      meta: { ok: true, updatedAt: nowIso(), error: null }
    };
  }
  return {
    data: Array.isArray(fallbackValue) ? fallbackValue : [],
    meta: {
      ok: false,
      updatedAt: previous?.updatedAt || null,
      error: result.reason ? String(result.reason.message || result.reason) : `${label} failed`
    }
  };
}

async function runCollectorRefresh(entry, mode = 'full', refreshId = 0) {
  const routerId = entry.routerId;
  const previous = entry.snapshot || buildInitialSnapshot(routerId);
  const fullSnapshotPromise = mode === 'full'
    ? mikrotikService.getMonitoringSnapshot(routerId, { bypassCache: true, strict: true })
    : null;
  const fetchers = mode === 'full'
    ? {
        pppoeSecretsRaw: () => fullSnapshotPromise.then((snapshot) => {
          if (snapshot.sectionErrors?.pppoeSecretsRaw) throw snapshot.sectionErrors.pppoeSecretsRaw;
          return snapshot.secrets;
        }),
        pppoeActiveRaw: () => fullSnapshotPromise.then((snapshot) => {
          if (snapshot.sectionErrors?.pppoeActiveRaw) throw snapshot.sectionErrors.pppoeActiveRaw;
          return snapshot.activePppoe;
        }),
        hotspotUsersRaw: () => fullSnapshotPromise.then((snapshot) => {
          if (snapshot.sectionErrors?.hotspotUsersRaw) throw snapshot.sectionErrors.hotspotUsersRaw;
          return snapshot.hotspotUsers;
        }),
        hotspotActiveRaw: () => fullSnapshotPromise.then((snapshot) => {
          if (snapshot.sectionErrors?.hotspotActiveRaw) throw snapshot.sectionErrors.hotspotActiveRaw;
          return snapshot.hotspotActive;
        })
      }
    : {
        pppoeSecretsRaw: () => Promise.resolve(previous.raw.pppoeSecretsRaw),
        pppoeActiveRaw: () => mikrotikService.getPppoeActive(routerId, { bypassCache: true, strict: true }),
        hotspotUsersRaw: () => Promise.resolve(previous.raw.hotspotUsersRaw),
        hotspotActiveRaw: () => mikrotikService.getHotspotActive(routerId, { bypassCache: true, strict: true })
      };
  const labels = Object.keys(fetchers);
  const settled = await Promise.allSettled(labels.map((label) => fetchers[label]()));
  const merged = {};
  const sections = {};
  let successCount = 0;

  labels.forEach((label, index) => {
    const mergedSection = mergeSection(previous.sections?.[label], label, settled[index], previous.raw?.[label]);
    merged[label] = mergedSection.data;
    sections[label] = mergedSection.meta;
    if (mergedSection.meta.ok) successCount += 1;
  });

  const pppoe = buildDerivedPppoe(routerId, merged.pppoeSecretsRaw, merged.pppoeActiveRaw);
  const hotspot = buildDerivedHotspot(routerId, merged.hotspotUsersRaw, merged.hotspotActiveRaw);
  const hasAnySuccess = successCount > 0;
  const nextSnapshotAt = hasAnySuccess ? nowIso() : (previous.snapshotAt || null);
  const snapshot = {
    routerId,
    snapshotAt: nextSnapshotAt,
    source: hasAnySuccess
      ? (successCount === labels.length ? 'collector-live' : 'collector-partial')
      : (previous.snapshotAt ? 'collector-stale' : 'collector-warming-up'),
    routerReachable: hasAnySuccess,
    collectorStatus: 'warming_up',
    partialFailure: successCount > 0 && successCount < labels.length,
    ageMs: getAgeMs(nextSnapshotAt),
    sections,
    raw: merged,
    derived: {
      summary: {
        ...pppoe.summary,
        ...hotspot.summary
      },
      tables: {
        pppoe: pppoe.rows,
        hotspot: hotspot.rows
      }
    }
  };
  snapshot.collectorStatus = resolveCollectorStatus(snapshot);
  snapshot.ageMs = getAgeMs(snapshot.snapshotAt);
  if (entry.activeRefreshId === refreshId) {
    entry.snapshot = snapshot;
    massOutageService.evaluateSnapshot(routerId, snapshot).catch((error) => {
      logger.warn(`[MonitoringCollector] Evaluasi gangguan massal gagal untuk ${entry.routerKey}: ${error.message || error}`);
    });
    return snapshot;
  }
  return entry.snapshot || snapshot;
}

async function refreshRouterSnapshot(routerId = null, options = {}) {
  if (!hasConfiguredRouter(routerId)) {
    removeCollectorEntry(routerId);
    return buildMissingRouterSnapshot(routerId);
  }
  const entry = getCollectorEntry(routerId);
  const mode = options.mode === 'live' ? 'live' : 'full';
  const existingAgeMs = getAgeMs(entry.snapshot?.snapshotAt);
  if (!options.force && entry.snapshot && existingAgeMs !== null && existingAgeMs < FAST_REPEAT_GUARD_MS) {
    return entry.snapshot;
  }
  if (entry.refreshPromise) {
    const hungForMs = Math.max(0, Date.now() - Number(entry.lastRefreshStartedAt || 0));
    if (hungForMs <= (REFRESH_TIMEOUT_MS + HUNG_REFRESH_GRACE_MS)) {
      return entry.refreshPromise;
    }
    logger.warn(`[MonitoringCollector] Refresh ${entry.routerKey} macet ${hungForMs}ms. Memulai ulang refresh collector.`);
    entry.refreshPromise = null;
  }

  const refreshId = Number(entry.activeRefreshId || 0) + 1;
  entry.activeRefreshId = refreshId;
  entry.lastRefreshStartedAt = Date.now();
  entry.refreshPromise = withRefreshTimeout(
    runCollectorRefresh(entry, mode, refreshId),
    REFRESH_TIMEOUT_MS,
    `refresh ${entry.routerKey} (${mode})`
  )
    .catch((error) => {
      logger.warn(`[MonitoringCollector] Refresh ${entry.routerKey} gagal: ${error.message || error}`);
      if (entry.snapshot) {
        entry.snapshot = {
          ...entry.snapshot,
          source: 'collector-stale',
          collectorStatus: resolveCollectorStatus({
            ...entry.snapshot,
            partialFailure: true,
            routerReachable: false
          }),
          partialFailure: true,
          ageMs: getAgeMs(entry.snapshot.snapshotAt)
        };
        return entry.snapshot;
      }
      throw error;
    })
    .finally(() => {
      if (entry.activeRefreshId === refreshId) {
        entry.refreshPromise = null;
      }
    });
  return entry.refreshPromise;
}

function startRouterCollector(routerId = null) {
  if (!hasConfiguredRouter(routerId)) {
    removeCollectorEntry(routerId);
    return null;
  }
  const entry = getCollectorEntry(routerId);
  if (entry.started) return entry;
  entry.started = true;
  refreshRouterSnapshot(routerId, { force: true, mode: 'full' }).catch((error) => {
    logger.warn(`[MonitoringCollector] Warmup ${entry.routerKey} gagal: ${error.message || error}`);
  });
  entry.liveTimer = setInterval(() => {
    refreshRouterSnapshot(routerId, { mode: 'live' }).catch((error) => {
      logger.warn(`[MonitoringCollector] Live tick ${entry.routerKey} gagal: ${error.message || error}`);
    });
  }, LIVE_INTERVAL_MS);
  entry.inventoryTimer = setInterval(() => {
    refreshRouterSnapshot(routerId, { mode: 'full' }).catch((error) => {
      logger.warn(`[MonitoringCollector] Inventory tick ${entry.routerKey} gagal: ${error.message || error}`);
    });
  }, INVENTORY_INTERVAL_MS);
  if (typeof entry.liveTimer?.unref === 'function') entry.liveTimer.unref();
  if (typeof entry.inventoryTimer?.unref === 'function') entry.inventoryTimer.unref();
  return entry;
}

function syncConfiguredRouters() {
  const routers = Array.isArray(mikrotikService.getAllRouters()) ? mikrotikService.getAllRouters() : [];
  const activeRouterIds = new Set(
    routers
      .filter((router) => Number(router?.is_active || 0) === 1)
      .map((router) => Number(router.id))
      .filter((value) => Number.isFinite(value) && value > 0)
  );

  for (const routerId of activeRouterIds) startRouterCollector(routerId);

  for (const [routerKey, entry] of routerCollectors.entries()) {
    if (routerKey === 'default') continue;
    if (!activeRouterIds.has(Number(entry.routerId))) {
      stopCollectorEntry(entry);
      routerCollectors.delete(routerKey);
    }
  }
}

function startCollectorService() {
  syncConfiguredRouters();
  return true;
}

function getSnapshotWithComputedMeta(routerId = null) {
  if (!hasConfiguredRouter(routerId)) {
    return buildMissingRouterSnapshot(routerId);
  }
  const entry = getCollectorEntry(routerId);
  const snapshot = entry.snapshot || buildInitialSnapshot(routerId);
  const ageMs = getAgeMs(snapshot.snapshotAt);
  return {
    ...snapshot,
    ageMs,
    collectorStatus: resolveCollectorStatus({ ...snapshot, ageMs })
  };
}

async function getRouterSnapshot(routerId = null, options = {}) {
  if (!hasConfiguredRouter(routerId)) {
    removeCollectorEntry(routerId);
    return buildMissingRouterSnapshot(routerId);
  }
  startRouterCollector(routerId);
  const snapshot = getSnapshotWithComputedMeta(routerId);
  if (!snapshot.snapshotAt || options.force === true) {
    return await refreshRouterSnapshot(routerId, { force: true, mode: options.mode || 'full' });
  }
  if ((snapshot.collectorStatus === 'stale' || snapshot.collectorStatus === 'partial') && !getCollectorEntry(routerId).refreshPromise) {
    refreshRouterSnapshot(routerId, { force: true, mode: 'full' }).catch((error) => {
      logger.warn(`[MonitoringCollector] Auto-recovery ${getRouterKey(routerId)} gagal: ${error.message || error}`);
    });
  }
  return snapshot;
}

async function refreshAndGetRouterSnapshot(routerId = null, options = {}) {
  if (!hasConfiguredRouter(routerId)) {
    removeCollectorEntry(routerId);
    return buildMissingRouterSnapshot(routerId);
  }
  startRouterCollector(routerId);
  return await refreshRouterSnapshot(routerId, { force: true, mode: options.mode || 'full' });
}

module.exports = {
  startCollectorService,
  syncConfiguredRouters,
  startRouterCollector,
  getRouterSnapshot,
  refreshRouterSnapshot: refreshAndGetRouterSnapshot,
  getSnapshotWithComputedMeta
};
