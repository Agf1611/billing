const mikrotikSvc = require('./services/mikrotikService');
(async () => {
  const routers = mikrotikSvc.getAllRouters();
  const wanted = 'acu@padanginyang';
  const out = [];
  for (const r of routers) {
    const actives = await mikrotikSvc.getPppoeActive(r.id).catch(() => []);
    const row = (actives || []).find((s) => String(s.name || '').trim().toLowerCase() === wanted);
    out.push({ router: r.name, routerId: r.id, activeCount: (actives || []).length, found: !!row, row });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message || String(e)); process.exit(1); });
