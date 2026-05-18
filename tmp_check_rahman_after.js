const db = require(process.cwd() + '/config/database');
function fmt(bytes){return Number((Number(bytes||0)/(1024**3)).toFixed(2));}
const now = new Date(); const month = now.getMonth()+1; const year = now.getFullYear();
const row = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username,
         COALESCE(u.bytes_in,0) AS bytes_in,
         COALESCE(u.bytes_out,0) AS bytes_out,
         COALESCE(r.last_total_bytes_in,0) AS r_last_in,
         COALESCE(r.last_total_bytes_out,0) AS r_last_out,
         COALESCE(r.last_seen_at,'') AS last_seen_at
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id=c.id AND u.period_month=? AND u.period_year=?
  LEFT JOIN customer_usage_runtime r ON r.customer_id=c.id
  WHERE c.name='RAHMAN'
`).get(month,year);
console.log(JSON.stringify({...row,storedTotalGB:fmt(Number(row.bytes_in)+Number(row.bytes_out)),runtimeTotalGB:fmt(Number(row.r_last_in)+Number(row.r_last_out))},null,2));