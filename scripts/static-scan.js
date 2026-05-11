const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = ['app-customer.js', 'routes', 'services', 'config', 'views'];
const ignoredDirNames = new Set(['node_modules', '.git', 'backups', 'workspace_archive']);
const patterns = [
  { label: "legacy redirect('back')", regex: /res\.redirect\('back'\)/g },
  { label: 'hardcoded localhost public URL', regex: /localhost:3001/g },
  { label: 'dangerous git reset hard', regex: /git reset --hard/g },
  { label: 'direct innerHTML assignment', regex: /\.innerHTML\s*=/g }
];

function walk(filePath, bucket) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    const base = path.basename(filePath);
    if (ignoredDirNames.has(base)) return;
    for (const entry of fs.readdirSync(filePath)) {
      walk(path.join(filePath, entry), bucket);
    }
    return;
  }
  bucket.push(filePath);
}

const files = [];
for (const target of targets) {
  const full = path.join(root, target);
  if (fs.existsSync(full)) walk(full, files);
}

let warningCount = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    const matches = [...src.matchAll(pattern.regex)];
    if (!matches.length) continue;
    warningCount += matches.length;
    console.log(`WARN ${rel} :: ${pattern.label} :: ${matches.length}`);
  }
}

console.log(`Static scan selesai. Total warning: ${warningCount}`);
