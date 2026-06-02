const dns = require('dns');
const net = require('net');
const { URL } = require('url');
const RosClient = require('ros-client');
const { RouterOSClient } = require('routeros-client');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const MIKROTIK_CONNECT_TIMEOUT_MS = envNumber('MIKROTIK_CONNECT_TIMEOUT_MS', 1800, 500);
const MIKROTIK_QUEUE_WAIT_TIMEOUT_MS = envNumber('MIKROTIK_QUEUE_WAIT_TIMEOUT_MS', 45000, 5000);
const MIKROTIK_CONNECTION_HOLD_TIMEOUT_MS = envNumber('MIKROTIK_CONNECTION_HOLD_TIMEOUT_MS', 45000, 10000);
const MIKROTIK_SUCCESS_LOG_TTL_MS = envNumber('MIKROTIK_SUCCESS_LOG_TTL_MS', 120000, 30000);
const connectionProbeCache = new Map();
const connectionQueueByRouter = new Map();
const connectionSuccessLogCache = new Map();
const listCache = new Map();
const missingRouterNoticeCache = new Map();
const throttledWarnCache = new Map();

function cacheKey(routerId, name) {
  const rid = routerId == null || String(routerId).trim() === '' ? 'default' : String(routerId).trim();
  return `${name}:${rid}`;
}

function normalizeRouterId(routerId) {
  const normalized = Number(routerId);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function buildRouterNotFoundError(routerId) {
  const normalizedRouterId = normalizeRouterId(routerId);
  const error = new Error(`Router with ID ${normalizedRouterId ?? routerId} not found`);
  error.code = 'ROUTER_NOT_FOUND';
  error.routerId = normalizedRouterId;
  return error;
}

function isRouterNotFoundError(error) {
  return Boolean(error) && (error.code === 'ROUTER_NOT_FOUND' || String(error.message || '').includes('Router with ID'));
}

function logMissingRouterNotice(context, routerId) {
  const normalizedRouterId = normalizeRouterId(routerId);
  if (!normalizedRouterId) return;
  const key = `${context}:${normalizedRouterId}`;
  const now = Date.now();
  const lastLoggedAt = Number(missingRouterNoticeCache.get(key) || 0);
  if ((now - lastLoggedAt) < 60000) return;
  missingRouterNoticeCache.set(key, now);
  logger.warn(`[MikroTik] ${context}: router ${normalizedRouterId} sudah tidak ada. Referensi akan di-skip.`);
}

function logThrottledWarn(key, message, ttlMs = 120000) {
  const cacheKey = String(key || message || 'warning');
  const now = Date.now();
  const lastLoggedAt = Number(throttledWarnCache.get(cacheKey) || 0);
  if ((now - lastLoggedAt) < Math.max(1000, Number(ttlMs) || 0)) return;
  throttledWarnCache.set(cacheKey, now);
  logger.warn(message);
}

function invalidateRouterCaches(routerId = null) {
  const normalizedRouterId = normalizeRouterId(routerId);
  const keyPart = normalizedRouterId == null ? 'default' : String(normalizedRouterId);
  for (const key of Array.from(listCache.keys())) {
    if (String(key).endsWith(`:${keyPart}`)) listCache.delete(key);
  }
  for (const key of Array.from(missingRouterNoticeCache.keys())) {
    if (String(key).endsWith(`:${keyPart}`)) missingRouterNoticeCache.delete(key);
  }
}

function getCachedList(key, ttlMs) {
  const hit = listCache.get(key);
  if (!hit) return null;
  const age = Date.now() - Number(hit.ts || 0);
  if (age >= Math.max(0, Number(ttlMs) || 0)) return null;
  return hit.data;
}

function setCachedList(key, data) {
  listCache.set(key, { ts: Date.now(), data });
}

function invalidateListCaches(routerId, names = []) {
  for (const name of Array.isArray(names) ? names : []) {
    listCache.delete(cacheKey(routerId, name));
  }
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(200, Number(timeoutMs) || 0);
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        clearTimeout(t);
        reject(new Error(`Timeout ${ms}ms${label ? `: ${label}` : ''}`));
      }, ms);
    })
  ]);
}

function buildConnectionQueueKey(config = {}) {
  return [
    String(config.host || '').trim() || 'unknown-host',
    String(config.user || '').trim() || 'unknown-user',
    String(config.port || '').trim() || 'unknown-port'
  ].join(':');
}

async function acquireConnectionQueueSlot(key) {
  const queueKey = String(key || 'default');
  const previous = connectionQueueByRouter.get(queueKey) || Promise.resolve();
  let releaseNext = () => {};
  const next = new Promise((resolve) => {
    releaseNext = resolve;
  });
  const current = previous.catch(() => {}).then(() => next);
  connectionQueueByRouter.set(queueKey, current);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (holdTimer) clearTimeout(holdTimer);
    releaseNext();
    current.finally(() => {
      if (connectionQueueByRouter.get(queueKey) === current) connectionQueueByRouter.delete(queueKey);
    }).catch(() => {});
  };

  let holdTimer = null;
  try {
    await withTimeout(previous.catch(() => {}), MIKROTIK_QUEUE_WAIT_TIMEOUT_MS, `MikroTik queue ${queueKey}`);
  } catch (error) {
    release();
    throw error;
  }

  holdTimer = setTimeout(() => {
    logger.warn(`[MikroTik] Queue slot ${queueKey} ditutup otomatis karena koneksi terlalu lama.`);
    release();
  }, MIKROTIK_CONNECTION_HOLD_TIMEOUT_MS);
  if (typeof holdTimer.unref === 'function') holdTimer.unref();

  return release;
}

function logConnectionSuccess(config, driverName) {
  const key = `${buildConnectionQueueKey(config)}:${driverName}:${config.routerOsMode || 'auto'}`;
  const now = Date.now();
  const last = Number(connectionSuccessLogCache.get(key) || 0);
  if ((now - last) < MIKROTIK_SUCCESS_LOG_TTL_MS) return;
  connectionSuccessLogCache.set(key, now);
  logger.info(`[MikroTik] Connected to ${config.host}:${config.port} via ${driverName} (${config.routerOsMode})`);
}

function attachQueueRelease(connection, release) {
  if (!connection || !connection.api || typeof release !== 'function') return connection;
  const originalClose = typeof connection.api.close === 'function'
    ? connection.api.close.bind(connection.api)
    : null;
  const originalDisconnect = typeof connection.api.disconnect === 'function'
    ? connection.api.disconnect.bind(connection.api)
    : null;

  connection.api.close = async () => {
    try {
      if (originalClose) return await originalClose();
      if (originalDisconnect) return await originalDisconnect();
      return undefined;
    } finally {
      release();
    }
  };
  connection.api.disconnect = connection.api.close;
  return connection;
}

async function canConnectTcp(host, port, timeoutMs = MIKROTIK_CONNECT_TIMEOUT_MS) {
  const h = String(host || '').trim();
  const p = Number(port) || 0;
  if (!h || !p) return false;
  return await new Promise((resolve) => {
    const socket = net.connect({ host: h, port: p });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(Boolean(ok));
    };
    socket.setTimeout(Math.max(200, Number(timeoutMs) || MIKROTIK_CONNECT_TIMEOUT_MS));
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

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

function pickMonitoringCountKey(row, candidates = []) {
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      const computed = String(candidate(row) || '').trim();
      if (computed) return computed;
      continue;
    }
    const value = String(row?.[candidate] || '').trim();
    if (value) return value;
  }
  return '';
}

function countUniqueMonitoringRows(rows = [], candidates = []) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = pickMonitoringCountKey(row, candidates);
    if (!key) continue;
    seen.add(key);
  }
  return seen.size;
}

function normalizeRouterOsMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ros-client' || raw === 'ros_client' || raw === 'rosclient') return 'ros-client';
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
  const normalizedRouterId = normalizeRouterId(routerId);
  const preferredRouter = db.prepare(`
    SELECT *
    FROM routers
    ORDER BY
      CASE WHEN COALESCE(is_active, 0) = 1 THEN 0 ELSE 1 END,
      name ASC,
      id ASC
    LIMIT 1
  `).get();

  if (normalizedRouterId) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(normalizedRouterId);
    if (!router) throw buildRouterNotFoundError(normalizedRouterId);
    host = router.host;
    port = router.port || 8728;
    user = router.user;
    password = router.password;
    routerOsMode = normalizeRouterOsMode(router.os_mode || globalRouterOsMode);
  } else {
    if (preferredRouter) {
      host = preferredRouter.host;
      port = preferredRouter.port || 8728;
      user = preferredRouter.user;
      password = preferredRouter.password;
      routerOsMode = normalizeRouterOsMode(preferredRouter.os_mode || globalRouterOsMode);
    } else {
      host = settings.mikrotik_host;
      port = settings.mikrotik_port || 8728;
      user = settings.mikrotik_user;
      password = settings.mikrotik_password;
      routerOsMode = globalRouterOsMode;
    }
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
    timeout: Math.max(MIKROTIK_CONNECT_TIMEOUT_MS, 5000)
  });
  if (typeof api.on === 'function') {
    api.on('error', (err) => {
      logger.error(`[MikroTik] ros-client error (${config.host}:${config.port}): ${err?.message || err}`);
    });
  }
  await withTimeout(api.connect(), Math.max(MIKROTIK_CONNECT_TIMEOUT_MS, 5000), `ros-client ${config.host}:${config.port}`);
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
  const client = await withTimeout(
    api.connect(),
    Math.max(MIKROTIK_CONNECT_TIMEOUT_MS, 5000),
    `routeros-client ${config.host}:${config.port}`
  ).catch(async (error) => {
    try { await api.close(); } catch {}
    throw error;
  });
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

async function resolveConnectableConfig(baseConfig) {
  const configuredPort = Number(baseConfig?.port) || 8728;
  const fallbackPort = configuredPort === 8728 ? 8729 : 8728;
  const probeKey = `${String(baseConfig?.host || '').trim()}:${String(baseConfig?.user || '').trim()}:${configuredPort}`;
  const now = Date.now();
  const cached = connectionProbeCache.get(probeKey);

  if (cached && cached.failUntil && now < cached.failUntil) {
    const e = new Error(cached.failMessage || `Tidak bisa konek ke MikroTik ${baseConfig.host}:${configuredPort}.`);
    e.code = 'ECONNREFUSED';
    throw e;
  }

  let selectedPort = (cached && cached.okUntil && now < cached.okUntil && cached.port)
    ? Number(cached.port)
    : 0;

  if (!selectedPort) {
    const candidates = configuredPort === fallbackPort ? [configuredPort] : [configuredPort, fallbackPort];
    for (const port of candidates) {
      const ok = await canConnectTcp(baseConfig.host, port, MIKROTIK_CONNECT_TIMEOUT_MS);
      if (ok) {
        selectedPort = port;
        break;
      }
    }
  }

  if (!selectedPort) {
    const failMessage = `Tidak bisa konek ke MikroTik ${baseConfig.host}:${configuredPort} (juga sudah coba ${fallbackPort}). Pastikan API 8728 atau API-SSL 8729 aktif.`;
    connectionProbeCache.set(probeKey, {
      port: 0,
      okUntil: 0,
      failUntil: now + 5000,
      failMessage
    });
    const e = new Error(failMessage);
    e.code = 'ECONNREFUSED';
    throw e;
  }

  connectionProbeCache.set(probeKey, {
    port: selectedPort,
    okUntil: now + 30000,
    failUntil: 0,
    failMessage: ''
  });

  return {
    ...baseConfig,
    port: selectedPort,
    useTls: selectedPort === 8729 || Boolean(baseConfig?.useTls)
  };
}

async function getConnection(routerId = null) {
  const config = await resolveConnectableConfig(resolveRouterConfig(routerId));
  const queueKey = buildConnectionQueueKey(config);
  const releaseQueueSlot = await acquireConnectionQueueSlot(queueKey);
  let releaseOnFailure = true;
  const attempts = [];
  if (config.routerOsMode === 'ros-client') {
    attempts.push(['ros-client', () => getRosClientConnection(config)]);
  } else if (config.routerOsMode === 'routeros_v6') {
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
  try {
    for (const [driverName, connectFn] of attempts) {
      try {
        const connection = await connectFn();
        logConnectionSuccess(config, driverName);
        releaseOnFailure = false;
        return attachQueueRelease(connection, releaseQueueSlot);
      } catch (err) {
        lastError = err;
        const probeKey = `${String(config.host || '').trim()}:${String(config.user || '').trim()}:${String(config.port || '').trim()}`;
        const msg = String(err?.message || err || '');
        if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('EHOSTUNREACH') || msg.includes('Timeout')) {
          connectionProbeCache.set(probeKey, {
            port: 0,
            okUntil: 0,
            failUntil: Date.now() + 15000,
            failMessage: `Tidak bisa konek ke MikroTik ${config.host}:${config.port}. ${msg}`
          });
        }
        logger.warn(`[MikroTik] Connection attempt via ${driverName} failed for ${config.host}:${config.port}: ${err.message}`);
      }
    }

    logger.error(`Failed to connect to MikroTik (${config.host}:${config.port}) after compatibility fallback`, lastError);
    throw lastError || new Error('Gagal terhubung ke MikroTik');
  } finally {
    if (releaseOnFailure) releaseQueueSlot();
  }
}

async function getPppoeProfilesViaRouterOsClient(routerId = null) {
  return await getMenuRowsViaRouterOsClient(routerId, '/ppp/profile');
}

async function getForcedRouterOsConnection(routerId = null) {
  const config = await resolveConnectableConfig(resolveRouterConfig(routerId));
  return await getRouterOsClientConnection(config);
}

async function getForcedRosConnection(routerId = null) {
  const config = await resolveConnectableConfig(resolveRouterConfig(routerId));
  return await getRosClientConnection(config);
}

async function getWriteConnection(routerId = null) {
  const config = await resolveConnectableConfig(resolveRouterConfig(routerId));
  return await getRosClientConnection(config);
}

async function getMenuRowsViaRouterOsClient(routerId = null, menuPath, proplist = []) {
  const options = Array.isArray(proplist) && proplist.length
    ? { proplist: proplist.map((item) => String(item || '').trim()).filter(Boolean) }
    : {};

  let routerOsError = null;
  let conn = null;
  try {
    conn = await getForcedRouterOsConnection(routerId);
    const results = await conn.client.menu(menuPath).get(options);
    return Array.isArray(results) ? results.map(augmentRow) : [];
  } catch (error) {
    routerOsError = error;
    logger.warn(`[MikroTik] RouterOS client read failed for ${menuPath}, fallback to ros-client: ${error.message}`);
  } finally {
    try {
      if (conn && conn.api) await conn.api.close();
    } catch {}
  }

  let fallbackConn = null;
  try {
    fallbackConn = await getForcedRosConnection(routerId);
    const results = await fallbackConn.client.menu(menuPath).get(options);
    return Array.isArray(results) ? results.map(augmentRow) : [];
  } catch (fallbackError) {
    if (routerOsError) fallbackError.cause = routerOsError;
    throw fallbackError;
  } finally {
    try {
      if (fallbackConn && fallbackConn.api) await fallbackConn.api.close();
    } catch {}
  }
}

async function getMenuRowsViaStableConnection(routerId = null, menuPath, proplist = [], optionsOverride = {}) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await getMenuRowsFromOpenConnection(conn, menuPath, proplist, optionsOverride);
  } finally {
    try {
      if (conn && conn.api) await conn.api.close();
    } catch {}
  }
}

async function getMenuRowsFromOpenConnection(conn, menuPath, proplist = [], optionsOverride = {}) {
  const options = Array.isArray(proplist) && proplist.length
    ? { proplist: proplist.map((item) => String(item || '').trim()).filter(Boolean) }
    : {};
  const request = conn.client.menu(menuPath).get(options);
  const timeoutMs = Number(optionsOverride?.timeoutMs || 0) || 0;
  const results = timeoutMs > 0
    ? await withTimeout(request, timeoutMs, optionsOverride?.label || menuPath)
    : await request;
  return Array.isArray(results) ? results.map(augmentRow) : [];
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
  const ck = cacheKey(routerId, 'pppoeProfiles');
  const cached = getCachedList(ck, 15000);
  if (cached) return cached;
  try {
    const results = await getMenuRowsViaStableConnection(
      routerId,
      '/ppp/profile',
      ['.id', 'name', 'local-address', 'remote-address', 'rate-limit', 'only-one']
    );
    const mapped = results.map(r => ({
      id: r['.id'],
      name: r.name,
      localAddress: r.localAddress || r['local-address'] || '-',
      remoteAddress: r.remoteAddress || r['remote-address'] || '-',
      rateLimit: r.rateLimit || r['rate-limit'] || '-',
      onlyOne: r.onlyOne || r['only-one'] || '-'
    }));
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getPppoeProfiles', routerId);
      return [];
    }
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
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getPppoeUsers', routerId);
      return [];
    }
    logger.error('Error getting PPPoE users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Function to isolate a user
async function setPppoeProfile(username, profileName, routerId = null, options = {}) {
  let conn = null;
  let shouldKick = false;
  try {
    conn = await getWriteConnection(routerId);
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
      shouldKick = true;
    } else {
      shouldKick = Boolean(options && options.forceKick);
      logger.info(`[MikroTik] Profile for ${username} is already ${profileName}.${shouldKick ? ' Reconnect tetap dijalankan.' : ' Skipping update and kick.'}`);
    }

    if (conn && conn.api) {
      await conn.api.close();
      conn = null;
    }

    // Buka koneksi baru untuk kick supaya tidak menunggu queue koneksi yang sedang dipakai.
    if (shouldKick) {
      try {
        await kickPppoeUser(username, routerId);
      } catch (kickError) {
        logger.warn(`[MikroTik] Profile ${username} sudah diset ke ${profileName}, tetapi gagal kick sesi aktif: ${kickError.message || String(kickError)}`);
      }
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
    conn = await getWriteConnection(routerId);
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

async function getPppoeSecrets(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const strict = Boolean(options && options.strict);
  const ck = cacheKey(routerId, 'pppoeSecrets');
  const cached = bypassCache ? null : getCachedList(ck, 8000);
  if (cached) return cached;
  try {
    const rows = await getMenuRowsViaStableConnection(routerId, '/ppp/secret');
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getPppoeSecrets', routerId);
      return [];
    }
    logger.error('Error getting PPPoE secrets:', e);
    if (strict) throw e;
    return [];
  }
}

async function addPppoeSecret(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').add(data);
    invalidateListCaches(routerId, ['pppoeSecrets', 'pppoeActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeSecret(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').set(data, id);
    invalidateListCaches(routerId, ['pppoeSecrets', 'pppoeActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeSecret(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/secret').remove(id);
    invalidateListCaches(routerId, ['pppoeSecrets', 'pppoeActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeActive(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const strict = Boolean(options && options.strict);
  const ck = cacheKey(routerId, 'pppoeActive');
  const cached = bypassCache ? null : getCachedList(ck, 10000);
  if (cached) return cached;
  try {
    const activeRows = await getMenuRowsViaStableConnection(
      routerId,
      '/ppp/active',
      ['.id', 'session-id', 'name', 'service', 'address', 'uptime', 'caller-id', 'interface', 'bytes-in', 'bytes-out'],
      { timeoutMs: 15000, label: 'getPppoeActive' }
    );
    const sessions = Array.isArray(activeRows) ? activeRows.map(augmentRow) : [];
    const needsInterfaceStats = sessions.some((row) =>
      (row?.['bytes-in'] === undefined || row?.['bytes-in'] === null || row?.['bytes-in'] === '') &&
      (row?.bytesIn === undefined || row?.bytesIn === null || row?.bytesIn === '') &&
      (row?.['bytes-out'] === undefined || row?.['bytes-out'] === null || row?.['bytes-out'] === '') &&
      (row?.bytesOut === undefined || row?.bytesOut === null || row?.bytesOut === '')
    );

    if (sessions.length) {
      if (needsInterfaceStats) {
        try {
          const interfaceRows = await getMenuRowsViaStableConnection(
            routerId,
            '/interface',
            ['.id', 'name', 'type', 'rx-byte', 'tx-byte', 'running', 'dynamic'],
            { timeoutMs: 12000, label: 'getPppoeInterfaceStats' }
          );
          const interfaceMap = new Map();
          for (const rawRow of Array.isArray(interfaceRows) ? interfaceRows : []) {
            const row = augmentRow(rawRow);
            if (String(row?.type || '').trim() !== 'pppoe-in') continue;
            const interfaceName = String(row?.name || '').trim();
            const match = interfaceName.match(/^<pppoe-(.+)>$/i);
            const username = String(match?.[1] || '').trim();
            if (!username) continue;
            interfaceMap.set(username, row);
          }

          for (const row of sessions) {
            const iface = interfaceMap.get(String(row?.name || '').trim());
            if (!iface) continue;
            const bytesIn = iface['rx-byte'] ?? iface.rxByte ?? '0';
            const bytesOut = iface['tx-byte'] ?? iface.txByte ?? '0';
            if (row['bytes-in'] === undefined || row['bytes-in'] === null || row['bytes-in'] === '') row['bytes-in'] = bytesIn;
            if (row.bytesIn === undefined || row.bytesIn === null || row.bytesIn === '') row.bytesIn = row['bytes-in'];
            if (row['bytes-out'] === undefined || row['bytes-out'] === null || row['bytes-out'] === '') row['bytes-out'] = bytesOut;
            if (row.bytesOut === undefined || row.bytesOut === null || row.bytesOut === '') row.bytesOut = row['bytes-out'];
            if (row.interface === undefined || row.interface === null || row.interface === '') row.interface = iface.name;
          }
        } catch (ifaceErr) {
          logThrottledWarn(
            `pppoe-interface-stats:${cacheKey(routerId, 'pppoeActive')}`,
            `[MikroTik] Failed to enrich PPPoE interface byte counters: ${ifaceErr.message}`,
            120000
          );
        }
      }
      setCachedList(ck, sessions);
      return sessions;
    }

    let interfaceRows = [];
    try {
      interfaceRows = await getMenuRowsViaStableConnection(
        routerId,
        '/interface',
        ['.id', 'name', 'type', 'running', 'dynamic', 'rx-byte', 'tx-byte', 'uptime', 'last-link-up-time', 'last-link-down-time'],
        { timeoutMs: 12000, label: 'getPppoeInterfaceFallback' }
      );
    } catch (ifaceErr) {
      logThrottledWarn(
        `pppoe-interface-fallback:${cacheKey(routerId, 'pppoeActive')}`,
        `[MikroTik] Fallback interface PPPoE tidak terbaca setelah /ppp/active kosong: ${ifaceErr.message || String(ifaceErr)}`,
        120000
      );
    }
    const fallbackSessions = [];
    for (const rawRow of Array.isArray(interfaceRows) ? interfaceRows : []) {
      const row = augmentRow(rawRow);
      if (String(row?.type || '').trim() !== 'pppoe-in') continue;
      if (String(row?.running || '').trim() !== 'true' && row?.running !== true) continue;
      const interfaceName = String(row?.name || '').trim();
      const match = interfaceName.match(/^<pppoe-(.+)>$/i);
      const username = String(match?.[1] || '').trim();
      if (!username) continue;
      const bytesIn = row['rx-byte'] ?? row.rxByte ?? '0';
      const bytesOut = row['tx-byte'] ?? row.txByte ?? '0';
      fallbackSessions.push(augmentRow({
        '.id': row['.id'] || row.id || interfaceName,
        name: username,
        service: 'pppoe',
        interface: interfaceName,
        uptime: row.uptime || row['uptime'] || row['last-link-up-time'] || '',
        'bytes-in': bytesIn,
        bytesIn,
        'bytes-out': bytesOut,
        bytesOut,
        address: row.address || row['address'] || '',
        callerId: row.callerId || row['caller-id'] || ''
      }));
    }

    setCachedList(ck, fallbackSessions);
    return fallbackSessions;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getPppoeActive', routerId);
      return [];
    }
    logger.error('Error getting active PPPoE sessions:', e);
    if (strict) throw e;
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
  const activeByName = new Map();

  for (const secret of Array.isArray(secrets) ? secrets : []) {
    const username = normalizePppoeTrackingName(secret?.name);
    if (username) trackedNames.add(username);
  }
  for (const session of Array.isArray(activeSessions) ? activeSessions : []) {
    const username = normalizePppoeTrackingName(session?.name);
    if (!username) continue;
    trackedNames.add(username);
    activeNames.add(username);
    activeByName.set(username, augmentRow(session));
  }

  if (!trackedNames.size) return new Map();

  const usernames = Array.from(trackedNames);
  const placeholders = usernames.map(() => '?').join(', ');
  const existingRows = db.prepare(
    `SELECT router_key, router_id, username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
     FROM pppoe_monitoring_state
     WHERE router_key = ? AND username IN (${placeholders})`
  ).all(routerKey, ...usernames);
  const existingMap = new Map(existingRows.map((row) => [String(row.username || '').trim(), row]));

  const upsert = db.prepare(`
    INSERT INTO pppoe_monitoring_state (
      router_key, router_id, username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
    ) VALUES (
      @router_key, @router_id, @username, @is_online, @profile_name, @remote_address, @session_uptime, @last_online_at, @offline_since, @last_logout_at, @updated_at
    )
    ON CONFLICT(router_key, username) DO UPDATE SET
      router_id = excluded.router_id,
      is_online = excluded.is_online,
      profile_name = excluded.profile_name,
      remote_address = excluded.remote_address,
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
      const profileName = pickPppoeSnapshotText(active?.profile, existing?.profile_name) || null;
      const remoteAddress = pickPppoeSnapshotText(active?.address, existing?.remote_address) || null;
      const sessionUptime = pickPppoeSnapshotText(active?.uptime, existing?.session_uptime) || null;
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
        profile_name: profileName,
        remote_address: remoteAddress,
        session_uptime: sessionUptime,
        last_online_at: lastOnlineAt,
        offline_since: offlineSince,
        last_logout_at: lastLogoutAt,
        updated_at: nowIso
      });
    }
  });

  transaction(usernames);

  const stateRows = db.prepare(
    `SELECT router_key, router_id, username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function readNumberValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const normalized = String(value).replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeInterfaceRow(row = {}) {
  const r = augmentRow(row && typeof row === 'object' ? row : {});
  return {
    id: String(r['.id'] || r.id || '').trim(),
    name: String(r.name || '').trim(),
    type: String(r.type || '').trim(),
    running: toBooleanLike(r.running),
    disabled: toBooleanLike(r.disabled),
    dynamic: toBooleanLike(r.dynamic),
    comment: String(r.comment || '').trim(),
    macAddress: String(r.macAddress || r['mac-address'] || '').trim(),
    mtu: String(r.mtu || '').trim(),
    rxByte: readNumberValue(r.rxByte, r['rx-byte']),
    txByte: readNumberValue(r.txByte, r['tx-byte']),
    rxPacket: readNumberValue(r.rxPacket, r['rx-packet']),
    txPacket: readNumberValue(r.txPacket, r['tx-packet'])
  };
}

async function getInterfaces(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const ck = cacheKey(routerId, 'interfaces');
  const cached = bypassCache ? null : getCachedList(ck, 5000);
  if (cached) return cached;
  try {
    const rows = await getMenuRowsViaStableConnection(
      routerId,
      '/interface',
      ['.id', 'name', 'type', 'running', 'disabled', 'dynamic', 'comment', 'mac-address', 'mtu', 'rx-byte', 'tx-byte', 'rx-packet', 'tx-packet']
    );
    const mapped = (Array.isArray(rows) ? rows : [])
      .map(normalizeInterfaceRow)
      .filter((row) => row.name && !String(row.name).startsWith('<pppoe-'));
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getInterfaces', routerId);
      return [];
    }
    logger.error('Error getting MikroTik interfaces:', e);
    return [];
  }
}

async function readInterfaceCounter(routerId = null, interfaceName = '') {
  const target = String(interfaceName || '').trim();
  if (!target) return null;
  const rows = await getMenuRowsViaStableConnection(
    routerId,
    '/interface',
    ['.id', 'name', 'type', 'running', 'disabled', 'rx-byte', 'tx-byte', 'rx-packet', 'tx-packet']
  );
  const match = (Array.isArray(rows) ? rows : []).find((row) => String(row?.name || '').trim() === target);
  return match ? normalizeInterfaceRow(match) : null;
}

function normalizeTrafficMonitorRow(row = {}, iface = {}) {
  const r = augmentRow(row && typeof row === 'object' ? row : {});
  const rxBps = readNumberValue(
    r.rxBitsPerSecond,
    r['rx-bits-per-second'],
    r.rxBps,
    r['rx-bps']
  );
  const txBps = readNumberValue(
    r.txBitsPerSecond,
    r['tx-bits-per-second'],
    r.txBps,
    r['tx-bps']
  );
  return {
    interface: String(r.name || r.interface || iface.name || '').trim(),
    type: String(iface.type || r.type || '').trim(),
    running: iface.running === true || toBooleanLike(r.running),
    disabled: iface.disabled === true || toBooleanLike(r.disabled),
    rxBps,
    txBps,
    rxMbps: rxBps / 1000000,
    txMbps: txBps / 1000000,
    rxByte: readNumberValue(iface.rxByte, r.rxByte, r['rx-byte']),
    txByte: readNumberValue(iface.txByte, r.txByte, r['tx-byte']),
    sampledAt: new Date().toISOString(),
    source: 'monitor-traffic',
    raw: r
  };
}

async function getInterfaceTraffic(routerId = null, interfaceName = '') {
  const target = String(interfaceName || '').trim();
  if (!target) throw new Error('Interface wajib dipilih');
  let conn = null;
  try {
    const iface = await readInterfaceCounter(routerId, target);
    if (!iface) throw new Error(`Interface ${target} tidak ditemukan`);

    try {
      conn = await getConnection(routerId);
      const rows = await withTimeout(
        conn.client.menu('/interface').exec('monitor-traffic', { interface: target, once: '' }),
        6500,
        `monitor traffic ${target}`
      );
      const row = Array.isArray(rows) && rows.length ? rows[0] : rows;
      const normalized = normalizeTrafficMonitorRow(row, iface);
      if (normalized.rxBps > 0 || normalized.txBps > 0) return normalized;
    } catch (monitorErr) {
      logger.warn(`[MikroTik] monitor-traffic ${target} gagal, fallback counter delta: ${monitorErr.message}`);
    } finally {
      try {
        if (conn && conn.api) await conn.api.close();
      } catch {}
      conn = null;
    }

    const before = iface;
    await sleep(1200);
    const after = await readInterfaceCounter(routerId, target);
    if (!after) throw new Error(`Interface ${target} tidak ditemukan`);
    const elapsed = 1.2;
    const rxBps = Math.max(0, ((Number(after.rxByte || 0) - Number(before.rxByte || 0)) * 8) / elapsed);
    const txBps = Math.max(0, ((Number(after.txByte || 0) - Number(before.txByte || 0)) * 8) / elapsed);
    return {
      interface: target,
      type: after.type || before.type || '',
      running: after.running,
      disabled: after.disabled,
      rxBps,
      txBps,
      rxMbps: rxBps / 1000000,
      txMbps: txBps / 1000000,
      rxByte: after.rxByte,
      txByte: after.txByte,
      sampledAt: new Date().toISOString(),
      source: 'counter-delta'
    };
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getInterfaceTraffic', routerId);
    }
    throw e;
  } finally {
    try {
      if (conn && conn.api) await conn.api.close();
    } catch {}
  }
}

async function getPppoeCustomerSync(routerId = null, options = {}) {
  const secrets = await getPppoeUsers(routerId, { bypassCache: Boolean(options?.bypassCache) });
  const rows = db.prepare(`
    SELECT id, name, phone, status, router_id, pppoe_username, genieacs_tag
    FROM customers
    WHERE pppoe_username IS NOT NULL
      AND TRIM(pppoe_username) != ''
      AND (? IS NULL OR router_id IS ?)
    ORDER BY name ASC
  `).all(routerId, routerId);

  const normalizeKey = (value) => String(value || '').trim().toLowerCase();
  const customersByPppoe = new Map();
  for (const customer of rows) {
    const key = normalizeKey(customer.pppoe_username);
    if (!key || customersByPppoe.has(key)) continue;
    customersByPppoe.set(key, customer);
  }

  const secretsByName = new Map();
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    const key = normalizeKey(secret?.name);
    if (!key || secretsByName.has(key)) continue;
    secretsByName.set(key, secret);
  }

  const matched = [];
  const routerOnly = [];
  const customerOnly = [];

  for (const [key, secret] of secretsByName.entries()) {
    const customer = customersByPppoe.get(key);
    if (customer) {
      matched.push({
        username: secret.name,
        profile: secret.profile || '',
        disabled: Boolean(secret.disabled),
        customer
      });
    } else {
      routerOnly.push({
        username: secret.name,
        profile: secret.profile || '',
        disabled: Boolean(secret.disabled),
        remoteAddress: secret.remoteAddress || ''
      });
    }
  }

  for (const [key, customer] of customersByPppoe.entries()) {
    if (secretsByName.has(key)) continue;
    customerOnly.push({
      username: customer.pppoe_username,
      customer
    });
  }

  return {
    summary: {
      matched: matched.length,
      routerOnly: routerOnly.length,
      customerOnly: customerOnly.length,
      totalSecrets: secretsByName.size,
      totalCustomersWithPppoe: customersByPppoe.size
    },
    matched,
    routerOnly,
    customerOnly,
    checkedAt: new Date().toISOString()
  };
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
  const sessionId = pickPppoeSnapshotText(active?.['session-id'], active?.sessionId, active?.['.id'], active?.id);
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

  if (reuseConn) {
    try {
      const [secretRows, activeRows] = await Promise.all([
        reuseConn.client.menu('/ppp/secret').where('name', normalizedUsername).get().catch(() => []),
        reuseConn.client.menu('/ppp/active').where('name', normalizedUsername).get().catch(() => [])
      ]);
      const secret = Array.isArray(secretRows) && secretRows.length > 0 ? augmentRow(secretRows[0]) : null;
      const activeBase = Array.isArray(activeRows) && activeRows.length > 0 ? augmentRow(activeRows[0]) : null;
      const active = activeBase ? {
        ...activeBase,
        address: pickPppoeSnapshotText(activeBase?.address, activeBase?.['address']),
        uptime: pickPppoeSnapshotText(activeBase?.uptime, activeBase?.['uptime']),
        interface: pickPppoeSnapshotText(activeBase?.interface, activeBase?.['interface-name']),
        callerId: pickPppoeSnapshotText(activeBase?.callerId, activeBase?.['caller-id']),
        bytesIn: pickPppoeSnapshotNumber(activeBase?.bytesIn, activeBase?.['bytes-in'], activeBase?.bytes_in),
        bytesOut: pickPppoeSnapshotNumber(activeBase?.bytesOut, activeBase?.['bytes-out'], activeBase?.bytes_out)
      } : null;
      if (!secret && !active) return null;
      return buildPppoeCustomerSnapshot({ username: normalizedUsername, secret, active, profile: null });
    } catch (e) {
      logger.warn(`[MikroTik] getPppoeCustomerSnapshot(reuse:${normalizedUsername}) gagal: ${e.message}`);
    }
  }

  const config = resolveRouterConfig(routerId);
  const attempts = [];
  if (config.routerOsMode === 'ros-client') {
    attempts.push('ros-client');
  } else if (config.routerOsMode === 'routeros_v6') {
    attempts.push('routeros-client', 'ros-client');
  } else if (config.routerOsMode === 'routeros_v7') {
    attempts.push('ros-client', 'routeros-client');
  } else {
    attempts.push('ros-client', 'routeros-client');
  }

  for (const driverName of attempts) {
    if (driverName === 'ros-client') {
      const api = new RosClient({
        host: config.host,
        username: config.user,
        password: config.password,
        port: Number(config.port) || 8728,
        tls: Boolean(config.useTls),
        timeout: MIKROTIK_CONNECT_TIMEOUT_MS
      });
      try {
        await api.connect();
        const [secretRows, activeRows] = await Promise.all([
          api.send(['/ppp/secret/print', `?name=${normalizedUsername}`]).catch(() => []),
          api.send(['/ppp/active/print', `?name=${normalizedUsername}`]).catch(() => [])
        ]);
        const secret = Array.isArray(secretRows) && secretRows.length > 0 ? augmentRow(secretRows[0]) : null;
        const activeBase = Array.isArray(activeRows) && activeRows.length > 0 ? augmentRow(activeRows[0]) : null;
        const active = activeBase ? {
          ...activeBase,
          address: pickPppoeSnapshotText(activeBase?.address, activeBase?.['address']),
          uptime: pickPppoeSnapshotText(activeBase?.uptime, activeBase?.['uptime']),
          interface: pickPppoeSnapshotText(activeBase?.interface, activeBase?.['interface-name']),
          callerId: pickPppoeSnapshotText(activeBase?.callerId, activeBase?.['caller-id']),
          bytesIn: pickPppoeSnapshotNumber(activeBase?.bytesIn, activeBase?.['bytes-in'], activeBase?.bytes_in),
          bytesOut: pickPppoeSnapshotNumber(activeBase?.bytesOut, activeBase?.['bytes-out'], activeBase?.bytes_out)
        } : null;
        if (secret || active) {
          return buildPppoeCustomerSnapshot({ username: normalizedUsername, secret, active, profile: null });
        }
      } catch (e) {
        logger.warn(`[MikroTik] ros-client snapshot ${normalizedUsername} gagal: ${e.message}`);
      } finally {
        try { await api.close(); } catch {
          try { await api.disconnect(); } catch {}
        }
      }
      continue;
    }

    let conn = null;
    try {
      conn = await getRouterOsClientConnection(config);
      const [secretRows, activeRows] = await Promise.all([
        conn.client.menu('/ppp/secret').where('name', normalizedUsername).get().catch(() => []),
        conn.client.menu('/ppp/active').where('name', normalizedUsername).get().catch(() => [])
      ]);
      const secret = Array.isArray(secretRows) && secretRows.length > 0 ? augmentRow(secretRows[0]) : null;
      const activeBase = Array.isArray(activeRows) && activeRows.length > 0 ? augmentRow(activeRows[0]) : null;
      const active = activeBase ? {
        ...activeBase,
        address: pickPppoeSnapshotText(activeBase?.address, activeBase?.['address']),
        uptime: pickPppoeSnapshotText(activeBase?.uptime, activeBase?.['uptime']),
        interface: pickPppoeSnapshotText(activeBase?.interface, activeBase?.['interface-name']),
        callerId: pickPppoeSnapshotText(activeBase?.callerId, activeBase?.['caller-id']),
        bytesIn: pickPppoeSnapshotNumber(activeBase?.bytesIn, activeBase?.['bytes-in'], activeBase?.bytes_in),
        bytesOut: pickPppoeSnapshotNumber(activeBase?.bytesOut, activeBase?.['bytes-out'], activeBase?.bytes_out)
      } : null;
      if (secret || active) {
        return buildPppoeCustomerSnapshot({ username: normalizedUsername, secret, active, profile: null });
      }
    } catch (e) {
      logger.warn(`[MikroTik] routeros-client snapshot ${normalizedUsername} gagal: ${e.message}`);
    } finally {
      if (conn?.api) {
        try { await conn.api.close(); } catch {}
      }
    }
  }

  return null;
}

async function getHotspotActive(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const strict = Boolean(options && options.strict);
  const ck = cacheKey(routerId, 'hotspotActive');
  const cached = bypassCache ? null : getCachedList(ck, 10000);
  if (cached) return cached;
  try {
    const rows = await getMenuRowsViaStableConnection(
      routerId,
      '/ip/hotspot/active',
      ['.id', 'user', 'address', 'mac-address', 'uptime', 'login-by', 'server'],
      { timeoutMs: 8000, label: 'getHotspotActive' }
    );
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getHotspotActive', routerId);
      return [];
    }
    logThrottledWarn(
      `hotspot-active:${ck}`,
      `[MikroTik] Active Hotspot sessions tidak terbaca: ${e.message || String(e)}`,
      180000
    );
    if (strict) throw e;
    return [];
  }
}

async function getMonitoringSnapshot(routerId = null, options = {}) {
  const strict = Boolean(options?.strict);
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sectionErrors = {};
    const readSection = async (section, menuPath, proplist, readOptions) => {
      try {
        return await getMenuRowsFromOpenConnection(conn, menuPath, proplist, readOptions);
      } catch (sectionError) {
        sectionErrors[section] = sectionError;
        logThrottledWarn(
          `monitoring-snapshot-section:${cacheKey(routerId, section)}`,
          `[MikroTik] Snapshot section ${section} gagal dibaca: ${sectionError.message || String(sectionError)}`,
          120000
        );
        return [];
      }
    };

    const secrets = await readSection(
      'pppoeSecretsRaw',
      '/ppp/secret',
      ['.id', 'name', 'service', 'disabled', 'profile', 'local-address', 'remote-address', 'comment'],
      { timeoutMs: 15000, label: 'monitoringSnapshotSecrets' }
    );
    const activeRows = await readSection(
      'pppoeActiveRaw',
      '/ppp/active',
      ['.id', 'session-id', 'name', 'service', 'address', 'uptime', 'caller-id', 'interface', 'bytes-in', 'bytes-out'],
      { timeoutMs: 15000, label: 'monitoringSnapshotPppoeActive' }
    );
    let activePppoe = Array.isArray(activeRows) ? activeRows.map(augmentRow) : [];

    if (!activePppoe.length) {
      try {
        const interfaceRows = await getMenuRowsFromOpenConnection(
          conn,
          '/interface',
          ['.id', 'name', 'type', 'running', 'dynamic', 'rx-byte', 'tx-byte', 'uptime', 'last-link-up-time', 'last-link-down-time'],
          { timeoutMs: 12000, label: 'monitoringSnapshotPppoeInterfaceFallback' }
        );
        const fallbackSessions = [];
        for (const rawRow of Array.isArray(interfaceRows) ? interfaceRows : []) {
          const row = augmentRow(rawRow);
          if (String(row?.type || '').trim() !== 'pppoe-in') continue;
          if (String(row?.running || '').trim() !== 'true' && row?.running !== true) continue;
          const interfaceName = String(row?.name || '').trim();
          const match = interfaceName.match(/^<pppoe-(.+)>$/i);
          const username = String(match?.[1] || '').trim();
          if (!username) continue;
          const bytesIn = row['rx-byte'] ?? row.rxByte ?? '0';
          const bytesOut = row['tx-byte'] ?? row.txByte ?? '0';
          fallbackSessions.push(augmentRow({
            '.id': row['.id'] || row.id || interfaceName,
            name: username,
            service: 'pppoe',
            interface: interfaceName,
            uptime: row.uptime || row['uptime'] || row['last-link-up-time'] || '',
            'bytes-in': bytesIn,
            bytesIn,
            'bytes-out': bytesOut,
            bytesOut,
            address: row.address || row['address'] || '',
            callerId: row.callerId || row['caller-id'] || ''
          }));
        }
        activePppoe = fallbackSessions;
        delete sectionErrors.pppoeActiveRaw;
      } catch (ifaceErr) {
        logThrottledWarn(
          `monitoring-snapshot-pppoe-interface:${cacheKey(routerId, 'pppoeActive')}`,
          `[MikroTik] Snapshot fallback interface PPPoE tidak terbaca setelah /ppp/active kosong: ${ifaceErr.message || String(ifaceErr)}`,
          120000
        );
      }
    }

    const hotspotUsers = await readSection(
      'hotspotUsersRaw',
      '/ip/hotspot/user',
      [],
      { timeoutMs: 15000, label: 'monitoringSnapshotHotspotUsers' }
    );
    const hotspotActive = await readSection(
      'hotspotActiveRaw',
      '/ip/hotspot/active',
      ['.id', 'user', 'address', 'mac-address', 'uptime', 'login-by', 'server'],
      { timeoutMs: 10000, label: 'monitoringSnapshotHotspotActive' }
    );

    if (!sectionErrors.pppoeSecretsRaw) setCachedList(cacheKey(routerId, 'pppoeSecrets'), secrets);
    if (!sectionErrors.pppoeActiveRaw) setCachedList(cacheKey(routerId, 'pppoeActive'), activePppoe);
    if (!sectionErrors.hotspotUsersRaw) setCachedList(cacheKey(routerId, 'hotspotUsers'), hotspotUsers);
    if (!sectionErrors.hotspotActiveRaw) setCachedList(cacheKey(routerId, 'hotspotActive'), hotspotActive);

    return {
      secrets: Array.isArray(secrets) ? secrets : [],
      activePppoe: Array.isArray(activePppoe) ? activePppoe : [],
      hotspotUsers: Array.isArray(hotspotUsers) ? hotspotUsers : [],
      hotspotActive: Array.isArray(hotspotActive) ? hotspotActive : [],
      sectionErrors,
      source: 'single-connection-live'
    };
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getMonitoringSnapshot', routerId);
      return { secrets: [], activePppoe: [], hotspotUsers: [], hotspotActive: [], source: 'router-missing' };
    }
    logger.error('Error getting MikroTik monitoring snapshot:', e);
    if (strict) throw e;
    return { secrets: [], activePppoe: [], hotspotUsers: [], hotspotActive: [], source: 'snapshot-failed' };
  } finally {
    try {
      if (conn && conn.api) await conn.api.close();
    } catch {}
  }
}

async function getMonitoringSummary(routerId = null) {
    try {
      const secrets = await withMikrotikTimeout(getPppoeSecrets(routerId, { bypassCache: true }), 10000, []);
      const activePppoe = await withMikrotikTimeout(getPppoeActive(routerId, { bypassCache: true }), 12000, []);
      const hotspotUsers = await withMikrotikTimeout(getHotspotUsers(routerId, { bypassCache: true }), 10000, []);
      const activeHotspot = await withMikrotikTimeout(getHotspotActive(routerId, { bypassCache: true }), 12000, []);
      const snapshotSource = 'direct-live-services';

      return {
        pppoeOnline: Array.isArray(activePppoe) ? activePppoe.length : 0,
        hotspotOnline: Array.isArray(activeHotspot) ? activeHotspot.length : 0,
        totalSecrets: Array.isArray(secrets) ? secrets.length : 0,
        totalHotspot: Array.isArray(hotspotUsers) ? hotspotUsers.length : 0,
        source: snapshotSource
      };
    } catch (e) {
      logger.error('Error getting MikroTik monitoring summary:', e);
      throw e;
    }
}

// PPPoE Profiles CRUD
async function addPppoeProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ppp/profile').add(data);
    invalidateListCaches(routerId, ['pppoeProfiles']);
    return res;
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
    const res = await conn.client.menu('/ppp/profile').set(data, id);
    invalidateListCaches(routerId, ['pppoeProfiles']);
    return res;
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
    const res = await conn.client.menu('/ppp/profile').remove(id);
    invalidateListCaches(routerId, ['pppoeProfiles']);
    return res;
  } catch (e) {
    logger.error('Error deleting PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Hotspot Profiles CRUD (User Profiles)
async function getHotspotUserProfiles(routerId = null) {
  const ck = cacheKey(routerId, 'hotspotUserProfiles');
  const cached = getCachedList(ck, 30000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const results = await conn.client.menu('/ip/hotspot/user/profile').get({
      proplist: ['.id', 'name', 'rate-limit', 'shared-users', 'session-timeout', 'on-login']
    });
    const mapped = Array.isArray(results) ? results.map(augmentRow) : [];
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getHotspotUserProfiles', routerId);
      return [];
    }
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
    const res = await conn.client.menu('/ip/hotspot/user/profile').add(data);
    invalidateListCaches(routerId, ['hotspotUserProfiles']);
    return res;
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
    const res = await conn.client.menu('/ip/hotspot/user/profile').set(data, id);
    invalidateListCaches(routerId, ['hotspotUserProfiles']);
    return res;
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
    const res = await conn.client.menu('/ip/hotspot/user/profile').remove(id);
    invalidateListCaches(routerId, ['hotspotUserProfiles']);
    return res;
  } catch (e) {
    logger.error('Error deleting Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUsers(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const strict = Boolean(options && options.strict);
  const ck = cacheKey(routerId, 'hotspotUsers');
  const cached = bypassCache ? null : getCachedList(ck, 15000);
  if (cached) return cached;
  try {
    const rows = await getMenuRowsViaStableConnection(routerId, '/ip/hotspot/user', [], { timeoutMs: 15000, label: 'getHotspotUsers' });
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getHotspotUsers', routerId);
      return [];
    }
    logThrottledWarn(
      `hotspot-users:${ck}`,
      `[MikroTik] Hotspot users tidak terbaca: ${e.message || String(e)}`,
      180000
    );
    if (strict) throw e;
    return [];
  }
}

async function addHotspotUser(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').add(data);
    invalidateListCaches(routerId, ['hotspotUsers', 'hotspotActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUser(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').set(data, id);
    invalidateListCaches(routerId, ['hotspotUsers', 'hotspotActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUser(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/user').remove(id);
    invalidateListCaches(routerId, ['hotspotUsers', 'hotspotActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

function normalizeHotspotBindingRow(row = {}) {
  const r = augmentRow(row && typeof row === 'object' ? row : {});
  return {
    id: String(r.id || r['.id'] || '').trim(),
    macAddress: String(r.macAddress || r['mac-address'] || '').trim(),
    address: String(r.address || '').trim(),
    toAddress: String(r.toAddress || r['to-address'] || '').trim(),
    server: String(r.server || '').trim(),
    type: String(r.type || '').trim(),
    comment: String(r.comment || '').trim(),
    disabled: toBooleanLike(r.disabled),
    dynamic: toBooleanLike(r.dynamic)
  };
}

async function getHotspotIpBindings(routerId = null, options = {}) {
  const bypassCache = Boolean(options && options.bypassCache);
  const ck = cacheKey(routerId, 'hotspotIpBindings');
  const cached = bypassCache ? null : getCachedList(ck, 15000);
  if (cached) return cached;
  try {
    const rows = await getMenuRowsViaStableConnection(routerId, '/ip/hotspot/ip-binding', [], { timeoutMs: 15000, label: 'getHotspotIpBindings' });
    const mapped = (Array.isArray(rows) ? rows : []).map(normalizeHotspotBindingRow);
    setCachedList(ck, mapped);
    return mapped;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getHotspotIpBindings', routerId);
      return [];
    }
    logThrottledWarn(
      `hotspot-ip-binding:${ck}`,
      `[MikroTik] Hotspot IP binding tidak terbaca: ${e.message || String(e)}`,
      180000
    );
    return [];
  }
}

async function updateHotspotIpBinding(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/ip-binding').set(data, id);
    invalidateListCaches(routerId, ['hotspotIpBindings', 'hotspotActive']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

function normalizeMacText(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
}

function normalizeIpText(value) {
  return String(value || '').trim();
}

function normalizeHotspotUserRow(row = {}) {
  const r = augmentRow(row && typeof row === 'object' ? row : {});
  return {
    id: String(r.id || r['.id'] || '').trim(),
    name: String(r.name || '').trim(),
    profile: String(r.profile || '').trim(),
    comment: String(r.comment || '').trim(),
    disabled: toBooleanLike(r.disabled)
  };
}

async function setHotspotBindingCustomerAccess(customer = {}, enabled = true) {
  const routerId = customer.router_id || null;
  const username = String(customer.hotspot_username || '').trim();
  const bindingId = String(customer.hotspot_binding_id || '').trim();
  const targetMac = normalizeMacText(customer.mac_address);
  const targetIp = normalizeIpText(customer.static_ip);
  const desiredDisabled = enabled ? 'false' : 'true';
  const touched = { users: 0, bindings: 0 };

  if (username) {
    const users = await getHotspotUsers(routerId, { bypassCache: true });
    const hit = (Array.isArray(users) ? users : [])
      .map(normalizeHotspotUserRow)
      .find((row) => String(row.name || '').trim().toLowerCase() === username.toLowerCase());
    if (hit?.id) {
      await updateHotspotUser(hit.id, { disabled: desiredDisabled }, routerId);
      touched.users += 1;
    }
  }

  const bindings = await getHotspotIpBindings(routerId, { bypassCache: true });
  const match = (Array.isArray(bindings) ? bindings : []).find((row) => {
    if (bindingId && String(row.id || '') === bindingId) return true;
    if (targetMac && normalizeMacText(row.macAddress) === targetMac) return true;
    if (targetIp && (row.address === targetIp || row.toAddress === targetIp)) return true;
    if (username && String(row.comment || '').toLowerCase().includes(username.toLowerCase())) return true;
    return false;
  });
  if (match?.id) {
    await updateHotspotIpBinding(match.id, { disabled: desiredDisabled }, routerId);
    touched.bindings += 1;
  }

  return touched;
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
  const ck = cacheKey(routerId, 'hotspotProfiles');
  const cached = getCachedList(ck, 30000);
  if (cached) return cached;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const rows = await conn.client.menu('/ip/hotspot/profile').get();
    setCachedList(ck, rows);
    return rows;
  } catch (e) {
    if (isRouterNotFoundError(e)) {
      logMissingRouterNotice('getHotspotProfiles', routerId);
      return [];
    }
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
    const res = await conn.client.menu('/ip/hotspot/profile').add(data);
    invalidateListCaches(routerId, ['hotspotProfiles']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/profile').set(data, id);
    invalidateListCaches(routerId, ['hotspotProfiles']);
    return res;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const res = await conn.client.menu('/ip/hotspot/profile').remove(id);
    invalidateListCaches(routerId, ['hotspotProfiles']);
    return res;
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
  const routerId = normalizeRouterId(id);
  if (!routerId) throw buildRouterNotFoundError(id);
  const existing = getRouterById(routerId);
  if (!existing) throw buildRouterNotFoundError(routerId);

  const nullableRouterTables = [
    'customers',
    'voucher_batches',
    'vouchers',
    'public_voucher_orders',
    'agent_hotspot_prices',
    'agent_transactions',
    'mass_outage_incidents',
    'technician_customer_requests'
  ];

  const cleanupTransaction = db.transaction(() => {
    for (const tableName of nullableRouterTables) {
      db.prepare(`UPDATE ${tableName} SET router_id = NULL WHERE router_id = ?`).run(routerId);
    }
    db.prepare('DELETE FROM pppoe_monitoring_state WHERE router_id = ? OR router_key = ?').run(routerId, `router:${routerId}`);
    db.prepare('DELETE FROM hotspot_monitoring_state WHERE router_id = ? OR router_key = ?').run(routerId, `router:${routerId}`);
    db.prepare('DELETE FROM routers WHERE id = ?').run(routerId);
  });

  cleanupTransaction();
  invalidateRouterCaches(routerId);
  return { changes: 1 };
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
  normalizeRouterId,
  isRouterNotFoundError,
  checkConnection,
  getConnection,
  getPppoeProfiles,
  getPppoeUsers,
  syncPppoeMonitoringState,
  getPppoeCustomerSnapshot,
  buildPppoeCustomerSnapshot,
  setPppoeProfile,
  getPppoeSecrets,
  getInterfaces,
  getInterfaceTraffic,
  getPppoeCustomerSync,
  addPppoeSecret,
  updatePppoeSecret,
  deletePppoeSecret,
  getHotspotUsers,
  addHotspotUser,
  updateHotspotUser,
  deleteHotspotUser,
  getHotspotIpBindings,
  updateHotspotIpBinding,
  setHotspotBindingCustomerAccess,
    getHotspotProfiles,
    getPppoeActive,
    getHotspotActive,
    getMonitoringSnapshot,
    getMonitoringSummary,
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
