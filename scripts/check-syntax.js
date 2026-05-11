const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = ['app-customer.js', 'routes', 'services', 'config', 'middleware', 'scripts'];
const ignoredDirNames = new Set([
  'node_modules',
  '.git',
  'backups',
  'public',
  'database',
  'logs',
  'auth_info_baileys',
  'workspace_archive'
]);

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
  if (!filePath.endsWith('.js') && !filePath.endsWith('.mjs')) return;
  bucket.push(filePath);
}

const files = [];
for (const target of targets) {
  const full = path.join(root, target);
  if (fs.existsSync(full)) walk(full, files);
}

let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`OK ${path.relative(root, file)}`);
  } catch (error) {
    failed = true;
    const detail = String(error.stderr || error.stdout || error.stack || error.message || error).trim();
    console.error(`FAIL ${path.relative(root, file)}\n${detail}`);
  }
}

if (failed) process.exit(1);
