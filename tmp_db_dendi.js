const db = require(process.cwd() + '/config/database');
const now = new Date();
const month = now.getMonth()+1; const year = now.getFullYear();
const rows = db.prepare(`
  SELECT c.id, c.name, c.phone, c.pppoe_username, c.router_id,
         u.bytes_in, u.bytes_out, u.last_total_bytes_in AS u_last_in, u.last_total_bytes_out AS u_last_out,
         r.last_total_bytes_in AS r_last_in, r.last_total_bytes_out AS r_last_out, r.last_seen_at
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id=c.id AND u.period_month=? AND u.period_year=?
  LEFT JOIN customer_usage_runtime r ON r.customer_id=c.id
  WHERE LOWER(c.name) LIKE '%dendi%' OR LOWER(c.pppoe_username) LIKE '%dendi%'
  ORDER BY c.id
`).all(month, year);
console.log(JSON.stringify(rows, null, 2));