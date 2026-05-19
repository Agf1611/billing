const db = require('/opt/billing-rtrw/config/database');
const row = db.prepare("SELECT host, port, user, password FROM routers WHERE is_active = 1 LIMIT 1").get();
console.log(JSON.stringify(row, null, 2));
