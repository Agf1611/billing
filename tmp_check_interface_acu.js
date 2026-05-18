const mik = require('./services/mikrotikService');

(async () => {
  const conn = mik.getConnection ? await mik.getConnection(null) : null;
  if (!conn) throw new Error('getConnection not exported');
  try {
    const rows = await conn.client.menu('/interface').where('name', 'acu@padanginyang').get();
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    try { await conn.api.close(); } catch {}
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
