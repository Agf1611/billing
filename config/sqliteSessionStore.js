const session = require('express-session');
const db = require('./database');
const { logger } = require('./logger');

const DEFAULT_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS customer_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires
  ON customer_sessions(expires_at);
`);

const selectSessionStmt = db.prepare(`
  SELECT sess, expires_at
  FROM customer_sessions
  WHERE sid = ?
  LIMIT 1
`);

const upsertSessionStmt = db.prepare(`
  INSERT INTO customer_sessions (sid, sess, expires_at, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(sid) DO UPDATE SET
    sess = excluded.sess,
    expires_at = excluded.expires_at,
    updated_at = CURRENT_TIMESTAMP
`);

const deleteSessionStmt = db.prepare(`
  DELETE FROM customer_sessions
  WHERE sid = ?
`);

const deleteExpiredSessionsStmt = db.prepare(`
  DELETE FROM customer_sessions
  WHERE expires_at <= ?
`);

function resolveExpiryMs(sess, fallbackMaxAgeMs) {
  const cookieMaxAge = Number(sess?.cookie?.maxAge);
  if (Number.isFinite(cookieMaxAge) && cookieMaxAge > 0) {
    return Date.now() + cookieMaxAge;
  }

  const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : 0;
  if (Number.isFinite(cookieExpires) && cookieExpires > 0) {
    return cookieExpires;
  }

  return Date.now() + fallbackMaxAgeMs;
}

class SQLiteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.defaultMaxAgeMs = Number(options.defaultMaxAgeMs) > 0
      ? Number(options.defaultMaxAgeMs)
      : DEFAULT_FALLBACK_MAX_AGE_MS;
    this.cleanupIntervalMs = Number(options.cleanupIntervalMs) > 0
      ? Number(options.cleanupIntervalMs)
      : DEFAULT_CLEANUP_INTERVAL_MS;

    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.pruneExpired();
        } catch (error) {
          logger.warn(`[session-store] Gagal membersihkan session kadaluarsa: ${error.message}`);
        }
      }, this.cleanupIntervalMs);

      if (typeof this.cleanupTimer.unref === 'function') {
        this.cleanupTimer.unref();
      }
    }
  }

  get(sid, callback) {
    try {
      const row = selectSessionStmt.get(String(sid || ''));
      if (!row) return callback(null, null);

      if (Number(row.expires_at || 0) <= Date.now()) {
        deleteSessionStmt.run(String(sid || ''));
        return callback(null, null);
      }

      const parsed = JSON.parse(String(row.sess || '{}'));
      return callback(null, parsed);
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const payload = JSON.stringify(sess || {});
      const expiresAt = resolveExpiryMs(sess, this.defaultMaxAgeMs);
      upsertSessionStmt.run(String(sid || ''), payload, expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }

  destroy(sid, callback = () => {}) {
    try {
      deleteSessionStmt.run(String(sid || ''));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      db.prepare('DELETE FROM customer_sessions').run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback = () => {}) {
    try {
      const row = db.prepare('SELECT COUNT(1) AS count FROM customer_sessions').get();
      callback(null, Number(row?.count || 0));
    } catch (error) {
      callback(error);
    }
  }

  pruneExpired() {
    return deleteExpiredSessionsStmt.run(Date.now());
  }
}

function createSqliteSessionStore(options = {}) {
  return new SQLiteSessionStore(options);
}

module.exports = {
  SQLiteSessionStore,
  createSqliteSessionStore,
};
