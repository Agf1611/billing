const { RouterOSClient } = require('/opt/billing-rtrw/node_modules/routeros-client');
(async () => {
  const api = new RouterOSClient({ host: '192.168.33.1', user: 'mikhmon', password: 'Agon1611*', port: 2023 });
  try {
    const client = await api.connect();
    const [active, secrets, hotspotUsers, hotspotActive] = await Promise.all([
      client.menu('/ppp/active').get(),
      client.menu('/ppp/secret').get(),
      client.menu('/ip/hotspot/user').get(),
      client.menu('/ip/hotspot/active').get()
    ]);
    console.log(JSON.stringify({
      active: Array.isArray(active) ? active.length : -1,
      secrets: Array.isArray(secrets) ? secrets.length : -1,
      hotspotUsers: Array.isArray(hotspotUsers) ? hotspotUsers.length : -1,
      hotspotActive: Array.isArray(hotspotActive) ? hotspotActive.length : -1
    }, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack || e);
    process.exit(1);
  } finally {
    try { await api.close(); } catch {}
  }
})();
