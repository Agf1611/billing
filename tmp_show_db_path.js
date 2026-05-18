const db = require(process.cwd() + '/config/database');
console.log(JSON.stringify(db.prepare("PRAGMA database_list").all(), null, 2));