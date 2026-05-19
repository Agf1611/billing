#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const trackedFiles = loadTrackedFiles();
const violations = [];

const blockedTrackedFiles = new Set([
  'deploy_pending_files.txt',
  'deploy_detail_fix.sh',
  'deploy_detail_hero_compact.sh',
  'deploy_detail_round2.sh',
  'deploy_detail_tech_history.sh',
  'deploy_detail_theme_fix.sh',
  'deploy_portal_traffic_fix.sh',
  'deploy_portal_traffic_live_fix.sh',
  'reports-chart-height-fix.sh',
  'scripts/deploy_agent_voucher_polish.cmd',
  'settings.local.json'
]);

for (const file of trackedFiles) {
  const fullPath = path.join(repoRoot, file);
  if (!fs.existsSync(fullPath)) continue;
  if (blockedTrackedFiles.has(file)) {
    violations.push(`${file}: file internal ini tidak boleh ikut rilis publik.`);
  }
}

const settingsTemplatePath = path.join(repoRoot, 'settings.json');
if (!fs.existsSync(settingsTemplatePath)) {
  violations.push('settings.json: template konfigurasi publik tidak ditemukan.');
} else {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsTemplatePath, 'utf8'));
    assertPlaceholder(settings, 'genieacs_password');
    assertPlaceholder(settings, 'session_secret');
    assertPlaceholder(settings, 'admin_password');
    assertPlaceholder(settings, 'admin_api_key');
    assertPlaceholder(settings, 'mikrotik_password');
    assertPlaceholder(settings, 'xendit_callback_token');
  } catch (error) {
    violations.push(`settings.json: ${error.message}`);
  }
}

for (const relPath of trackedFiles) {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) continue;
  const source = fs.readFileSync(fullPath, 'utf8');
  if (/sudo -S/.test(source)) {
    violations.push(`${relPath}: masih mengandung pola sudo non-interaktif yang sensitif.`);
  }
  if (/pscp\.exe|plink\.exe/i.test(source)) {
    violations.push(`${relPath}: masih mengandung skrip deploy berbasis kredensial lokal.`);
  }
}

if (violations.length) {
  console.error('Audit publish gagal:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Audit publish lulus. Repo aman untuk dibagikan setelah QA biasa tetap lulus.');

function loadTrackedFiles() {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const errorText = String(result.stderr || result.stdout || '').trim() || 'git ls-files gagal';
    throw new Error(errorText);
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertPlaceholder(settings, key) {
  const value = String(settings[key] || '').trim();
  if (!value) return;
  if (/^CHANGE_ME[_A-Z0-9-]*/.test(value)) return;
  throw new Error(`${key} masih berisi nilai nyata atau belum dipindahkan ke settings.local.json.`);
}
