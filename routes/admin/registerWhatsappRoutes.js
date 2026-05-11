module.exports = function registerWhatsappRoutes(router, deps = {}) {
  const {
    express,
    requireAdmin,
    requireAdminSession,
    company,
    flashMsg,
    getSetting,
    saveSettings,
    logger,
    customerSvc,
    billingSvc,
    resolveRequestBaseUrl,
    fillWhatsappTemplate,
    buildWhatsappCustomerPayload,
    defaultBillingWhatsappTemplate,
    defaultDueReminderWhatsappTemplate,
    defaultIsolationWhatsappTemplate,
    defaultWelcomeWhatsappTemplate,
    defaultReactivationWhatsappTemplate,
    defaultPaidWhatsappTemplate,
    buildWhatsappTemplatePreview,
    resolveWhatsappTestRecipient,
    formatPhoneDisplay,
    path,
    fs,
    getRandomDelay,
    getBackoffDelay,
    addMessageVariation,
    isPermanentError
  } = deps;

  router.get('/whatsapp', requireAdminSession, async (req, res) => {
    res.render('admin/whatsapp', {
      title: 'Status WhatsApp',
      company: company(),
      activePage: 'whatsapp',
      msg: flashMsg(req)
    });
  });

  router.get('/whatsapp/broadcast', requireAdminSession, (req, res) => {
    res.render('admin/broadcast', {
      title: 'Broadcast WhatsApp',
      company: company(),
      activePage: 'whatsapp',
      msg: flashMsg(req),
      broadcastStatus: global.broadcastStatus,
      getSetting,
      templateDefaults: {
        billing: defaultBillingWhatsappTemplate(company()),
        dueReminder: defaultDueReminderWhatsappTemplate(company()),
        isolation: defaultIsolationWhatsappTemplate(company()),
        welcome: defaultWelcomeWhatsappTemplate(company()),
        reactivation: defaultReactivationWhatsappTemplate(company()),
        paid: defaultPaidWhatsappTemplate(company())
      }
    });
  });

  router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
    res.json(global.broadcastStatus);
  });

  router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
    if (!global.broadcastStatus.active) {
      return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
    }
    global.broadcastStatus.paused = true;
    logger.info('[Broadcast] Broadcast dipause oleh admin.');
    return res.json({ ok: true, message: 'Broadcast berhasil dipause.' });
  });

  router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
    if (!global.broadcastStatus.active) {
      return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
    }
    global.broadcastStatus.paused = false;
    logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
    return res.json({ ok: true, message: 'Broadcast berhasil dilanjutkan.' });
  });

  router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
    if (!global.broadcastStatus.active) {
      return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
    }
    global.broadcastStatus.stopped = true;
    global.broadcastStatus.paused = false;
    logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
    return res.json({ ok: true, message: 'Broadcast berhasil dihentikan.' });
  });

  router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
      if (!message) throw new Error('Pesan tidak boleh kosong');
      const requestBaseUrl = resolveRequestBaseUrl(req);
      const baseDelayMs = (parseInt(customDelay, 10) || getSetting('whatsapp_broadcast_delay', 5)) * 1000;
      const batchSize = parseInt(customBatchSize, 10) || 15;
      const batchPauseMs = 120000;
      const hourlyLimit = parseInt(customHourlyLimit, 10) || 80;

      if (customDelay) {
        const v = parseInt(customDelay, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 60) {
          saveSettings({ whatsapp_broadcast_delay: v });
        }
      }

      if (global.broadcastStatus.active) {
        throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
      }

      let customers = [];
      const allCust = customerSvc.getAllCustomers();
      if (target === 'all') customers = allCust;
      else if (target === 'active') customers = allCust.filter((c) => c.status === 'active');
      else if (target === 'suspended') customers = allCust.filter((c) => c.status === 'suspended');
      else if (target === 'unpaid') customers = allCust.filter((c) => c.unpaid_count > 0);

      const uniqueCustomers = [];
      const seenPhones = new Set();
      for (const customer of customers) {
        let phoneKey = String(customer.phone || '').replace(/\D/g, '');
        if (phoneKey.startsWith('0')) phoneKey = `62${phoneKey.slice(1)}`;
        if (phoneKey && phoneKey.length > 8 && !seenPhones.has(phoneKey)) {
          uniqueCustomers.push(customer);
          seenPhones.add(phoneKey);
        }
      }

      if (uniqueCustomers.length === 0) {
        throw new Error('Tidak ada nomor pelanggan yang valid untuk target tersebut.');
      }

      const { sendWA, ensureWhatsAppReady } = await import('../../services/whatsappBot.mjs');
      const ready = await ensureWhatsAppReady(25000);
      if (!ready) {
        throw new Error('Bot WhatsApp belum terhubung. Silakan buka menu WhatsApp dan pastikan statusnya Terhubung.');
      }

      global.broadcastStatus = {
        active: true,
        total: uniqueCustomers.length,
        sent: 0,
        failed: 0,
        startTime: new Date(),
        paused: false,
        stopped: false,
        currentBatch: 0,
        messagesPerHour: 0,
        hourlyLimit
      };

      const sendMessageAsync = async () => {
        let batchCount = 0;
        let messagesInCurrentHour = 0;
        let hourStartTime = Date.now();

        for (let i = 0; i < uniqueCustomers.length; i += 1) {
          if (global.broadcastStatus.stopped) {
            logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
            break;
          }

          while (global.broadcastStatus.paused) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (global.broadcastStatus.stopped) break;
          }

          if (global.broadcastStatus.stopped) break;

          const elapsedHour = Date.now() - hourStartTime;
          if (elapsedHour >= 3600000) {
            messagesInCurrentHour = 0;
            hourStartTime = Date.now();
          }

          if (messagesInCurrentHour >= hourlyLimit) {
            const waitTime = 3600000 - elapsedHour;
            logger.info(`[Broadcast] Hourly limit tercapai (${hourlyLimit} pesan). Menunggu ${Math.floor(waitTime / 60000)} menit...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            messagesInCurrentHour = 0;
            hourStartTime = Date.now();
          }

          const customer = uniqueCustomers[i];
          let attemptCount = 0;
          const maxAttempts = 3;

          while (attemptCount < maxAttempts) {
            try {
              const randomDelay = getRandomDelay(baseDelayMs, 2000);
              await new Promise((resolve) => setTimeout(resolve, randomDelay));

              const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
              const primaryInvoice = Array.isArray(unpaidInvoices) && unpaidInvoices.length ? unpaidInvoices[0] : null;
              let formattedMsg = fillWhatsappTemplate(
                message,
                {
                  ...buildWhatsappCustomerPayload(customer, unpaidInvoices, primaryInvoice, { baseUrl: requestBaseUrl }),
                  company: company()
                }
              );

              formattedMsg = addMessageVariation(formattedMsg, i);

              const sentOk = await sendWA(customer.phone, formattedMsg);
              if (!sentOk) throw new Error('sendWA mengembalikan gagal');
              global.broadcastStatus.sent += 1;
              messagesInCurrentHour += 1;
              global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
              batchCount += 1;

              if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
                logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
                global.broadcastStatus.currentBatch += 1;
                await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
                batchCount = 0;
              }

              break;
            } catch (e) {
              attemptCount += 1;
              const errorMsg = e.message || e.toString();
              if (isPermanentError(errorMsg)) {
                logger.warn(`[Broadcast] SKIP: Error permanent untuk ${customer.phone} - ${errorMsg}`);
                global.broadcastStatus.failed += 1;
                break;
              }
              logger.error(`[Broadcast] Gagal kirim ke ${customer.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
              if (attemptCount >= maxAttempts) {
                logger.warn(`[Broadcast] Max attempts tercapai untuk ${customer.phone}`);
                global.broadcastStatus.failed += 1;
              } else {
                const backoffDelay = getBackoffDelay(attemptCount);
                logger.info(`[Broadcast] Retry ke ${customer.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
                await new Promise((resolve) => setTimeout(resolve, backoffDelay));
              }
            }
          }
        }

        global.broadcastStatus.active = false;
        logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
      };

      sendMessageAsync();
      req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${uniqueCustomers.length} pelanggan dengan smart rate limit.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
    }
    res.redirect('/admin/whatsapp/broadcast');
  });

  router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      const enabled = req.body && req.body.enabled ? true : false;
      const delay = req.body && req.body.delay ? parseInt(req.body.delay, 10) : null;
      const next = { whatsapp_auto_billing_enabled: enabled };
      if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
        next.whatsapp_broadcast_delay = delay;
      }
      const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
      if (msg) {
        next.whatsapp_auto_billing_message = msg;
      }
      saveSettings(next);
      req.session._msg = { type: 'success', text: `Pengingat tagihan otomatis ${enabled ? 'diaktifkan' : 'dimatikan'}.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan: ' + e.message };
    }
    res.redirect('/admin/whatsapp/broadcast');
  });

  router.post('/whatsapp/templates', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
    try {
      const next = {
        whatsapp_group_invite_link: String(req.body.whatsapp_group_invite_link || '').trim(),
        whatsapp_welcome_message: String(req.body.whatsapp_welcome_message || '').trim(),
        whatsapp_due_reminder_message: String(req.body.whatsapp_due_reminder_message || '').trim(),
        whatsapp_billing_message: String(req.body.whatsapp_billing_message || '').trim(),
        whatsapp_isolation_message: String(req.body.whatsapp_isolation_message || '').trim(),
        whatsapp_reactivation_message: String(req.body.whatsapp_reactivation_message || '').trim(),
        whatsapp_paid_message: String(req.body.whatsapp_paid_message || '').trim()
      };
      saveSettings(next);
      req.session._msg = { type: 'success', text: 'Template WhatsApp berhasil diperbarui.' };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan template WhatsApp: ' + e.message };
    }
    res.redirect('/admin/whatsapp/broadcast');
  });

  router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const { whatsappStatus } = await import('../../services/whatsappBot.mjs');
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
    try {
      const { sendWA, ensureWhatsAppReady, whatsappStatus } = await import('../../services/whatsappBot.mjs');
      const ready = await ensureWhatsAppReady(25000);
      if (!ready) {
        throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
      }
      const adminPhone = resolveWhatsappTestRecipient(whatsappStatus);
      if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia.');
      const messageText =
        `TEST NOTIFIKASI WHATSAPP\n\n` +
        `WhatsApp bot untuk ${getSetting('company_header', 'Portal Billing ISP')} sudah berfungsi.\n` +
        `Waktu: ${new Date().toLocaleString('id-ID')}`;
      const ok = await sendWA(adminPhone, messageText);
      if (!ok) throw new Error('Gagal mengirim pesan test (sendWA=false).');
      req.session._msg = { type: 'success', text: `Test notifikasi WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
    }
    res.redirect('/admin/whatsapp');
  });

  router.post('/whatsapp/test-template', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const { sendWA, whatsappStatus, ensureWhatsAppReady } = await import('../../services/whatsappBot.mjs');
      const ready = await ensureWhatsAppReady(25000);
      if (!ready) {
        throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
      }
      const adminPhone = resolveWhatsappTestRecipient(whatsappStatus);
      if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia.');
      const templateKey = String(req.body.template_key || 'billing').trim();
      const previewMessage = buildWhatsappTemplatePreview(templateKey, { baseUrl: resolveRequestBaseUrl(req) });
      const ok = await sendWA(adminPhone, previewMessage);
      if (!ok) throw new Error('Gagal mengirim test message.');
      req.session._msg = { type: 'success', text: `Test message WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)}.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim test message: ' + e.message };
    }
    res.redirect('/admin/whatsapp/broadcast');
  });

  router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
    try {
      const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
      const folderPath = path.resolve(__dirname, '..', '..', authFolder);

      if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);

        import('../../services/whatsappBot.mjs').then((m) => m.restartWhatsAppBot()).catch((e) => {
          logger.error('Failed to trigger WA restart:', e.message);
        });

        req.session._msg = { text: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang, silakan tunggu QR Code muncul.', type: 'success' };
      } else {
        req.session._msg = { text: 'Folder sesi tidak ditemukan atau sudah dihapus.', type: 'warning' };
      }
      res.redirect('/admin/whatsapp');
    } catch (e) {
      logger.error('Failed to reset WA session:', e.message);
      req.session._msg = { text: `Gagal menghapus sesi: ${e.message}. (Kemungkinan file sedang digunakan, silakan matikan aplikasi dulu lalu hapus folder ${getSetting('whatsapp_auth_folder', 'auth_info_baileys')} secara manual)`, type: 'danger' };
      res.redirect('/admin/whatsapp');
    }
  });
};
