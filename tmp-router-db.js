const db = require('/opt/billing-rtrw/config/database');
console.log(JSON.stringify(db.prepare("SELECT id, name, host, port, user, is_active, os_mode FROM routers ORDER BY id").all(), null, 2));
