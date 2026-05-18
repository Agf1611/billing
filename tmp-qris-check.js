const { getSettingsWithCache } = require('/opt/billing-rtrw/config/settingsManager');
const { decodeQrisPayloadFromUrl } = require('/opt/billing-rtrw/services/qrisService');
(async () => {
  const s = getSettingsWithCache();
  const url = String(s.qris_static_qr_url || '');
  let decoded = '';
  let error = '';
  try {
    decoded = await decodeQrisPayloadFromUrl(url);
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  console.log(JSON.stringify({
    qris_static_qr_url: url,
    qris_static_payload_len: String(s.qris_static_payload || '').length,
    qris_static_payload_sample: String(s.qris_static_payload || '').slice(0, 120),
    decoded_payload_len: String(decoded || '').length,
    decoded_payload_sample: String(decoded || '').slice(0, 120),
    payment_notif_secret_len: String(s.payment_notif_secret || '').length,
    mode: s.qris_static_payload ? 'dynamic' : 'static',
    decode_error: error
  }, null, 2));
  process.exit(0);
})();