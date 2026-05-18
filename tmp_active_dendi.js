const mikrotikSvc = require(process.cwd() + '/services/mikrotikService');
(async () => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000));
  const actives = await Promise.race([mikrotikSvc.getPppoeActive(), timeout]);
  const filtered = (Array.isArray(actives) ? actives : []).filter(r => String(r.name || '').toLowerCase().includes('dendi'));
  console.log(JSON.stringify(filtered, null, 2));
  process.exit(0);
})().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });