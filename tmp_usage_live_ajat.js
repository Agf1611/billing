const svc = require('./services/customerDetailService');
(async () => {
  for (const username of ['ajat@lewimalang','ajat']) {
    const live = await svc.resolvePppoeTrafficLive(username, null, []);
    console.log(username, JSON.stringify(live, null, 2));
  }
})().catch(err => { console.error(err); process.exit(1); });
