const svc = require('/opt/billing-rtrw/services/mikrotikService');
(async () => {
  try {
    const snap = await svc.getMonitoringSnapshot(null);
    console.log(JSON.stringify({
      secrets: Array.isArray(snap.secrets) ? snap.secrets.length : -1,
      activePppoe: Array.isArray(snap.activePppoe) ? snap.activePppoe.length : -1,
      hotspotUsers: Array.isArray(snap.hotspotUsers) ? snap.hotspotUsers.length : -1,
      hotspotActive: Array.isArray(snap.hotspotActive) ? snap.hotspotActive.length : -1,
      source: snap.source
    }, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack || e);
    process.exit(1);
  }
})();
