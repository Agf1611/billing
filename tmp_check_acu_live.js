const svc = require('./services/mikrotikService');
svc.getPppoeCustomerSnapshot('acu@padanginyang').then((row) => {
  console.log(JSON.stringify(row || {}, null, 2));
  process.exit(0);
}).catch((e) => {
  console.error(e && (e.stack || e.message) || e);
  process.exit(1);
});
