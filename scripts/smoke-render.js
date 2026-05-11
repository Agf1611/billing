const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const views = [
  'views/login.ejs',
  'views/dashboard.ejs',
  'views/static_qris_payment.ejs',
  'views/public_check_billing.ejs',
  'views/admin/customer_requests.ejs',
  'views/admin/settings.ejs',
  'views/admin/update.ejs'
];

for (const rel of views) {
  const file = path.join(root, rel);
  const src = fs.readFileSync(file, 'utf8');
  ejs.compile(src, { filename: file });
  console.log(`OK ${rel}`);
}
