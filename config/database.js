/**
 * Inisialisasi database SQLite untuk billing RTRWnet
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'billing.db');

function normalizePhoneStorage(input, defaultCountryCode = '62') {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith(defaultCountryCode)) return digits;
  if (digits.startsWith('0')) return defaultCountryCode + digits.slice(1);
  if (digits.startsWith('8')) return defaultCountryCode + digits;
  return defaultCountryCode + digits;
}

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error('[DB] Gagal membuka database:', err.message);
  process.exit(1);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pppoe_profile TEXT DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    price_before_tax INTEGER NOT NULL DEFAULT 0,
    include_ppn INTEGER NOT NULL DEFAULT 0,
    ppn_percent REAL NOT NULL DEFAULT 0,
    speed_down INTEGER DEFAULT 0,
    speed_up INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_code TEXT DEFAULT '',
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    nik TEXT DEFAULT '',
    npwp TEXT DEFAULT '',
    house_photo_url TEXT DEFAULT '',
    ktp_photo_url TEXT DEFAULT '',
    package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
    genieacs_tag TEXT DEFAULT '',
    pppoe_username TEXT DEFAULT '',
    normal_pppoe_profile TEXT DEFAULT '',
    isolir_profile TEXT DEFAULT 'BEATISOLIR',
    status TEXT DEFAULT 'active',
    install_date DATE,
    discount_enabled INTEGER NOT NULL DEFAULT 0,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    speed_boost_profile TEXT DEFAULT '',
    speed_boost_until DATETIME,
    speed_boost_started_at DATETIME,
    speed_boost_note TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    area TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cashiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS employee_live_locations (
    role TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT DEFAULT '',
    lat REAL,
    lng REAL,
    accuracy REAL DEFAULT 0,
    source TEXT DEFAULT 'device',
    sharing_enabled INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role, employee_id)
  );

  CREATE TABLE IF NOT EXISTS collector_payment_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collector_id INTEGER NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    decided_by_role TEXT DEFAULT '', -- admin, cashier
    decided_by_name TEXT DEFAULT '',
    decided_note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'unpaid',
    paid_at DATETIME,
    paid_by_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open', -- open, in_progress, resolved
    technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customer_package_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    current_package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
    target_package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    request_note TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    reviewed_by_name TEXT DEFAULT '',
    applied_at DATETIME,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS package_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    current_package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
    target_package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    change_kind TEXT NOT NULL DEFAULT 'upgrade', -- upgrade, downgrade, lateral
    request_source TEXT NOT NULL DEFAULT 'portal',
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, scheduled, processing, completed, rejected, cancelled
    request_note TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    reviewed_by_name TEXT DEFAULT '',
    eligibility_after DATETIME,
    effective_at DATETIME,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    approved_at DATETIME,
    scheduled_at DATETIME,
    processing_at DATETIME,
    completed_at DATETIME,
    rejected_at DATETIME,
    cancelled_at DATETIME,
    applied_at DATETIME,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customer_profile_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    current_name TEXT DEFAULT '',
    current_phone TEXT DEFAULT '',
    current_address TEXT DEFAULT '',
    requested_name TEXT DEFAULT '',
    requested_phone TEXT DEFAULT '',
    requested_address TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    request_note TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    reviewed_by_name TEXT DEFAULT '',
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    applied_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pppoe_monitoring_state (
    router_key TEXT NOT NULL,
    router_id INTEGER REFERENCES routers(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT,
    remote_address TEXT,
    session_uptime TEXT,
    last_online_at DATETIME,
    offline_since DATETIME,
    last_logout_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (router_key, username)
  );

  CREATE TABLE IF NOT EXISTS hotspot_monitoring_state (
    router_key TEXT NOT NULL,
    router_id INTEGER REFERENCES routers(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT,
    session_address TEXT,
    session_uptime TEXT,
    last_online_at DATETIME,
    offline_since DATETIME,
    last_logout_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (router_key, username)
  );

  CREATE TABLE IF NOT EXISTS mass_outage_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_key TEXT NOT NULL DEFAULT 'default',
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    zone_key TEXT NOT NULL,
    zone_label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recovered_at DATETIME,
    baseline_count INTEGER NOT NULL DEFAULT 0,
    offline_count INTEGER NOT NULL DEFAULT 0,
    offline_percent REAL NOT NULL DEFAULT 0,
    affected_customer_ids_json TEXT NOT NULL DEFAULT '[]',
    sample_customers_json TEXT NOT NULL DEFAULT '[]',
    first_snapshot_at DATETIME,
    last_snapshot_at DATETIME,
    opened_by_system INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customer_portal_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'system',
    tab TEXT NOT NULL DEFAULT 'home',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audience TEXT NOT NULL DEFAULT 'admin',
    kind TEXT NOT NULL DEFAULT 'system',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    target_url TEXT NOT NULL DEFAULT '/admin',
    payload_json TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'queued',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS routers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 8728,
    user TEXT NOT NULL,
    password TEXT NOT NULL,
    os_mode TEXT DEFAULT 'auto',
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS olts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    snmp_community TEXT DEFAULT 'public',
    snmp_port INTEGER DEFAULT 161,
    brand TEXT DEFAULT 'zte', -- zte, huawei, vsol, hioso, hsqg, etc.
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS odps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    olt_id INTEGER REFERENCES olts(id) ON DELETE SET NULL,
    pon_port TEXT DEFAULT '',
    port_capacity INTEGER NOT NULL DEFAULT 16,
    lat TEXT,
    lng TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS voucher_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    qty_total INTEGER NOT NULL DEFAULT 0,
    qty_created INTEGER NOT NULL DEFAULT 0,
    qty_failed INTEGER NOT NULL DEFAULT 0,
    price INTEGER NOT NULL DEFAULT 0,
    validity TEXT DEFAULT '',
    prefix TEXT DEFAULT '',
    code_length INTEGER NOT NULL DEFAULT 4,
    status TEXT DEFAULT 'creating',
    created_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES voucher_batches(id) ON DELETE CASCADE,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    password TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    comment TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    sold_at DATETIME,
    printed_at DATETIME,
    used_at DATETIME,
    last_seen_comment TEXT DEFAULT '',
    last_seen_uptime TEXT DEFAULT '',
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(router_id, code)
  );

  CREATE TABLE IF NOT EXISTS public_voucher_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    validity TEXT DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    buyer_phone TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    paid_at DATETIME,
    fulfilled_at DATETIME,
    voucher_code TEXT DEFAULT '',
    voucher_password TEXT DEFAULT '',
    voucher_comment TEXT DEFAULT '',
    wa_sent INTEGER NOT NULL DEFAULT 0,
    wa_sent_at DATETIME,
    wa_error TEXT DEFAULT '',
    payment_gateway TEXT DEFAULT '',
    payment_order_id TEXT DEFAULT '',
    payment_link TEXT DEFAULT '',
    payment_reference TEXT DEFAULT '',
    payment_payload TEXT,
    payment_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    balance INTEGER NOT NULL DEFAULT 0,
    billing_fee INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agent_hotspot_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    validity TEXT DEFAULT '',
    buy_price INTEGER NOT NULL DEFAULT 0,
    sell_price INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, router_id, profile_name)
  );

  CREATE TABLE IF NOT EXISTS agent_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- topup, invoice_payment, voucher_sale, adjust
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT DEFAULT '',
    voucher_code TEXT DEFAULT '',
    voucher_password TEXT DEFAULT '',
    amount_invoice INTEGER NOT NULL DEFAULT 0,
    amount_buy INTEGER NOT NULL DEFAULT 0,
    amount_sell INTEGER NOT NULL DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 0,
    balance_before INTEGER NOT NULL DEFAULT 0,
    balance_after INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agent_topup_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 0,
    unique_code INTEGER NOT NULL DEFAULT 0,
    pay_amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    qris_payload TEXT DEFAULT '',
    paid_notif_id INTEGER REFERENCES webhook_payment_notifs(id) ON DELETE SET NULL,
    paid_tx_id INTEGER REFERENCES agent_transactions(id) ON DELETE SET NULL,
    expires_at DATETIME,
    paid_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS digiflazz_staff_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL DEFAULT 'admin', -- admin, cashier
    actor_phone TEXT DEFAULT '',
    actor_name TEXT DEFAULT '',
    sku TEXT NOT NULL,
    target TEXT NOT NULL,
    ref_id TEXT NOT NULL UNIQUE,
    trx_id TEXT DEFAULT '',
    sn TEXT DEFAULT '',
    status TEXT DEFAULT '',
    message TEXT DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_payment_notifs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT DEFAULT '',
    content TEXT NOT NULL,
    parsed_amount INTEGER,
    parsed_ok INTEGER NOT NULL DEFAULT 0,
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_voucher_batches_router ON voucher_batches(router_id);
  CREATE INDEX IF NOT EXISTS idx_vouchers_batch ON vouchers(batch_id);
  CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
  CREATE INDEX IF NOT EXISTS idx_public_voucher_orders_status ON public_voucher_orders(status);
  CREATE INDEX IF NOT EXISTS idx_public_voucher_orders_created ON public_voucher_orders(created_at);

  CREATE INDEX IF NOT EXISTS idx_agents_username ON agents(username);
  CREATE INDEX IF NOT EXISTS idx_agent_prices_agent ON agent_hotspot_prices(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_prices_router_profile ON agent_hotspot_prices(router_id, profile_name);
  CREATE INDEX IF NOT EXISTS idx_agent_tx_agent ON agent_transactions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_tx_created ON agent_transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_agent ON agent_topup_orders(agent_id, id);
  CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_status_amount ON agent_topup_orders(status, pay_amount);
  CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_created ON agent_topup_orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_digi_staff_tx_created ON digiflazz_staff_transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_digi_staff_tx_role ON digiflazz_staff_transactions(role);
  CREATE INDEX IF NOT EXISTS idx_digi_staff_tx_ref ON digiflazz_staff_transactions(ref_id);

  CREATE INDEX IF NOT EXISTS idx_collectors_username ON collectors(username);
  CREATE INDEX IF NOT EXISTS idx_employee_live_locations_role ON employee_live_locations(role);
  CREATE INDEX IF NOT EXISTS idx_employee_live_locations_updated ON employee_live_locations(updated_at);
  CREATE INDEX IF NOT EXISTS idx_collector_pay_req_status ON collector_payment_requests(status);
  CREATE INDEX IF NOT EXISTS idx_collector_pay_req_invoice ON collector_payment_requests(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_collector_pay_req_collector ON collector_payment_requests(collector_id);
  CREATE INDEX IF NOT EXISTS idx_collector_pay_req_created ON collector_payment_requests(created_at);

  CREATE INDEX IF NOT EXISTS idx_pkg_change_req_customer ON customer_package_change_requests(customer_id);
  CREATE INDEX IF NOT EXISTS idx_pkg_change_req_status ON customer_package_change_requests(status);
  CREATE INDEX IF NOT EXISTS idx_pkg_change_req_created ON customer_package_change_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_package_change_requests_customer ON package_change_requests(customer_id);
  CREATE INDEX IF NOT EXISTS idx_package_change_requests_status ON package_change_requests(status);
  CREATE INDEX IF NOT EXISTS idx_package_change_requests_created ON package_change_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_package_change_requests_effective ON package_change_requests(effective_at);
  CREATE INDEX IF NOT EXISTS idx_customer_profile_change_customer ON customer_profile_change_requests(customer_id);
  CREATE INDEX IF NOT EXISTS idx_customer_profile_change_status ON customer_profile_change_requests(status);
  CREATE INDEX IF NOT EXISTS idx_customer_profile_change_created ON customer_profile_change_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_mass_outage_router_status ON mass_outage_incidents(router_key, status);
  CREATE INDEX IF NOT EXISTS idx_mass_outage_detected ON mass_outage_incidents(detected_at);
  CREATE INDEX IF NOT EXISTS idx_mass_outage_zone_status ON mass_outage_incidents(zone_key, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mass_outage_open_unique ON mass_outage_incidents(router_key, zone_key) WHERE status = 'open';

  CREATE INDEX IF NOT EXISTS idx_webhook_payment_notifs_created ON webhook_payment_notifs(created_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_payment_notifs_service ON webhook_payment_notifs(service);

  -- ─── INVENTORY / WAREHOUSE ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS inventory_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER REFERENCES inventory_categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    brand TEXT DEFAULT '',
    model TEXT DEFAULT '',
    unit TEXT DEFAULT 'pcs', -- pcs, meter, roll, etc.
    min_stock INTEGER DEFAULT 5,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    serial_number TEXT UNIQUE, -- Optional, for items like ONT/Router
    quantity INTEGER NOT NULL DEFAULT 0,
    condition TEXT DEFAULT 'new', -- new, used, broken
    location TEXT DEFAULT 'Gudang Utama',
    status TEXT DEFAULT 'available', -- available, assigned, broken, lost
    assigned_to_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    note TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
    stock_id INTEGER REFERENCES inventory_stock(id) ON DELETE SET NULL,
    type TEXT NOT NULL, -- in (stock masuk), out (stock keluar/dipakai), adjust (penyesuaian), broken, return
    quantity INTEGER NOT NULL DEFAULT 0,
    actor TEXT DEFAULT 'Admin',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_inventory_items_cat ON inventory_items(category_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_stock_item ON inventory_stock(item_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_stock_sn ON inventory_stock(serial_number);
  CREATE INDEX IF NOT EXISTS idx_inventory_logs_item ON inventory_logs(item_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_logs_created ON inventory_logs(created_at);
`);

// Tambahkan kolom baru jika belum ada
try {
  db.exec("ALTER TABLE customers ADD COLUMN auto_isolate INTEGER DEFAULT 1");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN isolate_day INTEGER DEFAULT 10");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN email TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN olt_id INTEGER REFERENCES olts(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN pon_port TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN odp_id INTEGER REFERENCES odps(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN lat TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN lng TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN cable_path TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN connection_type TEXT DEFAULT 'pppoe'");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN static_ip TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN mac_address TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN nik TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN npwp TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN house_photo_url TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN ktp_photo_url TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN discount_enabled INTEGER NOT NULL DEFAULT 0");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN customer_code TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_code_unique ON customers(customer_code) WHERE customer_code IS NOT NULL AND TRIM(customer_code) <> ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN speed_boost_profile TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN speed_boost_until DATETIME");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN speed_boost_started_at DATETIME");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN speed_boost_note TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE odps ADD COLUMN port_capacity INTEGER NOT NULL DEFAULT 16");
} catch (e) { /* ignore if already exists */ }

// Kolom untuk Payment Gateway di tabel invoices
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_gateway TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_method TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_order_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_link TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_reference TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_payload TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_expires_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN due_day_snapshot INTEGER"); } catch (e) {}
try {
  db.exec(`
    UPDATE invoices
    SET due_day_snapshot = COALESCE(
      due_day_snapshot,
      (
        SELECT CASE
          WHEN COALESCE(c.isolate_day, 10) < 1 THEN 1
          WHEN COALESCE(c.isolate_day, 10) > 31 THEN 31
          ELSE COALESCE(c.isolate_day, 10)
        END
        FROM customers c
        WHERE c.id = invoices.customer_id
      ),
      10
    )
    WHERE due_day_snapshot IS NULL
  `);
} catch (e) {}

// Kolom untuk QRIS statis (semi-otomatis via nominal unik)
try { db.exec("ALTER TABLE invoices ADD COLUMN qris_unique_code INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN qris_amount_unique INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN qris_assigned_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN qris_paid_notif_id INTEGER"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_qris_unpaid_amount ON invoices(status, qris_amount_unique)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_payment_notifs_duplicate ON webhook_payment_notifs(service, parsed_amount, created_at)"); } catch (e) {}

// Kolom untuk Login OLT (Web/API)
try { db.exec("ALTER TABLE olts ADD COLUMN web_user TEXT DEFAULT 'admin'"); } catch (e) {}
try { db.exec("ALTER TABLE olts ADD COLUMN web_password TEXT DEFAULT 'admin'"); } catch (e) {}
try { db.exec("ALTER TABLE olts ADD COLUMN api_base_url TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE olts ADD COLUMN telnet_port INTEGER DEFAULT 23"); } catch (e) {}
try { db.exec("ALTER TABLE olts ADD COLUMN enable_password TEXT"); } catch (e) {}
try { db.exec("CREATE TABLE IF NOT EXISTS olt_vlan_push_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, olt_id INTEGER REFERENCES olts(id) ON DELETE SET NULL, onu_index TEXT DEFAULT '', onu_name TEXT DEFAULT '', vlan INTEGER NOT NULL DEFAULT 0, vlan_mode TEXT DEFAULT 'tag', lan_ports TEXT DEFAULT '', ssid_ports TEXT DEFAULT '', dry_run INTEGER NOT NULL DEFAULT 1, commands TEXT DEFAULT '', output TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', error TEXT DEFAULT '', created_by TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_olt_vlan_push_logs_olt_created ON olt_vlan_push_logs(olt_id, created_at)"); } catch (e) {}
try { db.exec("ALTER TABLE routers ADD COLUMN os_mode TEXT DEFAULT 'auto'"); } catch (e) {}

try { db.exec("ALTER TABLE voucher_batches ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_comment TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_uptime TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN sold_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN printed_at DATETIME"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_sold_at ON vouchers(sold_at)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_vouchers_printed_at ON vouchers(printed_at)"); } catch (e) {}
try { db.exec("ALTER TABLE voucher_batches ADD COLUMN mode TEXT DEFAULT 'voucher'"); } catch (e) {}
try { db.exec("ALTER TABLE voucher_batches ADD COLUMN charset TEXT DEFAULT 'numbers'"); } catch (e) {}
try { db.exec("ALTER TABLE voucher_batches ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_voucher_batches_agent ON voucher_batches(agent_id, id)"); } catch (e) {}

// Relasi notifikasi webhook → invoice (untuk audit)
try { db.exec("ALTER TABLE webhook_payment_notifs ADD COLUMN matched_invoice_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE webhook_payment_notifs ADD COLUMN matched_agent_topup_id INTEGER"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_payment_notifs_agent_topup ON webhook_payment_notifs(matched_agent_topup_id)"); } catch (e) {}

try { db.exec("CREATE TABLE IF NOT EXISTS agent_topup_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE, amount INTEGER NOT NULL DEFAULT 0, unique_code INTEGER NOT NULL DEFAULT 0, pay_amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', qris_payload TEXT DEFAULT '', paid_notif_id INTEGER REFERENCES webhook_payment_notifs(id) ON DELETE SET NULL, paid_tx_id INTEGER REFERENCES agent_transactions(id) ON DELETE SET NULL, expires_at DATETIME, paid_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_agent ON agent_topup_orders(agent_id, id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_status_amount ON agent_topup_orders(status, pay_amount)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_topup_orders_created ON agent_topup_orders(created_at)"); } catch (e) {}

try { db.exec("ALTER TABLE agent_transactions ADD COLUMN provider TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_sku TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_target TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_ref_id TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_trx_id TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_sn TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_status TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_message TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_price INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN digi_refunded INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN voucher_batch_id INTEGER REFERENCES voucher_batches(id) ON DELETE SET NULL"); } catch (e) {}
try { db.exec("ALTER TABLE agent_transactions ADD COLUMN agent_topup_order_id INTEGER REFERENCES agent_topup_orders(id) ON DELETE SET NULL"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_tx_digi_ref ON agent_transactions(digi_ref_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_tx_type ON agent_transactions(type)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_tx_voucher_batch ON agent_transactions(voucher_batch_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_tx_topup_order ON agent_transactions(agent_topup_order_id)"); } catch (e) {}

// Kolom untuk Dynamic Speed & FUP di tabel packages
try { db.exec("ALTER TABLE packages ADD COLUMN pppoe_profile TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN night_speed_down INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN night_speed_up INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN fup_limit_gb INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN fup_speed_down INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN use_night_speed INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN night_profile_name TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN use_fup INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN fup_profile_name TEXT"); } catch (e) {}

// Promo harga & prorata tagihan pertama (per paket + counter per pelanggan)
try { db.exec("ALTER TABLE packages ADD COLUMN promo_price INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN promo_cycles INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN prorate_first_invoice INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN price_before_tax INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN include_ppn INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN ppn_percent REAL NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packages ADD COLUMN show_in_portal INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("UPDATE packages SET price_before_tax = price WHERE COALESCE(price_before_tax, 0) = 0"); } catch (e) {}
try { db.exec("ALTER TABLE customers ADD COLUMN normal_pppoe_profile TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE customers ADD COLUMN promo_cycles_used INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE customers ADD COLUMN portal_notifications_seen_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE customer_usage_runtime ADD COLUMN last_session_id TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE customer_usage_runtime ADD COLUMN last_uptime_seconds INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_portal_notifications_customer_created ON customer_portal_notifications(customer_id, created_at DESC)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_admin_notifications_created ON admin_notifications(created_at DESC)"); } catch (e) {}

// Tabel untuk Tracking Pemakaian (Usage) Pelanggan
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    bytes_in INTEGER DEFAULT 0,
    bytes_out INTEGER DEFAULT 0,
    last_total_bytes_in INTEGER DEFAULT 0, -- Untuk menghitung delta
    last_total_bytes_out INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, period_month, period_year)
  );
  CREATE INDEX IF NOT EXISTS idx_usage_customer ON customer_usage(customer_id);
  CREATE INDEX IF NOT EXISTS idx_usage_period ON customer_usage(period_month, period_year);
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS customer_usage_runtime (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      last_total_bytes_in INTEGER DEFAULT 0,
      last_total_bytes_out INTEGER DEFAULT 0,
      last_session_id TEXT DEFAULT '',
      last_uptime_seconds INTEGER DEFAULT 0,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  CREATE INDEX IF NOT EXISTS idx_usage_runtime_seen ON customer_usage_runtime(last_seen_at);
  `);

  db.exec(`
  CREATE TABLE IF NOT EXISTS usage_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      period_month INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'sync',
      stored_bytes_in INTEGER DEFAULT 0,
      stored_bytes_out INTEGER DEFAULT 0,
      observed_bytes_in INTEGER DEFAULT 0,
      observed_bytes_out INTEGER DEFAULT 0,
      delta_bytes_in INTEGER DEFAULT 0,
      delta_bytes_out INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_audit_customer_period ON usage_audit_logs(customer_id, period_year, period_month);
    CREATE INDEX IF NOT EXISTS idx_usage_audit_created ON usage_audit_logs(created_at);
  `);

db.exec(`
  CREATE TABLE IF NOT EXISTS bookkeeping_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'expense', -- income, expense
    category TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    entry_date DATE NOT NULL,
    description TEXT DEFAULT '',
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    source_type TEXT DEFAULT '', -- invoice, manual
    source_id INTEGER,
    created_by_role TEXT DEFAULT '',
    created_by_name TEXT DEFAULT '',
    holder_role TEXT DEFAULT '',
    holder_entity_id INTEGER,
    holder_label TEXT DEFAULT '',
    payment_method TEXT DEFAULT 'cash',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bookkeeping_type_date ON bookkeeping_entries(type, entry_date);
  CREATE INDEX IF NOT EXISTS idx_bookkeeping_category ON bookkeeping_entries(category);
  CREATE INDEX IF NOT EXISTS idx_bookkeeping_source ON bookkeeping_entries(source_type, source_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cash_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_date DATE NOT NULL,
    from_role TEXT NOT NULL DEFAULT '',
    from_entity_id INTEGER,
    from_label TEXT NOT NULL DEFAULT '',
    to_role TEXT NOT NULL DEFAULT 'admin',
    to_entity_id INTEGER,
    to_label TEXT NOT NULL DEFAULT 'Admin',
    amount INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_by_role TEXT DEFAULT '',
    created_by_name TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cash_settlements_date ON cash_settlements(settlement_date);
  CREATE INDEX IF NOT EXISTS idx_cash_settlements_from ON cash_settlements(from_role, from_entity_id);
  CREATE INDEX IF NOT EXISTS idx_cash_settlements_to ON cash_settlements(to_role, to_entity_id);
`);

try { db.exec("ALTER TABLE bookkeeping_entries ADD COLUMN holder_role TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE bookkeeping_entries ADD COLUMN holder_entity_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE bookkeeping_entries ADD COLUMN holder_label TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE bookkeeping_entries ADD COLUMN payment_method TEXT DEFAULT 'cash'"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_bookkeeping_holder ON bookkeeping_entries(holder_role, holder_entity_id)"); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS technician_customer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT DEFAULT '',
    package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    pppoe_username TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    payload_json TEXT NOT NULL DEFAULT '{}',
    review_note TEXT DEFAULT '',
    reviewed_by_name TEXT DEFAULT '',
    approved_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_tech_customer_req_status ON technician_customer_requests(status);
  CREATE INDEX IF NOT EXISTS idx_tech_customer_req_tech ON technician_customer_requests(technician_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS technician_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'repair',
    description TEXT DEFAULT '',
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    customer_address TEXT DEFAULT '',
    location_note TEXT DEFAULT '',
    technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'assigned', -- assigned, in_progress, done, cancelled
    scheduled_date DATE,
    due_date DATE,
    create_pppoe_secret INTEGER NOT NULL DEFAULT 0,
    pppoe_username TEXT DEFAULT '',
    pppoe_password TEXT DEFAULT '',
    normal_pppoe_profile TEXT DEFAULT '',
    created_by_name TEXT DEFAULT '',
    completion_note TEXT DEFAULT '',
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_technician_tasks_status ON technician_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_technician_tasks_tech ON technician_tasks(technician_id);
  CREATE INDEX IF NOT EXISTS idx_technician_tasks_due ON technician_tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_technician_tasks_created ON technician_tasks(created_at);
`);

try {
  db.exec('ALTER TABLE technician_tasks ADD COLUMN create_pppoe_secret INTEGER NOT NULL DEFAULT 0');
} catch (e) {}
try {
  db.exec('ALTER TABLE technician_tasks ADD COLUMN pppoe_username TEXT DEFAULT ""');
} catch (e) {}
try {
  db.exec('ALTER TABLE technician_tasks ADD COLUMN pppoe_password TEXT DEFAULT ""');
} catch (e) {}
try {
  db.exec('ALTER TABLE technician_tasks ADD COLUMN normal_pppoe_profile TEXT DEFAULT ""');
} catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS digiflazz_products (
    sku TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    category TEXT DEFAULT '',
    brand TEXT DEFAULT '',
    price_modal INTEGER NOT NULL DEFAULT 0,
    price_sell INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS digiflazz_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    inactive INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_digiflazz_products_cat ON digiflazz_products(category);
  CREATE INDEX IF NOT EXISTS idx_digiflazz_products_brand ON digiflazz_products(brand);
  CREATE INDEX IF NOT EXISTS idx_digiflazz_products_status ON digiflazz_products(status);
  CREATE INDEX IF NOT EXISTS idx_digiflazz_sync_created ON digiflazz_sync_logs(created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS digiflazz_webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_id TEXT DEFAULT '',
    status TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    signature_ok INTEGER NOT NULL DEFAULT 0,
    matched_agent_tx_id INTEGER,
    ip TEXT DEFAULT '',
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_digiflazz_webhook_created ON digiflazz_webhook_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_digiflazz_webhook_ref ON digiflazz_webhook_logs(ref_id);
`);

try { db.exec("ALTER TABLE technicians ADD COLUMN password_hash TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE cashiers ADD COLUMN password_hash TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE collectors ADD COLUMN password_hash TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE agents ADD COLUMN password_hash TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN change_kind TEXT NOT NULL DEFAULT 'upgrade'"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN request_source TEXT NOT NULL DEFAULT 'portal'"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN eligibility_after DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN effective_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN requested_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN approved_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN scheduled_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN processing_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN completed_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN rejected_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN cancelled_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN applied_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE package_change_requests ADD COLUMN reviewed_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE pppoe_monitoring_state ADD COLUMN last_logout_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE pppoe_monitoring_state ADD COLUMN profile_name TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE pppoe_monitoring_state ADD COLUMN remote_address TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE pppoe_monitoring_state ADD COLUMN session_uptime TEXT"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_package_change_requests_customer ON package_change_requests(customer_id)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_package_change_requests_status ON package_change_requests(status)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_package_change_requests_created ON package_change_requests(created_at)"); } catch (e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_package_change_requests_effective ON package_change_requests(effective_at)"); } catch (e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS network_map_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_odp_id INTEGER NOT NULL REFERENCES odps(id) ON DELETE CASCADE,
    to_odp_id INTEGER NOT NULL REFERENCES odps(id) ON DELETE CASCADE,
    link_kind TEXT NOT NULL DEFAULT 'backbone',
    cable_size TEXT DEFAULT '',
    path_json TEXT DEFAULT '',
    color TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_network_map_links_from ON network_map_links(from_odp_id);
  CREATE INDEX IF NOT EXISTS idx_network_map_links_to ON network_map_links(to_odp_id);
  CREATE INDEX IF NOT EXISTS idx_network_map_links_kind ON network_map_links(link_kind);
`);

try {
  const hasLegacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_package_change_requests'").get();
  const hasNewRows = Number(db.prepare("SELECT COUNT(1) AS c FROM package_change_requests").get()?.c || 0);
  if (hasLegacyTable && hasNewRows === 0) {
    db.exec(`
      INSERT INTO package_change_requests (
        id,
        customer_id,
        current_package_id,
        target_package_id,
        change_kind,
        request_source,
        status,
        request_note,
        review_note,
        reviewed_by_name,
        eligibility_after,
        effective_at,
        requested_at,
        approved_at,
        scheduled_at,
        processing_at,
        completed_at,
        rejected_at,
        cancelled_at,
        applied_at,
        reviewed_at,
        created_at
      )
      SELECT
        id,
        customer_id,
        current_package_id,
        target_package_id,
        'upgrade',
        'portal',
        CASE
          WHEN status = 'approved' THEN 'completed'
          WHEN status = 'rejected' THEN 'rejected'
          ELSE status
        END,
        request_note,
        review_note,
        reviewed_by_name,
        DATETIME(created_at, '+30 days'),
        applied_at,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        CASE WHEN status = 'approved' THEN COALESCE(reviewed_at, applied_at, created_at) END,
        NULL,
        NULL,
        CASE WHEN status = 'approved' THEN COALESCE(applied_at, reviewed_at, created_at) END,
        CASE WHEN status = 'rejected' THEN COALESCE(reviewed_at, created_at) END,
        NULL,
        applied_at,
        reviewed_at,
        created_at
      FROM customer_package_change_requests
    `);
  }
} catch (e) {}

function normalizePhoneColumnValues(tableName, columnName) {
  const selectStmt = db.prepare(`SELECT id, ${columnName} AS phone_value FROM ${tableName} WHERE COALESCE(TRIM(${columnName}), '') <> ''`);
  const updateStmt = db.prepare(`UPDATE ${tableName} SET ${columnName} = ? WHERE id = ?`);
  const rows = selectStmt.all();
  for (const row of rows) {
    const current = String(row.phone_value || '').trim();
    const normalized = normalizePhoneStorage(current);
    if (!normalized || normalized === current) continue;
    updateStmt.run(normalized, row.id);
  }
}

[
  ['customers', 'phone'],
  ['technicians', 'phone'],
  ['cashiers', 'phone'],
  ['collectors', 'phone'],
  ['agents', 'phone'],
  ['public_voucher_orders', 'buyer_phone'],
  ['digiflazz_staff_transactions', 'actor_phone'],
  ['technician_customer_requests', 'customer_phone'],
  ['technician_tasks', 'customer_phone']
].forEach(([tableName, columnName]) => {
  try {
    normalizePhoneColumnValues(tableName, columnName);
  } catch (e) {
    /* ignore normalization bootstrap issues */
  }
});

module.exports = db;
