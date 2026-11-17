'use strict';

/**
 * Is the database there yet? Uses the mysql2 Ghost itself ships, so the image adds no driver.
 * One `SELECT 1`, no database selected (Ghost creates its own on first boot). Never writes:
 * everything goes through the shared-db operator, which replicates writes to every node.
 */
// eslint-disable-next-line import/no-dynamic-require
const mysql = require('/var/lib/ghost/current/node_modules/mysql2/promise');

async function ping(env) {
  const conn = await mysql.createConnection({
    host: env.database__connection__host,
    port: Number(env.database__connection__port || 3307),
    user: env.database__connection__user || 'root',
    password: env.database__connection__password,
    connectTimeout: 10000,
  });
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    await conn.end().catch(() => {});
  }
}

function connect(env) {
  return mysql.createConnection({
    host: env.database__connection__host,
    port: Number(env.database__connection__port || 3307),
    user: env.database__connection__user || 'root',
    password: env.database__connection__password,
    database: env.database__connection__database || 'ghost',
    connectTimeout: 10000,
  });
}

/**
 * knex-migrator's lock: { locked, ageSeconds } or null when there is no lock table yet (a fresh
 * database). The age is measured by the DATABASE's clock, never this node's.
 */
async function migrationLock(env) {
  let conn;
  try {
    conn = await connect(env);
    const [rows] = await conn.query(
      "SELECT locked, TIMESTAMPDIFF(SECOND, acquired_at, UTC_TIMESTAMP()) AS age FROM migrations_lock WHERE lock_key = 'km01'",
    );
    if (!rows.length) return null;
    return { locked: Number(rows[0].locked) === 1, ageSeconds: Number(rows[0].age) };
  } catch (e) {
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) return null;
    throw e;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * Releases a lock left by a Ghost that was stopped mid-migration. The only write this image
 * ever makes, and only for a lock older than any real migration takes.
 */
async function releaseMigrationLock(env) {
  const conn = await connect(env);
  try {
    await conn.query("UPDATE migrations_lock SET locked = 0, released_at = UTC_TIMESTAMP() WHERE lock_key = 'km01' AND locked = 1");
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * A fingerprint of what Ghost reads once at boot and keeps in memory: its settings and the active
 * theme's custom settings. Null before Ghost has created its tables. Reads only.
 */
async function fingerprint(env) {
  const conn = await connect(env);
  try {
    const hash = require('crypto').createHash('sha256');
    try {
      const [s] = await conn.query('SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM settings');
      hash.update(JSON.stringify(s[0] || {}));
    } catch (e) {
      if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_DB_ERROR')) return null;
      throw e;
    }
    try {
      const [t] = await conn.query('SELECT theme, `key`, value FROM custom_theme_settings ORDER BY id');
      hash.update(JSON.stringify(t));
    } catch (e) {
      if (!(e && e.code === 'ER_NO_SUCH_TABLE')) throw e;
    }
    return hash.digest('hex');
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { ping, migrationLock, releaseMigrationLock, fingerprint };
