const multer = require('multer');
const { persistCompressedImageUpload } = require('../../services/imageUploadService');
const whatsappGateway = require('../../services/whatsappGatewayService');

const announcementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = String(file?.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) return cb(new Error('Lampiran pengumuman harus berupa gambar.'));
    return cb(null, true);
  }
});

module.exports = function registerWhatsappRoutes(router, deps = {}) {
  const {
    express,
    requireAdmin,
    requireAdminSession,
    company,
    flashMsg,
    getSetting,
    getSettings,
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
    isPermanentError,
    isPushConfigured,
    sendPushToCustomer
  } = deps;

  function buildBroadcastAnnouncementMessage(customer, template, options = {}) {
    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const primaryInvoice = Array.isArray(unpaidInvoices) && unpaidInvoices.length ? unpaidInvoices[0] : null;
    const payload = buildWhatsappCustomerPayload(customer, unpaidInvoices, primaryInvoice, options);
    return fillWhatsappTemplate(template, {
      ...payload,
      company: company()
    }).trim();
  }

  async function persistAnnouncementImage(file) {
    if (!file?.buffer?.length) return null;
    const saved = await persistCompressedImageUpload(file, 'announcement', {
      maxBytes: 900 * 1024,
      maxDimension: 1800
    });
    return saved && saved.publicUrl ? saved : null;
  }

  function resolveAbsoluteAssetUrl(req, assetUrl = '') {
    const value = String(assetUrl || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    const baseUrl = resolveRequestBaseUrl(req);
    return `${String(baseUrl || '').replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  }

  function buildAnnouncementPayload({ source = 'broadcast', target = '', imageUrl = '', absoluteImageUrl = '' } = {}) {
    return {
      senderName: 'Admin',
      senderRole: 'Pengumuman',
      source,
      target,
      ...(imageUrl ? { imageUrl, image_url: imageUrl } : {}),
      ...(absoluteImageUrl ? { mediaUrl: absoluteImageUrl, media_url: absoluteImageUrl } : {})
    };
  }

  async function sendWhatsappAnnouncement({ phone, message, imageFilePath = '', imageUrl = '', fs }) {
    const caption = String(message || '').trim();
    if (imageFilePath && fs?.existsSync(imageFilePath)) {
      const buffer = fs.readFileSync(imageFilePath);
      return Boolean(await whatsappGateway.sendImage(phone, buffer, caption, { mediaUrl: imageUrl }));
    }
    return Boolean(await whatsappGateway.sendText(phone, caption));
  }

  router.get('/whatsapp', requireAdminSession, async (req, res) => {
    res.render('admin/whatsapp', {
      title: 'Status WhatsApp',
      company: company(),
      activePage: 'whatsapp',
      msg: flashMsg(req),
      getSetting
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

  router.post('/whatsapp/test-push', requireAdminSession, announcementUpload.single('announcement_image'), async (req, res) => {
    try {
      if (typeof isPushConfigured !== 'function' || typeof sendPushToCustomer !== 'function') {
        throw new Error('Modul push OneSignal belum tersedia.');
      }

      const settings = typeof getSettings === 'function' ? getSettings() : {};
      if (!isPushConfigured(settings)) {
        throw new Error('OneSignal belum lengkap. Isi App ID dan REST API Key di Pengaturan.');
      }

      const lookup = String(req.body.customer_lookup || '').trim();
      if (!lookup) throw new Error('Isi ID pelanggan, nomor HP, PPPoE username, atau tag pelanggan untuk test push.');

      const customer = customerSvc.findCustomerByAny(lookup);
      if (!customer) throw new Error('Pelanggan tujuan test push tidak ditemukan.');

      const title = String(req.body.push_title || 'Test Push Portal').trim() || 'Test Push Portal';
      const message = String(req.body.push_message || 'Jika notifikasi ini masuk, push OneSignal portal pelanggan sudah aktif.').trim();
      if (!message) throw new Error('Isi pesan push tidak boleh kosong.');

      const baseUrl = resolveRequestBaseUrl(req);
      const uploadedImage = await persistAnnouncementImage(req.file);
      const imageUrl = uploadedImage?.publicUrl || '';
      const absoluteImageUrl = resolveAbsoluteAssetUrl(req, imageUrl);
      const result = await sendPushToCustomer(customer, {
        settings,
        title,
        message,
        targetUrl: `${baseUrl}/customer/dashboard#home`,
        imageUrl: absoluteImageUrl,
        data: {
          kind: 'test-push',
          source: 'admin-test-push',
          customerId: Number(customer.id || 0) || null,
          ...(imageUrl ? { imageUrl, image_url: imageUrl } : {})
        }
      });

      if (!result || result.success !== true) {
        throw new Error(`OneSignal belum menerima push: ${result?.reason || result?.error || 'unknown-error'}`);
      }

      try {
        customerSvc.addPortalNotification(customer.id, {
          kind: 'announcement',
          tab: 'home',
          title,
          body: message,
          payload: buildAnnouncementPayload({
            source: 'admin-test-push',
            target: 'test',
            imageUrl,
            absoluteImageUrl
          })
        });
      } catch (notificationError) {
        logger.warn(`[PushTest] Push terkirim, tetapi gagal simpan inbox: ${notificationError.message}`);
      }

      req.session._msg = {
        type: 'success',
        text: `Test push berhasil dikirim ke ${customer.name || lookup}. Pastikan pelanggan sudah mengizinkan notifikasi di portal.`
      };
    } catch (error) {
      logger.warn(`[PushTest] Gagal kirim test push: ${error.message}`);
      req.session._msg = { type: 'error', text: 'Gagal kirim test push: ' + error.message };
    }
    return res.redirect('/admin/whatsapp/broadcast');
  });

  router.post('/whatsapp/broadcast', requireAdminSession, announcementUpload.single('announcement_image'), async (req, res) => {
    try {
      const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit, send_whatsapp, send_push, push_title, broadcast_mode, test_lookup } = req.body;
      if (!message) throw new Error('Pesan tidak boleh kosong');
      const shouldSendWhatsapp = String(send_whatsapp || '').toLowerCase() === '1' || String(send_whatsapp || '').toLowerCase() === 'true' || send_whatsapp === 'on';
      const shouldSendPush = String(send_push || '').toLowerCase() === '1' || String(send_push || '').toLowerCase() === 'true' || send_push === 'on';
      if (!shouldSendWhatsapp && !shouldSendPush) {
        throw new Error('Pilih minimal satu channel broadcast: WhatsApp atau Push App.');
      }
      const requestBaseUrl = resolveRequestBaseUrl(req);
      const baseDelayMs = (parseInt(customDelay, 10) || getSetting('whatsapp_broadcast_delay', 5)) * 1000;
      const batchSize = parseInt(customBatchSize, 10) || 15;
      const batchPauseMs = 120000;
      const hourlyLimit = parseInt(customHourlyLimit, 10) || 80;
      const isTestMode = String(broadcast_mode || '').toLowerCase() === 'test';
      const uploadedImage = await persistAnnouncementImage(req.file);
      const imageUrl = uploadedImage?.publicUrl || '';
      const imageFilePath = uploadedImage?.filePath || '';
      const absoluteImageUrl = resolveAbsoluteAssetUrl(req, imageUrl);

      if (customDelay) {
        const v = parseInt(customDelay, 10);
        if (Number.isFinite(v) && v >= 1 && v <= 60) {
          saveSettings({ whatsapp_broadcast_delay: v });
        }
      }

      if (!isTestMode && global.broadcastStatus.active) {
        throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
      }

      let customers = [];
      if (isTestMode) {
        const lookup = String(test_lookup || '').trim();
        if (!lookup) throw new Error('Isi pelanggan tujuan untuk test pengumuman.');
        const customer = customerSvc.findCustomerByAny(lookup);
        if (!customer) throw new Error('Pelanggan tujuan test pengumuman tidak ditemukan.');
        customers = [customer];
      } else {
        const allCust = customerSvc.getAllCustomers();
        if (target === 'all') customers = allCust;
        else if (target === 'active') customers = allCust.filter((c) => c.status === 'active');
        else if (target === 'suspended') customers = allCust.filter((c) => c.status === 'suspended');
        else if (target === 'unpaid') customers = allCust.filter((c) => c.unpaid_count > 0);
      }

      const uniqueCustomers = [];
      const seenPhones = new Set();
      for (const customer of customers) {
        let phoneKey = String(customer.phone || '').replace(/\D/g, '');
        if (phoneKey.startsWith('0')) phoneKey = `62${phoneKey.slice(1)}`;
        const key = shouldSendWhatsapp ? phoneKey : String(customer.id || phoneKey || '');
        if (key && (!shouldSendWhatsapp || phoneKey.length > 8) && !seenPhones.has(key)) {
          uniqueCustomers.push(customer);
          seenPhones.add(key);
        }
      }

      if (uniqueCustomers.length === 0) {
        throw new Error(shouldSendWhatsapp ? 'Tidak ada nomor pelanggan yang valid untuk target tersebut.' : 'Tidak ada pelanggan yang valid untuk target tersebut.');
      }

      const pushTitle = String(push_title || 'Pengumuman Pelanggan').trim() || 'Pengumuman Pelanggan';
      const portalAnnouncementItems = uniqueCustomers.map((customer) => ({
        customer,
        body: buildBroadcastAnnouncementMessage(customer, message, { baseUrl: requestBaseUrl }) || 'Ada pengumuman baru untuk pelanggan.'
      }));

      if (shouldSendPush) {
        const settings = typeof getSettings === 'function' ? getSettings() : {};
        if (typeof isPushConfigured !== 'function' || typeof sendPushToCustomer !== 'function' || !isPushConfigured(settings)) {
          throw new Error('OneSignal belum aktif atau belum lengkap. Cek App ID dan REST API Key di Pengaturan.');
        }
        for (const item of portalAnnouncementItems) {
          await sendPushToCustomer(item.customer, {
            settings,
            title: pushTitle,
            message: item.body,
            targetUrl: `${requestBaseUrl}/customer/dashboard#home`,
            imageUrl: absoluteImageUrl,
            data: {
              kind: 'announcement',
              source: isTestMode ? 'broadcast-test' : 'broadcast',
              target,
              ...(imageUrl ? { imageUrl, image_url: imageUrl } : {})
            }
          });
        }
      }

      try {
        for (const item of portalAnnouncementItems) {
          customerSvc.addPortalNotification(item.customer.id, {
            kind: 'announcement',
            tab: 'home',
            title: pushTitle,
            body: item.body,
            payload: buildAnnouncementPayload({
              source: isTestMode ? 'broadcast-test' : 'broadcast',
              target,
              imageUrl,
              absoluteImageUrl
            })
          });
        }
      } catch (notificationError) {
        logger.warn(`[Broadcast] Simpan inbox pengumuman gagal: ${notificationError.message}`);
      }

      if (!shouldSendWhatsapp) {
        req.session._msg = { type: 'success', text: `${isTestMode ? 'Test' : 'Broadcast'} push berhasil dikirim/disimpan untuk ${uniqueCustomers.length} pelanggan tanpa WhatsApp.` };
        return res.redirect('/admin/whatsapp/broadcast');
      }

      const ready = await whatsappGateway.ensureReady(25000);
      if (!ready) {
        throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
      }

      if (isTestMode) {
        const customer = uniqueCustomers[0];
        const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
        const primaryInvoice = Array.isArray(unpaidInvoices) && unpaidInvoices.length ? unpaidInvoices[0] : null;
        const payload = buildWhatsappCustomerPayload(customer, unpaidInvoices, primaryInvoice, { baseUrl: requestBaseUrl });
        let formattedMsg = buildBroadcastAnnouncementMessage(customer, message, { baseUrl: requestBaseUrl });
        if (!/\{\{\s*payment_guide\s*\}\}/i.test(message) && payload.payment_guide) {
          formattedMsg += `\n\n${payload.payment_guide}`;
        }
        const sentOk = await sendWhatsappAnnouncement({
          phone: customer.phone,
          message: formattedMsg,
          imageFilePath,
          imageUrl: absoluteImageUrl,
          fs
        });
        if (!sentOk) throw new Error('sendWA mengembalikan gagal');
        req.session._msg = { type: 'success', text: `Test pengumuman berhasil dikirim ke ${customer.name || customer.phone}.` };
        return res.redirect('/admin/whatsapp/broadcast');
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
              const payload = buildWhatsappCustomerPayload(customer, unpaidInvoices, primaryInvoice, { baseUrl: requestBaseUrl });
              let formattedMsg = buildBroadcastAnnouncementMessage(customer, message, { baseUrl: requestBaseUrl });
              if (!/\{\{\s*payment_guide\s*\}\}/i.test(message) && payload.payment_guide) {
                formattedMsg += `\n\n${payload.payment_guide}`;
              }

              formattedMsg = addMessageVariation(formattedMsg, i);

              const sentOk = await sendWhatsappAnnouncement({
                phone: customer.phone,
                message: formattedMsg,
                imageFilePath,
                imageUrl: absoluteImageUrl,
                fs
              });
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
      const whatsappStatus = await whatsappGateway.getStatus();
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
    try {
      const startedAt = Date.now();
      const whatsappStatus = await whatsappGateway.getStatus();
      const ready = await whatsappGateway.ensureReady(25000);
      if (!ready) {
        throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
      }
      const adminPhone = resolveWhatsappTestRecipient(whatsappStatus, req.body?.test_phone);
      if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia. Isi kolom Nomor Test WA atau nomor admin/telepon usaha yang berbeda dari nomor bot.');
      const messageText =
        `TEST NOTIFIKASI WHATSAPP\n\n` +
        `WhatsApp bot untuk ${getSetting('company_header', 'Portal Billing ISP')} sudah berfungsi.\n` +
        `Waktu: ${new Date().toLocaleString('id-ID')}`;
      const ok = await whatsappGateway.sendText(adminPhone, messageText);
      if (!ok) throw new Error('Gagal mengirim pesan test.');
      const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      req.session._msg = { type: 'success', text: `Test notifikasi WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)} dalam sekitar ${durationSec} detik.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
    }
    res.redirect('/admin/whatsapp');
  });

  router.post('/whatsapp/test-template', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const startedAt = Date.now();
      const whatsappStatus = await whatsappGateway.getStatus();
      const ready = await whatsappGateway.ensureReady(25000);
      if (!ready) {
        throw new Error('WhatsApp belum terhubung. Silakan cek provider WhatsApp di menu Status.');
      }
      const adminPhone = resolveWhatsappTestRecipient(whatsappStatus, req.body?.test_phone);
      if (!adminPhone) throw new Error('Nomor tujuan test WhatsApp belum tersedia. Isi kolom Nomor Test WA atau nomor admin/telepon usaha yang berbeda dari nomor bot.');
      const templateKey = String(req.body.template_key || 'billing').trim();
      const previewMessage = buildWhatsappTemplatePreview(templateKey, { baseUrl: resolveRequestBaseUrl(req) });
      const ok = await whatsappGateway.sendText(adminPhone, previewMessage);
      if (!ok) throw new Error('Gagal mengirim test message.');
      const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      req.session._msg = { type: 'success', text: `Test message WhatsApp berhasil dikirim ke ${formatPhoneDisplay(adminPhone)} dalam sekitar ${durationSec} detik.` };
    } catch (e) {
      req.session._msg = { type: 'error', text: 'Gagal kirim test message: ' + e.message };
    }
    res.redirect('/admin/whatsapp/broadcast');
  });

  router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
    try {
      const confirmText = String(req.body?.confirm_reset_text || '').trim().toUpperCase();
      if (confirmText !== 'RESET WA') {
        req.session._msg = { text: 'Reset sesi dibatalkan. Ketik "RESET WA" untuk mengonfirmasi penghapusan sesi WhatsApp.', type: 'warning' };
        return res.redirect('/admin/whatsapp');
      }

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
