/**
 * Service: Backup & Recovery System
 * Menangani backup database/settings, download file backup,
 * serta restore aman saat aplikasi sedang berjalan.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../config/database');
const { logger } = require('../config/logger');
const {
  getSetting,
  getOperationalSettingsPath,
  getPrivateSettingsPath
} = require('../config/settingsManager');

const projectRoot = path.join(__dirname, '..');
const backupDir = path.join(projectRoot, 'backups');
const dbPath = path.join(projectRoot, 'database', 'billing.db');
const DATABASE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const SETTINGS_EXTENSIONS = new Set(['.json']);
const ESSENTIAL_DATABASE_TABLES = ['customers', 'packages', 'invoices'];

ensureBackupDir();

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    logger.info('[Backup] Created backup directory');
  }
}

function getBackupTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function sanitizeBackupFileName(fileName) {
  const safeName = path.basename(String(fileName || '').trim());
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('Nama file backup tidak valid.');
  }
  return safeName;
}

function resolveBackupFilePath(fileName) {
  const safeName = sanitizeBackupFileName(fileName);
  return path.join(backupDir, safeName);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function getUserTableNames(databaseName = 'main') {
  const rows = db.prepare(
    `SELECT name FROM ${quoteIdentifier(databaseName)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all();
  return rows.map((row) => row.name);
}

function getTableColumns(databaseName, tableName) {
  const stmt = db.prepare(`PRAGMA ${quoteIdentifier(databaseName)}.table_info(${quoteIdentifier(tableName)})`);
  return stmt.all().map((row) => row.name);
}

function classifyBackupFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (String(fileName).startsWith('billing_db_') && DATABASE_EXTENSIONS.has(ext)) {
    return { type: 'database', label: 'Database', restorable: true };
  }
  if (String(fileName).startsWith('settings_') && SETTINGS_EXTENSIONS.has(ext)) {
    return { type: 'settings', label: 'Settings', restorable: true };
  }
  if (String(fileName).startsWith('uploaded_restore_database_') && DATABASE_EXTENSIONS.has(ext)) {
    return { type: 'database', label: 'Database Upload', restorable: true };
  }
  if (String(fileName).startsWith('uploaded_restore_settings_') && SETTINGS_EXTENSIONS.has(ext)) {
    return { type: 'settings', label: 'Settings Upload', restorable: true };
  }
  if (DATABASE_EXTENSIONS.has(ext)) {
    return { type: 'database', label: 'Database', restorable: true };
  }
  if (SETTINGS_EXTENSIONS.has(ext)) {
    return { type: 'settings', label: 'Settings', restorable: true };
  }
  if (ext === '.zip' || ext === '.tar' || ext === '.gz' || ext === '.tgz') {
    return { type: 'archive', label: 'Archive', restorable: false };
  }
  return { type: 'file', label: 'File', restorable: false };
}

function parseBackupTimestamp(timestamp) {
  try {
    const [datePart, timePart] = String(timestamp || '').split('_');
    if (!datePart || !timePart) return null;
    const year = datePart.substring(0, 4);
    const month = datePart.substring(4, 6);
    const day = datePart.substring(6, 8);
    const hours = timePart.substring(0, 2);
    const minutes = timePart.substring(2, 4);
    const seconds = timePart.substring(4, 6);
    return new Date(year, month - 1, day, hours, minutes, seconds);
  } catch (_error) {
    return null;
  }
}

function inferBackupDate(fileName, stats) {
  if (fileName.startsWith('billing_db_')) {
    return parseBackupTimestamp(fileName.replace('billing_db_', '').replace(path.extname(fileName), ''));
  }
  if (fileName.startsWith('settings_')) {
    return parseBackupTimestamp(fileName.replace('settings_', '').replace(path.extname(fileName), ''));
  }
  if (fileName.startsWith('uploaded_restore_database_')) {
    return parseBackupTimestamp(fileName.replace('uploaded_restore_database_', '').split('_').slice(0, 2).join('_'));
  }
  if (fileName.startsWith('uploaded_restore_settings_')) {
    return parseBackupTimestamp(fileName.replace('uploaded_restore_settings_', '').split('_').slice(0, 2).join('_'));
  }
  return stats.birthtime || stats.mtime || null;
}

async function backupDatabase() {
  try {
    ensureBackupDir();
    const timestamp = getBackupTimestamp();
    const backupFileName = `billing_db_${timestamp}.db`;
    const backupFilePath = path.join(backupDir, backupFileName);

    db.pragma('wal_checkpoint(TRUNCATE)');
    await db.backup(backupFilePath);

    const stats = fs.statSync(backupFilePath);
    logger.info(`[Backup] Database backup created: ${backupFileName} (${Math.round(stats.size / 1024)} KB)`);

    return {
      success: true,
      type: 'database',
      fileName: backupFileName,
      filePath: backupFilePath,
      size: stats.size,
      sizeKB: Math.round(stats.size / 1024),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`[Backup] Failed to backup database: ${error.message}`);
    return { success: false, type: 'database', error: error.message };
  }
}

function backupSettings() {
  try {
    ensureBackupDir();
    const timestamp = getBackupTimestamp();
    const backupFileName = `settings_${timestamp}.json`;
    const backupFilePath = path.join(backupDir, backupFileName);
    const settingsPath = getOperationalSettingsPath();

    fs.copyFileSync(settingsPath, backupFilePath);
    const stats = fs.statSync(backupFilePath);
    logger.info(`[Backup] Settings backup created: ${backupFileName} (${Math.round(stats.size / 1024)} KB)`);

    return {
      success: true,
      type: 'settings',
      fileName: backupFileName,
      filePath: backupFilePath,
      size: stats.size,
      sizeKB: Math.round(stats.size / 1024),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`[Backup] Failed to backup settings: ${error.message}`);
    return { success: false, type: 'settings', error: error.message };
  }
}

async function backupAll() {
  const database = await backupDatabase();
  const settings = backupSettings();
  return {
    success: database.success && settings.success,
    type: 'all',
    database,
    settings,
    timestamp: new Date().toISOString()
  };
}

function validateDatabaseFile(filePath) {
  let probeDb;
  try {
    probeDb = new Database(filePath, { readonly: true, fileMustExist: true });
    const rows = probeDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const tables = rows.map((row) => row.name);
    const missingTables = ESSENTIAL_DATABASE_TABLES.filter((name) => !tables.includes(name));
    if (missingTables.length) {
      throw new Error(`Backup database tidak cocok. Tabel penting hilang: ${missingTables.join(', ')}`);
    }
    return { success: true, tables };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (probeDb) {
      try { probeDb.close(); } catch (_error) {}
    }
  }
}

function validateSettingsContent(rawText) {
  try {
    const parsed = JSON.parse(String(rawText || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Isi settings harus berupa objek JSON.');
    }
    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: `File settings tidak valid: ${error.message}` };
  }
}

async function restoreDatabaseFromFilePath(filePath, sourceLabel) {
  const validation = validateDatabaseFile(filePath);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  const preRestoreBackup = await backupDatabase();
  if (!preRestoreBackup.success) {
    logger.warn('[Backup] Failed to create pre-restore backup');
  }

  const attachedName = `restore_source_${Date.now()}`;
  let attached = false;

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('foreign_keys = OFF');
    db.prepare(`ATTACH DATABASE ? AS ${quoteIdentifier(attachedName)}`).run(filePath);
    attached = true;

    const sourceTables = getUserTableNames(attachedName);
    const targetTables = getUserTableNames('main');
    const sharedTables = targetTables.filter((tableName) => sourceTables.includes(tableName));

    if (!sharedTables.length) {
      throw new Error('Tidak ada tabel yang bisa dipulihkan dari file database ini.');
    }

    const restoreTransaction = db.transaction(() => {
      for (const tableName of sharedTables) {
        db.prepare(`DELETE FROM ${quoteIdentifier(tableName)}`).run();
      }

      for (const tableName of sharedTables) {
        const targetColumns = getTableColumns('main', tableName);
        const sourceColumns = getTableColumns(attachedName, tableName);
        const commonColumns = targetColumns.filter((column) => sourceColumns.includes(column));
        if (!commonColumns.length) continue;

        const quotedColumns = commonColumns.map((column) => quoteIdentifier(column)).join(', ');
        db.prepare(
          `INSERT INTO ${quoteIdentifier(tableName)} (${quotedColumns})
           SELECT ${quotedColumns} FROM ${quoteIdentifier(attachedName)}.${quoteIdentifier(tableName)}`
        ).run();
      }

      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyViolations.length) {
        throw new Error('Restore dibatalkan karena data backup tidak konsisten dengan relasi database.');
      }
    });

    restoreTransaction();

    if (attached) {
      db.prepare(`DETACH DATABASE ${quoteIdentifier(attachedName)}`).run();
      attached = false;
    }
    db.pragma('foreign_keys = ON');

    const stats = fs.statSync(filePath);
    logger.info(`[Backup] Database restored from: ${sourceLabel} (${Math.round(stats.size / 1024)} KB)`);

    return {
      success: true,
      type: 'database',
      fileName: path.basename(filePath),
      sourceLabel,
      size: stats.size,
      sizeKB: Math.round(stats.size / 1024),
      timestamp: new Date().toISOString(),
      preRestoreBackup: preRestoreBackup.fileName,
      restoredTables: sharedTables.length
    };
  } catch (error) {
    try {
      if (attached) db.prepare(`DETACH DATABASE ${quoteIdentifier(attachedName)}`).run();
    } catch (_detachError) {
      /* ignore detach cleanup error */
    }
    try {
      db.pragma('foreign_keys = ON');
    } catch (_pragmaError) {
      /* ignore pragma cleanup error */
    }
    logger.error(`[Backup] Failed to restore database: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function restoreDatabase(backupFileName) {
  try {
    const backupFilePath = resolveBackupFilePath(backupFileName);
    if (!fs.existsSync(backupFilePath)) {
      return { success: false, error: `Backup file not found: ${backupFileName}` };
    }
    return await restoreDatabaseFromFilePath(backupFilePath, sanitizeBackupFileName(backupFileName));
  } catch (error) {
    logger.error(`[Backup] Failed to restore database: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function restoreSettingsFromFilePath(filePath, sourceLabel) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const validation = validateSettingsContent(raw);
    if (!validation.success) {
      return { success: false, error: validation.error };
    }

    const preRestoreBackup = backupSettings();
    if (!preRestoreBackup.success) {
      logger.warn('[Backup] Failed to create pre-restore settings backup');
    }

    const targetSettingsPath = getPrivateSettingsPath();
    fs.writeFileSync(targetSettingsPath, JSON.stringify(validation.data, null, 2), 'utf8');
    const stats = fs.statSync(targetSettingsPath);
    logger.info(`[Backup] Settings restored from: ${sourceLabel} (${Math.round(stats.size / 1024)} KB)`);

    return {
      success: true,
      type: 'settings',
      fileName: path.basename(filePath),
      sourceLabel,
      size: stats.size,
      sizeKB: Math.round(stats.size / 1024),
      timestamp: new Date().toISOString(),
      preRestoreBackup: preRestoreBackup.fileName
    };
  } catch (error) {
    logger.error(`[Backup] Failed to restore settings: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function restoreSettings(backupFileName) {
  try {
    const backupFilePath = resolveBackupFilePath(backupFileName);
    if (!fs.existsSync(backupFilePath)) {
      return { success: false, error: `Backup file not found: ${backupFileName}` };
    }
    return restoreSettingsFromFilePath(backupFilePath, sanitizeBackupFileName(backupFileName));
  } catch (error) {
    logger.error(`[Backup] Failed to restore settings: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function storeUploadedRestoreFile(file, declaredType) {
  ensureBackupDir();
  if (!file || !file.buffer || !file.originalname) {
    return { success: false, error: 'File restore belum dipilih.' };
  }

  const normalizedType = declaredType === 'settings' ? 'settings' : 'database';
  const originalExt = path.extname(file.originalname || '').toLowerCase();
  const allowedExtensions = normalizedType === 'database' ? DATABASE_EXTENSIONS : SETTINGS_EXTENSIONS;
  if (!allowedExtensions.has(originalExt)) {
    const expected = normalizedType === 'database' ? '.db / .sqlite / .sqlite3' : '.json';
    return { success: false, error: `File ${normalizedType} harus berformat ${expected}.` };
  }

  const validation = normalizedType === 'database'
    ? (() => {
        const tempProbePath = path.join(backupDir, `__probe_${Date.now()}${originalExt}`);
        try {
          fs.writeFileSync(tempProbePath, file.buffer);
          return validateDatabaseFile(tempProbePath);
        } finally {
          if (fs.existsSync(tempProbePath)) fs.unlinkSync(tempProbePath);
        }
      })()
    : validateSettingsContent(file.buffer.toString('utf8'));

  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  const safeBaseName = path.basename(file.originalname, originalExt).replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'backup';
  const prefix = normalizedType === 'database' ? 'uploaded_restore_database' : 'uploaded_restore_settings';
  const savedFileName = `${prefix}_${getBackupTimestamp()}_${safeBaseName}${originalExt}`;
  const savedFilePath = path.join(backupDir, savedFileName);
  fs.writeFileSync(savedFilePath, file.buffer);
  const stats = fs.statSync(savedFilePath);

  return {
    success: true,
    type: normalizedType,
    fileName: savedFileName,
    filePath: savedFilePath,
    size: stats.size,
    sizeKB: Math.round(stats.size / 1024)
  };
}

async function importAndRestore(file, declaredType) {
  const saved = storeUploadedRestoreFile(file, declaredType);
  if (!saved.success) return saved;
  if (saved.type === 'database') {
    const restored = await restoreDatabaseFromFilePath(saved.filePath, saved.fileName);
    return { ...restored, uploadedFileName: saved.fileName };
  }
  const restored = restoreSettingsFromFilePath(saved.filePath, saved.fileName);
  return { ...restored, uploadedFileName: saved.fileName };
}

function listBackups() {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(backupDir);
    const backups = files.map((fileName) => {
      const filePath = path.join(backupDir, fileName);
      const stats = fs.statSync(filePath);
      const meta = classifyBackupFile(fileName);
      return {
        fileName,
        filePath,
        type: meta.type,
        typeLabel: meta.label,
        restorable: meta.restorable,
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
        created: stats.birthtime,
        createdDate: inferBackupDate(fileName, stats),
        modified: stats.mtime
      };
    });

    backups.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return { success: true, backups, total: backups.length };
  } catch (error) {
    logger.error(`[Backup] Failed to list backups: ${error.message}`);
    return { success: false, error: error.message, backups: [], total: 0 };
  }
}

function deleteBackup(backupFileName) {
  try {
    const backupFilePath = resolveBackupFilePath(backupFileName);
    if (!fs.existsSync(backupFilePath)) {
      return { success: false, error: 'File backup tidak ditemukan' };
    }
    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${path.basename(backupFilePath)}`);
    return { success: true, fileName: path.basename(backupFilePath) };
  } catch (error) {
    logger.error(`[Backup] Failed to delete backup: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function cleanupOldBackups(retentionDays = 30) {
  try {
    const result = listBackups();
    if (!result.success) return result;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;
    const deletedFiles = [];
    for (const backup of result.backups) {
      if (new Date(backup.created) < cutoffDate) {
        fs.unlinkSync(path.join(backupDir, backup.fileName));
        deletedCount += 1;
        deletedFiles.push(backup.fileName);
        logger.info(`[Backup] Deleted old backup: ${backup.fileName}`);
      }
    }

    return { success: true, deletedCount, deletedFiles, retentionDays };
  } catch (error) {
    logger.error(`[Backup] Failed to cleanup old backups: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function checkBackupCapacity(maxSizeMB = 500) {
  try {
    const result = listBackups();
    if (!result.success) return result;

    let totalSizeMB = result.backups.reduce((sum, backup) => sum + backup.size, 0) / (1024 * 1024);

    if (totalSizeMB > maxSizeMB) {
      logger.warn(`[Backup] Backup size (${totalSizeMB.toFixed(2)} MB) exceeds limit (${maxSizeMB} MB)`);
      const sortedBackups = [...result.backups].sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
      let deletedCount = 0;

      for (const backup of sortedBackups) {
        if (totalSizeMB <= maxSizeMB * 0.8) break;
        fs.unlinkSync(path.join(backupDir, backup.fileName));
        totalSizeMB -= backup.size / (1024 * 1024);
        deletedCount += 1;
        logger.info(`[Backup] Deleted backup for capacity: ${backup.fileName}`);
      }

      return {
        success: true,
        action: 'cleanup',
        deletedCount,
        totalSizeMB: totalSizeMB.toFixed(2),
        maxSizeMB
      };
    }

    return {
      success: true,
      action: 'none',
      totalSizeMB: totalSizeMB.toFixed(2),
      maxSizeMB
    };
  } catch (error) {
    logger.error(`[Backup] Failed to check backup capacity: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function normalizeBackupRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.max(1, Math.min(365, Math.floor(parsed)));
}

function normalizeBackupCapacityMB(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.max(100, Math.min(10240, Math.floor(parsed)));
}

function runScheduledBackupMaintenance() {
  const retentionDays = normalizeBackupRetentionDays(getSetting('auto_backup_retention_days', 30));
  const maxSizeMB = normalizeBackupCapacityMB(getSetting('auto_backup_max_size_mb', 500));

  const retention = cleanupOldBackups(retentionDays);
  if (retention.success && Number(retention.deletedCount || 0) > 0) {
    logger.info(`[Backup] Scheduled cleanup removed ${retention.deletedCount} old backup(s), retention=${retentionDays} days`);
  }

  const capacity = checkBackupCapacity(maxSizeMB);
  if (capacity.success && capacity.action === 'cleanup') {
    logger.info(`[Backup] Scheduled capacity cleanup removed ${capacity.deletedCount} backup(s), total=${capacity.totalSizeMB}MB, max=${maxSizeMB}MB`);
  }
}

function scheduleAutoBackup() {
  const nodeCron = require('node-cron');
  const enabled = getSetting('auto_backup_enabled', true);
  const schedule = getSetting('auto_backup_schedule', '0 2 * * *');

  if (!enabled) {
    logger.info('[Backup] Auto backup disabled');
    return;
  }

  nodeCron.schedule(schedule, async () => {
    logger.info('[Backup] Starting scheduled backup...');
    const result = await backupAll();
    if (result.success) {
      logger.info('[Backup] Scheduled backup completed successfully');
      runScheduledBackupMaintenance();
    } else {
      logger.error('[Backup] Scheduled backup failed');
    }
  });

  logger.info(`[Backup] Auto backup scheduled: ${schedule}`);
}

module.exports = {
  backupDatabase,
  backupSettings,
  backupAll,
  restoreDatabase,
  restoreSettings,
  importAndRestore,
  storeUploadedRestoreFile,
  listBackups,
  deleteBackup,
  cleanupOldBackups,
  checkBackupCapacity,
  scheduleAutoBackup,
  classifyBackupFile,
  getBackupDirectory: () => backupDir,
  getBackupFilePath: resolveBackupFilePath,
  validateDatabaseFile,
  validateSettingsContent
};
