const Database=require('/opt/billing-rtrw/node_modules/better-sqlite3');
const db=new Database('/opt/billing-rtrw/database/billing.db',{readonly:true});
console.log('routers', JSON.stringify(db.prepare('SELECT id,name,host,port,is_active FROM routers ORDER BY id').all(), null, 2));
