const db = require('./config/database');
const row = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username, u.bytes_in, u.bytes_out, u.last_total_bytes_in, u.last_total_bytes_out, u.updated_at
  FROM customers c
  LEFT JOIN customer_usage u
    ON u.customer_id = c.id
   AND u.period_month = CAST(strftime('%m','now') AS INTEGER)
   AND u.period_year = CAST(strftime('%Y','now') AS INTEGER)
  WHERE lower(c.name) = 'acu' OR lower(c.pppoe_username) = 'acu'
  LIMIT 1
`).get();
console.log(JSON.stringify(row || {}, null, 2));
