const db = require('./config/database');
console.log(JSON.stringify(db.prepare('PRAGMA table_info(customer_usage)').all(), null, 2));
