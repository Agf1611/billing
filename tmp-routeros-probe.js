const { RouterOSClient } = require('/opt/billing-rtrw/node_modules/routeros-client');
const settings = require('/opt/billing-rtrw/settings.json');
(async () => {
  const api = new RouterOSClient({
    host: settings.mikrotik_host,
    user: settings.mikrotik_user,
    password: settings.mikrotik_password,
    port: Number(settings.mikrotik_port || 8728)
  });
  try {
    const client = await api.connect();
    const [active, secrets, hotspotUsers, hotspotActive] = await Promise.all([
      client.menu('/ppp/active').get(),
      client.menu('/ppp/secret').get(),
      client.menu('/ip/hotspot/user').get(),
      client.menu('/ip/hotspot/active').get()
    ]);
    const summarize = (rows, nameKey) => {
      const arr = Array.isArray(rows) ? rows : [];
      const uniq = new Set(arr.map(r => String((r && r[nameKey]) || '').trim()).filter(Boolean));
      return { len: arr.length, uniq: uniq.size };
    };
    console.log(JSON.stringify({
      active: summarize(active, 'name'),
      secrets: summarize(secrets, 'name'),
      hotspotUsers: summarize(hotspotUsers, 'name'),
      hotspotActive: summarize(hotspotActive, 'user')
    }, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack || e);
    process.exit(1);
  } finally {
    try { await api.close(); } catch {}
  }
})();
