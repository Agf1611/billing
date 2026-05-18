const svc=require('/opt/billing-rtrw/services/mikrotikService');
console.log(JSON.stringify(svc.getAllRouters(), null, 2));
