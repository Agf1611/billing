const fs = require('fs');
const path = require('path');
const settingsPath = '/opt/billing-rtrw/settings.json';
const settingsPath2 = '/opt/billing-rtrw-3002/settings.json';
const { decodeQrisPayloadFromUrl } = require('/opt/billing-rtrw/services/qrisService');
(async () => {
  const updateOne = async (file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const url = String(json.qris_static_qr_url || '');
    const payload = await decodeQrisPayloadFromUrl(url);
    if (!payload) throw new Error(`Payload kosong untuk ${file}`);
    json.qris_static_payload = payload;
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
    return { file, payload_len: payload.length, qris_static_qr_url: url };
  };
  const results = [];
  results.push(await updateOne(settingsPath));
  results.push(await updateOne(settingsPath2));
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });