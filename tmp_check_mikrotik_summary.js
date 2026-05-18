const mik = require('./services/mikrotikService');
(async () => {
  const summary = await mik.getMonitoringSummary(null);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
