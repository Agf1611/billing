const RosClient = require('/opt/billing-rtrw/node_modules/ros-client');
const db = require('/opt/billing-rtrw/config/database');
const router = db.prepare('SELECT * FROM routers WHERE id = 2').get();
(async () => {
  const api = new RosClient({ host: router.host, username: router.user, password: router.password, port: Number(router.port)||8728, timeout: 4000 });
  try {
    await api.connect();
    const active = await api.send(['/ppp/active/print']);
    const activeP = await api.send(['/ppp/active/print','=count-only=']);
    const secrets = await api.send(['/ppp/secret/print']);
    const secretsP = await api.send(['/ppp/secret/print','=count-only=']);
    console.log('activeRows', Array.isArray(active) ? active.length : active);
    console.log('activeCountOnly', JSON.stringify(activeP));
    console.log('secretRows', Array.isArray(secrets) ? secrets.length : secrets);
    console.log('secretCountOnly', JSON.stringify(secretsP));
    console.log('sampleActiveLast5', JSON.stringify((active||[]).slice(-5).map(r => ({id:r['.id'], name:r.name, service:r.service, address:r.address, uptime:r.uptime}))));
  } catch (e) {
    console.log('ERR', e.message || String(e));
  } finally {
    try { await api.close(); } catch {}
    process.exit(0);
  }
})();
