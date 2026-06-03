const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

function normalizeRetentionDays(value, fallback, options = {}) {
  const parsed = Number(value);
  const min = Math.max(1, Number(options.min || 7) || 7);
  const max = Math.max(min, Number(options.max || 3650) || 3650);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function tableExists(tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || ''));
  return Boolean(row?.name);
}

function deleteOlderThan(tableName, createdColumn, days) {
  if (!tableExists(tableName)) {
    return { table: tableName, skipped: true, reason: 'table-missing', changes: 0 };
  }

  const safeTable = `"${String(tableName).replace(/"/g, '""')}"`;
  const safeColumn = `"${String(createdColumn).replace(/"/g, '""')}"`;
  const result = db.prepare(`
    DELETE FROM ${safeTable}
    WHERE ${safeColumn} IS NOT NULL
      AND datetime(${safeColumn}) < datetime('now', ?)
  `).run(`-${days} days`);

  return { table: tableName, skipped: false, days, changes: Number(result.changes || 0) };
}

function runDatabaseLogRetention(options = {}) {
  const enabled = options.force === true || getSetting('database_log_retention_enabled', true);
  if (!enabled) return { success: true, skipped: true, reason: 'disabled', results: [] };

  const jobs = [
    {
      table: 'admin_notifications',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_admin_notifications_days', 60), 60)
    },
    {
      table: 'usage_audit_logs',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_usage_audit_days', 90), 90)
    },
    {
      table: 'webhook_payment_notifs',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_webhook_payment_days', 90), 90)
    },
    {
      table: 'digiflazz_webhook_logs',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_digiflazz_webhook_days', 90), 90)
    },
    {
      table: 'digiflazz_sync_logs',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_digiflazz_sync_days', 90), 90)
    },
    {
      table: 'audit_trail',
      column: 'created_at',
      days: normalizeRetentionDays(getSetting('retention_audit_trail_days', 180), 180, { min: 30 })
    }
  ];

  const results = [];
  for (const job of jobs) {
    try {
      results.push(deleteOlderThan(job.table, job.column, job.days));
    } catch (error) {
      results.push({
        table: job.table,
        skipped: true,
        reason: error.message || String(error),
        changes: 0
      });
    }
  }

  const deleted = results.reduce((sum, item) => sum + Number(item.changes || 0), 0);
  if (deleted > 0 || options.logWhenEmpty === true) {
    logger.info(`[DB Maintenance] Retensi log selesai. Terhapus ${deleted} baris lama.`);
  }

  return { success: true, skipped: false, deleted, results };
}

module.exports = {
  runDatabaseLogRetention
};
