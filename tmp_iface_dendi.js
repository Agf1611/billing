const mikrotikSvc = require(process.cwd() + '/services/mikrotikService');
(async () => {
  const conn = await mikrotikSvc.getConnection();
  const rows = await conn.client.menu('/interface').where('type','pppoe-in').get({
    proplist: ['.id','name','type','rx-byte','tx-byte','running','dynamic']
  });
  const filtered = (Array.isArray(rows) ? rows : []).filter(r => String(r.name || '').toLowerCase().includes('dendi'));
  console.log(JSON.stringify(filtered, null, 2));
  process.exit(0);
})().catch(err => { console.error(err && err.stack || String(err)); process.exit(1); });