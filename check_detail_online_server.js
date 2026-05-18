const db = require('/opt/billing-rtrw/config/database');
const { buildCustomerDetail } = require('/opt/billing-rtrw/services/customerDetailService');
const row = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username
  FROM customers c
  JOIN pppoe_monitoring_state p ON p.username = c.pppoe_username
  WHERE p.is_online = 1 AND c.pppoe_username IS NOT NULL AND c.pppoe_username <> ''
  ORDER BY datetime(p.updated_at) DESC
  LIMIT 1
`).get();
(async () => {
  if (!row) { console.log('NO_ONLINE'); process.exit(0); }
  const started = Date.now();
  const detail = await buildCustomerDetail(row.id, { year: 2026, forceNetworkRefresh: true });
  console.log(JSON.stringify({
    ms: Date.now()-started,
    customer: row.name,
    user: row.pppoe_username,
    remoteAddress: detail.network?.remoteAddress,
    uptime: detail.network?.uptime,
    rxMbps: detail.network?.rxMbps,
    txMbps: detail.network?.txMbps,
    isLive: detail.usage?.isLive,
    location: { lat: detail.customer?.lat, lng: detail.customer?.lng }
  }, null, 2));
  process.exit(0);
})();
