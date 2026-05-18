const mik = require('./services/mikrotikService');

(async () => {
  const conn = await mik.getConnection(null);
  const commands = [
    ['/ppp/active/print', '?name=acu@padanginyang'],
    ['/ppp/active/print', '=.proplist=.id,name,bytes-in,bytes-out,uptime,address,interface', '?name=acu@padanginyang'],
    ['/ppp/active/print', '=stats=', '?name=acu@padanginyang'],
    ['/ppp/active/print', '=.proplist=.id,name,uptime,address,caller-id,session-id', '?name=acu@padanginyang'],
    ['/interface/print', '?name=acu@padanginyang'],
    ['/interface/print', '=.proplist=.id,name,rx-byte,tx-byte,rx-packet,tx-packet,type,running,dynamic', '?name=acu@padanginyang'],
    ['/interface/pppoe-server/print', '?name=acu@padanginyang']
  ];
  try {
    for (const words of commands) {
      try {
        const result = await conn.api.send(words);
        console.log('CMD', JSON.stringify(words));
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.log('CMD', JSON.stringify(words));
        console.log('ERR', err.message);
      }
    }
  } finally {
    try { await conn.api.close(); } catch {}
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
