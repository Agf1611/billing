const db = require('./config/database');
const mik = require('./services/mikrotikService');
const usageService = require('./services/usageService');

function readUsage(customerId) {
  const row = db.prepare("SELECT bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out, updated_at, period_month, period_year FROM customer_usage WHERE customer_id=? ORDER BY period_year DESC, period_month DESC LIMIT 1").get(customerId);
  if (!row) return null;
  return {
    ...row,
    total_gb: Number(((Number(row.bytes_in || 0) + Number(row.bytes_out || 0)) / 1073741824).toFixed(2))
  };
}

(async () => {
  const customer = db.prepare("SELECT id, name, pppoe_username, router_id FROM customers WHERE lower(name)=lower(?) OR lower(pppoe_username)=lower(?) LIMIT 1").get('ACU', 'acu@padanginyang');
  if (!customer) {
    console.log(JSON.stringify({ error: 'customer-not-found' }));
    process.exit(0);
  }
  const before = readUsage(customer.id);
  const sessions = await mik.getPppoeActive(customer.router_id);
  const active = sessions.find((s) => String(s.name || '').trim().toLowerCase() === String(customer.pppoe_username || '').trim().toLowerCase());
  let synced = false;
  if (active) {
    const totalIn = Number(active['bytes-in'] ?? active.bytesIn ?? 0);
    const totalOut = Number(active['bytes-out'] ?? active.bytesOut ?? 0);
    if (totalIn || totalOut) {
      usageService.syncUsageTotals(customer.id, totalIn, totalOut, new Date());
      synced = true;
    }
  }
  const after = readUsage(customer.id);
  console.log(JSON.stringify({
    customer,
    hasActive: !!active,
    active: active ? {
      name: active.name,
      bytesIn: active['bytes-in'] ?? active.bytesIn ?? null,
      bytesOut: active['bytes-out'] ?? active.bytesOut ?? null,
      uptime: active.uptime || null,
      address: active.address || null
    } : null,
    synced,
    before,
    after
  }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
