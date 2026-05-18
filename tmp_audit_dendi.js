const customerSvc = require(process.cwd() + '/services/customerService');
const mikrotikSvc = require(process.cwd() + '/services/mikrotikService');
const db = require(process.cwd() + '/config/database');
(async () => {
  const candidates = db.prepare(`SELECT id, name, phone, pppoe_username, router_id FROM customers WHERE LOWER(name) LIKE '%dendi%' OR LOWER(pppoe_username) LIKE '%dendi%' ORDER BY id`).all();
  const now = new Date();
  const month = now.getMonth()+1; const year = now.getFullYear();
  const out = [];
  for (const c of candidates) {
    const usage = db.prepare('SELECT * FROM customer_usage WHERE customer_id=? AND period_month=? AND period_year=?').get(c.id, month, year);
    const runtime = db.prepare('SELECT * FROM customer_usage_runtime WHERE customer_id=?').get(c.id);
    let snapshot = null;
    try {
      snapshot = await mikrotikSvc.getPppoeCustomerSnapshot(c.pppoe_username, c.router_id ? Number(c.router_id) : null);
    } catch (e) {
      snapshot = { error: e.message };
    }
    out.push({ customer: c, usage, runtime, snapshot });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });