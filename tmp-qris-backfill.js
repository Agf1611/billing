const base = process.argv[2];
if (!base) throw new Error('missing base path');
const svc = require(base + '/services/billingService');
console.log(JSON.stringify({ base, ...svc.backfillUniqueQrisForUnpaidInvoices() }, null, 2));
