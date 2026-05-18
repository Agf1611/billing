const Database = require('better-sqlite3');
const db = new Database('/opt/billing-rtrw/database/billing.db', { readonly: true });
const rows = db.prepare("SELECT id, amount, qris_unique_code, qris_amount_unique, status FROM invoices WHERE status = 'unpaid' AND qris_amount_unique IS NOT NULL ORDER BY id DESC LIMIT 5").all();
console.log(JSON.stringify(rows, null, 2));
