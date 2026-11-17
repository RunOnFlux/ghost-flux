#!/usr/bin/env node
'use strict';

/**
 * flux-ghost: what the hub's Ghost panel runs inside the container (FluxOS appexec), the way the
 * WordPress panel runs wp-cli. Every command prints ONE JSON document on stdout:
 *
 *   { "ok": true,  "data": ... }
 *   { "ok": false, "error": "..." }          exit code 1
 *
 * Commands
 *   info                               versions, URL, mail, database, sizes, counts
 *   users list                         staff users
 *   users reset-password <email> [pw]  new password (generated when omitted), unlocks the user
 *   themes list                        installed themes and the active one
 *   db size
 *   db export                          SQL dump into the backups folder
 *   db import <file.sql>               a dump uploaded to the content volume (moved out first)
 *   content backup                     tar.gz of the content folder (no backups, no logs)
 *   backups list
 *   backups delete <file>
 *
 * Backups live in /var/lib/ghost/content/.flux-backups: on the replicated volume (so a failover
 * keeps them), downloadable through FluxOS's file routes as appdata/.flux-backups/<file>, and not
 * served by Ghost, which only serves content/images, media, files and public.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const GHOST = '/var/lib/ghost/current';
const CONTENT = '/var/lib/ghost/content';
const BACKUPS = path.join(CONTENT, '.flux-backups');
const ENV_FILE = '/run/flux/ghost-env.json';
// eslint-disable-next-line import/no-dynamic-require
const mysql = require(`${GHOST}/node_modules/mysql2/promise`);

const out = (data) => { process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`); };
class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

function ghostEnv() {
  try { return JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')); } catch { /* not started yet */ }
  return process.env;
}

function dbConfig(env) {
  if (env.database__client !== 'mysql') fail('This Ghost has no MySQL database configured.');
  return {
    host: env.database__connection__host,
    port: Number(env.database__connection__port || 3307),
    user: env.database__connection__user || 'root',
    password: env.database__connection__password,
    database: env.database__connection__database || 'ghost',
  };
}

async function withDb(fn) {
  const conn = await mysql.createConnection({ ...dbConfig(ghostEnv()), connectTimeout: 10000 });
  try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}

function run(cmd, args, { env, input, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout);
    });
    if (input) fs.createReadStream(input).pipe(child.stdin);
  });
}

function dirSize(dir, skip = new Set()) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    } catch { /* gone */ }
  }
  return total;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
const safeName = (f) => {
  const name = path.basename(String(f || ''));
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) fail(`Not a backup file name: ${f}`);
  return name;
};

// --- commands ---------------------------------------------------------------------------------

async function info() {
  const env = ghostEnv();
  const data = {
    ghostVersion: process.env.GHOST_VERSION,
    imageVersion: process.env.FLUX_IMAGE_VERSION,
    url: env.url || null,
    mail: env.mail__transport && env.mail__transport !== 'Direct'
      ? { configured: true, transport: env.mail__transport, host: env.mail__options__host || env.mail__options__service || null, from: env.mail__from || null }
      : { configured: false },
    staffDeviceVerification: String(env.security__staffDeviceVerification) === 'true',
    contentBytes: dirSize(CONTENT, new Set(['.flux-backups', 'logs'])),
    backupsBytes: dirSize(BACKUPS),
  };
  try {
    await withDb(async (c) => {
      const one = async (sql) => { const [r] = await c.query(sql); return r[0] || {}; };
      const s = await c.query("SELECT `key`, value FROM settings WHERE `key` IN ('title','description','active_theme','members_signup_access','timezone')");
      data.site = Object.fromEntries(s[0].map((r) => [r.key, r.value]));
      data.counts = {
        posts: Number((await one("SELECT COUNT(*) n FROM posts WHERE type='post' AND status='published'")).n),
        drafts: Number((await one("SELECT COUNT(*) n FROM posts WHERE type='post' AND status='draft'")).n),
        pages: Number((await one("SELECT COUNT(*) n FROM posts WHERE type='page'")).n),
        members: Number((await one('SELECT COUNT(*) n FROM members')).n),
        paidMembers: Number((await one("SELECT COUNT(*) n FROM members WHERE status IN ('paid','comped')")).n),
        staff: Number((await one("SELECT COUNT(*) n FROM users WHERE status NOT IN ('inactive')")).n),
      };
      data.database = { reachable: true, bytes: Number((await one('SELECT COALESCE(SUM(data_length + index_length),0) b FROM information_schema.tables WHERE table_schema = DATABASE()')).b) };
      // Ghost's own test (authentication setup): the owner exists and is no longer `inactive`.
      data.setupDone = Boolean(Number((await one(
        "SELECT COUNT(*) n FROM users u JOIN roles_users ru ON ru.user_id = u.id JOIN roles r ON r.id = ru.role_id WHERE r.name = 'Owner' AND u.status <> 'inactive'",
      )).n));
    });
  } catch (e) {
    data.database = { reachable: false, error: e.code || e.message };
  }
  out(data);
}

async function usersList() {
  out(await withDb(async (c) => {
    const [rows] = await c.query(
      `SELECT u.id, u.name, u.email, u.status, u.last_seen, r.name AS role
         FROM users u LEFT JOIN roles_users ru ON ru.user_id = u.id LEFT JOIN roles r ON r.id = ru.role_id
        ORDER BY u.created_at`,
    );
    return rows;
  }));
}

async function usersResetPassword(email, given) {
  if (!email) fail('Usage: users reset-password <email> [password]');
  const password = given || crypto.randomBytes(12).toString('base64url');
  if (password.length < 10) fail('Ghost requires at least 10 characters.');
  // eslint-disable-next-line import/no-dynamic-require
  const { password: pw } = require(`${GHOST}/node_modules/@tryghost/security`);
  const hash = await pw.hash(password);
  const changed = await withDb(async (c) => {
    // `locked` is what Ghost sets after too many failed sign-ins; a reset unlocks.
    const [r] = await c.query(
      "UPDATE users SET password = ?, status = IF(status = 'locked', 'active', status), updated_at = UTC_TIMESTAMP() WHERE email = ?",
      [hash, email],
    );
    return r.affectedRows;
  });
  if (!changed) fail(`No staff user with the email ${email}.`);
  out({ email, password, generated: !given });
}

async function themesList() {
  const dir = path.join(CONTENT, 'themes');
  let active = null;
  try { active = await withDb(async (c) => { const [r] = await c.query("SELECT value FROM settings WHERE `key`='active_theme'"); return r[0] ? r[0].value : null; }); } catch { /* db down */ }
  const themes = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'package.json'), 'utf8')); } catch { /* none */ }
    return { name: e.name, version: pkg.version || null, active: e.name === active };
  });
  out({ active, themes });
}

async function dbSize() {
  out(await withDb(async (c) => {
    const [rows] = await c.query('SELECT table_name AS name, (data_length + index_length) AS bytes, table_rows AS `rows` FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY bytes DESC');
    return { bytes: rows.reduce((a, r) => a + Number(r.bytes || 0), 0), tables: rows.length, largest: rows.slice(0, 10) };
  }));
}

function dumpArgs(cfg) {
  return ['-h', cfg.host, '-P', String(cfg.port), '-u', cfg.user, '--protocol=TCP', '--skip-ssl'];
}

async function dbExport() {
  const cfg = dbConfig(ghostEnv());
  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, `ghost-db-${stamp()}.sql`);
  const tmp = `${file}.part`;
  // The same client wp-cli's `db export` uses in runonflux/wp-nginx (the MariaDB one), so it goes
  // through the shared-db operator the way WordPress's exports already do.
  const dump = await run('mariadb-dump', [...dumpArgs(cfg), '--single-transaction', '--skip-lock-tables', '--no-tablespaces', '--routines', '--default-character-set=utf8mb4', cfg.database], { env: { MYSQL_PWD: cfg.password } });
  fs.writeFileSync(tmp, dump);
  fs.renameSync(tmp, file);
  out({ file: path.basename(file), bytes: fs.statSync(file).size, path: `appdata/.flux-backups/${path.basename(file)}` });
}

async function dbImport(given) {
  if (!given) fail('Usage: db import <file.sql>');
  const cfg = dbConfig(ghostEnv());
  // An upload lands somewhere on the content volume. Move it out of any served folder first.
  const src = path.resolve(CONTENT, given);
  if (!src.startsWith(`${CONTENT}/`) || !fs.existsSync(src)) fail(`No such file on the content volume: ${given}`);
  if (!/\.sql$/i.test(src)) fail('Only a .sql file can be imported.');
  // Same volume (a rename cannot cross into /tmp), into the folder Ghost never serves.
  fs.mkdirSync(BACKUPS, { recursive: true });
  const work = path.join(BACKUPS, `import-${Date.now()}.sql.part`);
  fs.renameSync(src, work);
  try {
    await run('mariadb', [...dumpArgs(cfg), '--default-character-set=utf8mb4', cfg.database], { env: { MYSQL_PWD: cfg.password }, input: work });
  } finally {
    fs.rmSync(work, { force: true });
  }
  out({ imported: path.basename(src), restartRequired: true });
}

async function contentBackup() {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const name = `ghost-content-${stamp()}.tar.gz`;
  const file = path.join(BACKUPS, name);
  await run('tar', ['-czf', `${file}.part`, '-C', CONTENT, '--exclude=./.flux-backups', '--exclude=./logs', '.']);
  fs.renameSync(`${file}.part`, file);
  out({ file: name, bytes: fs.statSync(file).size, path: `appdata/.flux-backups/${name}` });
}

function backupsList() {
  let files = [];
  try { files = fs.readdirSync(BACKUPS); } catch { /* none yet */ }
  out(files.filter((f) => !f.endsWith('.part')).map((f) => {
    const s = fs.statSync(path.join(BACKUPS, f));
    return { file: f, kind: f.startsWith('ghost-db-') ? 'database' : 'content', bytes: s.size, created: s.mtime.toISOString(), path: `appdata/.flux-backups/${f}` };
  }).sort((a, b) => b.created.localeCompare(a.created)));
}

function backupsDelete(f) {
  const name = safeName(f);
  const p = path.join(BACKUPS, name);
  if (!fs.existsSync(p)) fail(`No such backup: ${name}`);
  fs.rmSync(p);
  out({ deleted: name });
}

const COMMANDS = {
  info: () => info(),
  'users list': () => usersList(),
  'users reset-password': (a) => usersResetPassword(a[0], a[1]),
  'themes list': () => themesList(),
  'db size': () => dbSize(),
  'db export': () => dbExport(),
  'db import': (a) => dbImport(a[0]),
  'content backup': () => contentBackup(),
  'backups list': () => backupsList(),
  'backups delete': (a) => backupsDelete(a[0]),
};

async function main(argv) {
  const two = argv.slice(0, 2).join(' ');
  const one = argv[0];
  if (COMMANDS[two]) return COMMANDS[two](argv.slice(2));
  if (COMMANDS[one] && one === 'info') return COMMANDS[one](argv.slice(1));
  return fail(`Unknown command. One of: ${Object.keys(COMMANDS).join(', ')}`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: e.message || String(e) })}\n`);
  process.exit(1);
});
