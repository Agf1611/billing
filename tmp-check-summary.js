(async () => {
  const svc=require('/opt/billing-rtrw/services/mikrotikService');
  const routers=svc.getAllRouters();
  console.log('routers=' + JSON.stringify(routers));
  const summary=await svc.getMonitoringSummary(null);
  console.log('summary=' + JSON.stringify(summary));
  process.exit(0);
})().catch((e)=>{ console.error(e && e.stack || e); process.exit(1); });
