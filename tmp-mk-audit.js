const svc = require('/opt/billing-rtrw/services/mikrotikService');
(async () => {
  try {
    const [secrets, active, hotspotUsers, hotspotActive, summary] = await Promise.all([
      svc.getPppoeSecrets(null),
      svc.getPppoeActive(null),
      svc.getHotspotUsers(null),
      svc.getHotspotActive(null),
      svc.getMonitoringSummary(null)
    ]);
    console.log(JSON.stringify({
      secrets: Array.isArray(secrets) ? secrets.length : -1,
      active: Array.isArray(active) ? active.length : -1,
      hotspotUsers: Array.isArray(hotspotUsers) ? hotspotUsers.length : -1,
      hotspotActive: Array.isArray(hotspotActive) ? hotspotActive.length : -1,
      summary
    }, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack || e);
    process.exit(1);
  }
})();
