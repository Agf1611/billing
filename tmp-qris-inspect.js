const fs = require('fs');
for (const file of ['/opt/billing-rtrw/settings.json','/opt/billing-rtrw-3002/settings.json']) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify({
    file,
    qris_static_qr_url: json.qris_static_qr_url || '',
    qris_static_payload_len: String(json.qris_static_payload || '').length
  }));
}
process.exit(0);