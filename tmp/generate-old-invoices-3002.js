const billingSvc = require('/opt/billing-rtrw-3002/services/billingService');
const db = require('/opt/billing-rtrw-3002/config/database');
const periodMonth = 5;
const periodYear = 2026;
const targetMonthKey = `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
const rows = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username, c.install_date, c.status
  FROM customers c
  LEFT JOIN invoices i
    ON i.customer_id = c.id AND i.period_month = ? AND i.period_year = ?
  WHERE i.id IS NULL
    AND c.package_id IS NOT NULL
    AND c.status IN ('active','suspended')
    AND COALESCE(substr(c.install_date,1,7),'') != ?
  ORDER BY c.name ASC
`).all(periodMonth, periodYear, targetMonthKey);
const result = { targetCount: rows.length, created: 0, skipped: 0, failures: [] };
for (const row of rows) {
  try {
    const out = billingSvc.generateInvoiceForCustomer(row.id, periodMonth, periodYear);
    if (out && out.created) result.created += 1;
    else result.skipped += 1;
  } catch (error) {
    result.failures.push({ id: row.id, name: row.name, message: String(error && error.message ? error.message : error) });
  }
}
const summary = db.prepare("select count(1) as c, coalesce(sum(amount),0) as t from invoices where period_month=? and period_year=?").get(periodMonth, periodYear);
const unpaid = db.prepare("select count(1) as c, coalesce(sum(amount),0) as t from invoices where period_month=? and period_year=? and status='unpaid'").get(periodMonth, periodYear);
console.log(JSON.stringify({ ...result, summary, unpaid }, null, 2));
