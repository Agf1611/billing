/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const mikrotikService = require('./mikrotikService');
const usageSvc = require('./usageService');
const { getSetting } = require('../config/settingsManager');
const {
  buildCustomerCheckBillingLink,
  buildCustomerPortalLoginLink,
  buildPublicInvoicePrintLink,
  formatInvoiceDueDate,
  defaultBillingWhatsappTemplate,
  defaultDueReminderWhatsappTemplate,
  defaultIsolationWhatsappTemplate,
  fillWhatsappTemplate,
  ensureDueDateLine
} = require('./publicLinkService');

function getEffectiveCustomerBillingDay(rawDay, month, year) {
  const day = Number(rawDay || 0) || Number(getSetting('isolir_day', 10) || 10) || 10;
  return billingSvc.getEffectiveBillingDay(day, month, year);
}

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

async function sendCustomerWhatsapp(phone, message) {
  if (!getSetting('whatsapp_enabled', false)) return false;
  let sendWA;
  try {
    const mod = await import('./whatsappBot.mjs');
    sendWA = mod.sendWA;
  } catch (e) {
    logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
    return false;
  }
  return Boolean(await sendWA(phone, String(message || '').trim()));
}

function buildInvoicePeriods(invoices = []) {
  const periods = (Array.isArray(invoices) ? invoices : [])
    .map((inv) => `${inv.period_month}/${inv.period_year}`)
    .filter(Boolean);
  return periods.length ? periods.join(', ') : '-';
}

function buildWhatsappMessageContext(customer, invoices = []) {
  const invoiceList = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  const primaryInvoice = invoiceList[0] || null;
  const totalTagihan = invoiceList.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const groupLink = String(getSetting('whatsapp_group_invite_link', '') || '').trim();
  return {
    nama: customer?.name || 'Pelanggan',
    paket: String(customer?.package_name || primaryInvoice?.package_name || '-').trim() || '-',
    tagihan: Number(totalTagihan || 0).toLocaleString('id-ID'),
    rincian: buildInvoicePeriods(invoiceList),
    jatuh_tempo: primaryInvoice ? formatInvoiceDueDate(primaryInvoice, customer) : '-',
    link: buildCustomerCheckBillingLink(customer),
    portal_link: buildCustomerPortalLoginLink(),
    invoice_link: primaryInvoice ? buildPublicInvoicePrintLink(primaryInvoice, customer) : buildCustomerCheckBillingLink(customer),
    invoice_no: primaryInvoice?.id ? `INV-${primaryInvoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: groupLink,
    group_line: groupLink ? `Grup pelanggan: ${groupLink}` : '',
    company: getSetting('company_header', 'ISP')
  };
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

function startCronJobs() {
  // 1. Generate Tagihan Otomatis setiap tanggal 1 jam 07:00
  cron.schedule('0 7 1 * *', () => {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    
    logger.info(`[CRON] Menjalankan generate tagihan otomatis untuk ${month}/${year}`);
    try {
      const count = billingSvc.generateMonthlyInvoices(month, year);
      logger.info(`[CRON] Berhasil generate ${count} tagihan otomatis.`);
    } catch (error) {
      logger.error(`[CRON] Gagal generate tagihan otomatis: ${error.message}`);
    }
  });

  // 2. Isolir Otomatis setiap hari jam 07:00
  cron.schedule('0 7 * * *', async () => {
    const now = new Date();
    const today = now.getDate();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    // Kita cek semua pelanggan setiap hari untuk isolir otomatis
    logger.info(`[CRON] Menjalankan pengecekan isolir otomatis harian (Tanggal ${today})`);
    
    const customers = customerSvc.getAllCustomers();
    let isolatedCount = 0;

    for (const c of customers) {
      // Cek apakah isolir otomatis aktif untuk user ini dan hari ini adalah tanggal isolirnya
      const customerIsolirDay = getEffectiveCustomerBillingDay(c.isolate_day, month, year);
      const isAutoIsolateEnabled = c.auto_isolate !== 0; // default aktif jika null/1

      if (isAutoIsolateEnabled && today >= customerIsolirDay) {
        // Jika pelanggan aktif tapi punya tagihan belum bayar
        if (c.status === 'active' && c.unpaid_count > 0) {
          try {
            logger.info(`[CRON] Isolir otomatis pelanggan: ${c.name} (${c.pppoe_username}) - Tanggal Tagihan: ${customerIsolirDay}`);
            
            // Gunakan fungsi terpusat untuk isolir
            await customerSvc.suspendCustomer(c.id);
            const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
            const isolationTemplate = String(
              getSetting('whatsapp_isolation_message', defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
              defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))
            ).trim();
            if (c.phone) {
              const messageContext = buildWhatsappMessageContext(c, unpaidInvoices);
              await sendCustomerWhatsapp(
                c.phone,
                ensureDueDateLine(fillWhatsappTemplate(isolationTemplate, {
                  ...messageContext,
                  alasan: 'Layanan dinonaktifkan sementara karena masih ada tagihan yang belum lunas.'
                }), messageContext.jatuh_tempo)
              );
            }
            
            isolatedCount++;
          } catch (err) {
            logger.error(`[CRON] Gagal isolir ${c.name}: ${err.message}`);
          }
        }
      }
    }
    logger.info(`[CRON] Selesai pengecekan isolir. Total ${isolatedCount} pelanggan baru di-isolir.`);
  });

  cron.schedule('0 9 * * *', async () => {
    const enabled = getSetting('whatsapp_auto_billing_enabled', false);
    const waEnabled = getSetting('whatsapp_enabled', false);
    if (!enabled || !waEnabled) return;

    let ensureWhatsAppReady;
    try {
      const mod = await import('./whatsappBot.mjs');
      ensureWhatsAppReady = mod.ensureWhatsAppReady;
    } catch (e) {
      logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
      return;
    }

    const ready = typeof ensureWhatsAppReady === 'function'
      ? await ensureWhatsAppReady(25000)
      : false;
    if (!ready) {
      logger.warn('[CRON] WhatsApp bot belum terhubung, pengingat tagihan otomatis dilewati.');
      return;
    }

    const baseDelayMs = (Number(getSetting('whatsapp_broadcast_delay', 5) || 5) * 1000); // Default 5 detik
    const batchSize = 15; // 15 pesan per batch (dari 20)
    const batchPauseMs = 120000; // Pause 2 menit setelah batch (dari 1 menit)

    const today = new Date();
    const day = today.getDate();

    const customers = customerSvc.getAllCustomers();
    let targetCount = 0;
    let sent = 0;
    let failed = 0;
    let batchCount = 0;

    const defaultTemplate =
      `Yth. Pelanggan {{nama}},\n\n` +
      `Ini adalah pengingat tagihan internet Anda sebelum jatuh tempo pembayaran.\n\n` +
      `📦 *Paket:* {{paket}}\n` +
      `💰 *Total Tagihan:* Rp {{tagihan}}\n` +
      `📅 *Periode:* {{rincian}}\n\n` +
      `Mohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\n` +
      `Terima kasih atas kerja samanya.\n` +
      `Salam,\nAdmin ${getSetting('company_header', 'ISP')}`;
    const template = String(getSetting('whatsapp_auto_billing_message', defaultTemplate) || defaultTemplate);
    const reminderTemplate = String(
      getSetting('whatsapp_due_reminder_message', getSetting('whatsapp_billing_message', template)) ||
      template
    ).trim();

    // Filter pelanggan yang perlu diingatkan
    const targetCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      const phone = c.phone ? String(c.phone).trim() : '';
      if (!phone || phone.length < 9) continue;
      let digits = phone.replace(/\D/g, '');
      if (!digits) continue;
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      if (seenPhones.has(digits)) continue;
      const unpaidCount = Number(c.unpaid_count || 0) || 0;
      if (unpaidCount <= 0) continue;

      const dueDay = getEffectiveCustomerBillingDay(c.isolate_day, today.getMonth() + 1, today.getFullYear());
      const reminderDays = [dueDay - 3, dueDay - 2, dueDay - 1].filter((candidate) => candidate >= 1);
      const shouldSend = reminderDays.includes(day);
      if (!shouldSend) continue;

      seenPhones.add(digits);
      targetCustomers.push(c);
    }

    if (targetCustomers.length === 0) {
      logger.info('[CRON] Tidak ada pelanggan yang perlu diingatkan hari ini.');
      return;
    }

    logger.info(`[CRON] Memulai pengingat tagihan otomatis untuk ${targetCustomers.length} pelanggan dengan smart rate limit.`);

    // Kirim pesan dengan smart rate limit
    for (let i = 0; i < targetCustomers.length; i++) {
      const c = targetCustomers[i];
      let attemptCount = 0;
      const maxAttempts = 3;

      while (attemptCount < maxAttempts) {
        try {
          // Smart Random Delay
          const randomDelay = getRandomDelay(baseDelayMs, 2000);
          await new Promise(r => setTimeout(r, randomDelay));

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
          const messageContext = buildWhatsappMessageContext(c, unpaidInvoices);

          let formattedMsg = ensureDueDateLine(fillWhatsappTemplate(
            reminderTemplate,
            messageContext
          ), messageContext.jatuh_tempo);

          // Add subtle variation untuk menghindari spam detection
          formattedMsg = addMessageVariation(formattedMsg, i);

          const ok = await sendCustomerWhatsapp(c.phone, formattedMsg);
          if (ok) {
            sent++;
            targetCount++;
            batchCount++;
          } else {
            throw new Error('Gagal kirim pesan');
          }

          // Batch Processing: Pause setelah N pesan
          if (batchCount >= batchSize && i < targetCustomers.length - 1) {
            logger.info(`[CRON] Selesai batch ${Math.floor(i / batchSize) + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
            await new Promise(r => setTimeout(r, batchPauseMs));
            batchCount = 0;
          }

          break; // Sukses, keluar dari retry loop
        } catch (e) {
          attemptCount++;
          const errorMsg = e.message || e.toString();

          // Cek apakah error permanent (tidak perlu retry)
          if (isPermanentError(errorMsg)) {
            logger.warn(`[CRON] SKIP: Error permanent untuk ${c.phone} - ${errorMsg}`);
            failed++;
            break; // Skip retry langsung ke pelanggan berikutnya
          }

          // Error temporary, bisa retry
          logger.error(`[CRON] Gagal kirim ke ${c.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);

          if (attemptCount >= maxAttempts) {
            logger.warn(`[CRON] Max attempts tercapai untuk ${c.phone}`);
            failed++;
          } else {
            // Exponential backoff untuk retry
            const backoffDelay = getBackoffDelay(attemptCount);
            logger.info(`[CRON] Retry ke ${c.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
            await new Promise(r => setTimeout(r, backoffDelay));
          }
        }
      }
    }

    logger.info(`[CRON] Pengingat tagihan otomatis selesai: target=${targetCount}, terkirim=${sent}, gagal=${failed}`);
  });

  // 4. Jam Kalong (Night Speed) Start - Jam 00:00
  cron.schedule('0 0 * * *', async () => {
    logger.info('[CRON] Memulai Jam Kalong (Night Speed) - Ganti Profile...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        
        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1 && pkg.night_profile_name) {
          try {
            logger.info(`[CRON] Switching ${c.name} to Night Profile: ${pkg.night_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, pkg.night_profile_name, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal switch Jam Kalong untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Jam Kalong aktif untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong Start: ${e.message}`);
    }
  });

  // 5. Jam Kalong (Night Speed) End - Jam 06:00
  cron.schedule('0 6 * * *', async () => {
    logger.info('[CRON] Mengakhiri Jam Kalong (Night Speed) - Kembali ke Profile Normal...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;

        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1) {
          try {
            // Kembali ke profile normal pelanggan atau default paket
            const normalProfile = c.normal_pppoe_profile || pkg.pppoe_profile || pkg.name;
            logger.info(`[CRON] Restoring ${c.name} to Normal Profile: ${normalProfile}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, normalProfile, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal restore profil normal untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Profil normal dikembalikan untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong End: ${e.message}`);
    }
  });

  // 6. Track Usage Pelanggan (Data Traffic) - Setiap 10 Menit
  cron.schedule('*/10 * * * *', async () => {
    const enabled = getSetting('usage_tracking_enabled', true);
    if (!enabled) return;

    try {
      const routers = mikrotikService.getAllRouters();
      const customers = customerSvc.getAllCustomers();
      const customerMap = new Map();
      customers.forEach(c => { if (c.pppoe_username) customerMap.set(c.pppoe_username, c); });

      for (const r of routers) {
        try {
          const actives = await mikrotikService.getPppoeActive(r.id);
          for (const s of actives) {
            const username = s.name;
            const cust = customerMap.get(username);
            if (!cust) continue;

            const totalIn = Number(s['bytes-in'] ?? s.bytesIn ?? s.bytes_in ?? 0) || 0;
            const totalOut = Number(s['bytes-out'] ?? s.bytesOut ?? s.bytes_out ?? 0) || 0;
            usageSvc.syncUsageTotals(cust.id, totalIn, totalOut);
          }
        } catch (err) {
          logger.error(`[CRON] Gagal track usage di router ${r.name}: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error Usage Tracking: ${e.message}`);
    }
  });

  // 7. FUP (Fair Usage Policy) Check - Setiap Jam
  cron.schedule('0 * * * *', async () => {
    logger.info('[CRON] Mengecek FUP Pelanggan...');
    try {
      const customers = customerSvc.getAllCustomers();
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        
        const pkg = customerSvc.getPackageById(c.package_id);
        if (!pkg || pkg.use_fup !== 1 || !pkg.fup_limit_gb || pkg.fup_limit_gb <= 0 || !pkg.fup_profile_name) continue;

        const usage = usageSvc.getUsage(c.id, month, year);
        if (!usage) continue;

        const totalGB = (usage.bytes_in + usage.bytes_out) / (1024 * 1024 * 1024);
        
        if (totalGB >= pkg.fup_limit_gb) {
          logger.warn(`[CRON] Pelanggan ${c.name} melewati FUP (${totalGB.toFixed(2)} GB / ${pkg.fup_limit_gb} GB). Menurunkan kecepatan (Ganti Profile)...`);
          
          try {
            // Ganti ke profile FUP yang sudah ditentukan di paket
            logger.info(`[CRON] Switching ${c.name} to FUP Profile: ${pkg.fup_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, pkg.fup_profile_name, c.router_id);
          } catch (err) {
            logger.error(`[CRON] Gagal apply FUP untuk ${c.name}: ${err.message}`);
          }
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error FUP Check: ${e.message}`);
    }
  });

  logger.info('[CRON] Semua tugas penjadwalan telah aktif.');
}

module.exports = { startCronJobs };
