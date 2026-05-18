const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('/opt/billing-rtrw/settings.json','utf8'));
const secret = String(settings.payment_notif_secret || '');
fetch('http://127.0.0.1:3001/api/webhook/v1/payment-notif', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Codex-QRIS-Test' },
  body: JSON.stringify({
    service: 'manual-test',
    content: 'DANA Business: pembayaran QRIS masuk sebesar Rp 123.456 pada 15/05/2026 17:30',
    secret_key: secret
  })
}).then(async (res) => {
  const text = await res.text();
  console.log(JSON.stringify({ status: res.status, body: text }, null, 2));
}).catch((err) => { console.error(err.stack || String(err)); process.exit(1); });
