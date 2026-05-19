const path = require('path');

const appRoot = path.resolve(__dirname, '..');
process.chdir(appRoot);

const db = require(path.join(appRoot, 'config', 'database'));
const usageSvc = require(path.join(appRoot, 'services', 'usageService'));

function toGb(bytes) {
  return Number((Number(bytes || 0) / (1024 ** 3)).toFixed(2));
}

function loadCustomer(customerId) {
  return db.prepare(`
    SELECT id, name, pppoe_username
    FROM customers
    WHERE id = ?
  `).get(customerId);
}

function main() {
  const targetArg = String(process.argv[2] || '').trim();
  const now = new Date();
  let results = [];

  if (targetArg) {
    const customer = /^\d+$/.test(targetArg)
      ? loadCustomer(Number(targetArg))
      : db.prepare(`
          SELECT id, name, pppoe_username
          FROM customers
          WHERE lower(name) LIKE ? OR lower(pppoe_username) LIKE ?
          ORDER BY id ASC
          LIMIT 1
        `).get(`%${targetArg.toLowerCase()}%`, `%${targetArg.toLowerCase()}%`);

    if (!customer) {
      console.log(JSON.stringify({ repairedCount: 0, reason: 'customer-not-found', target: targetArg }, null, 2));
      return;
    }

    const repaired = usageSvc.repairUsageReplayForCurrentPeriod(customer.id, now);
    results = repaired?.repaired ? [repaired] : [];
  } else {
    results = usageSvc.repairUsageReplayForAllCurrentCustomers(now);
  }

  const payload = results.map((result) => {
    const customer = loadCustomer(result.customerId);
    return {
      customerId: result.customerId,
      name: customer?.name || '-',
      username: customer?.pppoe_username || '-',
      anchorCreatedAt: result.anchorCreatedAt,
      beforeGb: toGb(Number(result.beforeBytesIn || 0) + Number(result.beforeBytesOut || 0)),
      afterGb: toGb(Number(result.afterBytesIn || 0) + Number(result.afterBytesOut || 0)),
      savedGb: toGb(result.savedBytes || 0)
    };
  });

  console.log(JSON.stringify({
    repairedCount: payload.length,
    repaired: payload
  }, null, 2));
}

main();
