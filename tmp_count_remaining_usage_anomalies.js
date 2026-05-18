const db = require(process.cwd() + '/config/database');
const now = new Date(); const month = now.getMonth()+1; const year = now.getFullYear();
const count = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ? AND u.period_year = ?
  LEFT JOIN customer_usage_runtime r ON r.customer_id = c.id
  WHERE (COALESCE(u.bytes_in,0)+COALESCE(u.bytes_out,0)) > (50 * 1024 * 1024 * 1024)
    AND (COALESCE(r.last_total_bytes_in,0)+COALESCE(r.last_total_bytes_out,0)) > 0
    AND (COALESCE(u.bytes_in,0)+COALESCE(u.bytes_out,0)) > ((COALESCE(r.last_total_bytes_in,0)+COALESCE(r.last_total_bytes_out,0)) * 6)
`).get(month,year);
console.log(JSON.stringify(count));