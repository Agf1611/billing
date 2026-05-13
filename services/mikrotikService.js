const dns = require('dns');
const { URL } = require('url');
const RosClient = require('ros-client');
const { RouterOSClient } = require('routeros-client');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');

function toKebabCase(key) {
  const s = String(key || '').trim();
  if (!s) return s;
  if (s.includes('-') || s.startsWith('.') || s.startsWith('=') || s.startsWith('?')) return s;
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function toCamelCaseKey(key) {
  return String(key || '').replace(/-([a-z0-9])/g, (_, c) => String(c).toUpperCase());
}

function augmentRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const [k, v] of Object.entries(row)) {
    if (!k || k.startsWith('.') || k.includes('-') === false) continue;
    const camel = toCamelCaseKey(k);
    if (camel && row[camel] === undefined) row[camel] = v;
  }
  return row;
}

function normalizeRouterOsMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'routeros_v6' || raw === 'v6' || raw === 'ros6') return 'routeros_v6';
  if (raw === 'routeros_v7' || raw === 'v7' || raw === 'ros7') return 'routeros_v7';
  return 'auto';
}

class MenuAdapter {
  constructor(api, basePath, filters = []) {
    this.api = api;
    this.basePath = basePath;
    this.filters = filters;
  }

  where(keyOrObj, value) {
    const next = [...this.filters];
    if (keyOrObj && typeof keyOrObj === 'object') {
      for (const [k, v] of Object.entries(keyOrObj)) next.push(this.#toQueryWord(k, v));
    } else {
      next.push(this.#toQueryWord(keyOrObj, value));
    }
    return new MenuAdapter(this.api, this.basePath, next);
  }

  async get(options = {}) {
    const proplist = Array.isArray(options?.proplist)
      ? options.proplist.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const words = [`${this.basePath}/print`];
    if (proplist.length) {
      words.push(`=.proplist=${proplist.join(',')}`);
    }
    words.push(...this.filters);
    const res = await this.api.send(words);
    return Array.isArray(res) ? res.map(augmentRow) : [];
  }

  async getOnly() {
    const rows = await this.get();
    return rows && rows.length ? rows[0] : null;
  }

  async add(data) {
    const words = [`${this.basePath}/add`, ...this.#toSetWords(data)];
    const res = await this.api.send(words);
    return res;
  }

  async set(data, id) {
    const rid = String(id || '').trim();
    const words = [`${this.basePath}/set`, `=.id=${rid}`, ...this.#toSetWords(data)];
    const res = await this.api.send(words);
    return res;
  }

  async remove(id) {
    const rid = String(id || '').trim();
    const words = [`${this.basePath}/remove`, `=.id=${rid}`];
    const res = await this.api.send(words);
    return res;
  }

  async update(data) {
    const rows = await this.get();
    for (const r of rows) {
      const rid = String(r?.['.id'] || '').trim();
      if (!rid) continue;
      await this.set(data, rid);
    }
    return [];
  }

  async exec(command, params) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('Command is required');
    const path = this.basePath === '/' ? `/${cmd}` : `${this.basePath}/${cmd}`;
    const words = [path, ...this.#toSetWords(params)];
    return await this.api.send(words);
  }

  #toQueryWord(key, value) {
    const k = String(key || '').trim();
    const v = value === undefined || value === null ? '' : String(value);
    const kk = k === 'id' ? '.id' : toKebabCase(k);
    return `?${kk}=${v}`;
  }

  #toSetWords(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    for (const [kRaw, vRaw] of Object.entries(data)) {
      if (vRaw === undefined) continue;
      const k = String(kRaw || '').trim();
      if (!k) continue;
      const kk = k === 'id' ? '.id' : toKebabCase(k);
      const v = vRaw === null ? '' : String(vRaw);
      out.push(`=${kk}=${v}`);
    }
    return out;
  }
}

class ClientAdapter {
  constructor(api) {
    this.api = api;
  }

  menu(path) {
    const raw = String(path || '').trim();
    const normalized = raw
      ? ('/' + raw.replace(/^\/+/, '').replace(/\s+/g, '/').replace(/\/+$/g, ''))
      : '/';
    return new MenuAdapter(this.api, normalized);
  }
}

function resolveRouterConfig(routerId = null) {
  let host, port, user, password, routerOsMode;
  const settings = getSettingsWithCache();
  const globalRouterOsMode = normalizeRouterOsMode(settings.mikrotik_os_mode || '');

  if (routerId) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
    if (!router) throw new Error(`Router with ID ${routerId} not found`);
    host = router.host;
    port = router.port || 8728;
    user = router.user;
    password = router.password;
    routerOsMode = normalizeRouterOsMode(router.os_mode || globalRouterOsMode);
  } else {
    host = settings.mikrotik_host;
    port = settings.mikrotik_port || 8728;
    user = settings.mikrotik_user;
    password = settings.mikrotik_password;
    routerOsMode = globalRouterOsMode;
  }

  if (!host || !user) {
    throw new Error('MikroTik settings not configured');
  }

  const useTls = Number(port) === 8729 || settings.mikrotik_tls === true;
  return {
    host,
    port: Number(port) || 8728,
    user,
    password,
    routerOsMode,
    useTls: Boolean(useTls)
  };
}

async function getRosClientConnection(config) {
  const api = new RosClient({
    host: config.host,
    username: config.user,
    password: config.password,
    port: Number(config.port) || 8728,
    tls: Boolean(config.useTls),
    timeout: 10000
  });
  await api.connect();
  const originalClose = typeof api.close === 'function' ? api.close.bind(api) : null;
  const originalDisconnect = typeof api.disconnect === 'function' ? api.disconnect.bind(api) : null;
  api.close = async () => {
    try {
      if (originalClose) return await originalClose();
      if (originalDisconnect) return await originalDisconnect();
    } catch {}
    return undefined;
  };
  if (typeof api.disconnect !== 'function') api.disconnect = api.close;
  return { client: new ClientAdapter(api), api, driver: 'ros-client' };
}

async function getRouterOsClientConnection(config) {
  const api = new RouterOSClient({
    host: config.host,
    port: Number(config.port) || 8728,
    user: config.user,
    password: config.password
  });
  const client = await api.connect();
  return {
    client,
    api: {
      close: async () => {
        try {
          await api.close();
        } catch {}
      }
    },
    driver: 'routeros-client'
  };
}

async function getConnection(routerId = null) {
  const config = resolveRouterConfig(routerId);
  const attempts = [];
  if (config.routerOsMode === 'routeros_v6') {
    attempts.push(['routeros-client', () => getRouterOsClientConnection(config)]);
    attempts.push(['ros-client', () => getRosClientConnection(config)]);
  } else if (config.routerOsMode === 'routeros_v7') {
    attempts.push(['ros-client', () => getRosClientConnection(config)]);
    attempts.push(['routeros-client', () => getRouterOsClientConnection(config)]);
  } else {
    attempts.push(['ros-client', () => getRosClientConnection(config)]);
    attempts.push(['routeros-client', () => getRouterOsClientConnection(config)]);
  }

  let lastError = null;
  for (const [driverName, connectFn] of attempts) {
    try {
      const connection = await connectFn();
      logger.info(`[MikroTik] Connected to ${config.host}:${config.port} via ${driverName} (${config.routerOsMode})`);
      return connection;
    } catch (err) {
      lastError = err;
      logger.warn(`[MikroTik] Connection attempt via ${driverName} failed for ${config.host}:${config.port}: ${err.message}`);
    }
  }

  logger.error(`Failed to connect to MikroTik (${config.host}:${config.port}) after compatibility fallback`, lastError);
  throw lastError || new Error('Gagal terhubung ke MikroTik');
}

async function getPppoeProfilesViaRouterOsClient(routerId = null) {
  return await getMenuRowsViaRouterOsClient(routerId, '/ppp/profile');
}

async function getMenuRowsViaRouterOsClient(routerId = null, menuPath, proplist = []) {
  const conn = await getConnection(routerId);
  try {
    const menu = conn.client.menu(menuPath);
    const results = await menu.get();
    return Array.isArray(results) ? results.map(augmentRow) : [];
  } finally {
    try {
      await conn.api.close();
    } catch {}
  }
}

async function checkConnection(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const identity = await conn.client.menu('/system/identity').getOnly();
    return Boolean(identity && (identity.name || identity['name']));
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('not found')) throw e;
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeProfiles(routerId = null) {
  try {
    const results = await getMenuRowsViaRouterOsClient(
      routerId,
      '/ppp/profile',
      ['.id', 'name', 'local-address', 'remote-address', 'rate-limit', 'only-one']
    );
    return results.map(r => ({
      id: r['.id'],
      name: r.name,
      localAddress: r.localAddress || r['local-address'] || '-',
      remoteAddress: r.remoteAddress || r['remote-address'] || '-',
      rateLimit: r.rateLimit || r['rate-limit'] || '-',
      onlyOne: r.onlyOne || r['only-one'] || '-'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE profiles:', e);
    return [];
  }
}

async function getPppoeUsers(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    // Only get secrets for pppoe service
    const results = await conn.client.menu('/ppp/secret').where('service', 'pppoe').get();
    return results.map(r => ({
      id: r['.id'],
      name: r.name,
      profile: r.profile,
      service: r.service || 'pppoe',
      callerId: r.callerId || r['caller-id'] || '',
      remoteAddress: r.remoteAddress || r['remote-address'] || '',
      localAddress: r.localAddress || r['local-address'] || '',
      comment: r.comment || '',
      disabled: r.disabled === 'true'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Function to isolate a user
async function setPppoeProfile(username, profileName, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const secretMenu = conn.client.menu('/ppp/secret');
    const secrets = await secretMenu.where('name', username).get();
    
    if (!secrets || secrets.length === 0) {
      throw new Error(`PPPoE User ${username} not found in MikroTik`);
    }

    const secret = secrets[0];
    const secretId = secret['.id'] || secret.id;
    if (!secretId) {
      throw new Error(`PPPoE secret ID not found for user ${username}`);
    }
    const currentProfile = secret.profile;

    // Hanya update dan kick jika profil berubah
    if (currentProfile !== profileName) {
      logger.info(`[MikroTik] Changing profile for ${username}: ${currentProfile} -> ${profileName}`);
      await secretMenu.set({ profile: profileName }, secretId);
      
      // Disconnect active connection so they reconnect with new profile
      await kickPppoeUser(username, routerId);
    } else {
      logger.info(`[MikroTik] Profile for ${username} is already ${profileName}. Skipping update and kick.`);
    }

    return true;
  } catch (e) {
    logger.error(`Error setting PPPoE profile for ${username}:`, e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickPppoeUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) {
    logger.warn('[MikroTik] kickPppoeUser called without username. Skipping.');
    return false;
  }
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping PPPoE active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ppp/active').remove(sessionId);
      }
      return true;
    }
    
    logger.info(`[MikroTik] No active PPPoE session found for user: ${normalizedUsername}`);
    return false;
  } catch (e) {
    logger.error(`Error kicking PPPoE user ${normalizedUsername}:`, e);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickHotspotUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return false;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ip/hotspot/active').where('user', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active hotspot session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping Hotspot active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ip/hotspot/active').remove(sessionId);
      }
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Could not kick active hotspot connection for ${normalizedUsername}: ${e.message}`);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeSecrets(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').get();
  } catch (e) {
    logger.error('Error getting PPPoE secrets:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addPppoeSecret(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeSecret(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeSecret(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeActive(routerId = null) {
  try {
    return await getMenuRowsViaRouterOsClient(
      routerId,
      '/ppp/active',
      ['.id', 'name', 'service', 'caller-id', 'address', 'uptime', 'encoding', 'session-id', 'bytes-in', 'bytes-out', 'interface']
    );
  } catch (e) {
    logger.error('Error getting active PPPoE sessions:', e);
    return [];
  }
}

function getPppoeMonitoringRouterKey(routerId = null) {
  const normalizedRouterId = Number(routerId);
  return Number.isFinite(normalizedRouterId) && normalizedRouterId > 0
    ? `router:${normalizedRouterId}`
    : 'default';
}

function normalizePppoeTrackingName(value) {
  return String(value || '').trim();
}

function syncPppoeMonitoringState(routerId = null, secrets = [], activeSessions = []) {
  const routerKey = getPppoeMonitoringRouterKey(routerId);
  const normalizedRouterId = Number(routerId);
  const routerIdValue = Number.isFinite(normalizedRouterId) && normalizedRouterId > 0 ? normalizedRouterId : null;
  const nowIso = new Date().toISOString();
  const trackedNames = new Set();
  const activeNames = new Set();

  for (const secret of Array.isArray(secrets) ? secrets : []) {
    const username = normalizePppoeTrackingName(secret?.name);
    if (username) trackedNames.add(username);
  }
  for (const session of Array.isArray(activeSessions) ? activeSessions : []) {
    const username = normalizePppoeTrackingName(session?.name);
    if (!username) continue;
    trackedNames.add(username);
    activeNames.add(username);
  }

  if (!trackedNames.size) return new Map();

  const usernames = Array.from(trackedNames);
  const placeholders = usernames.map(() => '?').join(', ');
  const existingRows = db.prepare(
    `SELECT router_key, router_id, username, is_online, last_online_at, offline_since, last_logout_at, updated_at
     FROM pppoe_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...usernames);
  const existingMap = new Map(existingRows.map((row) => [String(row.username || '').trim(), row]));

  const upsert = db.prepare(`
    INSERT INTO pppoe_monitoring_state (
      router_key, router_id, username, is_online, last_online_at, offline_since, last_logout_at, updated_at
    ) VALUES (
      @router_key, @router_id, @username, @is_online, @last_online_at, @offline_since, @last_logout_at, @updated_at
    )
    ON CONFLICT(router_key, username) DO UPDATE SET
      router_id = excluded.router_id,
      is_online = excluded.is_online,
      last_online_at = excluded.last_online_at,
      offline_since = excluded.offline_since,
      last_logout_at = excluded.last_logout_at,
      updated_at = excluded.updated_at
  `);

  const transaction = db.transaction((rows) => {
    for (const username of rows) {
      const existing = existingMap.get(username) || null;
      const isOnline = activeNames.has(username);
      const wasOnline = Number(existing?.is_online || 0) === 1;
      let lastOnlineAt = existing?.last_online_at || null;
      let offlineSince = existing?.offline_since || null;
      let lastLogoutAt = existing?.last_logout_at || null;

      if (isOnline) {
        lastOnlineAt = nowIso;
        offlineSince = null;
      } else {
        if (wasOnline) {
          offlineSince = nowIso;
          lastLogoutAt = nowIso;
        } else if (!offlineSince) {
          offlineSince = nowIso;
        }
      }

      upsert.run({
        router_key: routerKey,
        router_id: routerIdValue,
        username,
        is_online: isOnline ? 1 : 0,
        last_online_at: lastOnlineAt,
        offline_since: offlineSince,
        last_logout_at: lastLogoutAt,
        updated_at: nowIso
      });
    }
  });

  transaction(usernames);

  const stateRows = db.prepare(
    `SELECT router_key, router_id, username, is_online, last_online_at, offline_since, last_logout_at, updated_at
     FROM pppoe_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...usernames);

  return new Map(stateRows.map((row) => [String(row.username || '').trim(), row]));
}

function normalizePppoeSnapshotValue(value, fallback = '-') {
  const raw = String(value ?? '').trim();
  return raw ? raw : fallback;
}

function pickPppoeSnapshotText(...values) {
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (raw && raw !== '-') return raw;
  }
  return '';
}

function pickPppoeSnapshotNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function toBooleanLike(value) {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === 'yes' || raw === '1';
}

function withMikrotikTimeout(promise, timeoutMs, fallbackValue = null) {
  const waitMs = Math.max(250, Number(timeoutMs) || 0);
  if (!waitMs) return Promise.resolve(promise).catch(() => fallbackValue);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), waitMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildPppoeCustomerSnapshot({ username, secret, active, profile } = {}) {
  const secretProfile = pickPppoeSnapshotText(secret?.profile);
  const activeAddress = pickPppoeSnapshotText(active?.address, active?.['address']);
  const remoteAddress = pickPppoeSnapshotText(
    secret?.remoteAddress,
    secret?.['remote-address'],
    profile?.remoteAddress,
    profile?.['remote-address'],
    activeAddress
  );
  const localAddress = pickPppoeSnapshotText(
    secret?.localAddress,
    secret?.['local-address'],
    profile?.localAddress,
    profile?.['local-address']
  );
  const profileName = pickPppoeSnapshotText(profile?.name, secretProfile, active?.profile);
  const callerId = pickPppoeSnapshotText(active?.callerId, active?.['caller-id'], secret?.callerId, secret?.['caller-id']);
  const service = pickPppoeSnapshotText(secret?.service, active?.service, 'pppoe');
  const comment = pickPppoeSnapshotText(secret?.comment);
  const rateLimit = pickPppoeSnapshotText(profile?.rateLimit, profile?.['rate-limit']);
  const iface = pickPppoeSnapshotText(active?.interface, active?.['interface-name'], active?.name);
  const uptime = pickPppoeSnapshotText(active?.uptime);
  const sessionId = pickPppoeSnapshotText(active?.['.id'], active?.id);
  const bytesIn = pickPppoeSnapshotNumber(active?.bytesIn, active?.['bytes-in'], active?.bytes_in);
  const bytesOut = pickPppoeSnapshotNumber(active?.bytesOut, active?.['bytes-out'], active?.bytes_out);
  const online = Boolean(active);
  const disabled = toBooleanLike(secret?.disabled);
  const resolvedUsername = pickPppoeSnapshotText(
    username ||
    secret?.name ||
    active?.name ||
    ''
  );

  return {
    username: resolvedUsername,
    secretId: String(secret?.['.id'] || secret?.id || '').trim(),
    profile: profileName,
    service,
    comment: comment || '-',
    disabled,
    online,
    callerId: callerId || '-',
    uptime: uptime || '-',
    interface: iface || '-',
    sessionId: sessionId || '-',
    activeAddress: activeAddress || '-',
    localAddress: localAddress || '-',
    remoteAddress: remoteAddress || '-',
    rateLimit: rateLimit || '-',
    bytesIn,
    bytesOut,
    pppoeIp: activeAddress || remoteAddress || '-',
    statusText: online ? 'Online' : (disabled ? 'Disabled' : 'Offline')
  };
}

async function getPppoeCustomerSnapshot(username, routerId = null, reuseConn = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;

  let conn = reuseConn;
  let ownConn = false;
  try {
    if (!conn) {
      conn = await getConnection(routerId);
      ownConn = true;
    }

    const secretMenu = conn.client.menu('/ppp/secret');

    const [secretRows, activeRowsViaRos, activeRowsViaRouterOs] = await Promise.all([
      secretMenu.where('name', normalizedUsername).get().catch(() => []),
      conn.client.menu('/ppp/active').where('name', normalizedUsername).get().catch(() => []),
      getPppoeActive(routerId).catch(() => [])
    ]);

    const secret = Array.isArray(secretRows) && secretRows.length > 0 ? secretRows[0] : null;
    const activeFromRouterOs = (Array.isArray(activeRowsViaRouterOs) ? activeRowsViaRouterOs : []).find((row) => {
      return String(row?.name || '').trim() === normalizedUsername;
    }) || null;
    const activeFromRos = Array.isArray(activeRowsViaRos) && activeRowsViaRos.length > 0 ? activeRowsViaRos[0] : null;
    const active = (activeFromRouterOs || activeFromRos)
      ? {
          ...(activeFromRos || {}),
          ...(activeFromRouterOs || {}),
          name: pickPppoeSnapshotText(activeFromRouterOs?.name, activeFromRos?.name),
          profile: pickPppoeSnapshotText(activeFromRouterOs?.profile, activeFromRos?.profile),
          address: pickPppoeSnapshotText(activeFromRouterOs?.address, activeFromRos?.address, activeFromRos?.['address']),
          uptime: pickPppoeSnapshotText(activeFromRouterOs?.uptime, activeFromRos?.uptime, activeFromRos?.['uptime']),
          interface: pickPppoeSnapshotText(activeFromRouterOs?.interface, activeFromRos?.interface, activeFromRos?.['interface-name']),
          callerId: pickPppoeSnapshotText(activeFromRouterOs?.callerId, activeFromRouterOs?.['caller-id'], activeFromRos?.callerId, activeFromRos?.['caller-id']),
          bytesIn: pickPppoeSnapshotNumber(activeFromRouterOs?.bytesIn, activeFromRouterOs?.['bytes-in'], activeFromRos?.bytesIn, activeFromRos?.['bytes-in'], activeFromRos?.bytes_in),
          bytesOut: pickPppoeSnapshotNumber(activeFromRouterOs?.bytesOut, activeFromRouterOs?.['bytes-out'], activeFromRos?.bytesOut, activeFromRos?.['bytes-out'], activeFromRos?.bytes_out)
        }
      : null;

    let profile = null;
    const profileName = String(secret?.profile || active?.profile || '').trim();
    if (profileName) {
      const profileRows = await withMikrotikTimeout(
        getPppoeProfilesViaRouterOsClient(routerId).catch(() => []).then((all) => {
          return Array.isArray(all) ? all.filter((row) => String(row?.name || '').trim() === profileName) : [];
        }),
        1200,
        []
      );
      if (Array.isArray(profileRows) && profileRows.length > 0) profile = profileRows[0];
    }

    if (!secret && !active && !profile) return null;
    return buildPppoeCustomerSnapshot({
      username: normalizedUsername,
      secret,
      active,
      profile
    });
  } catch (e) {
    logger.warn(`[MikroTik] getPppoeCustomerSnapshot(${normalizedUsername}) gagal: ${e.message}`);
    return null;
  } finally {
    if (ownConn && conn && conn.api) conn.api.close();
  }
}

async function getHotspotActive(routerId = null) {
  try {
    return await getMenuRowsViaRouterOsClient(
      routerId,
      '/ip/hotspot/active',
      ['.id', 'user', 'address', 'mac-address', 'uptime', 'login-by', 'server']
    );
  } catch (e) {
    logger.error('Error getting active Hotspot sessions:', e);
    return [];
  }
}

// PPPoE Profiles CRUD
async function addPppoeProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').add(data);
  } catch (e) {
    logger.error('Error adding PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').set(data, id);
  } catch (e) {
    logger.error('Error updating PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Hotspot Profiles CRUD (User Profiles)
async function getHotspotUserProfiles(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').get({
      proplist: ['.id', 'name', 'rate-limit', 'shared-users', 'session-timeout', 'on-login']
    });
  } catch (e) {
    logger.error('Error getting Hotspot user profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUserProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').add(data);
  } catch (e) {
    logger.error('Error adding Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUserProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').set(data, id);
  } catch (e) {
    logger.error('Error updating Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUserProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUsers(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').get();
  } catch (e) {
    logger.error('Error getting Hotspot users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUser(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUser(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUser(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getBackup(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/').exec('export');
    return result;
  } catch (e) {
    logger.error('Error exporting MikroTik config:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemScripts(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/system/script').get();
  } catch (e) {
    logger.error('Error getting MikroTik system scripts:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemResource(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/system/resource').get();
    return result[0];
  } catch (e) {
    logger.error('Error getting MikroTik system resource:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotProfiles(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').get();
  } catch (e) {
    logger.error('Error getting Hotspot profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Router CRUD Services
function getAllRouters() {
  return db.prepare('SELECT * FROM routers ORDER BY name ASC').all();
}

function getRouterById(id) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
}

function createRouter(data) {
  const osMode = normalizeRouterOsMode(data.os_mode || data.router_os_mode || data.mikrotik_os_mode || '');
  return db.prepare(`
    INSERT INTO routers (name, host, port, user, password, os_mode, description, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.name, data.host, data.port || 8728, data.user, data.password, osMode, data.description || '', data.is_active || 1);
}

function updateRouter(id, data) {
  const osMode = normalizeRouterOsMode(data.os_mode || data.router_os_mode || data.mikrotik_os_mode || '');
  const existing = getRouterById(id);
  if (!existing) {
    throw new Error(`Router with ID ${id} not found`);
  }
  const nextPassword = String(data.password || '').trim() ? data.password : existing.password;
  return db.prepare(`
    UPDATE routers SET name=?, host=?, port=?, user=?, password=?, os_mode=?, description=?, is_active=?
    WHERE id=?
  `).run(data.name, data.host, data.port || 8728, data.user, nextPassword, osMode, data.description || '', data.is_active || 1, id);
}

function deleteRouter(id) {
  return db.prepare('DELETE FROM routers WHERE id = ?').run(id);
}

/**
 * RouterOS (.rsc) untuk mengarahkan pelanggan di address-list LIST_ISOLIR ke portal billing
 * (HTTP/HTTPS ke IP server sesuai Pengaturan → app_url). Salin ke Terminal / Import.
 * PPPoE: set profil isolir on-up agar IP masuk LIST_ISOLIR (sama seperti tombol Setup Firewall di panel).
 */
function generateIsolirPortalScript() {
  const settings = getSettingsWithCache();
  const raw = String(settings.app_url || '').trim();
  const normalized = raw && /^https?:\/\//i.test(raw) ? raw : (raw ? `https://${raw}` : '');
  let hostname = '';
  let port = 443;
  let isHttps = true;
  try {
    const u = new URL(normalized || 'http://127.0.0.1:4555');
    hostname = u.hostname;
    port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    isHttps = u.protocol === 'https:';
  } catch {
    hostname = 'GANTI-host-portal-billing';
    port = 4555;
    isHttps = false;
  }

  let billingIp = hostname;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    try {
      billingIp = dns.lookupSync(hostname, { family: 4 });
    } catch {
      billingIp = 'GANTI_IP_SERVER_PORTAL';
    }
  }

  const httpServicePort = isHttps ? 80 : port;
  const httpsServicePort = isHttps ? port : 443;

  const lines = [
    '# ============================================================',
    '# Script halaman isolir / portal penagihan (generate Billing)',
    `# Sumber URL: ${normalized || '(atur app_url di Pengaturan)'}`,
    `# Host: ${hostname}  →  IP NAT: ${billingIp}`,
    '# Address-list: LIST_ISOLIR — saat isolir, billing memasang on-up di profil PPPoE (nama = isolir_profile pelanggan).',
    '# Hapus rule lama dengan comment=BILLING_ISOLIR_* sebelum import ulang.',
    '# ============================================================',
    '',
    '# --- DNS ---',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR protocol=udp dst-port=53 action=accept comment="BILLING_ISOLIR_DNS"',
    '',
    '# --- Izinkan akses ke server portal ---',
    `/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR dst-address=${billingIp} action=accept comment="BILLING_ISOLIR_ALLOW"`,
    '',
    '# --- NAT: HTTP menuju portal (untuk redirect ke /isolated, dll.) ---',
    `/ip firewall nat add chain=dstnat protocol=tcp dst-port=80 src-address-list=LIST_ISOLIR action=dst-nat to-addresses=${billingIp} to-ports=${httpServicePort} comment="BILLING_ISOLIR_HTTP"`,
    '',
    '# --- NAT: HTTPS ke portal (jika portal pakai TLS) ---',
    `/ip firewall nat add chain=dstnat protocol=tcp dst-port=443 src-address-list=LIST_ISOLIR action=dst-nat to-addresses=${billingIp} to-ports=${httpsServicePort} comment="BILLING_ISOLIR_HTTPS"`,
    '',
    '# --- Blokir sisa traffic forward dari pelanggan terisolir (opsional; sesuaikan urutan) ---',
    '/ip firewall filter add chain=forward src-address-list=LIST_ISOLIR action=drop comment="BILLING_ISOLIR_BLOCK_REST" disabled=yes',
    '',
    '# --- PPPoE: contoh memasukkan IP ke LIST_ISOLIR saat login (nama profil = isolir) ---',
    '# Jalankan sekali, atau salin ke on-up profil isolir di Winbox:',
    '# /ppp profile set [find name=isolir] on-up="/ip firewall address-list add list=LIST_ISOLIR address=$remote-address comment=$user timeout=23h"',
    '',
  ];

  return {
    script: lines.join('\n'),
    appUrl: normalized || raw,
    billingHost: hostname,
    billingIp,
    httpNatPort: httpServicePort,
    httpsNatPort: httpsServicePort,
  };
}

const ISOLIR_ADDR_LIST = 'LIST_ISOLIR';

/** Nama profil PPPoE isolir yang dipakai pelanggan di router ini (distinct dari DB). */
function getDistinctIsolirProfilesForRouter(routerId) {
  const rid = Number(routerId);
  if (!Number.isFinite(rid) || rid <= 0) return ['BEATISOLIR'];
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(COALESCE(isolir_profile, '')) AS n
    FROM customers
    WHERE router_id = ? AND TRIM(COALESCE(pppoe_username, '')) != ''
  `).all(rid);
  const names = new Set();
  for (const r of rows || []) {
    const n = String(r.n || '').trim();
    names.add(n || 'BEATISOLIR');
  }
  if (names.size === 0) names.add('BEATISOLIR');
  return [...names];
}

/**
 * Pasang on-up / on-down di profil PPPoE (mis. isolir) agar IP pelanggan masuk address-list LIST_ISOLIR
 * saat login — supaya NAT/firewall "halaman isolir" berlaku untuk trafik internet mereka.
 * @param {object|null} reuseConn - hasil getConnection() jika sudah terbuka (mis. dari setupIsolirFirewall).
 */
async function ensurePppProfileIsolirAddressListHook(profileName, routerId = null, reuseConn = null) {
  const name = String(profileName || 'BEATISOLIR').trim() || 'BEATISOLIR';
  let conn = reuseConn;
  let ownConn = false;
  try {
    if (!conn) {
      conn = await getConnection(routerId);
      ownConn = true;
    }
    const menu = conn.client.menu('/ppp/profile');
    const rows = await menu.get();
    const list = Array.isArray(rows) ? rows : [];
    const prof = list.find((r) => String(r.name || '') === name);
    if (!prof) {
      const msg = `Profil PPPoE "${name}" tidak ada di router (buat profil isolir di MikroTik atau samakan nama dengan isolir_profile pelanggan).`;
      logger.warn(`[MikroTik] ${msg}`);
      return { ok: false, profile: name, message: msg };
    }
    const id = prof['.id'] || prof.id;
    if (!id) {
      return { ok: false, profile: name, message: 'ID profil tidak ditemukan' };
    }

    let onUp = prof['on-up'] != null ? String(prof['on-up']) : (prof.onUp != null ? String(prof.onUp) : '');
    let onDown = prof['on-down'] != null ? String(prof['on-down']) : (prof.onDown != null ? String(prof.onDown) : '');
    onUp = onUp.trim();
    onDown = onDown.trim();

    const hookUp =
      `/ip firewall address-list remove [find list=${ISOLIR_ADDR_LIST} address=$remote-address]; ` +
      `/ip firewall address-list add list=${ISOLIR_ADDR_LIST} address=$remote-address comment=$user timeout=23h`;
    const hookDown = `/ip firewall address-list remove [find list=${ISOLIR_ADDR_LIST} address=$remote-address]`;

    const addSnip = `address-list add list=${ISOLIR_ADDR_LIST}`;
    const remSnip = `remove [find list=${ISOLIR_ADDR_LIST}`;
    if (!onUp.includes(addSnip)) {
      onUp = onUp ? `${onUp}; ${hookUp}` : hookUp;
    }
    if (!onDown.includes(remSnip)) {
      onDown = onDown ? `${onDown}; ${hookDown}` : hookDown;
    }

    await menu.set({ 'on-up': onUp, 'on-down': onDown }, id);
    logger.info(`[MikroTik] Profil PPPoE "${name}": on-up/on-down diset untuk ${ISOLIR_ADDR_LIST} (isolir portal).`);
    return { ok: true, profile: name, message: `Profil "${name}" memasukkan IP ke ${ISOLIR_ADDR_LIST} saat PPP login.` };
  } catch (e) {
    logger.error(`[MikroTik] ensurePppProfileIsolirAddressListHook(${name}):`, e);
    return { ok: false, profile: name, message: e.message || String(e) };
  } finally {
    if (ownConn && conn && conn.api) conn.api.close();
  }
}

// --- FIREWALL & ISOLIR STATIC IP ---
async function setupIsolirFirewall(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const settings = getSettingsWithCache();

    /** IP portal (app_url) untuk rule allow — pelanggan isolir tetap bisa DNS + ke server billing saja */
    let billingIp = '';
    try {
      const raw = String(settings.app_url || '').trim();
      const normalized = raw && /^https?:\/\//i.test(raw) ? raw : (raw ? `https://${raw}` : '');
      const u = new URL(normalized || 'http://127.0.0.1');
      let host = u.hostname;
      if (host && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
        host = dns.lookupSync(host, { family: 4 });
      }
      billingIp = host || '';
    } catch (e) {
      logger.warn('[setupIsolirFirewall] app_url tidak valid / tidak bisa di-resolve:', e.message);
    }

    // 1. NAT HTTP (legacy: billing di mesin yang sama port 3002; sesuaikan jika portal remote)
    const natMenu = conn.client.menu('/ip/firewall/nat');
    const existingNat = await natMenu.where('comment', 'ISOLIR_REDIRECT').get();

    if (existingNat.length === 0) {
      await natMenu.add({
        chain: 'dstnat',
        'src-address-list': 'LIST_ISOLIR',
        protocol: 'tcp',
        'dst-port': '80',
        action: 'redirect',
        'to-ports': '3002',
        comment: 'ISOLIR_REDIRECT'
      });
    }

    const filterMenu = conn.client.menu('/ip/firewall/filter');
    let blockRows = await filterMenu.where('comment', 'BLOCK_ISOLIR').get();
    let blockId = blockRows[0] ? (blockRows[0]['.id'] || blockRows[0].id) : null;

    if (!blockId) {
      await filterMenu.add({
        chain: 'forward',
        'src-address-list': 'LIST_ISOLIR',
        action: 'drop',
        comment: 'BLOCK_ISOLIR',
      });
      blockRows = await filterMenu.where('comment', 'BLOCK_ISOLIR').get();
      blockId = blockRows[0] ? (blockRows[0]['.id'] || blockRows[0].id) : null;
    }

    const insertBeforeBlock = async (comment, fields) => {
      if (!blockId) return;
      const ex = await filterMenu.where('comment', comment).get();
      if (ex && ex.length > 0) return;
      await filterMenu.add({ ...fields, comment, 'place-before': blockId });
    };

    await insertBeforeBlock('BILLING_API_ISOLIR_DNS', {
      chain: 'forward',
      'src-address-list': 'LIST_ISOLIR',
      protocol: 'udp',
      'dst-port': '53',
      action: 'accept',
    });
    if (billingIp) {
      await insertBeforeBlock('BILLING_API_ISOLIR_ALLOW', {
        chain: 'forward',
        'src-address-list': 'LIST_ISOLIR',
        'dst-address': billingIp,
        action: 'accept',
      });
    }

    const hookResults = [];
    for (const pname of getDistinctIsolirProfilesForRouter(routerId)) {
      hookResults.push(await ensurePppProfileIsolirAddressListHook(pname, routerId, conn));
    }
    const okNames = hookResults.filter((h) => h.ok).map((h) => h.profile).join(', ');
    const bad = hookResults.filter((h) => !h.ok);
    const warn = bad.length
      ? ` Perhatian: ${bad.map((h) => `${h.profile} (${h.message})`).join('; ')}`
      : '';

    return {
      success: true,
      message: `Firewall isolir + NAT siap. Profil PPPoE di-hook ke ${ISOLIR_ADDR_LIST}: ${okNames || '-'}.${warn}`,
      hooks: hookResults,
    };
  } catch (e) {
    logger.error('Error setupIsolirFirewall:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function manageStaticIp(data, routerId = null) {
  const { ip, name, limit, isolate } = data;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // 1. Manage Simple Queue for Bandwidth
    const queueMenu = conn.client.menu('/queue/simple');
    const existingQueue = await queueMenu.where('target', `${ip}/32`).get();
    
    const queueData = {
      name: `CUST-${name}`,
      target: `${ip}/32`,
      'max-limit': limit || '5M/5M',
      comment: `Managed by Billing - ${name}`
    };

    if (existingQueue.length > 0) {
      await queueMenu.set(queueData, existingQueue[0]['.id']);
    } else {
      await queueMenu.add(queueData);
    }

    // 2. Manage Address List for Isolation
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const existingEntry = await addrListMenu.where('address', ip).where('list', 'LIST_ISOLIR').get();

    if (isolate) {
      if (existingEntry.length === 0) {
        await addrListMenu.add({ list: 'LIST_ISOLIR', address: ip, comment: name });
      }
    } else {
      if (existingEntry.length > 0) {
        await addrListMenu.remove(existingEntry[0]['.id']);
      }
    }

    return true;
  } catch (e) {
    logger.error('Error manageStaticIp:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function removeStaticIp(ip, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // Remove Queue
    const queueMenu = conn.client.menu('/queue/simple');
    const queues = await queueMenu.where('target', `${ip}/32`).get();
    for (const q of queues) await queueMenu.remove(q['.id']);

    // Remove from Address List
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const entries = await addrListMenu.where('address', ip).where('list', 'LIST_ISOLIR').get();
    for (const e of entries) await addrListMenu.remove(e['.id']);

    return true;
  } catch (e) {
    logger.error('Error removeStaticIp:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

module.exports = {
  checkConnection,
  getConnection,
  getPppoeProfiles,
  getPppoeUsers,
  syncPppoeMonitoringState,
  getPppoeCustomerSnapshot,
  buildPppoeCustomerSnapshot,
  setPppoeProfile,
  getPppoeSecrets,
  addPppoeSecret,
  updatePppoeSecret,
  deletePppoeSecret,
  getHotspotUsers,
  addHotspotUser,
  updateHotspotUser,
  deleteHotspotUser,
  getHotspotProfiles,
  getPppoeActive,
  getHotspotActive,
  addPppoeProfile,
  updatePppoeProfile,
  deletePppoeProfile,
  getHotspotUserProfiles,
  addHotspotUserProfile,
  updateHotspotUserProfile,
  deleteHotspotUserProfile,
  getBackup,
  kickPppoeUser,
  kickHotspotUser,
  getSystemResource,
  getSystemScripts,
  getAllRouters,
  getRouterById,
  createRouter,
  updateRouter,
  deleteRouter,
  setupIsolirFirewall,
  ensurePppProfileIsolirAddressListHook,
  generateIsolirPortalScript,
  manageStaticIp,
  removeStaticIp
};
