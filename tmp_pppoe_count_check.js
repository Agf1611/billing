const mik = require('./services/mikrotikService');
(async () => {
  const conn = await mik.getConnection(null);
  try {
    const rows = await conn.client.menu('/ppp/active').get({ proplist: ['.id', 'name', 'address', 'uptime'] });
    const list = Array.isArray(rows) ? rows : [];
    const uniqueNames = new Set(list.map(r => String(r.name || '').trim()).filter(Boolean));
    console.log(JSON.stringify({ totalRows: list.length, uniqueNames: uniqueNames.size, sample: list.slice(0,5) }, null, 2));
  } finally {
    try { await conn.api.close(); } catch {}
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
