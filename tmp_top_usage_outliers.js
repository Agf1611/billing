const db = require(process.cwd() + '/config/database');
function fmt(bytes){return Number((Number(bytes||0)/(1024**3)).toFixed(2));}
const now = new Date();
const month = now.getMonth()+1; const year = now.getFullYear();
const rows = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username,
         COALESCE(u.bytes_in,0)+COALESCE(u.bytes_out,0) AS stored_total,
         COALESCE(r.last_total_bytes_in,0)+COALESCE(r.last_total_bytes_out,0) AS runtime_total,
         COALESCE(r.last_seen_at,'') AS last_seen_at
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id=c.id AND u.period_month=? AND u.period_year=?
  LEFT JOIN customer_usage_runtime r ON r.customer_id=c.id
  WHERE (COALESCE(u.bytes_in,0)+COALESCE(u.bytes_out,0)) > (500 * 1024 * 1024 * 1024)
  ORDER BY stored_total DESC
  LIMIT 20
`).all(month, year);
console.log(JSON.stringify(rows.map(r=>({...r,stored_total_gb:fmt(r.stored_total),runtime_total_gb:fmt(r.runtime_total)})),null,2));