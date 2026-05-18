const db = require(process.cwd() + '/config/database');
const usageSvc = require(process.cwd() + '/services/usageService');

function fmt(bytes){return Number((Number(bytes||0)/(1024**3)).toFixed(2));}
const now = new Date();
const month = now.getMonth()+1;
const year = now.getFullYear();
const rows = db.prepare(`
  SELECT c.id, c.name, c.pppoe_username,
         COALESCE(u.bytes_in,0) AS bytes_in,
         COALESCE(u.bytes_out,0) AS bytes_out,
         COALESCE(u.last_total_bytes_in,0) AS u_last_in,
         COALESCE(u.last_total_bytes_out,0) AS u_last_out,
         COALESCE(r.last_total_bytes_in,0) AS r_last_in,
         COALESCE(r.last_total_bytes_out,0) AS r_last_out,
         COALESCE(r.last_seen_at,'') AS last_seen_at
  FROM customers c
  LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ? AND u.period_year = ?
  LEFT JOIN customer_usage_runtime r ON r.customer_id = c.id
  WHERE c.pppoe_username IS NOT NULL AND TRIM(c.pppoe_username) <> ''
  ORDER BY c.name COLLATE NOCASE
`).all(month, year);

const repaired = [];
const skipped = [];
for (const row of rows) {
  const storedIn = Number(row.bytes_in || 0);
  const storedOut = Number(row.bytes_out || 0);
  const storedTotal = storedIn + storedOut;
  const refIn = Math.max(Number(row.r_last_in || 0), Number(row.u_last_in || 0));
  const refOut = Math.max(Number(row.r_last_out || 0), Number(row.u_last_out || 0));
  const refTotal = refIn + refOut;
  if (storedTotal <= 50 * 1024 ** 3) continue;
  if (refTotal > 0 && storedTotal > refTotal * 6) {
    usageSvc.overwriteUsageForCurrentPeriod(row.id, refIn, refOut, now);
    repaired.push({
      id: row.id,
      name: row.name,
      pppoe_username: row.pppoe_username,
      oldTotalGB: fmt(storedTotal),
      newTotalGB: fmt(refTotal),
      oldUpGB: fmt(storedIn),
      oldDownGB: fmt(storedOut),
      newUpGB: fmt(refIn),
      newDownGB: fmt(refOut)
    });
  } else if (storedTotal > 50 * 1024 ** 3) {
    skipped.push({
      id: row.id,
      name: row.name,
      pppoe_username: row.pppoe_username,
      storedTotalGB: fmt(storedTotal),
      refTotalGB: fmt(refTotal),
      last_seen_at: row.last_seen_at
    });
  }
}
console.log(JSON.stringify({ month, year, repairedCount: repaired.length, skippedCount: skipped.length, repaired: repaired.slice(0, 60), skipped: skipped.slice(0, 20) }, null, 2));