(async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { createRequire } = require('module');
  const req = createRequire(process.cwd() + '/');
  const { getSetting } = req('./config/settingsManager.js');
  const wa = await import(pathToFileURL(path.join(process.cwd(), 'services', 'whatsappBot.mjs')).href);
  const linkedDigits = String(wa.whatsappStatus?.user?.id || '').split(':')[0].replace(/\D/g, '');
  const adminNumbers = getSetting('whatsapp_admin_numbers', []);
  const fallbackRaw = String((Array.isArray(adminNumbers) && adminNumbers[0]) || getSetting('company_phone', '') || '').trim();
  const fallbackDigits = fallbackRaw.replace(/\D/g, '');
  const recipient = linkedDigits && linkedDigits.length >= 9
    ? (linkedDigits.startsWith('0') ? `62${linkedDigits.slice(1)}` : linkedDigits)
    : (fallbackDigits.startsWith('0') ? `62${fallbackDigits.slice(1)}` : fallbackDigits);

  const ready = await wa.ensureWhatsAppReady(25000);
  console.log(JSON.stringify({ ready, connection: wa.whatsappStatus.connection, recipient, linkedUser: wa.whatsappStatus?.user?.id || '' }));
  if (!ready || !recipient) process.exit(2);

  const ok = await wa.sendWA(
    recipient,
    `TEST UI WHATSAPP\n\nPesan ini dikirim dari server 192.168.1.10 setelah perbaikan indikator loading.\nWaktu: ${new Date().toLocaleString('id-ID')}`
  );
  console.log(JSON.stringify({ ok, recipient }));
  process.exit(ok ? 0 : 3);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
