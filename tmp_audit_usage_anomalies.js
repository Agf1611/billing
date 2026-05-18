const db = require(process.cwd() + '/config/database');

function fmt(bytes) {
  return Number((Number(bytes || 0) / (1024 ** 3)).toFixed(2));
}

const now = new Date();
const month = now.getMonth() + 1;
const year = now.getFullYear();
const rows = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username,
         COALESCE(u.bytes_in,0) AS bytes_in,
         COALESCE(u.bytes_out,0) AS bytes_out,
         COALESCE(u.last_total_bytes_in,0) AS usage_last_in,
         COALESCE(u.last_total_bytes_out,0) AS usage_last_out,
         COALESCE(r.last_total_bytes_in,0) AS runtime_in,
         COALESCE(r.last_total_bytes_out,0) AS runtime_out,
         COALESCE(r.last_seen_at,'') AS last_seen_at
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ? AND u.period_year = ?
  LEFT JOIN customer_usage_runtime r ON r.customer_id = c.id
  WHERE c.pppoe_username IS NOT NULL AND TRIM(c.pppoe_username) <> ''
  ORDER BY c.name COLLATE NOCASE
`).all(month, year);

const anomalies = rows.filter((row) => {
  const stored = Number(row.bytes_in) + Number(row.bytes_out);
  const runtime = Number(row.runtime_in) + Number(row.runtime_out);
  if (stored <= 0 || runtime <= 0) return false;
  if (stored < 50 * 1024 ** 3) return false;
  return stored > runtime * 6;
}).map((row) => ({
  id: row.id,
  name: row.name,
  pppoe_username: row.pppoe_username,
  storedTotalGB: fmt(Number(row.bytes_in) + Number(row.bytes_out)),
  runtimeTotalGB: fmt(Number(row.runtime_in) + Number(row.runtime_out)),
  storedUpGB: fmt(row.bytes_in),
  storedDownGB: fmt(row.bytes_out),
  runtimeUpGB: fmt(row.runtime_in),
  runtimeDownGB: fmt(row.runtime_out),
  usage_last_total_gb: fmt(Number(row.usage_last_in) + Number(row.usage_last_out)),
  last_seen_at: row.last_seen_at,
}));

console.log(JSON.stringify({ month, year, anomalyCount: anomalies.length, anomalies }, null, 2));