const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizePhone(value, defaultCountryCode = '62') {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith(defaultCountryCode)) return digits;
  if (digits.startsWith('0')) return `${defaultCountryCode}${digits.slice(1)}`;
  if (digits.startsWith('8')) return `${defaultCountryCode}${digits}`;
  return `${defaultCountryCode}${digits}`;
}

function parseDateInput(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts || !parts.y || !parts.m || !parts.d) return null;
    const yyyy = String(parts.y).padStart(4, '0');
    const mm = String(parts.m).padStart(2, '0');
    const dd = String(parts.d).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const raw = normalizeText(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/febr/gi, 'feb')
    .replace(/ags/gi, 'agu')
    .replace(/okt/gi, 'oct')
    .replace(/des/gi, 'dec')
    .replace(/mei/gi, 'may')
    .replace(/sept/gi, 'sep');

  const idMonths = {
    jan: 1, januari: 1,
    feb: 2, februari: 2,
    mar: 3, maret: 3,
    apr: 4, april: 4,
    may: 5, mei: 5,
    jun: 6, juni: 6,
    jul: 7, juli: 7,
    agu: 8, ags: 8, agustus: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, okt: 10, oktober: 10,
    nov: 11, november: 11,
    dec: 12, des: 12, desember: 12
  };

  const match = normalized.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = idMonths[normalizeKey(match[2]).replace(/\s+/g, '')];
    const year = Number(match[3]);
    if (day >= 1 && day <= 31 && month && year >= 2000) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function parseLatLng(value) {
  const raw = normalizeText(value);
  if (!raw || raw.toLowerCase() === 'null, null') return { lat: '', lng: '' };
  const parts = raw.split(',').map((item) => item.trim());
  if (parts.length !== 2) return { lat: '', lng: '' };
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: '', lng: '' };
  return { lat: String(lat), lng: String(lng) };
}

function readLegacyRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
}

function buildLegacySignature(rows) {
  return rows
    .map((row) => normalizeKey(row.ppoe || row.PPPoE || row.pppoe_username || row.nama || row.Nama))
    .filter(Boolean)
    .sort()
    .join('|');
}

function canonicalPackageInfo(name, price) {
  const key = normalizeKey(name);
  const amount = Number(price) || 0;
  if (key.includes('super lite') || key.includes('paket low')) {
    return { name: key.includes('paket low') ? 'Paket Low' : 'Paket super lite', pppoe_profile: 'paket-3mb', speed_down: 3000, speed_up: 3000, price: amount };
  }
  if (key.includes('basic') && key.includes('promo')) {
    return { name: 'Paket Basic (promo)', pppoe_profile: 'paket-8mb', speed_down: 8000, speed_up: 8000, price: amount };
  }
  if (key.includes('basic')) {
    return { name: 'Paket Basic', pppoe_profile: 'paket-8mb', speed_down: 8000, speed_up: 8000, price: amount };
  }
  if (key.includes('standar')) {
    return { name: 'Paket Standar', pppoe_profile: 'paket-10mb', speed_down: 10000, speed_up: 10000, price: amount };
  }
  if (key.includes('premium') || key.includes('premi')) {
    return { name: 'Paket Premium', pppoe_profile: 'paket-10mb', speed_down: 10000, speed_up: 10000, price: amount };
  }
  if (key.includes('ultra')) {
    return { name: 'Paket Ultra', pppoe_profile: 'paket-15mb', speed_down: 15000, speed_up: 15000, price: amount };
  }
  if (key.includes('lite')) {
    return { name: 'Paket Lite', pppoe_profile: 'paket-5mb', speed_down: 5000, speed_up: 5000, price: amount };
  }
  return {
    name: normalizeText(name) || 'Paket Migrasi',
    pppoe_profile: normalizeText(name).toLowerCase().replace(/\s+/g, '-'),
    speed_down: 0,
    speed_up: 0,
    price: amount
  };
}

function buildCustomerNotes(row, sourceTag) {
  const parts = [];
  const legacyId = normalizeText(row.ID);
  const area = normalizeText(row.area);
  const modem = normalizeText(row.Modem);
  const odp = normalizeText(row.ODP);
  const mikrotik = normalizeText(row.Mikrotik);

  if (legacyId) parts.push(`Legacy ID: ${legacyId}`);
  if (area) parts.push(`Area: ${area}`);
  if (modem) parts.push(`Modem: ${modem}`);
  if (odp) parts.push(`ODP: ${odp}`);
  if (mikrotik) parts.push(`Router: ${mikrotik}`);
  parts.push(`Sumber: ${sourceTag}`);

  return parts.join(' | ');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(args.db || path.join(__dirname, '..', 'database', 'billing.db'));
  const activePath = args.active ? path.resolve(args.active) : null;
  const isolatedPath = args.isolated ? path.resolve(args.isolated) : null;
  const stoppedPath = args.stopped ? path.resolve(args.stopped) : null;
  const backupEnabled = args.backup !== 'false';
  const dryRun = Boolean(args['dry-run']);

  if (!activePath || !isolatedPath) {
    throw new Error('Gunakan --active <file> dan --isolated <file>.');
  }
  if (!fs.existsSync(dbPath)) throw new Error(`Database tidak ditemukan: ${dbPath}`);
  if (!fs.existsSync(activePath)) throw new Error(`File active tidak ditemukan: ${activePath}`);
  if (!fs.existsSync(isolatedPath)) throw new Error(`File isolated tidak ditemukan: ${isolatedPath}`);
  if (stoppedPath && !fs.existsSync(stoppedPath)) throw new Error(`File stopped tidak ditemukan: ${stoppedPath}`);

  if (backupEnabled && !dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.legacy-import-${stamp}.bak`;
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[backup] ${backupPath}`);
  }

  const activeRows = readLegacyRows(activePath);
  const isolatedRows = readLegacyRows(isolatedPath);
  const stoppedRows = stoppedPath ? readLegacyRows(stoppedPath) : [];

  const activeSignature = buildLegacySignature(activeRows);
  const stoppedSignature = stoppedRows.length ? buildLegacySignature(stoppedRows) : '';
  const stoppedLooksDuplicated = Boolean(stoppedRows.length) && activeSignature === stoppedSignature;

  const isolatedSet = new Set(
    isolatedRows
      .map((row) => normalizeKey(row.ppoe || row.pppoe_username || row.nama))
      .filter(Boolean)
  );

  const inactiveSet = stoppedLooksDuplicated
    ? new Set()
    : new Set(
        stoppedRows
          .map((row) => normalizeKey(row.ppoe || row.pppoe_username || row.nama))
          .filter(Boolean)
      );

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  );
  const customerColumns = new Set(
    db.prepare('PRAGMA table_info(customers)').all().map((row) => row.name)
  );
  const routerRows = tables.has('routers')
    ? db.prepare('SELECT id, name FROM routers').all()
    : [];
  const routerMap = new Map(routerRows.map((row) => [normalizeKey(row.name), row.id]));
  const odpRows = tables.has('odps')
    ? db.prepare('SELECT id, name FROM odps').all()
    : [];
  const odpMap = new Map(odpRows.map((row) => [normalizeKey(row.name), row.id]));

  const packageRows = db.prepare('SELECT * FROM packages').all();
  const packageByNamePrice = new Map();
  packageRows.forEach((pkg) => {
    packageByNamePrice.set(`${normalizeKey(pkg.name)}|${Number(pkg.price) || 0}`, pkg);
  });

  const findOrCreatePackage = (legacyName, legacyPrice) => {
    const spec = canonicalPackageInfo(legacyName, legacyPrice);
    const key = `${normalizeKey(spec.name)}|${Number(spec.price) || 0}`;
    const existing = packageByNamePrice.get(key);
    if (existing) return existing;
    const result = db.prepare(`
      INSERT INTO packages (
        name, pppoe_profile, price, price_before_tax, include_ppn, ppn_percent,
        speed_down, speed_up, description, is_active, show_in_portal
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 1)
    `).run(
      spec.name,
      spec.pppoe_profile,
      spec.price,
      spec.price,
      spec.speed_down,
      spec.speed_up,
      `Dibuat otomatis dari migrasi pelanggan legacy (${normalizeText(legacyName) || spec.name})`
    );
    const created = { id: result.lastInsertRowid, ...spec };
    packageByNamePrice.set(key, created);
    stats.packagesCreated += 1;
    return created;
  };

  const findExistingCustomer = (() => {
    const byPppoe = customerColumns.has('pppoe_username')
      ? db.prepare("SELECT id FROM customers WHERE lower(trim(pppoe_username)) = lower(trim(?)) LIMIT 1")
      : null;
    const byPhone = customerColumns.has('phone')
      ? db.prepare("SELECT id FROM customers WHERE replace(replace(replace(phone, ' ', ''), '-', ''), '+', '') = ? LIMIT 1")
      : null;
    const byName = db.prepare("SELECT id FROM customers WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1");

    return (row) => {
      const pppoe = normalizeText(row.ppoe);
      if (pppoe && byPppoe) {
        const found = byPppoe.get(pppoe);
        if (found) return found.id;
      }
      const phone = normalizePhone(row.telepon);
      if (phone && byPhone) {
        const found = byPhone.get(phone);
        if (found) return found.id;
      }
      const name = normalizeText(row.nama);
      if (name) {
        const found = byName.get(name);
        if (found) return found.id;
      }
      return null;
    };
  })();

  const updateStmt = db.prepare(`
    UPDATE customers SET
      name = ?,
      phone = ?,
      address = ?,
      nik = ?,
      package_id = ?,
      ${customerColumns.has('router_id') ? 'router_id = ?,' : ''}
      ${customerColumns.has('odp_id') ? 'odp_id = ?,' : ''}
      ${customerColumns.has('lat') ? 'lat = ?,' : ''}
      ${customerColumns.has('lng') ? 'lng = ?,' : ''}
      ${customerColumns.has('pppoe_username') ? 'pppoe_username = ?,' : ''}
      ${customerColumns.has('normal_pppoe_profile') ? 'normal_pppoe_profile = ?,' : ''}
      isolir_profile = ?,
      status = ?,
      install_date = ?,
      notes = ?,
      ${customerColumns.has('auto_isolate') ? 'auto_isolate = ?,' : ''}
      ${customerColumns.has('isolate_day') ? 'isolate_day = ?,' : ''}
      ${customerColumns.has('connection_type') ? 'connection_type = ?' : "notes = ?"}
    WHERE id = ?
  `);

  const insertColumns = ['name', 'phone', 'address', 'nik', 'package_id'];
  if (customerColumns.has('router_id')) insertColumns.push('router_id');
  if (customerColumns.has('odp_id')) insertColumns.push('odp_id');
  if (customerColumns.has('lat')) insertColumns.push('lat');
  if (customerColumns.has('lng')) insertColumns.push('lng');
  if (customerColumns.has('pppoe_username')) insertColumns.push('pppoe_username');
  if (customerColumns.has('normal_pppoe_profile')) insertColumns.push('normal_pppoe_profile');
  insertColumns.push('isolir_profile', 'status', 'install_date', 'notes');
  if (customerColumns.has('auto_isolate')) insertColumns.push('auto_isolate');
  if (customerColumns.has('isolate_day')) insertColumns.push('isolate_day');
  if (customerColumns.has('connection_type')) insertColumns.push('connection_type');

  const insertStmt = db.prepare(`
    INSERT INTO customers (${insertColumns.join(', ')})
    VALUES (${insertColumns.map(() => '?').join(', ')})
  `);

  const stats = {
    rowsActive: activeRows.length,
    rowsIsolated: isolatedRows.length,
    rowsStopped: stoppedRows.length,
    stoppedIgnoredAsDuplicate: stoppedLooksDuplicated,
    packagesCreated: 0,
    customersCreated: 0,
    customersUpdated: 0,
    activeAssigned: 0,
    suspendedAssigned: 0,
    inactiveAssigned: 0
  };

  const importTxn = db.transaction(() => {
    activeRows.forEach((row) => {
      const pppoeKey = normalizeKey(row.ppoe);
      const status = inactiveSet.has(pppoeKey)
        ? 'inactive'
        : isolatedSet.has(pppoeKey)
          ? 'suspended'
          : 'active';
      if (status === 'active') stats.activeAssigned += 1;
      if (status === 'suspended') stats.suspendedAssigned += 1;
      if (status === 'inactive') stats.inactiveAssigned += 1;

      const pkg = findOrCreatePackage(row.paket_nama, row.paket_tarif || row['Total Bayar']);
      const routerId = routerMap.get(normalizeKey(row.Mikrotik)) || null;
      const odpId = odpMap.get(normalizeKey(row.ODP)) || null;
      const phone = normalizePhone(row.telepon);
      const installDate = parseDateInput(row['Tanggal Register']);
      const { lat, lng } = parseLatLng(row['Lat Long']);
      const notes = buildCustomerNotes(row, path.basename(activePath));

      const values = [
        normalizeText(row.nama),
        phone,
        normalizeText(row.alamat),
        normalizeText(row.NIK),
        pkg ? pkg.id : null
      ];
      if (customerColumns.has('router_id')) values.push(routerId);
      if (customerColumns.has('odp_id')) values.push(odpId);
      if (customerColumns.has('lat')) values.push(lat);
      if (customerColumns.has('lng')) values.push(lng);
      if (customerColumns.has('pppoe_username')) values.push(normalizeText(row.ppoe));
      if (customerColumns.has('normal_pppoe_profile')) values.push(pkg?.pppoe_profile || '');
      values.push('BEATISOLIR', status, installDate, notes);
      if (customerColumns.has('auto_isolate')) values.push(1);
      if (customerColumns.has('isolate_day')) values.push(Number(row.tanggal) || 10);
      if (customerColumns.has('connection_type')) values.push('pppoe');

      const existingId = findExistingCustomer(row);
      if (existingId) {
        updateStmt.run(...values, existingId);
        stats.customersUpdated += 1;
      } else {
        insertStmt.run(...values);
        stats.customersCreated += 1;
      }
    });
  });

  if (!dryRun) importTxn();
  console.log(JSON.stringify(stats, null, 2));

  if (stoppedLooksDuplicated) {
    console.warn('[warn] File pelanggan berhenti identik dengan file pelanggan utama, jadi tidak dipakai untuk status inactive.');
  }
}

try {
  main();
} catch (error) {
  console.error('[import-legacy-customers] gagal:', error.message || error);
  process.exit(1);
}
