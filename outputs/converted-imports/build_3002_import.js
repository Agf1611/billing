const fs = require('fs');
const XLSX = require('xlsx');

const inputPath = 'C:/Users/ANHComp/Downloads/Pelanggan - Mei 2026 - Per 12 Mei 2026.xls';
const outputPath = 'C:/xampp/htdocs/billing/outputs/converted-imports/template_import_pelanggan_3002_2026-05-12.xlsx';
const downloadCopy = 'C:/Users/ANHComp/Downloads/template_import_pelanggan_3002_2026-05-12.xlsx';

const wb = XLSX.readFile(inputPath, { raw: true, cellDates: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

const packageMap = new Map([
  ['paket basic', { name: 'Paket Basic', profile: 'paket-10mb' }],
  ['paket basic (promo)', { name: 'Paket Basic', profile: 'paket-10mb' }],
  ['paket lite', { name: 'Paket Lite', profile: 'paket-5mb' }],
  ['paket low', { name: 'Paket super lite', profile: 'paket-3mb' }],
  ['paket premium', { name: 'PAKET PREMI', profile: 'paket-15mb' }],
  ['paket ultra', { name: 'PAKET PREMI', profile: 'paket-15mb' }],
  ['paket standar', { name: 'Paket Basic', profile: 'paket-10mb' }],
  ['paket super lite', { name: 'Paket super lite', profile: 'paket-3mb' }],
  ['paket-10mb(promo)', { name: 'paket-10mb(promo)', profile: 'paket-10mb(promo)' }],
  ['paket-3mb', { name: 'paket-3mb', profile: 'paket-3mb' }]
]);

const indoMonths = {
  jan: '01', januari: '01',
  feb: '02', febr: '02', februari: '02',
  mar: '03', maret: '03',
  apr: '04', april: '04',
  mei: '05',
  jun: '06', juni: '06',
  jul: '07', juli: '07',
  agu: '08', ags: '08', agustus: '08',
  sep: '09', sept: '09', september: '09',
  okt: '10', oktober: '10',
  nov: '11', november: '11',
  des: '12', desember: '12'
};

function clean(v) { return String(v ?? '').trim(); }
function normalizePhone(raw) {
  const digits = clean(raw).replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  return digits;
}
function normalizePackage(raw, tariff) {
  const key = clean(raw).toLowerCase();
  if (packageMap.has(key)) return packageMap.get(key);
  const tariffNum = Number(String(tariff).replace(/[^0-9]/g, '')) || 0;
  if (tariffNum >= 240000) return { name: 'PAKET PREMI', profile: 'paket-15mb' };
  if (tariffNum >= 180000) return { name: 'Paket Basic', profile: 'paket-10mb' };
  if (tariffNum >= 150000) return { name: 'Paket Lite', profile: 'paket-5mb' };
  if (tariffNum >= 100000) return { name: 'Paket super lite', profile: 'paket-3mb' };
  return { name: 'Paket Lite', profile: 'paket-5mb' };
}
function parseInstallDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = clean(raw);
  if (!text) return '';
  const iso = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  const id = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/i);
  if (id) {
    const day = String(id[1]).padStart(2, '0');
    const month = indoMonths[id[2].toLowerCase()];
    if (month) return `${id[3]}-${month}-${day}`;
  }
  return text;
}
function splitLatLng(raw) {
  const text = clean(raw);
  if (!text) return ['', ''];
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return ['', ''];
  const lat = parts[0].toLowerCase() === 'null' ? '' : parts[0];
  const lng = parts[1].toLowerCase() === 'null' ? '' : parts[1];
  return [lat, lng];
}

const headers = ['Nama','Telepon','Email','Alamat','Paket','Tag ONU','PPPoE Username','PPPoE Profile','Isolir Profile','Status','Tanggal Pasang','Auto Isolir','Tgl Isolir','ODP','Latitude','Longitude','Catatan'];
const converted = [];
const summaryCounts = new Map();
for (const row of rows) {
  const name = clean(row.nama);
  if (!name) continue;
  const mapped = normalizePackage(row.paket_nama, row.paket_tarif);
  const [lat, lng] = splitLatLng(row['Lat Long']);
  const originalPackage = clean(row.paket_nama);
  const originalTariff = clean(row.paket_tarif);
  const notes = [
    clean(row.ID) ? `Source ID: ${clean(row.ID)}` : '',
    clean(row.area) ? `Area: ${clean(row.area)}` : '',
    originalPackage ? `Paket lama: ${originalPackage}` : '',
    originalTariff ? `Tarif lama: ${originalTariff}` : '',
    clean(row.Modem) ? `Modem: ${clean(row.Modem)}` : '',
    clean(row.Mikrotik) ? `Mikrotik: ${clean(row.Mikrotik)}` : '',
    clean(row.NIK) ? `NIK: ${clean(row.NIK)}` : '',
    clean(row['Bulan Tagihan']) ? `Bulan tagihan sumber: ${clean(row['Bulan Tagihan'])}` : ''
  ].filter(Boolean).join(' | ');
  converted.push([
    name,
    normalizePhone(row.telepon),
    '',
    clean(row.alamat),
    mapped.name,
    '',
    clean(row.ppoe),
    mapped.profile,
    'BEATISOLIR',
    'active',
    parseInstallDate(row['Tanggal Register']),
    'YA',
    String(parseInt(clean(row.tanggal), 10) || 10),
    clean(row.ODP),
    lat,
    lng,
    notes
  ]);
  const sumKey = `${originalPackage} => ${mapped.name}`;
  summaryCounts.set(sumKey, (summaryCounts.get(sumKey) || 0) + 1);
}
const guideRows = [
  ['Panduan Import Pelanggan 3002'],
  ['1. File ini sudah disesuaikan dari backup aplikasi lama untuk data BARU di instance 3002.'],
  ['2. Upload file ini dari menu import pelanggan 3002.'],
  ['3. Semua data akan dibuat sebagai pelanggan baru karena format mengikuti template import tanpa kolom ID.'],
  ['4. Paket sudah dinormalisasi mengikuti master paket 3001 yang sudah disalin ke 3002.'],
  ['5. Nama/tarif paket lama tetap disimpan di kolom Catatan.'],
  ['6. Isolir Profile default: BEATISOLIR.'],
  ['7. Cek ulang kolom ODP bila ingin dipakai, karena harus sama persis dengan nama ODP di aplikasi.']
];
const summaryRows = [['Paket Sumber', 'Paket Tujuan', 'Jumlah']];
for (const [key, count] of [...summaryCounts.entries()].sort()) {
  const [source, target] = key.split(' => ');
  summaryRows.push([source, target, count]);
}
const wsData = XLSX.utils.aoa_to_sheet([headers, ...converted]);
wsData['!cols'] = headers.map((header, idx) => ({ wch: [20,16,20,28,18,14,22,18,16,12,16,12,10,16,14,14,60][idx] || 16 }));
const wsGuide = XLSX.utils.aoa_to_sheet(guideRows); wsGuide['!cols'] = [{ wch: 96 }];
const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows); wsSummary['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 10 }];
const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, wsData, 'Template Import');
XLSX.utils.book_append_sheet(outWb, wsGuide, 'Panduan');
XLSX.utils.book_append_sheet(outWb, wsSummary, 'Mapping Paket');
XLSX.writeFile(outWb, outputPath);
fs.copyFileSync(outputPath, downloadCopy);
console.log(JSON.stringify({ outputPath, downloadCopy, rows: converted.length }, null, 2));
