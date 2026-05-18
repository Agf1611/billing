const db = require('./config/database');
const row = db.prepare("SELECT id,name,phone,genieacs_tag,pppoe_username FROM customers WHERE lower(name)=lower(?) LIMIT 1").get('ACU');
if (!row) { console.log('NOT_FOUND'); process.exit(0); }
const invoice = db.prepare("SELECT id,status,amount,qris_amount_unique,qris_unique_code,period_month,period_year FROM invoices WHERE customer_id=? ORDER BY id DESC LIMIT 5").all(row.id);
console.log(JSON.stringify({ customer: row, invoices: invoice }, null, 2));