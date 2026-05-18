const mik = require('./services/mikrotikService');

(async () => {
  const conn = await mik.getConnection(null);
  try {
    const rows = await conn.api.send(['/interface/print']);
    const shortlist = rows.filter((row) => {
      const name = String(row.name || '').toLowerCase();
      const type = String(row.type || '').toLowerCase();
      const def = String(row['default-name'] || '').toLowerCase();
      return name.includes('acu') || type.includes('ppp') || type.includes('pptp') || type.includes('l2tp') || def.includes('ppp');
    }).slice(0, 50);
    console.log(JSON.stringify(shortlist, null, 2));
  } finally {
    try { await conn.api.close(); } catch {}
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
