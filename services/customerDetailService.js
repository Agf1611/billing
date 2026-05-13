const db = require('../config/database');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const customerDevice = require('./customerDeviceService');
const mikrotikService = require('./mikrotikService');

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
    online: Boolean(base.online || extra.online),
    statusText: meaningfulText(base.statusText, extra.statusText) || (Boolean(base.online || extra.online) ? 'Online' : 'Offline')
  };
}

async function resolvePppoeSnapshot(username, preferredRouterId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;

  const tried = new Set();
  const routerIds = [];
  const preferredId = Number(preferredRouterId || 0);
  if (preferredId > 0) routerIds.push(preferredId);

  const activeRouters = db.prepare(`
    SELECT id
    FROM routers
    WHERE is_active = 1
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
  `).all(preferredId > 0 ? preferredId : -1);

  for (const row of activeRouters) {
    const id = Number(row?.id || 0);
    if (id > 0 && !routerIds.includes(id)) routerIds.push(id);
  }

  for (const routerId of routerIds) {
    tried.add(`router:${routerId}`);
    const snapshot = await withTimeout(
      mikrotikService.getPppoeCustomerSnapshot(normalizedUsername, routerId),
      4200,
      null
    );
    if (snapshot?.online) {
      return { snapshot, routerId, source: `router:${routerId}` };
    }
    if (snapshot && !preferredId) {
      return { snapshot, routerId, source: `router:${routerId}` };
    }
  }

  if (!tried.has('default')) {
    const fallbackSnapshot = await withTimeout(
      mikrotikService.getPppoeCustomerSnapshot(normalizedUsername, null),
      3600,
      null
    );
    if (fallbackSnapshot) {
      return { snapshot: fallbackSnapshot, routerId: null, source: 'default' };
    }
  }

  return { snapshot: null, routerId: preferredId > 0 ? preferredId : null, source: preferredId > 0 ? `router:${preferredId}` : 'default' };
}

function monthStatusLabel(status) {
  if (status === 'paid') return 'Lunas';
  if (status === 'isolated') return 'Isolir';
  if (status === 'unpaid') return 'Belum Bayar';
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

async function buildCustomerDetail(customerId, options = {}) {
  const id = Number(customerId || 0);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  const year = Number(options.year || new Date().getFullYear()) || new Date().getFullYear();
  const customer = customerSvc.getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const usageBytesIn = Number(customer.bytes_in || 0) || 0;
  const usageBytesOut = Number(customer.bytes_out || 0) || 0;

  const currentInvoice = db.prepare(`
    SELECT *
    FROM invoices
    WHERE customer_id = ? AND period_month = ? AND period_year = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(id, currentMonth, currentYear) || null;

  const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(id);
  const billingYear = billingSvc.getCustomerBillingYearSummary(id, year);
  const monthlyBilling = buildMonthlyBilling(customer, billingYear?.invoices || [], year);

  let pppoeState = null;
  const username = String(customer.pppoe_username || '').trim();
  const deviceToken = String(customer.genieacs_tag || customer.pppoe_username || '').trim();
  const networkPromise = username
    ? resolvePppoeSnapshot(username, customer.router_id || null)
    : Promise.resolve({ snapshot: null, routerId: customer.router_id || null, source: customer.router_id ? `router:${Number(customer.router_id)}` : 'default' });
  const devicePromise = deviceToken
    ? withTimeout(
        customerDevice.getCustomerDeviceData(deviceToken, { timeoutMs: 1800 }),
        2200,
        null
      )
    : Promise.resolve(null);

  if (username) {
    const exactState = db.prepare(`
      SELECT username, is_online, last_online_at, offline_since, last_logout_at, updated_at
      FROM pppoe_monitoring_state
      WHERE router_key = ? AND username = ?
      LIMIT 1
    `).get(
      customer.router_id ? `router:${Number(customer.router_id)}` : 'default',
      username
    ) || null;

    const anyState = db.prepare(`
      SELECT username, is_online, last_online_at, offline_since, last_logout_at, updated_at, router_key, router_id
      FROM pppoe_monitoring_state
      WHERE username = ?
      ORDER BY is_online DESC, updated_at DESC
      LIMIT 1
    `).get(username) || null;

    pppoeState = exactState || anyState || null;
  }

  const [networkResult, device] = await Promise.all([networkPromise, devicePromise]);
  let network = networkResult?.snapshot || null;
  const stateRouterId = Number(pppoeState?.router_id || 0) > 0 ? Number(pppoeState.router_id) : null;
  const snapshotRouterId = Number(networkResult?.routerId || 0) > 0
    ? Number(networkResult.routerId)
    : (stateRouterId || customer.router_id || null);
  const stateOnline = Number(pppoeState?.is_online || 0) === 1;
  if (username) {
    const needsLiveRefresh = !network || (
      stateOnline && (
        !meaningfulText(network.uptime) ||
        !meaningfulText(network.remoteAddress, network.activeAddress)
      )
    );
    if (needsLiveRefresh) {
      const refreshRouterIds = [];
      for (const candidate of [snapshotRouterId, stateRouterId, customer.router_id, null]) {
        const normalized = Number(candidate || 0) > 0 ? Number(candidate) : null;
        if (!refreshRouterIds.some((item) => item === normalized)) refreshRouterIds.push(normalized);
      }
      for (const routerId of refreshRouterIds) {
        const refreshed = await withTimeout(
          mikrotikService.getPppoeCustomerSnapshot(username, routerId),
          4200,
          null
        );
        if (refreshed) {
          network = mergeNetworkSnapshot(network, refreshed);
          if (refreshed.online && meaningfulText(refreshed.uptime, refreshed.remoteAddress, refreshed.activeAddress)) break;
        }
      }
    }
  }

  const resolvedOnline = Boolean(network?.online || stateOnline);
  const liveDownloadBytes = Number(network?.bytesIn || 0) || 0;
  const liveUploadBytes = Number(network?.bytesOut || 0) || 0;
  const hasLiveTraffic = Boolean(resolvedOnline && network);
  const displayDownloadBytes = hasLiveTraffic ? liveDownloadBytes : usageBytesIn;
  const displayUploadBytes = hasLiveTraffic ? liveUploadBytes : usageBytesOut;
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
    Promise.resolve(
      mikrotikService.syncPppoeMonitoringState(
        snapshotRouterId,
        [{ name: username }],
        network.online ? [{ name: username }] : []
      )
    ).catch(() => {});
  }

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
      packagePrice: Number(customer.package_price || 0) || 0,
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
      customerCode: customer.customer_code || customer.phone || customer.genieacs_tag || customer.pppoe_username || String(customer.id || ''),
      isolateDay: Number(customer.isolate_day || 0) || 0,
      staticIp: customer.static_ip || '',
      macAddress: customer.mac_address || ''
    },
    usage: {
      downloadBytes: displayDownloadBytes,
      uploadBytes: displayUploadBytes,
      totalBytes: displayTotalBytes,
      storedDownloadBytes: usageBytesIn,
      storedUploadBytes: usageBytesOut,
      storedTotalBytes: usageBytesIn + usageBytesOut,
      liveDownloadBytes,
      liveUploadBytes,
      liveTotalBytes: liveDownloadBytes + liveUploadBytes,
      isLive: hasLiveTraffic,
      snapshotSource: networkResult?.source || '',
      snapshotUpdatedAt: pppoeState?.updated_at || ''
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
    unpaidInvoices: (Array.isArray(unpaidInvoices) ? unpaidInvoices : []).map((invoice) => ({
      id: invoice.id,
      amount: Number(invoice.amount || 0) || 0,
      periodMonth: Number(invoice.period_month || 0) || 0,
      periodYear: Number(invoice.period_year || 0) || 0,
      status: String(invoice.status || '').toLowerCase(),
      dueDate: normalizeIsoDate(billingSvc.getInvoiceDueDate(invoice, customer.isolate_day)),
      packageName: invoice.package_name || ''
    })),
    network: {
      username: username,
      profile: meaningfulText(network?.profile, customer.normal_pppoe_profile, customer.package_pppoe_profile, customer.package_name) || '',
      uptime: meaningfulText(network?.uptime) || '-',
      status: resolvedStatus,
      online: resolvedOnline,
      remoteAddress: meaningfulText(network?.remoteAddress, network?.activeAddress, network?.pppoeIp, customer.static_ip) || '-',
      localAddress: meaningfulText(network?.localAddress) || '-',
      activeAddress: meaningfulText(network?.activeAddress, network?.pppoeIp, network?.remoteAddress) || '-',
      callerId: meaningfulText(network?.callerId) || '-',
      interface: meaningfulText(network?.interface) || '-',
      sessionId: meaningfulText(network?.sessionId) || '-',
      comment: meaningfulText(network?.comment) || '-',
      rateLimit: meaningfulText(network?.rateLimit) || '-',
      lastOnlineAt: pppoeState?.last_online_at || '',
      offlineSince: resolvedOnline ? '' : (pppoeState?.offline_since || ''),
      lastLogoutAt: pppoeState?.last_logout_at || '',
      stateUpdatedAt: pppoeState?.updated_at || '',
      source: networkResult?.source || ''
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
    billing: {
      year,
      months: monthlyBilling
    }
  };
}

module.exports = {
  buildCustomerDetail
};
