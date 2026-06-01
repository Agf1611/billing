/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const packageChangeSvc = require('./packageChangeService');
const mikrotikService = require('./mikrotikService');
const usageSvc = require('./usageService');
const whatsappGateway = require('./whatsappGatewayService');
const { getSetting } = require('../config/settingsManager');
const { hasStaticQrisEnabled } = require('./qrisService');
const {
  buildCustomerCheckBillingLink,
  buildCustomerInvoiceCheckBillingLink,
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

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getDaysUntilInvoiceDue(invoice, customer, today = new Date()) {
  const dueAt = billingSvc.getInvoiceDueDate(invoice, customer?.isolate_day);
  if (!dueAt) return null;
  const dueDay = startOfLocalDay(dueAt);
  const currentDay = startOfLocalDay(today);
  return Math.round((dueDay.getTime() - currentDay.getTime()) / (24 * 60 * 60 * 1000));
}

function isCustomerSpeedBoostActive(customer, now = new Date()) {
  const profile = String(customer?.speed_boost_profile || '').trim();
  if (!profile) return false;
  const untilRaw = String(customer?.speed_boost_until || '').trim();
  if (!untilRaw) return false;
  const until = new Date(untilRaw);
  return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
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
  return Boolean(await whatsappGateway.sendText(phone, String(message || '').trim()));
}

function buildInvoicePeriods(invoices = []) {
  const periods = (Array.isArray(invoices) ? invoices : [])
    .map((inv) => `${inv.period_month}/${inv.period_year}`)
    .filter(Boolean);
  return periods.length ? periods.join(', ') : '-';
}

function formatRupiahValue(value) {
  return Number(Math.max(0, Number(value || 0) || 0)).toLocaleString('id-ID');
}

function buildPaymentGuideMessage(customer, invoices = []) {
  const invoiceList = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  let primaryInvoice = invoiceList[0] || null;
  if (
    primaryInvoice &&
    String(primaryInvoice.status || 'unpaid').toLowerCase() === 'unpaid' &&
    (!Number(primaryInvoice.qris_amount_unique || 0) || !Number(primaryInvoice.qris_unique_code || 0)) &&
    hasStaticQrisEnabled({
      qris_static_enabled: getSetting('qris_static_enabled', undefined),
      qris_static_payload: getSetting('qris_static_payload', ''),
      qris_static_qr_url: getSetting('qris_static_qr_url', '')
    }) &&
    String(getSetting('qris_static_payload', '') || '').trim()
  ) {
    try {
      const assigned = billingSvc.assignUniqueQrisForInvoice(primaryInvoice.id);
      if (assigned) {
        primaryInvoice = { ...primaryInvoice, ...assigned };
        const idx = invoiceList.findIndex((inv) => Number(inv.id || 0) === Number(primaryInvoice.id || 0));
        if (idx >= 0) invoiceList[idx] = { ...invoiceList[idx], ...assigned };
      }
    } catch (error) {
      logger.warn(`[CRON] Gagal auto-assign kode unik INV-${primaryInvoice.id}: ${error.message || error}`);
    }
  }
  const totalTagihan = invoiceList.reduce((sum, inv) => sum + (Number(inv.amount || 0) || 0), 0);
  const includePpn = Number(customer?.package_include_ppn || 0) === 1;
  const ppnPercent = includePpn ? Math.max(0, Number(customer?.package_ppn_percent || 0) || 0) : 0;
  const lines = [];

  if (includePpn && ppnPercent > 0 && totalTagihan > 0) {
    const saleAmount = Math.round(totalTagihan / (1 + (ppnPercent / 100)));
    const ppnAmount = Math.max(0, totalTagihan - saleAmount);
    lines.push(
      '',
      `Rincian: Dasar Rp ${formatRupiahValue(saleAmount)} + PPN ${Number(ppnPercent || 0).toLocaleString('id-ID')}% Rp ${formatRupiahValue(ppnAmount)}`
    );
  }

  const baseAmount = Number(primaryInvoice?.amount || 0) || 0;
  const uniqueAmount = Number(primaryInvoice?.qris_amount_unique || 0) || 0;
  const uniqueCode = Number(primaryInvoice?.qris_unique_code || 0) || 0;
  const uniqueDelta = uniqueAmount > baseAmount ? (uniqueAmount - baseAmount) : uniqueCode;
  if (baseAmount > 0 && uniqueAmount > 0 && uniqueDelta > 0) {
    lines.push(
      '',
      `Bayar otomatis: Rp ${formatRupiahValue(uniqueAmount)}`,
      `Kode unik: ${String(uniqueCode || uniqueDelta).padStart(3, '0')}`,
      'Bayar sesuai nominal agar otomatis terbaca lunas.'
    );
  }

  return lines.join('\n').trim();
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
    link: primaryInvoice
      ? buildCustomerInvoiceCheckBillingLink(primaryInvoice, customer)
      : buildCustomerCheckBillingLink(customer),
    portal_link: buildCustomerPortalLoginLink(),
    invoice_link: primaryInvoice ? buildPublicInvoicePrintLink(primaryInvoice, customer) : buildCustomerCheckBillingLink(customer),
    invoice_no: primaryInvoice?.id ? `INV-${primaryInvoice.id}` : '-',
    login_id: String(customer?.pppoe_username || customer?.genieacs_tag || customer?.phone || customer?.id || '').trim(),
    group_link: groupLink,
    group_line: groupLink ? `Grup pelanggan: ${groupLink}` : '',
    payment_guide: buildPaymentGuideMessage(customer, invoiceList),
    company: getSetting('company_header', 'ISP')
  };
}

function normalizeUsageTrackingUsername(value) {
  return String(value || '').trim().toLowerCase();
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

function isSqliteBusyError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('database is locked') || msg.includes('sqlite_busy');
}

async function syncUsageTotalsWithRetry(customerId, totalIn, totalOut, at, meta, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return usageSvc.syncUsageTotals(customerId, totalIn, totalOut, at, meta);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt >= retries) throw error;
      const waitMs = 150 * attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError || new Error('sync usage failed');
}

function startCronJobs() {
  try {
    const pruned = customerSvc.pruneOldPortalNotifications(30);
    if (Number(pruned?.changes || 0) > 0) {
      logger.info(`[CRON] Membersihkan ${pruned.changes} pesan inbox pelanggan lama.`);
    }
  } catch (error) {
    logger.warn(`[CRON] Gagal membersihkan inbox pelanggan saat startup: ${error.message}`);
  }

  cron.schedule('10,40 * * * *', async () => {
    try {
      const processed = await packageChangeSvc.processDueScheduledRequests(50);
      if (processed > 0) {
        logger.info(`[CRON] Berhasil memproses ${processed} request perubahan paket terjadwal.`);
      }
    } catch (error) {
      logger.error(`[CRON] Gagal memproses request perubahan paket terjadwal: ${error.message}`);
    }
  });

  cron.schedule('20 3 * * *', () => {
    try {
      const pruned = customerSvc.pruneOldPortalNotifications(30);
      if (Number(pruned?.changes || 0) > 0) {
        logger.info(`[CRON] Membersihkan ${pruned.changes} pesan inbox pelanggan lebih dari 30 hari.`);
      }
    } catch (error) {
      logger.warn(`[CRON] Gagal membersihkan inbox pelanggan lama: ${error.message}`);
    }
  });

  // 1. Generate tagihan otomatis harian H-7 sebelum tanggal isolir/jatuh tempo pelanggan.
  cron.schedule('30 6 * * *', () => {
    const leadDays = Math.max(0, Number(getSetting('auto_invoice_lead_days', 7) || 7) || 7);
    logger.info(`[CRON] Menjalankan generate tagihan otomatis H-${leadDays} sebelum jatuh tempo.`);
    try {
      const result = billingSvc.generateInvoicesDueInDays(leadDays);
      logger.info(
        `[CRON] Generate tagihan H-${leadDays} selesai: periode=${result.periodMonth}/${result.periodYear}, ` +
        `jatuh_tempo_tgl=${result.dueDay}, eligible=${result.eligible}, dibuat=${result.count}.`
      );
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
        const dueUnpaidInvoices = billingSvc.getDueUnpaidInvoicesByCustomerId(c.id, now);
        // Jika pelanggan aktif dan punya tagihan yang benar-benar sudah jatuh tempo
        if (c.status === 'active' && dueUnpaidInvoices.length > 0) {
          try {
            logger.info(`[CRON] Isolir otomatis pelanggan: ${c.name} (${c.pppoe_username}) - Tanggal Tagihan: ${customerIsolirDay}`);
            
            // Gunakan fungsi terpusat untuk isolir
            await customerSvc.suspendCustomer(c.id);
            const isolationTemplate = String(
              getSetting('whatsapp_isolation_message', defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
              defaultIsolationWhatsappTemplate(getSetting('company_header', 'ISP'))
            ).trim();
            if (c.phone) {
              const messageContext = buildWhatsappMessageContext(c, dueUnpaidInvoices);
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
    if (!enabled) return;

    const ready = waEnabled
      ? await whatsappGateway.ensureReady(25000)
      : false;
    if (waEnabled && !ready) {
      logger.warn('[CRON] WhatsApp belum terhubung, pengingat tagihan otomatis dilewati.');
    }

    const baseDelayMs = (Number(getSetting('whatsapp_broadcast_delay', 5) || 5) * 1000); // Default 5 detik
    const batchSize = Math.max(1, Math.min(20, Number(getSetting('whatsapp_auto_billing_batch_size', 12) || 12) || 12));
    const batchPauseMs = 120000; // Pause 2 menit setelah batch (dari 1 menit)
    const dailyLimit = Math.max(0, Number(getSetting('whatsapp_auto_billing_daily_limit', 0) || 0) || 0);

    const today = new Date();

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
    const billingTemplate = String(
      getSetting('whatsapp_billing_message', defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))) ||
      defaultBillingWhatsappTemplate(getSetting('company_header', 'ISP'))
    ).trim();
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

      let unpaidInvoices = [];
      let targetInvoice = null;
      let daysLeft = null;
      try {
        unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
        targetInvoice = unpaidInvoices.find((invoice) => {
          if (Number(invoice.period_month || 0) !== today.getMonth() + 1 || Number(invoice.period_year || 0) !== today.getFullYear()) {
            return false;
          }
          const diff = getDaysUntilInvoiceDue(invoice, c, today);
          if (![7, 3, 2, 1].includes(diff)) return false;
          daysLeft = diff;
          return true;
        });
      } catch (invoiceError) {
        logger.warn(`[CRON] Gagal cek tagihan unpaid customer ${c.id}: ${invoiceError.message || invoiceError}`);
      }
      if (!targetInvoice || !daysLeft) continue;

      seenPhones.add(digits);
      try {
        const dueText = formatInvoiceDueDate(targetInvoice, c);
        customerSvc.addPortalNotification(c.id, {
          kind: daysLeft === 7 ? 'invoice-ready' : 'due-reminder',
          tab: 'billing',
          title: daysLeft === 7 ? 'Tagihan baru tersedia' : `Pengingat jatuh tempo H-${daysLeft}`,
          body: `Tagihan internet Anda akan jatuh tempo ${dueText}. Silakan cek tagihan agar layanan tetap aktif.`
        }, { dedupeWindowMs: 20 * 60 * 60 * 1000, push: true });
      } catch (notificationError) {
        logger.warn(`[CRON] Gagal simpan notif jatuh tempo customer ${c.id}: ${notificationError.message || notificationError}`);
      }
      targetCustomers.push({
        customer: c,
        daysLeft,
        template: daysLeft === 7 ? billingTemplate : reminderTemplate
      });
      if (dailyLimit > 0 && targetCustomers.length >= dailyLimit) break;
    }

    if (targetCustomers.length === 0) {
      logger.info('[CRON] Tidak ada pelanggan yang perlu diingatkan hari ini.');
      return;
    }

    logger.info(
      `[CRON] Memulai pengingat tagihan otomatis untuk ${targetCustomers.length} pelanggan dengan smart rate limit. ` +
      `Batas harian=${dailyLimit > 0 ? dailyLimit : 'tanpa batas khusus'}.`
    );

    // Kirim pesan dengan smart rate limit
    for (let i = 0; i < targetCustomers.length; i++) {
      const target = targetCustomers[i];
      const c = target.customer;
      let attemptCount = 0;
      const maxAttempts = 3;

      while (attemptCount < maxAttempts) {
        try {
          // Smart Random Delay
          const randomDelay = getRandomDelay(baseDelayMs, 2000);
          await new Promise(r => setTimeout(r, randomDelay));

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id).filter((invoice) =>
            Number(invoice.period_month || 0) === today.getMonth() + 1 &&
            Number(invoice.period_year || 0) === today.getFullYear()
          );
          const messageContext = buildWhatsappMessageContext(c, unpaidInvoices);

          let formattedMsg = ensureDueDateLine(fillWhatsappTemplate(
            target.template,
            messageContext
          ), messageContext.jatuh_tempo);
          if (!/\{\{\s*payment_guide\s*\}\}/i.test(target.template) && messageContext.payment_guide) {
            formattedMsg += `\n\n${messageContext.payment_guide}`;
          }

          // Add subtle variation untuk menghindari spam detection
          formattedMsg = addMessageVariation(formattedMsg, i);

          const ok = ready ? await sendCustomerWhatsapp(c.phone, formattedMsg) : false;
          if (ok) {
            sent++;
            targetCount++;
            batchCount++;
          } else if (!ready) {
            targetCount++;
            break;
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
      const now = new Date();

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        if (isCustomerSpeedBoostActive(c, now)) continue;
        
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
      const now = new Date();

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        if (isCustomerSpeedBoostActive(c, now)) continue;

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

  // 6. Boost Paket Sementara - kembali otomatis ke profil normal
  cron.schedule('*/5 * * * *', async () => {
    try {
      const expired = customerSvc.getExpiredSpeedBoostCustomers(new Date());
      if (!expired.length) return;
      let restored = 0;
      for (const c of expired) {
        const targetProfile = String(c.normal_pppoe_profile || c.package_pppoe_profile || c.package_name || 'default').trim();
        try {
          await mikrotikService.setPppoeProfile(c.pppoe_username, targetProfile, c.router_id, { forceKick: true });
          customerSvc.clearSpeedBoost(c.id);
          restored++;
          logger.info(`[CRON] Boost paket selesai untuk ${c.name}, kembali ke profil ${targetProfile}`);
        } catch (err) {
          logger.error(`[CRON] Gagal restore boost paket ${c.name}: ${err.message}`);
        }
      }
      if (restored) logger.info(`[CRON] Boost paket dikembalikan untuk ${restored} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error restore boost paket: ${e.message}`);
    }
  });

  // 7. Track Usage Pelanggan (Data Traffic) - Setiap 1 Menit
  cron.schedule('* * * * *', async () => {
    const enabled = getSetting('usage_tracking_enabled', true);
    if (!enabled) return;

    try {
      const routers = mikrotikService.getAllRouters();
      const customers = customerSvc.getAllCustomers();
      const customerMap = new Map();
      customers.forEach((c) => {
        const key = normalizeUsageTrackingUsername(c.pppoe_username);
        if (key) customerMap.set(key, c);
      });

      for (const r of routers) {
        try {
          const actives = await mikrotikService.getPppoeActive(r.id);
          for (const s of actives) {
            const username = normalizeUsageTrackingUsername(s.name);
            const cust = customerMap.get(username);
            if (!cust) continue;

            const totalIn = Number(s['bytes-in'] ?? s.bytesIn ?? s.bytes_in ?? 0) || 0;
            const totalOut = Number(s['bytes-out'] ?? s.bytesOut ?? s.bytes_out ?? 0) || 0;
            await syncUsageTotalsWithRetry(cust.id, totalIn, totalOut, new Date(), {
              sessionId: String(s['session-id'] ?? s.sessionId ?? s['.id'] ?? s.id ?? '').trim(),
              uptime: String(s.uptime ?? '').trim(),
              source: `cron-router-${r.id}`
            });
          }
        } catch (err) {
          logger.error(`[CRON] Gagal track usage di router ${r.name}: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error Usage Tracking: ${e.message}`);
    }
  });

  // 8. FUP (Fair Usage Policy) Check - Setiap Jam
  cron.schedule('0 * * * *', async () => {
    logger.info('[CRON] Mengecek FUP Pelanggan...');
    try {
      const customers = customerSvc.getAllCustomers();
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        if (isCustomerSpeedBoostActive(c, now)) continue;
        
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
