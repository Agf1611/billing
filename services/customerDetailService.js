const db = require('../config/database');
const path = require('path');
const RosClient = require('ros-client');
const { execFile } = require('child_process');
const { getSettingsWithCache } = require('../config/settingsManager');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const customerDevice = require('./customerDeviceService');
const mikrotikService = require('./mikrotikService');
const ticketSvc = require('./ticketService');
const usageSvc = require('./usageService');
const pppoeTrafficSamples = new Map();
const PPPOE_TRAFFIC_SAMPLE_RETENTION_MS = 2 * 60 * 1000;
const PPPOE_TRAFFIC_MIN_WINDOW_MS = 4500;
const PPPOE_TRAFFIC_TARGET_WINDOW_MS = 12000;
const PPPOE_TRAFFIC_MAX_SAMPLES = 6;

function prunePppoeTrafficSamples(now = Date.now()) {
  for (const [key, value] of pppoeTrafficSamples.entries()) {
    if (!value) {
      pppoeTrafficSamples.delete(key);
      continue;
    }
    const lastTs = Number(value.t || value.lastTs || 0);
    if (!lastTs || now - lastTs > PPPOE_TRAFFIC_SAMPLE_RETENTION_MS) {
      pppoeTrafficSamples.delete(key);
    }
  }
}

function readTrafficSamples(key) {
  const state = pppoeTrafficSamples.get(key);
  if (!state || typeof state !== 'object') return { history: [], lastRate: null };
  const history = Array.isArray(state.history) ? state.history : [];
  return {
    history,
    lastRate: state.lastRate && typeof state.lastRate === 'object' ? state.lastRate : null
  };
}

function writeTrafficSamples(key, sessionId, sample, nextRate = null) {
  const current = readTrafficSamples(key);
  const history = current.history
    .filter((entry) => entry && entry.sessionId === sessionId)
    .concat(sample)
    .slice(-PPPOE_TRAFFIC_MAX_SAMPLES);
  pppoeTrafficSamples.set(key, {
    t: sample.t,
    lastTs: sample.t,
    history,
    lastRate: nextRate || current.lastRate || null
  });
}

function computeTrafficRateFromHistory(history = [], sessionId) {
  const rows = (Array.isArray(history) ? history : []).filter((entry) => entry && entry.sessionId === sessionId);
  if (rows.length < 2) return null;
  const newest = rows[rows.length - 1];
  let candidate = null;
  for (let i = rows.length - 2; i >= 0; i -= 1) {
    const row = rows[i];
    const dtMs = Number(newest.t || 0) - Number(row.t || 0);
    if (dtMs >= PPPOE_TRAFFIC_MIN_WINDOW_MS) {
      candidate = row;
      if (dtMs >= PPPOE_TRAFFIC_TARGET_WINDOW_MS) break;
    }
  }
  if (!candidate) return null;
  const dtMs = Math.max(1, Number(newest.t || 0) - Number(candidate.t || 0));
  const dIn = Number(newest.rxBytes || 0) - Number(candidate.rxBytes || 0);
  const dOut = Number(newest.txBytes || 0) - Number(candidate.txBytes || 0);
  if (dIn < 0 || dOut < 0) return null;
  return {
    rxMbps: (dIn * 8) / (dtMs / 1000) / 1e6,
    txMbps: (dOut * 8) / (dtMs / 1000) / 1e6,
    dtMs
  };
}

function meaningfulText(...values) {
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (raw && raw !== '-') return raw;
  }
  return '';
}

function mergeNetworkSnapshot(base, extra) {
  if (!base) return extra || null;
  if (!extra) return base;
  return {
    ...base,
    ...extra,
    username: meaningfulText(base.username, extra.username) || '',
    profile: meaningfulText(base.profile, extra.profile) || '-',
    uptime: meaningfulText(base.uptime, extra.uptime) || '-',
    remoteAddress: meaningfulText(base.remoteAddress, base.activeAddress, extra.remoteAddress, extra.activeAddress) || '-',
    localAddress: meaningfulText(base.localAddress, extra.localAddress) || '-',
    activeAddress: meaningfulText(base.activeAddress, extra.activeAddress, base.remoteAddress, extra.remoteAddress) || '-',
    callerId: meaningfulText(base.callerId, extra.callerId) || '-',
    interface: meaningfulText(base.interface, extra.interface) || '-',
    sessionId: meaningfulText(base.sessionId, extra.sessionId) || '-',
    comment: meaningfulText(base.comment, extra.comment) || '-',
    rateLimit: meaningfulText(base.rateLimit, extra.rateLimit) || '-',
    bytesIn: Math.max(Number(base.bytesIn || 0) || 0, Number(extra.bytesIn || 0) || 0),
    bytesOut: Math.max(Number(base.bytesOut || 0) || 0, Number(extra.bytesOut || 0) || 0),
    rxMbps: Math.max(Number(base.rxMbps || 0) || 0, Number(extra.rxMbps || 0) || 0),
    txMbps: Math.max(Number(base.txMbps || 0) || 0, Number(extra.txMbps || 0) || 0),
    online: Boolean(base.online || extra.online),
    statusText: meaningfulText(base.statusText, extra.statusText) || (Boolean(base.online || extra.online) ? 'Online' : 'Offline')
  };
}

function numField(obj, keys) {
  for (const key of keys) {
    const value = Number(obj?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function strField(obj, keys) {
  for (const key of keys) {
    const raw = String(obj?.[key] ?? '').trim();
    if (raw) return raw;
  }
  return '';
}

function resolveCandidateRouterIds(preferredRouterId = null, extraRouterIds = [], limit = 3) {
  const routerIds = [];
  const pushId = (value) => {
    const id = Number(value || 0);
    if (id > 0 && !routerIds.includes(id)) routerIds.push(id);
  };

  pushId(preferredRouterId);
  for (const candidate of Array.isArray(extraRouterIds) ? extraRouterIds : []) {
    pushId(candidate);
  }

  const activeRouters = db.prepare(`
    SELECT id
    FROM routers
    WHERE is_active = 1
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
  `).all(Number(preferredRouterId || 0) > 0 ? Number(preferredRouterId) : -1);

  for (const row of activeRouters) {
    pushId(row?.id);
    if (routerIds.length >= Math.max(1, Number(limit || 3))) break;
  }

  return routerIds;
}

async function invokeRouterOsMenuCommand(menu, command, args = {}) {
  if (!menu) return [];
  if (typeof menu.exec === 'function') {
    return await menu.exec(command, args);
  }
  if (typeof menu.call === 'function') {
    return await menu.call(command, args);
  }
  throw new Error('Perintah RouterOS tidak didukung pada adapter ini');
}

async function resolvePppoeTrafficLiveSingle(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    let sessions = [];
    try {
      sessions = await conn.client.menu('/ppp/active').where('name', normalizedUsername).get();
    } catch {
      try {
        const allSessions = await conn.client.menu('/ppp/active').get({
          proplist: ['.id', 'session-id', 'name', 'service', 'address', 'uptime', 'caller-id', 'interface', 'bytes-in', 'bytes-out']
        });
        sessions = (Array.isArray(allSessions) ? allSessions : [])
          .filter((row) => String(row?.name || '').trim() === normalizedUsername);
      } catch {
        sessions = [];
      }
    }
    sessions = (Array.isArray(sessions) ? sessions : []).filter((row) => String(row?.name || '').trim() === normalizedUsername);
    if (!sessions.length) {
      sessions = await conn.client.menu('/ppp/active').where('name', normalizedUsername).get().catch(() => []);
    }
    if (!sessions || !sessions.length) {
      return {
        online: false,
        username: normalizedUsername,
        rxMbps: 0,
        txMbps: 0,
        bytesIn: 0,
        bytesOut: 0,
        statusText: 'Offline',
        source: 'ppp-active'
      };
    }

    const session = sessions[0];
    let iface = strField(session, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(session, ['session-id', 'sessionId', '.id', 'id']) || normalizedUsername;
    const bytesIn = numField(session, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(session, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(session, ['uptime']) || null;
    const remoteAddress = strField(session, ['address']);

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', normalizedUsername).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find((row) => String(row?.user || row?.['user'] || '').trim() === normalizedUsername);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;
    const key = `${routerId || 'default'}:${normalizedUsername}`;
    const currentSampleState = readTrafficSamples(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';
    let rxMbps = 0;
    let txMbps = 0;
    let warmup = false;

    if (iface) {
      try {
        const ifMenu = conn.client.menu('/interface');
        const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
        const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
        const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second']);
        const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second']);
        if (rxBps || txBps) {
          rxMbps = (Number(rxBps) || 0) / 1e6;
          txMbps = (Number(txBps) || 0) / 1e6;
          source = 'monitor-traffic';
        }
      } catch {}
    }

    if ((!rxMbps && !txMbps) && iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    if (!rxMbps && !txMbps) {
      const sample = { t: now, sessionId, rxBytes, txBytes, source };
      const computed = computeTrafficRateFromHistory(currentSampleState.history.concat(sample), sessionId);
      if (computed) {
        rxMbps = computed.rxMbps;
        txMbps = computed.txMbps;
      } else {
        warmup = true;
        rxMbps = Number(currentSampleState.lastRate?.rxMbps || 0) || 0;
        txMbps = Number(currentSampleState.lastRate?.txMbps || 0) || 0;
      }
      writeTrafficSamples(
        key,
        sessionId,
        sample,
        computed
          ? {
              rxMbps: Number.isFinite(computed.rxMbps) ? computed.rxMbps : 0,
              txMbps: Number.isFinite(computed.txMbps) ? computed.txMbps : 0,
              source
            }
          : currentSampleState.lastRate
      );
    } else {
      writeTrafficSamples(key, sessionId, { t: now, sessionId, rxBytes, txBytes, source }, {
        rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
        txMbps: Number.isFinite(txMbps) ? txMbps : 0,
        source
      });
    }

    return {
      online: true,
      username: normalizedUsername,
      sessionId,
      iface,
      uptime,
      remoteAddress: remoteAddress || '-',
      activeAddress: remoteAddress || '-',
      bytesIn: rxBytes,
      bytesOut: txBytes,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0,
      warmup,
      statusText: 'Online',
      source
    };
  } catch {
    return null;
  } finally {
    if (conn?.api) {
      try { await conn.api.close(); } catch {}
    }
  }
}

async function resolvePppoeTrafficLive(username, routerId = null, extraRouterIds = []) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;

  const candidateRouterIds = resolveCandidateRouterIds(routerId, extraRouterIds, 3);
  let firstOffline = null;

  for (const candidateRouterId of candidateRouterIds) {
    const live = await resolvePppoeTrafficLiveSingle(normalizedUsername, candidateRouterId);
    if (live?.online) {
      return { ...live, routerId: candidateRouterId, source: live.source || `router:${candidateRouterId}` };
    }
    if (live && !firstOffline) {
      firstOffline = { ...live, routerId: candidateRouterId, source: live.source || `router:${candidateRouterId}` };
    }
  }

  if (!candidateRouterIds.length || !candidateRouterIds.includes(null)) {
    const fallback = await resolvePppoeTrafficLiveSingle(normalizedUsername, null);
    if (fallback) {
      if (fallback.online) {
        return { ...fallback, routerId: null, source: fallback.source || 'default' };
      }
      if (!firstOffline) {
        firstOffline = { ...fallback, routerId: null, source: fallback.source || 'default' };
      }
    }
  }

  return firstOffline;
}

function resolveFastRouterConfig(routerId = null) {
  const settings = getSettingsWithCache();
  if (routerId) {
    const router = db.prepare('SELECT host, port, user, password FROM routers WHERE id = ? LIMIT 1').get(routerId);
    if (router?.host && router?.user) {
      return {
        host: router.host,
        port: Number(router.port || 8728) || 8728,
        user: router.user,
        password: router.password || ''
      };
    }
  }
  if (!settings.mikrotik_host || !settings.mikrotik_user) return null;
  return {
    host: settings.mikrotik_host,
    port: Number(settings.mikrotik_port || 8728) || 8728,
    user: settings.mikrotik_user,
    password: settings.mikrotik_password || ''
  };
}

async function fetchPppoeSnapshotFast(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;
  const config = resolveFastRouterConfig(routerId);
  if (!config) return null;
  const api = new RosClient({
    host: config.host,
    username: config.user,
    password: config.password,
    port: config.port,
    timeout: 2200
  });
  try {
    await api.connect();
    const [secretRows, activeRows] = await Promise.all([
      api.send(['/ppp/secret/print', `?name=${normalizedUsername}`]).catch(() => []),
      api.send(['/ppp/active/print', `?name=${normalizedUsername}`]).catch(() => [])
    ]);
    const secret = Array.isArray(secretRows) && secretRows.length ? secretRows[0] : null;
    const active = Array.isArray(activeRows) && activeRows.length ? activeRows[0] : null;
    if (!secret && !active) return null;
    return {
      username: normalizedUsername,
      profile: meaningfulText(secret?.profile, active?.profile) || '-',
      uptime: meaningfulText(active?.uptime) || '-',
      remoteAddress: meaningfulText(active?.address, secret?.['remote-address'], secret?.remoteAddress) || '-',
      localAddress: meaningfulText(secret?.['local-address'], secret?.localAddress) || '-',
      activeAddress: meaningfulText(active?.address) || '-',
      callerId: meaningfulText(active?.['caller-id'], active?.callerId, secret?.['caller-id'], secret?.callerId) || '-',
      interface: meaningfulText(active?.['interface-name'], active?.interface, active?.name) || '-',
      sessionId: meaningfulText(active?.['session-id'], active?.sessionId, active?.['.id'], active?.id) || '-',
      comment: meaningfulText(secret?.comment) || '-',
      rateLimit: meaningfulText(secret?.['rate-limit'], secret?.rateLimit) || '-',
      bytesIn: Math.max(0, Number(active?.['bytes-in'] || active?.bytesIn || 0) || 0),
      bytesOut: Math.max(0, Number(active?.['bytes-out'] || active?.bytesOut || 0) || 0),
      online: Boolean(active),
      statusText: active ? 'Online' : (String(secret?.disabled || '').toLowerCase() === 'true' ? 'Disabled' : 'Offline')
    };
  } catch {
    return null;
  } finally {
    try { await api.close(); } catch {
      try { await api.disconnect(); } catch {}
    }
  }
}

function fetchPppoeSnapshotViaChild(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return Promise.resolve(null);
  const config = resolveFastRouterConfig(routerId);
  if (!config) return Promise.resolve(null);
  const payload = Buffer.from(JSON.stringify({ ...config, username: normalizedUsername }), 'utf8').toString('base64');
  const script = `
    const RosClient = require('ros-client');
    const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
    (async () => {
      const api = new RosClient({
        host: payload.host,
        username: payload.user,
        password: payload.password,
        port: Number(payload.port || 8728),
        timeout: 2200
      });
      try {
        await api.connect();
        const [secretRows, activeRows] = await Promise.all([
          api.send(['/ppp/secret/print', '?name=' + payload.username]).catch(() => []),
          api.send(['/ppp/active/print', '?name=' + payload.username]).catch(() => [])
        ]);
        const secret = Array.isArray(secretRows) && secretRows.length ? secretRows[0] : null;
        const active = Array.isArray(activeRows) && activeRows.length ? activeRows[0] : null;
        if (!secret && !active) {
          console.log('null');
          return;
        }
        console.log(JSON.stringify({
          username: payload.username,
          profile: String(secret?.profile || active?.profile || '-').trim() || '-',
          uptime: String(active?.uptime || '-').trim() || '-',
          remoteAddress: String(active?.address || secret?.['remote-address'] || secret?.remoteAddress || '-').trim() || '-',
          localAddress: String(secret?.['local-address'] || secret?.localAddress || '-').trim() || '-',
          activeAddress: String(active?.address || '-').trim() || '-',
          callerId: String(active?.['caller-id'] || active?.callerId || secret?.['caller-id'] || secret?.callerId || '-').trim() || '-',
          interface: String(active?.['interface-name'] || active?.interface || active?.name || '-').trim() || '-',
          sessionId: String(active?.['session-id'] || active?.sessionId || active?.['.id'] || active?.id || '-').trim() || '-',
          comment: String(secret?.comment || '-').trim() || '-',
          rateLimit: String(secret?.['rate-limit'] || secret?.rateLimit || '-').trim() || '-',
          bytesIn: Math.max(0, Number(active?.['bytes-in'] || active?.bytesIn || 0) || 0),
          bytesOut: Math.max(0, Number(active?.['bytes-out'] || active?.bytesOut || 0) || 0),
          online: Boolean(active),
          statusText: active ? 'Online' : (String(secret?.disabled || '').toLowerCase() === 'true' ? 'Disabled' : 'Offline')
        }));
      } catch {
        console.log('null');
      } finally {
        try { await api.close(); } catch {
          try { await api.disconnect(); } catch {}
        }
      }
    })();
  `;

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', script, payload],
      {
        cwd: path.resolve(__dirname, '..'),
        timeout: 2600,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        const raw = String(stdout || '').trim();
        if (error && !raw) return resolve(null);
        const lines = raw ? raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
        const last = lines.length ? lines[lines.length - 1] : '';
        if (!last || last === 'null') return resolve(null);
        try {
          resolve(JSON.parse(last));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function resolvePppoeSnapshot(username, preferredRouterId = null, extraRouterIds = []) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;

  const tried = new Set();
  const preferredId = Number(preferredRouterId || 0);
  const routerIds = resolveCandidateRouterIds(preferredId, extraRouterIds, 3);
  let firstSnapshotResult = null;

  for (const routerId of routerIds) {
    tried.add(`router:${routerId}`);
    const snapshot = await withTimeout(
      fetchPppoeSnapshotViaChild(normalizedUsername, routerId),
      2800,
      null
    );
    if (snapshot?.online) {
      return { snapshot, routerId, source: `router:${routerId}` };
    }
    if (snapshot && !firstSnapshotResult) {
      firstSnapshotResult = { snapshot, routerId, source: `router:${routerId}` };
    }
  }

  if (!tried.has('default')) {
    const fallbackSnapshot = await withTimeout(
      fetchPppoeSnapshotViaChild(normalizedUsername, null),
      2800,
      null
    );
    if (fallbackSnapshot) {
      if (fallbackSnapshot.online) {
        return { snapshot: fallbackSnapshot, routerId: null, source: 'default' };
      }
      if (!firstSnapshotResult) {
        firstSnapshotResult = { snapshot: fallbackSnapshot, routerId: null, source: 'default' };
      }
    }
  }

  if (firstSnapshotResult) return firstSnapshotResult;

  return { snapshot: null, routerId: preferredId > 0 ? preferredId : null, source: preferredId > 0 ? `router:${preferredId}` : 'default' };
}

function resolveBestPppoeState(username, customerRouterId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;
  const preferredRouterId = Number(customerRouterId || 0) > 0 ? Number(customerRouterId) : null;
  const rows = db.prepare(`
    SELECT username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, last_logout_at, updated_at, router_key, router_id
    FROM pppoe_monitoring_state
    WHERE username = ?
    ORDER BY
      CASE WHEN ? > 0 AND router_id = ? THEN 0 ELSE 1 END,
      datetime(updated_at) DESC,
      is_online DESC,
      router_id ASC
    LIMIT 5
  `).all(normalizedUsername, preferredRouterId || 0, preferredRouterId || -1);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function isRecentPppoeState(row, maxAgeMs = 5 * 60 * 1000) {
  const updatedAt = new Date(row?.updated_at || row?.last_online_at || 0);
  if (Number.isNaN(updatedAt.getTime())) return false;
  return (Date.now() - updatedAt.getTime()) <= maxAgeMs;
}

function monthStatusLabel(status) {
  if (status === 'paid') return 'Lunas';
  if (status === 'isolated') return 'Isolir';
  if (status === 'unpaid') return 'Belum Bayar';
  if (status === 'void') return 'Hangus Prabayar';
  return 'Belum Ada Tagihan';
}

function normalizeIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function withTimeout(promise, timeoutMs, fallbackValue = null) {
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

function buildMonthlyBilling(customer, invoices = [], year) {
  const invoiceMap = new Map();
  for (const invoice of invoices) {
    const month = Number(invoice.month || invoice.period_month || 0);
    if (month >= 1 && month <= 12) invoiceMap.set(month, invoice);
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const months = [];

  for (let month = 1; month <= 12; month += 1) {
    const invoice = invoiceMap.get(month) || null;
    let status = 'missing';
    if (invoice) {
      const rawStatus = String(invoice.status || '').toLowerCase();
      if (rawStatus === 'paid') {
        status = 'paid';
      } else if (rawStatus === 'void') {
        status = 'void';
      } else if (
        rawStatus === 'unpaid' &&
        String(customer?.status || '').toLowerCase() === 'suspended' &&
        (Number(year) < currentYear || (Number(year) === currentYear && month <= currentMonth))
      ) {
        status = 'isolated';
      } else if (rawStatus === 'unpaid') {
        status = 'unpaid';
      }
    }

    months.push({
      month,
      status,
      label: monthStatusLabel(status),
      invoiceId: invoice?.id || null,
      amount: Number(invoice?.amount || 0) || 0,
      paidAt: invoice?.paid_at || '',
      dueDay: Number(invoice?.due_day_snapshot || 0) || 0,
      notes: String(invoice?.notes || '').trim()
    });
  }

  return months;
}

async function resolveCustomerLiveState(customer, username, deviceToken, pppoeState, options = {}) {
  const stateRouterId = Number(pppoeState?.router_id || 0) > 0 ? Number(pppoeState.router_id) : null;
  const preferredRouterId = stateRouterId || customer.router_id || null;
  const forceNetworkRefresh = Boolean(options.forceNetworkRefresh);
  const disableTrafficProbe = Boolean(options.disableTrafficProbe);
  const candidateRouters = [customer.router_id, stateRouterId].filter(Boolean);
  const trafficPromise = username && !disableTrafficProbe
    ? withTimeout(resolvePppoeTrafficLive(username, preferredRouterId, candidateRouters), forceNetworkRefresh ? 6500 : 4500, null)
    : Promise.resolve(null);
  const networkPromise = username
    ? withTimeout(
        resolvePppoeSnapshot(
          username,
          preferredRouterId,
          candidateRouters
        ),
        forceNetworkRefresh ? 6500 : 3200,
        {
          snapshot: null,
          routerId: preferredRouterId,
          source: preferredRouterId ? `router:${Number(preferredRouterId)}` : 'default'
        }
      )
    : Promise.resolve({
        snapshot: null,
        routerId: preferredRouterId,
        source: preferredRouterId ? `router:${Number(preferredRouterId)}` : 'default'
      });
  const devicePromise = deviceToken
    ? withTimeout(
        customerDevice.getCustomerDeviceData(deviceToken, { timeoutMs: 950 }),
        1050,
        null
      )
    : Promise.resolve(null);

  const [trafficLive, networkResult, device] = await Promise.all([trafficPromise, networkPromise, devicePromise]);

  let network = mergeNetworkSnapshot(networkResult?.snapshot || null, trafficLive || null);
  const snapshotRouterId = Number(networkResult?.routerId || 0) > 0
    ? Number(networkResult.routerId)
    : preferredRouterId;
  const stateOnline = Number(pppoeState?.is_online || 0) === 1 && isRecentPppoeState(pppoeState);

  if (username && stateOnline && (!network || (!meaningfulText(network.uptime) && !meaningfulText(network.remoteAddress, network.activeAddress)))) {
    const refreshed = await withTimeout(
      fetchPppoeSnapshotViaChild(username, snapshotRouterId),
      forceNetworkRefresh ? 3600 : 2200,
      null
    );
    if (refreshed) {
      network = mergeNetworkSnapshot(network, refreshed);
    }
  }

  const needsDeepTraffic = !disableTrafficProbe && Boolean(
    username && (
      !network ||
      !meaningfulText(network.remoteAddress, network.activeAddress) ||
      !meaningfulText(network.uptime) ||
      (!Number(network.rxMbps || 0) && !Number(network.txMbps || 0))
    )
  );

  if (needsDeepTraffic) {
    const deepTraffic = await withTimeout(
      resolvePppoeTrafficLive(username, snapshotRouterId, candidateRouters),
      forceNetworkRefresh ? 6500 : 3800,
      null
    );
    if (deepTraffic) {
      network = mergeNetworkSnapshot(network, deepTraffic);
    }
  }

  return {
    network,
    device,
    trafficLive,
    stateRouterId,
    snapshotRouterId,
    source: trafficLive?.source || networkResult?.source || (snapshotRouterId ? `router:${snapshotRouterId}` : 'default')
  };
}

async function buildCustomerDetail(customerId, options = {}) {
  const id = Number(customerId || 0);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  const year = Number(options.year || new Date().getFullYear()) || new Date().getFullYear();
  const customer = customerSvc.getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const usageMeta = usageSvc.getUsageSnapshotMeta(id, now);
  const usageRow = usageMeta?.usage || null;
  const usageBytesIn = Number(usageRow?.bytes_in ?? customer.bytes_in ?? 0) || 0;
  const usageBytesOut = Number(usageRow?.bytes_out ?? customer.bytes_out ?? 0) || 0;

  let currentInvoice = null;
  try {
    currentInvoice = db.prepare(`
      SELECT *
      FROM invoices
      WHERE customer_id = ? AND period_month = ? AND period_year = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(id, currentMonth, currentYear) || null;
  } catch (error) {
    console.error('[CustomerDetail] currentInvoice gagal dimuat:', error?.message || error);
  }

  let unpaidInvoices = [];
  try {
    unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(id) || [];
  } catch (error) {
    console.error('[CustomerDetail] unpaidInvoices gagal dimuat:', error?.message || error);
  }

  let billingYear = { invoices: [] };
  try {
    billingYear = billingSvc.getCustomerBillingYearSummary(id, year) || { invoices: [] };
  } catch (error) {
    console.error('[CustomerDetail] billingYear gagal dimuat:', error?.message || error);
  }

  let monthlyBilling = [];
  try {
    monthlyBilling = buildMonthlyBilling(customer, billingYear?.invoices || [], year);
  } catch (error) {
    console.error('[CustomerDetail] monthlyBilling gagal dibangun:', error?.message || error);
  }

  let tickets = [];
  try {
    tickets = ticketSvc.getTicketsByCustomerId(id) || [];
  } catch (error) {
    console.error('[CustomerDetail] tickets gagal dimuat:', error?.message || error);
  }

  let pppoeState = null;
  const username = String(customer.pppoe_username || '').trim();
  const deviceToken = String(customer.genieacs_tag || customer.pppoe_username || '').trim();

  if (username) {
    try {
      pppoeState = resolveBestPppoeState(username, customer.router_id || null);
    } catch (error) {
      console.error('[CustomerDetail] pppoeState gagal dimuat:', error?.message || error);
      pppoeState = null;
    }
  }

  const liveState = await withTimeout(
    resolveCustomerLiveState(customer, username, deviceToken, pppoeState, {
      forceNetworkRefresh: Boolean(options.forceNetworkRefresh),
      disableTrafficProbe: false
    }),
    options.forceNetworkRefresh ? 8500 : 6000,
    {
      network: null,
      device: null,
      stateRouterId: Number(pppoeState?.router_id || 0) > 0 ? Number(pppoeState.router_id) : null,
      snapshotRouterId: Number(pppoeState?.router_id || 0) > 0 ? Number(pppoeState.router_id) : (customer.router_id || null),
      source: customer.router_id ? `router:${Number(customer.router_id)}` : 'default'
    }
  );

  const network = liveState?.network || null;
  const device = liveState?.device || null;
  const stateRouterId = Number(liveState?.stateRouterId || 0) > 0 ? Number(liveState.stateRouterId) : (Number(pppoeState?.router_id || 0) > 0 ? Number(pppoeState.router_id) : null);
  const snapshotRouterId = Number(liveState?.snapshotRouterId || 0) > 0 ? Number(liveState.snapshotRouterId) : (stateRouterId || customer.router_id || null);
  const stateOnline = Number(pppoeState?.is_online || 0) === 1 && isRecentPppoeState(pppoeState);

  const hasFreshNetworkState = Boolean(network && Object.prototype.hasOwnProperty.call(network, 'online'));
  const resolvedOnline = Boolean(network?.online) || (!options.forceNetworkRefresh && stateOnline && (!hasFreshNetworkState || network?.online === false));
  const liveDownloadBytes = resolvedOnline ? (Number(network?.bytesOut || 0) || 0) : 0;
  const liveUploadBytes = resolvedOnline ? (Number(network?.bytesIn || 0) || 0) : 0;
  const hasLiveTraffic = Boolean(resolvedOnline && network);
  const displayDownloadBytes = usageBytesOut;
  const displayUploadBytes = usageBytesIn;
  const displayTotalBytes = displayDownloadBytes + displayUploadBytes;
  let resolvedStatus = 'Offline';
  if (resolvedOnline) {
    resolvedStatus = 'Online';
  } else if (network?.statusText) {
    resolvedStatus = network.statusText;
  } else if (String(customer.status || '').toLowerCase() === 'suspended') {
    resolvedStatus = 'Suspended';
  }

  if (network && username) {
    try {
      Promise.resolve(
        mikrotikService.syncPppoeMonitoringState(
          snapshotRouterId,
          [{ name: username }],
          resolvedOnline
            ? [{
                name: username,
                profile: meaningfulText(network.profile, pppoeState?.profile_name),
                address: meaningfulText(network.remoteAddress, network.activeAddress, pppoeState?.remote_address),
                uptime: meaningfulText(network.uptime, pppoeState?.session_uptime)
              }]
            : []
        )
      ).catch(() => {});
    } catch (error) {
      console.error('[CustomerDetail] syncPppoeMonitoringState gagal:', error?.message || error);
    }
  }

  const usesPppoe = Boolean(username);
  const resolvedRemoteAddress = (resolvedOnline || !usesPppoe)
    ? (meaningfulText(
        network?.remoteAddress,
        network?.activeAddress,
        network?.pppoeIp,
        pppoeState?.remote_address,
        customer.static_ip
      ) || '-')
    : '-';
  const resolvedActiveAddress = resolvedOnline
    ? (meaningfulText(network?.activeAddress, network?.pppoeIp, network?.remoteAddress) || '-')
    : '-';
  const resolvedUptime = resolvedOnline
    ? (meaningfulText(network?.uptime, pppoeState?.session_uptime) || 'Online sekarang')
    : '-';

  const packagePrice = Number(customer.package_price || 0) || 0;
  const discountEnabled = Number(customer.discount_enabled || 0) === 1;
  const discountAmount = discountEnabled ? Math.min(packagePrice, Math.max(0, Math.round(Number(customer.discount_amount || 0) || 0))) : 0;
  const packagePriceAfterDiscount = Math.max(0, packagePrice - discountAmount);

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone || '',
      address: customer.address || '',
      lat: customer.lat || '',
      lng: customer.lng || '',
      notes: customer.notes || '',
      nik: customer.nik || '',
      npwp: customer.npwp || '',
      housePhotoUrl: customer.house_photo_url || '',
      ktpPhotoUrl: customer.ktp_photo_url || '',
      status: customer.status || 'active',
      createdAt: customer.created_at || '',
      installDate: customer.install_date || '',
      packageName: customer.package_name || '',
      packagePrice,
      discountEnabled: discountEnabled && discountAmount > 0,
      discountAmount,
      packagePriceAfterDiscount,
      speedDown: Number(customer.speed_down || 0) || 0,
      speedUp: Number(customer.speed_up || 0) || 0,
      useFup: Number(customer.use_fup || 0) === 1,
      fupLimitGb: Number(customer.fup_limit_gb || 0) || 0,
      genieacsTag: customer.genieacs_tag || '',
      pppoeUsername: customer.pppoe_username || '',
      normalPppoeProfile: customer.normal_pppoe_profile || '',
      isolirProfile: customer.isolir_profile || 'BEATISOLIR',
      routerName: customer.router_name || '',
      oltName: customer.olt_name || '',
      odpName: customer.odp_name || '',
      ponPort: customer.pon_port || '',
      customerCode: customer.customer_code || `SCK${customer.id || ''}`,
      isolateDay: Number(customer.isolate_day || 0) || 0,
      staticIp: customer.static_ip || '',
      macAddress: customer.mac_address || ''
    },
    usage: {
      downloadBytes: displayDownloadBytes,
      uploadBytes: displayUploadBytes,
      totalBytes: displayTotalBytes,
      storedDownloadBytes: usageBytesOut,
      storedUploadBytes: usageBytesIn,
      storedTotalBytes: usageBytesIn + usageBytesOut,
      liveDownloadBytes,
      liveUploadBytes,
      liveTotalBytes: liveDownloadBytes + liveUploadBytes,
      isLive: hasLiveTraffic,
      snapshotSource: liveState?.source || '',
      snapshotUpdatedAt: pppoeState?.updated_at || '',
      updatedAt: usageMeta?.updatedAt || '',
      freshnessSeconds: Number(usageMeta?.freshnessSeconds || 0) || 0,
      usageLagSeconds: Number(usageMeta?.usageLagSeconds || 0) || 0,
      usageSource: String(usageMeta?.usageSource || 'database').trim() || 'database',
      isAuthoritative: usageMeta?.isAuthoritative !== false
    },
    currentInvoice: currentInvoice ? {
      id: currentInvoice.id,
      amount: Number(currentInvoice.amount || 0) || 0,
      status: String(currentInvoice.status || 'unpaid').toLowerCase(),
      periodMonth: Number(currentInvoice.period_month || currentMonth) || currentMonth,
      periodYear: Number(currentInvoice.period_year || currentYear) || currentYear,
      paidAt: currentInvoice.paid_at || '',
      dueDay: Number(currentInvoice.due_day_snapshot || customer.isolate_day || 10) || 10
    } : null,
    unpaidInvoices: (Array.isArray(unpaidInvoices) ? unpaidInvoices : []).map((invoice) => {
      let dueDate = '';
      try {
        dueDate = normalizeIsoDate(billingSvc.getInvoiceDueDate(invoice, customer.isolate_day));
      } catch (error) {
        console.error('[CustomerDetail] dueDate invoice gagal dihitung:', error?.message || error);
      }
      return {
        id: invoice.id,
        amount: Number(invoice.amount || 0) || 0,
        periodMonth: Number(invoice.period_month || 0) || 0,
        periodYear: Number(invoice.period_year || 0) || 0,
        status: String(invoice.status || '').toLowerCase(),
        dueDate,
        packageName: invoice.package_name || ''
      };
    }),
    network: {
      username: username,
      profile: meaningfulText(network?.profile, pppoeState?.profile_name, customer.normal_pppoe_profile, customer.package_pppoe_profile, customer.package_name) || '',
      uptime: resolvedUptime,
      status: resolvedStatus,
      online: resolvedOnline,
      remoteAddress: resolvedRemoteAddress,
      localAddress: meaningfulText(network?.localAddress) || '-',
      activeAddress: resolvedActiveAddress,
      callerId: meaningfulText(network?.callerId) || '-',
      interface: meaningfulText(network?.interface) || '-',
      sessionId: meaningfulText(network?.sessionId) || '-',
      comment: meaningfulText(network?.comment) || '-',
      rateLimit: meaningfulText(network?.rateLimit) || '-',
      rxMbps: Number(network?.rxMbps || 0) || 0,
      txMbps: Number(network?.txMbps || 0) || 0,
      lastOnlineAt: pppoeState?.last_online_at || '',
      offlineSince: resolvedOnline ? '' : (pppoeState?.offline_since || ''),
      lastLogoutAt: pppoeState?.last_logout_at || '',
      stateUpdatedAt: pppoeState?.updated_at || '',
      source: liveState?.source || ''
    },
    device: device ? {
      token: deviceToken,
      ssid: device.ssid || '-',
      status: device.status || '-',
      uptime: device.uptime || '-',
      model: device.model || '-',
      serialNumber: device.serialNumber || '-',
      lastInform: device.lastInform || '-',
      totalUsers: Number(device.totalAssociations || 0) || 0
    } : null,
    technicianHistory: (Array.isArray(tickets) ? tickets : []).map((ticket) => ({
      id: Number(ticket.id || 0) || 0,
      subject: ticket.subject || 'Laporan teknisi',
      message: ticket.message || '',
      status: String(ticket.status || 'open').toLowerCase(),
      technicianName: ticket.technician_name || '',
      createdAt: ticket.created_at || '',
      updatedAt: ticket.updated_at || ''
    })),
    billing: {
      year,
      months: monthlyBilling
    }
  };
}

module.exports = {
  buildCustomerDetail,
  resolveCandidateRouterIds,
  resolvePppoeTrafficLive
};
