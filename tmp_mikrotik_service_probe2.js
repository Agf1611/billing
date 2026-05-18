const svc = require('/opt/billing-rtrw/services/mikrotikService');
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true, label }), ms))
  ]);
}
async function probe(label, fn) {
  try {
    const result = await withTimeout(fn(), 15000, label);
    if (result && result.__timeout) {
      console.log(label + ':TIMEOUT');
      return;
    }
    if (Array.isArray(result)) console.log(label + ':' + result.length);
    else console.log(label + ':' + JSON.stringify(result));
  } catch (e) {
    console.log(label + ':ERR:' + (e.message || String(e)));
  }
}
(async () => {
  await probe('default-secrets', () => svc.getPppoeSecrets(null));
  await probe('default-active', () => svc.getPppoeActive(null));
  await probe('router2-secrets', () => svc.getPppoeSecrets(2));
  await probe('router2-active', () => svc.getPppoeActive(2));
  await probe('default-summary', () => svc.getMonitoringSummary(null));
  await probe('router2-summary', () => svc.getMonitoringSummary(2));
})();
