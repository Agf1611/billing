const express = require('express');
const router = express.Router();
const techSvc = require('../services/techService');
const customerSvc = require('../services/customerService');
const customerDetailSvc = require('../services/customerDetailService');
const odpSvc = require('../services/odpService');
const { getSetting } = require('../config/settingsManager');
const mikrotikService = require('../services/mikrotikService');
const billingSvc = require('../services/billingService');
const db = require('../config/database');
const oltSvc = require('../services/oltService');
const employeeLocationSvc = require('../services/employeeLocationService');
const massOutageSvc = require('../services/massOutageService');
const multer = require('multer');
const {
  DEFAULT_MAX_BYTES,
  persistCompressedImageUpload
} = require('../services/imageUploadService');
const {
  buildTechnicianPushExternalId
} = require('../services/pushNotificationService');
const techUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

router.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('application/manifest+json');
  return res.json({
    id: '/tech/',
    name: 'Portal Teknisi',
    short_name: 'Teknisi',
    description: `Portal Teknisi ${String(getSetting('company_header', 'SICKAS WIFI') || 'SICKAS WIFI').trim() || 'SICKAS WIFI'}`,
    start_url: '/tech/login?source=pwa',
    scope: '/tech/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png', sizes: '192x192', purpose: 'any maskable' },
      { src: String(getSetting('pwa_logo_url', '') || getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png', sizes: '512x512', purpose: 'any maskable' },
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
});

function requireTechSession(req, res, next) {
  if (req.session && req.session.isTechnician && req.session.techId) {
    return next();
  }
  res.redirect('/tech/login');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function company() { return getSetting('company_header', 'ISP App'); }
function companyLogo() { return String(getSetting('company_logo_url', '/img/logo.png') || '/img/logo.png').trim() || '/img/logo.png'; }

function isTruthyFormValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function getTechNav(techId) {
  const stats = techSvc.getTechStats(techId);
  return {
    openTickets: Number(stats?.open || 0),
    myTickets: Number(stats?.total || 0),
    assignedTasks: Number((stats?.taskAssigned || 0) + (stats?.taskInProgress || 0)),
    inProgress: Number(stats?.inProgress || 0),
    resolved: Number(stats?.resolved || 0)
  };
}

function renderTechPage(req, res, view, payload = {}) {
  const techId = Number(req.session?.techId || 0) || 0;
  const oneSignalAppId = String(getSetting('onesignal_app_id', '') || '').trim();
  const oneSignalEnabled = getSetting('onesignal_enabled', false) === true && Boolean(oneSignalAppId);
  return res.render(view, {
    company: company(),
    techName: req.session?.techName || '',
    techPushEnabled: oneSignalEnabled,
    techOneSignalAppId: oneSignalAppId,
    techPushExternalId: techId ? buildTechnicianPushExternalId({ id: techId }) : '',
    techNav: techId ? getTechNav(techId) : { openTickets: 0, myTickets: 0, assignedTasks: 0, inProgress: 0, resolved: 0 },
    operationalTasks: [],
    ...payload
  });
}

// --- AUTH ---
router.get('/login', (req, res) => {
  if (req.session && req.session.isTechnician) return res.redirect('/tech');
  res.render('tech/login', { title: 'Teknisi Login', company: company(), logoUrl: companyLogo(), error: null, form: {} });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const tech = techSvc.authenticate(username, password);
  if (tech) {
    req.session.isTechnician = true;
    req.session.techId = tech.id;
    req.session.techName = tech.name;
    return res.redirect('/tech');
  }
  res.render('tech/login', { title: 'Teknisi Login', company: company(), logoUrl: companyLogo(), error: 'Username atau password salah!', form: { username } });
});

router.get('/logout', (req, res) => {
  const techId = Number(req.session?.techId || 0) || 0;
  if (techId) {
    try {
      employeeLocationSvc.clearEmployeeLocation('technician', techId, 'logout');
    } catch (_error) {}
  }
  req.session.destroy();
  res.redirect('/tech/login');
});

// --- DASHBOARD (My Tickets) ---
router.get('/', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const stats = techSvc.getTechStats(techId);
  const myTickets = techSvc.getAssignedTickets(techId);
  const operationalTasks = (techSvc.getTechnicianTasks(techId, { status: 'all' }) || []).slice(0, 4);
  const openOutages = massOutageSvc.listOpenIncidents().slice(0, 6);

  renderTechPage(req, res, 'tech/dashboard', {
    title: 'Dashboard Teknisi', 
    activePage: 'dashboard',
    stats,
    operationalTasks,
    openOutages,
    tickets: myTickets,
    msg: flashMsg(req)
  });
});

router.get('/api/outages', requireTechSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const status = String(req.query.status || 'open').trim().toLowerCase();
    const outages = status === 'recent'
      ? massOutageSvc.listRecentIncidents(limit)
      : massOutageSvc.listOpenIncidents().slice(0, limit);
    res.json({
      success: true,
      status,
      count: outages.length,
      outages
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Gagal memuat data gangguan massal.' });
  }
});

router.get('/tasks', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const status = String(req.query.status || 'all').trim() || 'all';
  const stats = techSvc.getTechStats(techId);
  const tasks = techSvc.getTechnicianTasks(techId, { status });
  renderTechPage(req, res, 'tech/tasks', {
    title: 'Job Lapangan',
    activePage: 'tasks',
    stats,
    filterStatus: status,
    tasks,
    msg: flashMsg(req)
  });
});

// --- OPEN TICKETS (Pool) ---
router.get('/pool', requireTechSession, (req, res) => {
  const openTickets = techSvc.getOpenTickets();
  renderTechPage(req, res, 'tech/pool', {
    title: 'Tiket Baru', 
    activePage: 'pool',
    tickets: openTickets,
    msg: flashMsg(req)
  });
});

// --- HISTORY TICKETS ---
router.get('/history', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const historyTickets = techSvc.getResolvedTickets(techId);
  renderTechPage(req, res, 'tech/history', {
    title: 'Riwayat Tiket', 
    activePage: 'history',
    tickets: historyTickets,
    msg: flashMsg(req)
  });
});

// --- NETWORK MAP ---
router.get('/map', requireTechSession, (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();

  renderTechPage(req, res, 'tech/map', { 
    title: 'Peta Jaringan', 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSetting('office_lat') ? { office_lat: getSetting('office_lat'), office_lng: getSetting('office_lng') } : {}
  });
});

router.get('/customers', requireTechSession, (req, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  let customers = customerSvc.getAllCustomers(search);
  if (status) customers = customers.filter((row) => String(row.status || '').trim() === status);
  renderTechPage(req, res, 'tech/customers', {
    title: 'Pelanggan',
    activePage: 'customers',
    customers,
    search,
    filterStatus: status,
    msg: flashMsg(req)
  });
});

router.post('/api/location', requireTechSession, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const techId = Number(req.session?.techId || 0) || 0;
    if (!techId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (req.body && req.body.enabled === false) {
      employeeLocationSvc.clearEmployeeLocation('technician', techId, String(req.body.reason || 'disabled'));
      return res.json({ ok: true, disabled: true });
    }

    const tech = techSvc.getTechById(techId);
    if (!tech) return res.status(404).json({ ok: false, error: 'technician_not_found' });

    const location = employeeLocationSvc.upsertEmployeeLocation({
      role: 'technician',
      employeeId: techId,
      username: tech.username,
      name: tech.name || req.session?.techName || 'Teknisi',
      phone: tech.phone || '',
      lat: req.body?.lat,
      lng: req.body?.lng,
      accuracy: req.body?.accuracy,
      source: 'portal-tech',
      userAgent: req.headers['user-agent'] || '',
      note: String(req.body?.note || '').trim()
    });

    return res.json({ ok: true, location });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Gagal menyimpan lokasi teknisi.' });
  }
});

// --- ACTIONS ---
router.post('/tickets/:id/take', requireTechSession, (req, res) => {
  try {
    techSvc.takeTicket(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Tiket berhasil diambil. Silakan mulai kerjakan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mengambil tiket: ' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tickets/:id/update', requireTechSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status } = req.body;
    const ticketId = req.params.id;
    const techId = req.session.techId;
    
    techSvc.updateTicketStatus(ticketId, techId, status);
    const ticketSvc = require('../services/ticketService');
    const customerSvc = require('../services/customerService');
    const ticket = ticketSvc.getTicketById(ticketId);
    if (ticket?.customer_id) {
      const statusLabel = String(status || 'open').replace(/_/g, ' ').toUpperCase();
      customerSvc.addPortalNotification(ticket.customer_id, {
        kind: 'ticket',
        tab: 'ticketing',
        title: `Update tiket #${ticket.id}`,
        body: `${ticket.subject || 'Keluhan pelanggan'} - Status ${statusLabel}`
      }, { dedupeWindowMs: 5 * 60 * 1000 });
    }
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET ---
    if (status === 'resolved') {
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const settings = getSettingsWithCache();
        
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          if (ticket) {
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Teknisi:* ${req.session.techName}\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await sendWA(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *LAPORAN TIKET SELESAI*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `🛠️ *Teknisi:* ${req.session.techName}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                if (digits.startsWith('0')) digits = '62' + digits.slice(1);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[TechPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tasks/:id/start', requireTechSession, (req, res) => {
  try {
    techSvc.startTechnicianTask(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Job lapangan sudah dimulai.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memulai job: ' + e.message };
  }
  res.redirect('/tech/tasks');
});

router.post('/tasks/:id/complete', requireTechSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    techSvc.completeTechnicianTask(req.params.id, req.session.techId, req.body.completion_note || '');
    req.session._msg = { type: 'success', text: 'Job lapangan ditandai selesai.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyelesaikan job: ' + e.message };
  }
  res.redirect('/tech/tasks');
});

// --- MONITORING ONU ---
router.get('/monitoring', requireTechSession, (req, res) => {
  renderTechPage(req, res, 'tech/monitoring', {
    title: 'Monitoring ONU',
    activePage: 'monitoring',
    msg: flashMsg(req)
  });
});

// --- CREATE CUSTOMER (Technician) ---
router.get('/customers/new', requireTechSession, (req, res) => {
  const packages = customerSvc.getAllPackages();
  const odps = odpSvc.getAllOdps();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const requests = db.prepare(`
    SELECT r.*, p.name as package_name
    FROM technician_customer_requests r
    LEFT JOIN packages p ON p.id = r.package_id
    WHERE r.technician_id = ?
    ORDER BY r.id DESC
    LIMIT 20
  `).all(req.session.techId);
  renderTechPage(req, res, 'tech/create_customer', {
    title: 'Tambah Pelanggan',
    activePage: 'create_customer',
    packages,
    odps,
    routers,
    olts,
    requests,
    msg: flashMsg(req)
  });
});

router.post('/customers', requireTechSession, techUpload.fields([
  { name: 'house_photo_file', maxCount: 1 },
  { name: 'ktp_photo_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Nama pelanggan wajib diisi');

    const housePhotoResult = req.files?.house_photo_file?.[0]
      ? await persistCompressedImageUpload(req.files.house_photo_file[0], 'tech-house-photo', { maxBytes: DEFAULT_MAX_BYTES })
      : null;
    const ktpPhotoResult = req.files?.ktp_photo_file?.[0]
      ? await persistCompressedImageUpload(req.files.ktp_photo_file[0], 'tech-ktp-photo', { maxBytes: DEFAULT_MAX_BYTES })
      : null;
    const housePhotoUrl = housePhotoResult?.publicUrl || '';
    const ktpPhotoUrl = ktpPhotoResult?.publicUrl || '';

    const customerData = {
      name,
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),
      address: String(req.body.address || '').trim(),
      nik: String(req.body.nik || '').trim(),
      npwp: String(req.body.npwp || '').trim(),
      house_photo_url: housePhotoUrl,
      ktp_photo_url: ktpPhotoUrl,
      package_id: req.body.package_id ? Number(req.body.package_id) : null,
      create_pppoe_secret: isTruthyFormValue(req.body.create_pppoe_secret) ? 1 : 0,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      pppoe_password: String(req.body.pppoe_password || '').trim(),
      normal_pppoe_profile: String(req.body.normal_pppoe_profile || '').trim(),
      router_id: req.body.router_id ? Number(req.body.router_id) : null,
      olt_id: req.body.olt_id ? Number(req.body.olt_id) : null,
      odp_id: req.body.odp_id ? Number(req.body.odp_id) : null,
      pon_port: String(req.body.pon_port || '').trim(),
      lat: String(req.body.lat || '').trim(),
      lng: String(req.body.lng || '').trim(),
      isolir_profile: String(req.body.isolir_profile || 'BEATISOLIR').trim() || 'BEATISOLIR',
      status: String(req.body.status || 'active').trim() || 'active',
      install_date: req.body.install_date ? String(req.body.install_date).trim() : null,
      notes: String(req.body.notes || '').trim(),
      auto_isolate: req.body.auto_isolate !== undefined ? Number(req.body.auto_isolate) : 1,
      isolate_day: req.body.isolate_day !== undefined ? Number(req.body.isolate_day) : 10
    };

    if (customerData.pppoe_password && customerData.pppoe_password.length < 4) {
      throw new Error('Password akun internet minimal 4 karakter');
    }

    if (customerData.pppoe_username) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(customerData.router_id ?? null, customerData.pppoe_username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      if (!customerData.create_pppoe_secret) {
        let conn = null;
        try {
          conn = await mikrotikService.getConnection(customerData.router_id || null);
          const results = await conn.client.menu('/ppp/secret')
            .where('service', 'pppoe')
            .where('name', customerData.pppoe_username)
            .get();
          if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
        } finally {
          if (conn && conn.api) conn.api.close();
        }
      }
    }

    if (customerData.create_pppoe_secret && !customerData.pppoe_username) {
      throw new Error('Username PPPoE wajib diisi jika ingin membuat secret baru');
    }

    db.prepare(`
      INSERT INTO technician_customer_requests (
        technician_id, customer_name, customer_phone, package_id, router_id, pppoe_username, payload_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      Number(req.session.techId || 0),
      customerData.name,
      customerData.phone || '',
      customerData.package_id || null,
      customerData.router_id || null,
      customerData.pppoe_username || '',
      JSON.stringify(customerData)
    );

    req.session._msg = { type: 'success', text: `Pengajuan pelanggan "${name}" berhasil dikirim. Menunggu approval admin.` };
    res.redirect('/tech/customers/new');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat pelanggan: ' + e.message };
    res.redirect('/tech/customers/new');
  }
});

// API Endpoints for Technician
const customerDevice = require('../services/customerDeviceService');

router.get('/api/mikrotik/pppoe-users', requireTechSession, async (req, res) => {
  try {
    const parsedRouterId = req.query.routerId ? Number(req.query.routerId) : null;
    const requestedRouterId = Number.isFinite(parsedRouterId) && parsedRouterId > 0 ? parsedRouterId : null;
    const routerId = requestedRouterId && mikrotikService.getRouterById(requestedRouterId) ? requestedRouterId : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    const usedRows = db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(usedRows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat akun PPPoE.' });
  }
});

router.get('/api/mikrotik/pppoe-profiles', requireTechSession, async (req, res) => {
  try {
    const requestedRouterId = req.query.routerId ? Number(req.query.routerId) : null;
    const routerId = requestedRouterId && mikrotikService.getRouterById(requestedRouterId) ? requestedRouterId : null;
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/odps/:id/ports', requireTechSession, (req, res) => {
  try {
    const odpId = Number(req.params.id);
    if (!odpId) return res.status(400).json({ error: 'ODP tidak valid' });
    const usage = odpSvc.getOdpPortUsage(odpId);
    if (!usage) return res.status(404).json({ error: 'ODP tidak ditemukan' });
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/detail', requireTechSession, async (req, res) => {
  try {
    const year = Number(req.query.year || new Date().getFullYear()) || new Date().getFullYear();
    const forceNetworkRefresh = String(req.query.refreshNetwork || '') === '1';
    const detail = await customerDetailSvc.buildCustomerDetail(req.params.id, { year, forceNetworkRefresh });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

async function activateCustomerWhenNoUnpaid(customerId) {
  const freshCustomer = customerSvc.getCustomerById(customerId);
  const stillUnpaid = billingSvc.getUnpaidInvoicesByCustomerId(customerId);
  if (freshCustomer && ['suspended', 'inactive'].includes(String(freshCustomer.status || '').toLowerCase()) && !stillUnpaid.length) {
    await customerSvc.activateCustomer(customerId);
  }
  return stillUnpaid;
}

router.post('/api/customers/:id/pay-unpaid-first', requireTechSession, express.json(), async (req, res) => {
  try {
    const customerId = Number(req.params.id || 0);
    if (!Number.isFinite(customerId) || customerId <= 0) throw new Error('ID pelanggan tidak valid');

    const customer = customerSvc.getCustomerById(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customerId);
    const invoice = Array.isArray(unpaidInvoices) ? unpaidInvoices[0] : null;
    if (!invoice) throw new Error('Tidak ada tagihan belum lunas untuk pelanggan ini');

    const techName = String(req.session.techName || '').trim() || 'Teknisi';
    const paidBy = `Teknisi ${techName}`;
    const rawNotes = String(req.body?.notes || '').trim();
    const notes = rawNotes || `Lunas oleh teknisi ${techName}`;

    billingSvc.markAsPaid(invoice.id, paidBy, notes, {
      type: 'technician',
      id: req.session.techId,
      name: req.session.techName,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    });

    const paidInvoice = billingSvc.getInvoiceById(invoice.id);
    if (String(paidInvoice?.status || '').trim().toLowerCase() !== 'paid') {
      throw new Error('Tagihan belum tersimpan sebagai lunas. Silakan coba lagi.');
    }

    const stillUnpaid = await activateCustomerWhenNoUnpaid(customerId);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      invoice: {
        id: Number(paidInvoice.id || invoice.id),
        status: String(paidInvoice.status || 'paid').trim().toLowerCase(),
        paidAt: paidInvoice.paid_at || null,
        paidBy: paidInvoice.paid_by_name || paidBy,
        periodMonth: Number(paidInvoice.period_month || invoice.period_month || 0) || 0,
        periodYear: Number(paidInvoice.period_year || invoice.period_year || 0) || 0,
        amount: Number(paidInvoice.amount || invoice.amount || 0) || 0
      },
      customer: {
        id: customerId,
        unpaidCount: stillUnpaid.length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post('/api/customers/:id/invoices/:invoiceId/pay', requireTechSession, express.json(), async (req, res) => {
  try {
    const customerId = Number(req.params.id || 0);
    const invoiceId = Number(req.params.invoiceId || 0);
    if (!Number.isFinite(customerId) || customerId <= 0) throw new Error('ID pelanggan tidak valid');
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) throw new Error('ID tagihan tidak valid');

    const customer = customerSvc.getCustomerById(customerId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    const invoice = billingSvc.getInvoiceById(invoiceId);
    if (!invoice || Number(invoice.customer_id || 0) !== customerId) throw new Error('Tagihan tidak ditemukan untuk pelanggan ini');

    const techName = String(req.session.techName || '').trim() || 'Teknisi';
    const paidBy = `Teknisi ${techName}`;
    const rawNotes = String(req.body?.notes || '').trim();
    const notes = rawNotes || `Lunas oleh teknisi ${techName}`;
    const wasPaid = String(invoice.status || '').trim().toLowerCase() === 'paid';
    billingSvc.markAsPaid(invoiceId, paidBy, notes, {
      type: 'technician',
      id: req.session.techId,
      name: req.session.techName,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    });

    const paidInvoice = billingSvc.getInvoiceById(invoiceId);
    if (String(paidInvoice?.status || '').trim().toLowerCase() !== 'paid') {
      throw new Error('Tagihan belum tersimpan sebagai lunas. Silakan coba lagi.');
    }

    const stillUnpaid = await activateCustomerWhenNoUnpaid(customerId);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      invoice: {
        id: Number(paidInvoice.id || invoiceId),
        status: String(paidInvoice.status || 'paid').trim().toLowerCase(),
        paidAt: paidInvoice.paid_at || null,
        paidBy: paidInvoice.paid_by_name || paidBy,
        alreadyPaid: wasPaid
      },
      customer: {
        id: customerId,
        unpaidCount: stillUnpaid.length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get('/api/devices', requireTechSession, async (req, res) => {
  try {
    const { search, status, limit = 100, offset = 0 } = req.query;
    const customers = db.prepare('SELECT id, name, phone, pppoe_username, genieacs_tag FROM customers').all();
    const byPppoe = new Map();
    const byTag = new Map();
    for (const c of customers) {
      const pu = String(c.pppoe_username || '').trim().toLowerCase();
      const tg = String(c.genieacs_tag || '').trim();
      if (pu) byPppoe.set(pu, c);
      if (tg) byTag.set(tg, c);
    }

    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    
    let devices = result.devices.map(d => {
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id);
      const pu = String(mapped.pppoeUsername || '').trim();
      const puKey = pu && pu !== 'N/A' ? pu.toLowerCase() : '';
      let customer = puKey ? byPppoe.get(puKey) : null;
      if (!customer && Array.isArray(d._tags)) {
        for (const t of d._tags) {
          const hit = byTag.get(String(t || '').trim());
          if (hit) { customer = hit; break; }
        }
      }
      return {
        id: d._id, 
        tags: d._tags || [],
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid,
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : '',
        customerPhone: customer ? customer.phone : ''
      };
    });

    if (search) {
      const s = search.toLowerCase();
      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s)) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.customerName && d.customerName.toLowerCase().includes(s)) ||
        (d.customerPhone && d.customerPhone.toLowerCase().includes(s))
      );
    }

    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    
    res.json({ devices: devices.slice(0, 100), total: devices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/device/:tag', requireTechSession, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireTechSession, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireTechSession, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireTechSession, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

module.exports = router;
