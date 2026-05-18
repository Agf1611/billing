const fs = require('fs');
const s = JSON.parse(fs.readFileSync('/opt/billing-rtrw/settings.json','utf8'));
console.log(JSON.stringify({ secretReady: String(s.payment_notif_secret || '').length >= 8, secretLen: String(s.payment_notif_secret || '').length }, null, 2));
