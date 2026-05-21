const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = {
    file: '',
    customerFile: '',
    db: '',
    apply: false,
    verbose: false,
    backup: true,
    reactivatePaid: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') args.apply = true;
    else if (token === '--verbose') args.verbose = true;
    else if (token === '--no-backup') args.backup = false;
    else if (token === '--reactivate-paid') args.reactivatePaid = true;
    else if (token === '--file') args.file = String(argv[i + 1] || '');
    else if (token.startsWith('--file=')) args.file = token.slice(7);
    else if (token === '--db') args.db = String(argv[i + 1] || '');
    else if (token.startsWith('--db=')) args.db = token.slice(5);
    else if (token === '--customer-file') args.customerFile = String(argv[i + 1] || '');
    else if (token.startsWith('--customer-file=')) args.customerFile = token.slice(16);
    if (token === '--file' || token === '--db' || token === '--customer-file') i += 1;
  }

  if (!args.file || !args.db) {
    throw new Error('Gunakan --file <path-xls> dan --db <path-db>.');
  }

  return args;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeAddress(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\b(kp|kampung|ds|desa|jl|jalan|sd|ko)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressesLookSimilar(left, right) {
  const a = normalizeAddress(left);
  const b = normalizeAddress(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const compactA = a.replace(/\s+/g, '');
  const compactB = b.replace(/\s+/g, '');
  if (compactA === compactB) return true;
  if (compactA.includes(compactB) || compactB.includes(compactA)) return true;

  const aTokens = new Set(a.split(' ').filter(Boolean));
  const bTokens = new Set(b.split(' ').filter(Boolean));
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap >= 1;
}

function formatSqlDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d} 12:00:00`;
}

function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

function normalizeIsolateDay(value, fallback = 10) {
  const day = Math.max(1, Math.min(31, Number(value || fallback) || fallback));
  return day >= 5 ? day : 5;
}

function parseMonthYear(input) {
  const raw = String(input || '').trim();
  const monthMap = {
    januari: 1,
    februari: 2,
    maret: 3,
    april: 4,
    mei: 5,
    juni: 6,
    juli: 7,
    agustus: 8,
    september: 9,
    oktober: 10,
    november: 11,
    desember: 12
  };

  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(raw);
  if (!match) throw new Error(`Bulan tagihan tidak valid: ${raw}`);
  const month = monthMap[match[1].toLowerCase()];
  const year = Number(match[2]);
  if (!month || !year) throw new Error(`Bulan tagihan tidak dikenali: ${raw}`);
  return { month, year };
}

function parseDateToYmd(value, fallbackYear = null, fallbackMonth = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const monthMap = {
    januari: 1, jan: 1,
    februari: 2, febr: 2, feb: 2,
    maret: 3, mar: 3,
    april: 4, apr: 4,
    mei: 5,
    juni: 6, jun: 6,
    juli: 7, jul: 7,
    agustus: 8, ags: 8, agu: 8,
    september: 9, sep: 9,
    oktober: 10, okt: 10,
    november: 11, nov: 11,
    desember: 12, des: 12
  };

  const idMatch = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(raw);
  if (idMatch) {
    const month = monthMap[idMatch[2].toLowerCase()];
    if (month) {
      return `${idMatch[3]}-${String(month).padStart(2, '0')}-${String(Number(idMatch[1])).padStart(2, '0')}`;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  const native = new Date(raw);
  if (!Number.isNaN(native.getTime())) {
    const y = native.getFullYear();
    const m = String(native.getMonth() + 1).padStart(2, '0');
    const d = String(native.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (fallbackYear && fallbackMonth) {
    const day = Number(raw);
    if (Number.isFinite(day) && day >= 1 && day <= 31) {
      const safeDay = Math.min(day, daysInMonth(fallbackYear, fallbackMonth));
      return `${fallbackYear}-${String(fallbackMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
    }
  }

  return '';
}

function parsePaymentDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return new Date(parsed.y, parsed.m - 1, parsed.d, 12, 0, 0, 0);
    }
  }

  const raw = String(value || '').trim();
  if (!raw) return null;

  const monthMap = {
    januari: 0,
    februari: 1,
    maret: 2,
    april: 3,
    mei: 4,
    juni: 5,
    juli: 6,
    agustus: 7,
    september: 8,
    oktober: 9,
    november: 10,
    desember: 11
  };

  const idMatch = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(raw);
  if (idMatch) {
    const day = Number(idMatch[1]);
    const month = monthMap[idMatch[2].toLowerCase()];
    const year = Number(idMatch[3]);
    if (Number.isFinite(day) && Number.isFinite(month) && Number.isFinite(year)) {
      return new Date(year, month, day, 12, 0, 0, 0);
    }
  }

  const isoCandidate = new Date(raw);
  if (!Number.isNaN(isoCandidate.getTime())) {
    return new Date(isoCandidate.getFullYear(), isoCandidate.getMonth(), isoCandidate.getDate(), 12, 0, 0, 0);
  }

  return null;
}

function readSheetRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  const dataRows = rows
    .slice(2)
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim() !== ''));

  return dataRows.map((row, index) => {
    const period = parseMonthYear(row[17]);
    let paymentDate = parsePaymentDate(row[20]);
    let paymentDateCoerced = false;
    if (
      paymentDate &&
      (paymentDate.getFullYear() !== period.year || paymentDate.getMonth() + 1 !== period.month)
    ) {
      const coercedDay = Math.min(paymentDate.getDate(), daysInMonth(period.year, period.month));
      paymentDate = new Date(period.year, period.month - 1, coercedDay, 12, 0, 0, 0);
      paymentDateCoerced = true;
    }
    return {
      rowNumber: index + 3,
      idFromSheet: Number(row[1] || 0) || null,
      name: String(row[2] || '').trim(),
      phone: String(row[3] || '').trim(),
      pppoe: String(row[4] || '').trim(),
      packageName: String(row[5] || '').trim(),
      area: String(row[6] || '').trim(),
      address: String(row[7] || '').trim(),
      amount: Math.round(Number(row[16] || row[8] || 0) || 0),
      isolateDay: normalizeIsolateDay(row[9], 10),
      periodMonth: period.month,
      periodYear: period.year,
      paymentDate,
      paymentDateCoerced,
      paymentBy: String(row[21] || '').trim() || 'Import XLS',
      via: String(row[22] || '').trim()
    };
  });
}

function splitLatLng(raw) {
  const text = String(raw || '').trim();
  if (!text || text.toLowerCase().includes('null')) return { lat: '', lng: '' };
  const parts = text.split(',').map((item) => String(item || '').trim());
  if (parts.length < 2) return { lat: '', lng: '' };
  const lat = parts[0];
  const lng = parts[1];
  return { lat, lng };
}

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

function readCustomerMasterRows(filePath) {
  if (!filePath) return [];
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  return rows.slice(1)
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim() !== ''))
    .map((row, index) => {
      const { lat, lng } = splitLatLng(row[17]);
      return {
        rowNumber: index + 2,
        name: String(row[0] || '').trim(),
        phone: normalizePhoneStorage(row[1]),
        pppoe: String(row[2] || '').trim(),
        isolateDay: normalizeIsolateDay(row[8], 10),
        area: String(row[9] || '').trim(),
        packageName: String(row[10] || '').trim(),
        packagePrice: Math.round(Number(row[11] || 0) || 0),
        address: String(row[12] || '').trim(),
        legacyId: String(row[13] || '').trim(),
        totalBill: Math.round(Number(row[15] || 0) || 0),
        periodLabel: String(row[16] || '').trim(),
        lat,
        lng,
        nik: String(row[18] || '').trim(),
        installDate: parseDateToYmd(row[22]),
        routerName: String(row[23] || '').trim(),
        modem: String(row[24] || '').trim(),
        odp: String(row[25] || '').trim()
      };
    });
}

function loadCustomerMatchers(db) {
  const customers = db.prepare(`
    SELECT id, name, phone, address, pppoe_username, status, isolate_day
    FROM customers
  `).all();

  const byPppoe = new Map();
  const byName = new Map();

  for (const customer of customers) {
    const pppoeKey = normalizeText(customer.pppoe_username);
    const nameKey = normalizeText(customer.name);
    if (pppoeKey && !byPppoe.has(pppoeKey)) byPppoe.set(pppoeKey, customer);
    if (!nameKey) continue;
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(customer);
  }

  return { byPppoe, byName };
}

function loadReferenceCustomers(customerRows) {
  const byPppoe = new Map();
  for (const row of customerRows) {
    const key = normalizeText(row.pppoe);
    if (key && !byPppoe.has(key)) byPppoe.set(key, row);
  }
  return { byPppoe };
}

function buildPackageMatcher(db) {
  const packages = db.prepare('SELECT id, name, price, pppoe_profile FROM packages').all();
  const byNamePrice = new Map();
  const byPrice = new Map();
  for (const pkg of packages) {
    const key = `${normalizeText(pkg.name)}::${Number(pkg.price || 0)}`;
    if (!byNamePrice.has(key)) byNamePrice.set(key, pkg);
    const priceKey = Number(pkg.price || 0);
    if (!byPrice.has(priceKey)) byPrice.set(priceKey, []);
    byPrice.get(priceKey).push(pkg);
  }
  return { byNamePrice, byPrice };
}

function resolvePackage(referenceRow, packageMatcher) {
  const exactKey = `${normalizeText(referenceRow.packageName)}::${Number(referenceRow.packagePrice || 0)}`;
  if (packageMatcher.byNamePrice.has(exactKey)) return packageMatcher.byNamePrice.get(exactKey);
  const byPrice = packageMatcher.byPrice.get(Number(referenceRow.packagePrice || 0)) || [];
  if (byPrice.length === 1) return byPrice[0];
  return null;
}

function resolveRouterId(db, routerName) {
  const text = String(routerName || '').trim();
  if (!text) return null;
  try {
    const row = db.prepare('SELECT id FROM routers WHERE lower(name) = lower(?) LIMIT 1').get(text);
    return row ? Number(row.id || 0) || null : null;
  } catch (_) {
    return null;
  }
}

function resolveCustomer(row, matchers) {
  const pppoeKey = normalizeText(row.pppoe);
  const nameKey = normalizeText(row.name);
  const byPppoe = pppoeKey ? matchers.byPppoe.get(pppoeKey) : null;
  if (byPppoe) return { customer: byPppoe, matchedBy: 'pppoe' };

  const byName = nameKey ? (matchers.byName.get(nameKey) || []) : [];
  if (byName.length === 1 && addressesLookSimilar(row.address, byName[0].address)) {
    return { customer: byName[0], matchedBy: 'name' };
  }

  return { customer: null, matchedBy: '' };
}

function ensureBackup(dbPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.paid-import-${timestamp}.bak`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const absoluteFile = path.resolve(args.file);
  const absoluteDb = path.resolve(args.db);
  const absoluteCustomerFile = args.customerFile ? path.resolve(args.customerFile) : '';

  if (!fs.existsSync(absoluteFile)) throw new Error(`File XLS tidak ditemukan: ${absoluteFile}`);
  if (!fs.existsSync(absoluteDb)) throw new Error(`Database tidak ditemukan: ${absoluteDb}`);
  if (absoluteCustomerFile && !fs.existsSync(absoluteCustomerFile)) {
    throw new Error(`File master pelanggan tidak ditemukan: ${absoluteCustomerFile}`);
  }

  const rows = readSheetRows(absoluteFile);
  const customerReferenceRows = readCustomerMasterRows(absoluteCustomerFile);
  const db = new Database(absoluteDb);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const matchers = loadCustomerMatchers(db);
  const referenceCustomers = loadReferenceCustomers(customerReferenceRows);
  const packageMatcher = buildPackageMatcher(db);
  const stats = {
    rows: rows.length,
    matchedByPppoe: 0,
    matchedByName: 0,
    missingCustomers: 0,
    customersCreated: 0,
    customersUpdated: 0,
    customersReactivated: 0,
    invoicesCreated: 0,
    invoicesUpdated: 0,
    invoicesMarkedPaid: 0,
    incomeEntriesUpserted: 0,
    paymentDatesCoerced: 0,
    warnings: [],
    backupPath: null,
    periodSummary: {}
  };
  const reactivatedCustomerIds = [];

  const insertCustomer = db.prepare(`
    INSERT INTO customers (
      name, phone, address, nik, package_id, router_id, lat, lng,
      pppoe_username, normal_pppoe_profile, isolir_profile, status,
      install_date, notes, auto_isolate, isolate_day, connection_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BEATISOLIR', 'active', ?, ?, 1, ?, 'pppoe')
  `);
  const updateCustomer = db.prepare('UPDATE customers SET isolate_day = ? WHERE id = ?');
  const reactivateCustomer = db.prepare("UPDATE customers SET status = 'active' WHERE id = ? AND status != 'active'");
  const selectInvoice = db.prepare(`
    SELECT id, status, amount, paid_at
    FROM invoices
    WHERE customer_id = ? AND period_month = ? AND period_year = ?
    ORDER BY id ASC
    LIMIT 1
  `);
  const insertInvoice = db.prepare(`
    INSERT INTO invoices (
      customer_id, period_month, period_year, amount, status, paid_at, paid_by_name, notes,
      payment_gateway, due_day_snapshot
    ) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?)
  `);
  const updateInvoice = db.prepare(`
    UPDATE invoices
    SET amount = ?, status = 'paid', paid_at = ?, paid_by_name = ?, notes = ?, payment_gateway = ?, due_day_snapshot = ?
    WHERE id = ?
  `);
  const selectBook = db.prepare("SELECT id FROM bookkeeping_entries WHERE source_type = 'invoice' AND source_id = ? LIMIT 1");
  const insertBook = db.prepare(`
    INSERT INTO bookkeeping_entries (
      type, category, amount, entry_date, description, customer_id, invoice_id,
      source_type, source_id, created_by_role, created_by_name
    ) VALUES ('income', 'Pembayaran Tagihan', ?, ?, ?, ?, ?, 'invoice', ?, 'system', ?)
  `);
  const updateBook = db.prepare(`
    UPDATE bookkeeping_entries
    SET type = 'income',
        category = 'Pembayaran Tagihan',
        amount = ?,
        entry_date = ?,
        description = ?,
        customer_id = ?,
        invoice_id = ?,
        created_by_name = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      let { customer, matchedBy } = resolveCustomer(row, matchers);
      if (!customer) {
        const ref = referenceCustomers.byPppoe.get(normalizeText(row.pppoe));
        if (ref) {
          const pkg = resolvePackage(ref, packageMatcher);
          if (!pkg) {
            stats.missingCustomers += 1;
            stats.warnings.push(`Baris ${row.rowNumber}: paket tidak ditemukan untuk pelanggan baru ${row.name} (${ref.packageName} / ${ref.packagePrice}).`);
            continue;
          }
          const routerId = resolveRouterId(db, ref.routerName);
          if (args.apply) {
            const result = insertCustomer.run(
              ref.name || row.name,
              ref.phone || normalizePhoneStorage(row.phone),
              ref.address || row.address,
              ref.nik || '',
              pkg.id,
              routerId,
              ref.lat || null,
              ref.lng || null,
              ref.pppoe || row.pppoe,
              pkg.pppoe_profile || '',
              ref.installDate || null,
              `Auto dibuat dari master pelanggan untuk impor lunas Mei 2026${ref.legacyId ? ` | legacyId ${ref.legacyId}` : ''}${ref.area ? ` | area ${ref.area}` : ''}${ref.routerName ? ` | router ${ref.routerName}` : ''}${ref.modem ? ` | modem ${ref.modem}` : ''}${ref.odp ? ` | odp ${ref.odp}` : ''}`,
              ref.isolateDay || row.isolateDay
            );
            customer = db.prepare('SELECT id, name, phone, address, pppoe_username, status, isolate_day FROM customers WHERE id = ?').get(result.lastInsertRowid);
          } else {
            customer = {
              id: `planned-customer-${row.pppoe || row.name}`,
              name: ref.name || row.name,
              phone: ref.phone || normalizePhoneStorage(row.phone),
              address: ref.address || row.address,
              pppoe_username: ref.pppoe || row.pppoe,
              status: 'active',
              isolate_day: ref.isolateDay || row.isolateDay
            };
          }
          matchedBy = 'created-from-master';
          stats.customersCreated += 1;
          if (args.apply && typeof customer.id === 'number') {
            const key = normalizeText(customer.pppoe_username);
            if (key && !matchers.byPppoe.has(key)) matchers.byPppoe.set(key, customer);
            const nameKey = normalizeText(customer.name);
            if (nameKey) {
              if (!matchers.byName.has(nameKey)) matchers.byName.set(nameKey, []);
              matchers.byName.get(nameKey).push(customer);
            }
          }
        }
      }

      if (!customer) {
        stats.missingCustomers += 1;
        stats.warnings.push(`Baris ${row.rowNumber}: pelanggan tidak ditemukan (${row.name} / ${row.pppoe})`);
        continue;
      }

      if (matchedBy === 'pppoe') stats.matchedByPppoe += 1;
      if (matchedBy === 'name') stats.matchedByName += 1;

      if (Number(customer.isolate_day || 0) !== row.isolateDay) {
        if (args.apply) updateCustomer.run(row.isolateDay, customer.id);
        stats.customersUpdated += 1;
      }

      if (args.reactivatePaid && String(customer.status || '').toLowerCase() !== 'active') {
        if (args.apply) {
          const reactivated = reactivateCustomer.run(customer.id);
          if (Number(reactivated.changes || 0) > 0) {
            stats.customersReactivated += 1;
            reactivatedCustomerIds.push(Number(customer.id));
          }
        } else {
          stats.customersReactivated += 1;
        }
      } else if (String(customer.status || '').toLowerCase() !== 'active') {
        stats.warnings.push(`Pelanggan ${customer.name} (${customer.id}) tetap ${customer.status} walau ada di file lunas.`);
      }

      const paidAt = row.paymentDate ? formatSqlDate(row.paymentDate) : null;
      if (row.paymentDateCoerced) {
        stats.paymentDatesCoerced += 1;
        stats.warnings.push(`Baris ${row.rowNumber}: tanggal bayar dinormalkan ke ${paidAt.slice(0, 10)} agar sesuai periode ${row.periodMonth}/${row.periodYear}.`);
      }
      const notes = [
        'Import lunas XLS',
        row.via ? `via ${row.via}` : '',
        row.area ? `area ${row.area}` : ''
      ].filter(Boolean).join(' | ');

      let invoice = selectInvoice.get(customer.id, row.periodMonth, row.periodYear);
      if (!invoice) {
        if (args.apply) {
          const result = insertInvoice.run(
            customer.id,
            row.periodMonth,
            row.periodYear,
            row.amount,
            paidAt,
            row.paymentBy,
            notes,
            row.via || null,
            row.isolateDay
          );
          invoice = { id: result.lastInsertRowid };
        } else {
          invoice = { id: `planned-${customer.id}-${row.periodYear}-${row.periodMonth}` };
        }
        stats.invoicesCreated += 1;
      } else {
        if (args.apply) {
          updateInvoice.run(
            row.amount,
            paidAt,
            row.paymentBy,
            notes,
            row.via || null,
            row.isolateDay,
            invoice.id
          );
        }
        stats.invoicesUpdated += 1;
      }

      stats.invoicesMarkedPaid += 1;

      const entryDate = paidAt ? paidAt.slice(0, 10) : `${row.periodYear}-${String(row.periodMonth).padStart(2, '0')}-01`;
      const description = [
        `Pembayaran tagihan ${customer.name}`,
        `periode ${row.periodMonth}/${row.periodYear}`,
        row.paymentBy ? `oleh ${row.paymentBy}` : ''
      ].filter(Boolean).join(' • ');
      const existingBook = typeof invoice.id === 'number' ? selectBook.get(invoice.id) : null;
      if (existingBook) {
        if (args.apply) {
          updateBook.run(row.amount, entryDate, description, customer.id, invoice.id, row.paymentBy, existingBook.id);
        }
      } else {
        if (args.apply) {
          insertBook.run(row.amount, entryDate, description, customer.id, invoice.id, invoice.id, row.paymentBy);
        }
      }
      stats.incomeEntriesUpserted += 1;

      const periodKey = `${row.periodYear}-${String(row.periodMonth).padStart(2, '0')}`;
      if (!stats.periodSummary[periodKey]) stats.periodSummary[periodKey] = { invoiceCount: 0, totalAmount: 0 };
      stats.periodSummary[periodKey].invoiceCount += 1;
      stats.periodSummary[periodKey].totalAmount += row.amount;
    }
  });

  if (args.apply && args.backup) {
    stats.backupPath = ensureBackup(absoluteDb);
  }

  run();

  if (args.apply && reactivatedCustomerIds.length > 0) {
    try {
      const customerSvcPath = path.join(process.cwd(), 'services', 'customerService.js');
      const mikrotikSvcPath = path.join(process.cwd(), 'services', 'mikrotikService.js');
      if (fs.existsSync(customerSvcPath) && fs.existsSync(mikrotikSvcPath)) {
        const customerSvc = require(customerSvcPath);
        const mikrotikSvc = require(mikrotikSvcPath);
        for (const customerId of reactivatedCustomerIds) {
          const customer = customerSvc.getCustomerById(customerId);
          if (!customer || !customer.pppoe_username) continue;
          let targetProfile = String(customer.normal_pppoe_profile || '').trim();
          if (!targetProfile && customer.package_id && typeof customerSvc.getPackageById === 'function') {
            const pkg = customerSvc.getPackageById(customer.package_id);
            targetProfile = String(pkg?.pppoe_profile || pkg?.name || '').trim();
          }
          if (targetProfile) {
            try {
              await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id);
            } catch (syncError) {
              stats.warnings.push(`Sinkron profil MikroTik gagal untuk customer ${customerId}: ${String(syncError?.message || syncError)}`);
            }
          }
        }
      }
    } catch (activationError) {
      stats.warnings.push(`Sinkron aktivasi MikroTik gagal: ${String(activationError?.message || activationError)}`);
    }
  }

  const output = {
    mode: args.apply ? 'apply' : 'dry-run',
    file: absoluteFile,
    db: absoluteDb,
    ...stats
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: String(error && error.message ? error.message : error)
  }, null, 2));
  process.exit(1);
});
