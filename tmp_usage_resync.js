const customerService = require('./services/customerService');
const usageService = require('./services/usageService');
const mik = require('./services/mikrotikService');

const norm = (v) => String(v || '').trim().toLowerCase();

(async () => {
  const customers = customerService.getAllCustomers('');
  const map = new Map(
    customers
      .map((c) => [norm(c.pppoe_username), c])
      .filter(([key]) => key)
  );
  const routers = [...new Set(customers.map((c) => c.router_id).filter(Boolean))];
  let synced = 0;
  for (const rid of routers) {
    const sessions = await mik.getPppoeActive(rid);
    for (const s of sessions) {
      const customer = map.get(norm(s.name));
      if (!customer) continue;
      const totalIn = Number(s['bytes-in'] ?? s.bytesIn ?? 0);
      const totalOut = Number(s['bytes-out'] ?? s.bytesOut ?? 0);
      if (totalIn || totalOut) {
        usageService.syncUsageTotals(customer.id, totalIn, totalOut, new Date());
        synced += 1;
      }
    }
  }
  console.log(JSON.stringify({ synced }));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
