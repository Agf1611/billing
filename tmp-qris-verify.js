const { getSettingsWithCache } = require('/opt/billing-rtrw/config/settingsManager');
const { buildDynamicQrisPayload } = require('/opt/billing-rtrw/services/qrisService');
const db = require('/opt/billing-rtrw/config/database');
const s = getSettingsWithCache();
const sample = db.prepare("SELECT id, amount, qris_amount_unique, status FROM invoices WHERE status='unpaid' ORDER BY id DESC LIMIT 1").get();
const exact = Number(sample?.qris_amount_unique || sample?.amount || 0) || 0;
const dyn = buildDynamicQrisPayload(String(s.qris_static_payload || ''), exact || 150000);
console.log(JSON.stringify({
  mode: s.qris_static_payload ? 'dynamic' : 'static',
  unpaid_invoice_id: sample?.id || null,
  exact_amount: exact || 150000,
  dynamic_payload_len: String(dyn || '').length,
  dynamic_payload_sample: String(dyn || '').slice(0, 80)
}, null, 2));
process.exit(0);