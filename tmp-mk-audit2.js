const svc = require('/opt/billing-rtrw/services/mikrotikService');
(async () => {
  const active = await svc.getPppoeActive(null);
  const suspicious = active.filter(r => !String(r.name||'').trim() || !String(r.address||r['address']||'').trim() || !String(r.service||'').trim());
  console.log('ACTIVE_TOTAL', active.length);
  console.log('SUSPICIOUS_TOTAL', suspicious.length);
  suspicious.slice(0, 30).forEach((r, i) => console.log('S', i+1, JSON.stringify({id:r['.id']||r.id,name:r.name,service:r.service,address:r.address,uptime:r.uptime,caller:r['caller-id']||r.callerId,encoding:r.encoding}))); 
})();
