const db = require(process.cwd() + '/config/database');
console.log(JSON.stringify(db.prepare("PRAGMA table_info(customer_usage_runtime)").all(), null, 2));