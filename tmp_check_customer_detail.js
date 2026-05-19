const db = require('./config/database');
const svc = require('./services/customerDetailService');

const term = String(process.argv[2] || '').trim().toLowerCase();

if (!term) {
  console.error('Usage: node tmp_check_customer_detail.js <name-or-pppoe>');
  process.exit(1);
}

const rows = db.prepare(`
  SELECT id, name, phone, pppoe_username, router_id, genieacs_tag, status, package_id
  FROM customers
  WHERE lower(name) LIKE ? OR lower(pppoe_username) LIKE ?
  ORDER BY id
`).all(`%${term}%`, `%${term}%`);

(async () => {
  const out = [];
  for (const row of rows) {
    const started = Date.now();
    try {
      const detail = await svc.buildCustomerDetail(row.id, { year: new Date().getFullYear(), forceNetworkRefresh: false });
      out.push({
        customer: row,
        ms: Date.now() - started,
        ok: true,
        network: detail?.network || null,
        device: detail?.device || null,
        currentInvoice: detail?.currentInvoice || null,
        unpaidCount: Array.isArray(detail?.unpaidInvoices) ? detail.unpaidInvoices.length : 0,
        billingMonths: Array.isArray(detail?.billing?.months) ? detail.billing.months.length : 0
      });
    } catch (error) {
      out.push({
        customer: row,
        ms: Date.now() - started,
        ok: false,
        error: error?.message || String(error),
        stack: error?.stack || String(error)
      });
    }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
