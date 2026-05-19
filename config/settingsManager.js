const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_DURATION = 2000;

const projectRoot = path.join(__dirname, '..');
const publicSettingsPath = path.join(projectRoot, 'settings.json');
const privateSettingsPath = path.join(projectRoot, 'settings.local.json');
const watchedFiles = new Set(['settings.json', 'settings.local.json']);
let watcher = null;

function readSettingsFile(filePath, { silent = false } = {}) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Isi file harus berupa objek JSON.');
    }
    return parsed;
  } catch (error) {
    if (!silent) {
      logger.error(`[settings] Error reading ${path.basename(filePath)}: ${error.message}`);
    }
    return {};
  }
}

function getOperationalSettingsPath() {
  if (fs.existsSync(privateSettingsPath)) return privateSettingsPath;
  if (fs.existsSync(publicSettingsPath)) return publicSettingsPath;
  return privateSettingsPath;
}

function getSettings() {
  const publicSettings = readSettingsFile(publicSettingsPath, { silent: true });
  const privateSettings = readSettingsFile(privateSettingsPath, { silent: true });
  return {
    ...publicSettings,
    ...privateSettings
  };
}

function getSettingsWithCache() {
  const now = Date.now();
  if (!settingsCache || (now - settingsCacheTime) > CACHE_DURATION) {
    settingsCache = getSettings();
    settingsCacheTime = now;
  }
  return settingsCache;
}

function getSetting(key, defaultValue = null) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

function getSettingsByKeys(keys) {
  const settings = getSettingsWithCache();
  const result = {};
  keys.forEach((key) => {
    result[key] = settings[key];
  });
  return result;
}

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
}

function logReloadSummary() {
  try {
    const s = getSettingsWithCache();
    const port = s.server_port ?? 4555;
    const host = s.server_host || 'localhost';
    const gurl = s.genieacs_url || '(tidak diatur)';
    const company = s.company_header || '(default)';
    logger.info(
      `[settings] Konfigurasi dimuat ulang - port ${port}, host ${host}, company: ${company}, GenieACS: ${gurl}`
    );
  } catch (error) {
    logger.error(`[settings] Gagal memuat ulang konfigurasi: ${error.message}`);
  }
}

function startSettingsWatcher() {
  try {
    if (watcher) watcher.close();

    watcher = fs.watch(projectRoot, (_eventType, filename) => {
      if (filename == null) return;
      if (!watchedFiles.has(String(filename))) return;
      invalidateSettingsCache();
      logReloadSummary();
    });

    logger.info('[settings] Memantau perubahan settings.json dan settings.local.json');
  } catch (error) {
    logger.error(`[settings] Error starting settings watcher: ${error.message}`);
  }
}

function saveSettings(newSettings) {
  try {
    const currentSettings = getSettings();
    const updatedSettings = { ...currentSettings, ...newSettings };
    fs.writeFileSync(privateSettingsPath, JSON.stringify(updatedSettings, null, 2), 'utf-8');
    settingsCache = updatedSettings;
    settingsCacheTime = Date.now();
    return true;
  } catch (error) {
    logger.error(`[settings] Error saving ${path.basename(privateSettingsPath)}: ${error.message}`);
    return false;
  }
}

startSettingsWatcher();

module.exports = {
  getSettings,
  getSettingsWithCache,
  getSetting,
  getSettingsByKeys,
  saveSettings,
  startSettingsWatcher,
  getPublicSettingsPath: () => publicSettingsPath,
  getPrivateSettingsPath: () => privateSettingsPath,
  getOperationalSettingsPath
};
