const svc = require('/opt/billing-rtrw/services/mikrotikService');
(async () => {
  try {
    const secretsDefault = await svc.getPppoeSecrets(null);
    const activeDefault = await svc.getPppoeActive(null);
    const summaryDefault = await svc.getMonitoringSummary(null);
    console.log('DEFAULT', JSON.stringify({ secrets: secretsDefault.length, active: activeDefault.length, summary: summaryDefault }));
  } catch (e) {
    console.log('DEFAULT_ERR', e.message || String(e));
  }
  try {
    const secrets2 = await svc.getPppoeSecrets(2);
    const active2 = await svc.getPppoeActive(2);
    const summary2 = await svc.getMonitoringSummary(2);
    console.log('ROUTER2', JSON.stringify({ secrets: secrets2.length, active: active2.length, summary: summary2 }));
  } catch (e) {
    console.log('ROUTER2_ERR', e.message || String(e));
  }
})();
