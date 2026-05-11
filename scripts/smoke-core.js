const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

function listRoutePaths(router) {
  return (router.stack || [])
    .filter((layer) => layer && layer.route && layer.route.path)
    .map((layer) => String(layer.route.path));
}

try {
  const publicLinkService = require('../services/publicLinkService');
  const runtimeSafety = require('../config/runtimeSafety');
  const customerRouter = require('../routes/customerPortal');
  const adminRouter = require('../routes/adminPortal');

  const base = publicLinkService.resolveRequestBaseUrl({
    protocol: 'http',
    headers: {
      origin: '',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'billing.example.com'
    },
    get(name) {
      return name === 'host' ? 'localhost:3001' : '';
    }
  });

  assert.strictEqual(base, 'https://billing.example.com');
  assert.ok(
    publicLinkService.buildCustomerCheckBillingLink({ phone: '08123' }, { baseUrl: base })
      .startsWith('https://billing.example.com/customer/check-billing?q=')
  );
  assert.strictEqual(
    runtimeSafety.resolveSafeBackRedirect({
      protocol: 'https',
      headers: {},
      get(name) {
        if (name === 'host') return 'billing.example.com';
        if (name === 'Referrer') return 'https://billing.example.com/admin/customers';
        if (name === 'Referer') return 'https://billing.example.com/admin/customers';
        return '';
      }
    }, '/admin'),
    '/admin/customers'
  );

  const customerPaths = listRoutePaths(customerRouter);
  assert.ok(customerPaths.includes('/login'));
  assert.ok(customerPaths.includes('/check-billing'));
  assert.ok(customerPaths.includes('/payment/static/:invoiceId'));

  const adminPaths = listRoutePaths(adminRouter);
  assert.ok(adminPaths.includes('/billing/:id/whatsapp'));
  assert.ok(adminPaths.includes('/update'));
  assert.ok(adminPaths.includes('/settings'));

  const appSource = fs.readFileSync(path.join(root, 'app-customer.js'), 'utf8');
  assert.ok(appSource.includes("app.post('/api/webhook/v1/payment-notif'"));
  assert.ok(appSource.includes("app.get('/health'"));

  console.log('OK core smoke checks');
  setImmediate(() => process.exit(0));
} catch (error) {
  console.error(error.stack || error.message || error);
  setImmediate(() => process.exit(1));
}
