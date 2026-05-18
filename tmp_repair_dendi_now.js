const db = require(process.cwd() + '/config/database');
const usageSvc = require(process.cwd() + '/services/usageService');
const mikrotikSvc = require(process.cwd() + '/services/mikrotikService');
(async () => {
  const customer = db.prepare("SELECT id, name, pppoe_username, router_id FROM customers WHERE LOWER(name) LIKE '%dendi%' ORDER BY id DESC LIMIT 1").get();
  if (!customer) throw new Error('Customer Dendi tidak ditemukan');
  const conn = await mikrotikSvc.getConnection(customer.router_id ? Number(customer.router_id) : null);
  const ifaceRows = await conn.client.menu('/interface').where('name', `<pppoe-${customer.pppoe_username}>`).get({ proplist: ['name','rx-byte','tx-byte'] });
  const row = Array.isArray(ifaceRows) && ifaceRows[0] ? ifaceRows[0] : null;
  const totalIn = Number(row?.['rx-byte'] ?? row?.rxByte ?? 0) || 0;
  const totalOut = Number(row?.['tx-byte'] ?? row?.txByte ?? 0) || 0;
  usageSvc.overwriteUsageForCurrentPeriod(customer.id, totalIn, totalOut, new Date());
  const now = new Date(); const month = now.getMonth()+1; const year = now.getFullYear();
  const usage = db.prepare('SELECT bytes_in, bytes_out, last_total_bytes_in, last_total_bytes_out FROM customer_usage WHERE customer_id=? AND period_month=? AND period_year=?').get(customer.id, month, year);
  console.log(JSON.stringify({ customer, iface: row, usage }, null, 2));
  process.exit(0);
})().catch(err => { console.error(err && err.stack || String(err)); process.exit(1); });