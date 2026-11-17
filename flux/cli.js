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
 *   info                                 versions, URL, role, mail, database, sizes, counts, warnings
 *   status                               the supervisor's state (role, Ghost running/held, port)
 *   restart [reason]                     restarts Ghost safely (refused mid-boot or mid-migration)
 *   hold [reason] / release              stops Ghost and closes the port / starts it again
 *                                        (a hold expires by itself after 30 minutes)
 *   users list
 *   users reset-password <email> [pw]    generated when omitted; also unlocks a locked user
 *   members signup <all|invite|paid|none>  who may sign up (restarts Ghost: settings are cached)
 *   themes list
 *   db size
 *   db export                            SQL dump into the backups folder
 *   db import <file.sql>                 a dump uploaded to the content volume; Ghost is held
 *                                        while it imports, and restarted after
 *   content backup                       tar.gz of the content folder (no backups, no logs)
 *   content restore <backup.tar.gz>      unpacks a content backup over the content folder (held)
 *   backups list
 *   backups delete <file>
 *
 * Backups live in /var/lib/ghost/content/.flux-backups: on the replicated volume (so a failover
 * keeps them), downloadable through FluxOS's file routes as appdata/.flux-backups/<file>, and never
 * served by Ghost. FLUX_BACKUPS_KEEP (default 5) of each kind are kept; a backup is refused when
 * the volume could not hold it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const lib = require('./lib');

const GHOST = '/var/lib/ghost/current';
const CONTENT = '/var/lib/ghost/content';
const BACKUPS = path.join(CONTENT, '.flux-backups');
const RUN = '/run/flux';
const ENV_FILE = path.join(RUN, 'ghost-env.json');
const KEEP = Math.max(1, Number(process.env.FLUX_BACKUPS_KEEP || 5));
// eslint-disable-next-line import/no-dynamic-require
const mysql = require(`${GHOST}/node_modules/mysql2/promise`);

const out = (data) => { process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`); };
class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function ghostEnv() {
  try { return JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')); } catch { /* not started yet */ }
  return lib.ghostEnv(process.env, {});
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(RUN, 'state.json'), 'utf8')); } catch { return null; }
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

function run(cmd, args, { env, input, timeout = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 1024 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* gone */ }
  }
  return total;
}

function disk() {
  try {
    const s = fs.statfsSync(CONTENT);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch { return { freeBytes: NaN, totalBytes: NaN }; }
}

/** Refuses an operation the volume could not hold, with 20% and 200 MB to spare. */
function ensureSpace(neededBytes, what) {
  const { freeBytes } = disk();
  const need = Math.ceil(neededBytes * 1.2) + 200 * 1024 * 1024;
  if (Number.isFinite(freeBytes) && freeBytes < need) {
    fail(`Not enough disk space for ${what}: about ${Math.round(need / 1048576)} MB needed, ${Math.round(freeBytes / 1048576)} MB free. Delete old backups or move to a bigger plan.`);
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const safeName = (f) => {
  const name = path.basename(String(f || ''));
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) fail(`Not a backup file name: ${f}`);
  return name;
};

function listBackups() {
  let files = [];
  try { files = fs.readdirSync(BACKUPS); } catch { /* none yet */ }
  return files
    .filter((f) => /^ghost-(db|content)-.*\.(sql|tar\.gz)$/.test(f))
    .map((f) => {
      const s = fs.statSync(path.join(BACKUPS, f));
      return { file: f, kind: f.startsWith('ghost-db-') ? 'database' : 'content', bytes: s.size, created: s.mtime.toISOString(), path: `appdata/.flux-backups/${f}` };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

function prune() {
  const gone = lib.backupsToPrune(listBackups(), KEEP);
  for (const f of gone) fs.rmSync(path.join(BACKUPS, f.file), { force: true });
  return gone.map((f) => f.file);
}

/** Asks the supervisor for an action and waits for its answer. */
async function ask(action, reason, timeoutMs = 180000) {
  const st = readState();
  if (!st) fail('The supervisor is not running (no /run/flux/state.json).');
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(RUN, 'request.json.tmp'), JSON.stringify({ id, action, reason }), { mode: 0o600 });
  fs.renameSync(path.join(RUN, 'request.json.tmp'), path.join(RUN, 'request.json'));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(1000);
    const s = readState();
    if (s && s.lastAction && s.lastAction.id === id) {
      if (!s.lastAction.ok) fail(`${action} refused: ${s.lastAction.message}`);
      return s;
    }
  }
  return fail(`${action}: no answer from the supervisor within ${timeoutMs / 1000}s`);
}

/** Holds Ghost around `fn` and always releases it, even when `fn` fails. */
async function withHold(reason, fn) {
  await ask('hold', reason);
  try {
    return await fn();
  } finally {
    await ask('release', reason).catch(() => {}); // the hold also expires by itself
  }
}

// --- commands ---------------------------------------------------------------------------------

async function info() {
  const env = ghostEnv();
  const st = readState();
  const d = disk();
  const data = {
    ghostVersion: process.env.GHOST_VERSION,
    imageVersion: process.env.FLUX_IMAGE_VERSION,
    url: env.url || null,
    role: st ? st.role : null,
    ghost: st ? st.ghost : null,
    mail: env.mail__transport && env.mail__transport !== 'Direct'
      ? { configured: true, summary: lib.mailSummary(env), from: env.mail__from || null }
      : { configured: false },
    staffDeviceVerification: String(env.security__staffDeviceVerification) === 'true',
    contentBytes: dirSize(CONTENT, new Set(['.flux-backups', 'logs'])),
    backupsBytes: dirSize(BACKUPS),
    disk: d,
  };
  try {
    await withDb(async (c) => {
      const one = async (sql) => { const [r] = await c.query(sql); return r[0] || {}; };
      const [s] = await c.query("SELECT `key`, value FROM settings WHERE `key` IN ('title','description','active_theme','members_signup_access','timezone')");
      data.site = Object.fromEntries(s.map((r) => [r.key, r.value]));
      data.counts = {
        posts: Number((await one("SELECT COUNT(*) n FROM posts WHERE type='post' AND status='published'")).n),
        drafts: Number((await one("SELECT COUNT(*) n FROM posts WHERE type='post' AND status='draft'")).n),
        scheduled: Number((await one("SELECT COUNT(*) n FROM posts WHERE status='scheduled'")).n),
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
  data.warnings = lib.warningsOf(env, { signupAccess: data.site && data.site.members_signup_access, ...d });
  out(data);
}

async function status() { out(readState()); }

async function restart(reason) { const s = await ask('restart', reason || 'flux-ghost restart'); out({ restarted: true, state: s }); }
async function hold(reason) { const s = await ask('hold', reason || 'flux-ghost hold'); out({ held: true, until: s.holdUntil }); }
async function release() { await ask('release', 'flux-ghost release'); out({ released: true }); }

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
  // The module Ghost itself hashes staff passwords with.
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

const SIGNUP = ['all', 'invite', 'paid', 'none'];

async function membersSignup(value) {
  if (!SIGNUP.includes(value)) fail(`Usage: members signup <${SIGNUP.join('|')}>`);
  await withDb(async (c) => {
    const [r] = await c.query("UPDATE settings SET value = ?, updated_at = UTC_TIMESTAMP() WHERE `key` = 'members_signup_access'", [value]);
    if (!r.affectedRows) fail('Ghost has no members_signup_access setting yet (finish the setup first).');
  });
  // Ghost caches its settings at boot: the new value is live only after a restart.
  let restarted = false;
  try { await ask('restart', `members signup ${value}`); restarted = true; } catch { /* reported */ }
  out({ members_signup_access: value, restarted });
}

async function themesList() {
  const dir = path.join(CONTENT, 'themes');
  let active = null;
  try { active = await withDb(async (c) => { const [r] = await c.query("SELECT value FROM settings WHERE `key`='active_theme'"); return r[0] ? r[0].value : null; }); } catch { /* db down */ }
  const themes = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'package.json'), 'utf8')); } catch { /* none */ }
    return { name: e.name, version: pkg.version || null, active: e.name === active, builtIn: e.isSymbolicLink() };
  });
  out({ active, themes });
}

async function dbBytes() {
  return withDb(async (c) => {
    const [r] = await c.query('SELECT COALESCE(SUM(data_length + index_length),0) b FROM information_schema.tables WHERE table_schema = DATABASE()');
    return Number(r[0].b);
  });
}

async function dbSize() {
  out(await withDb(async (c) => {
    const [rows] = await c.query('SELECT table_name AS name, (data_length + index_length) AS bytes, table_rows AS `rows` FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY bytes DESC');
    return { bytes: rows.reduce((a, r) => a + Number(r.bytes || 0), 0), tables: rows.length, largest: rows.slice(0, 10) };
  }));
}

function clientArgs(cfg) {
  return ['-h', cfg.host, '-P', String(cfg.port), '-u', cfg.user, '--protocol=TCP', '--skip-ssl', '--default-character-set=utf8mb4'];
}

async function dbExport() {
  const cfg = dbConfig(ghostEnv());
  ensureSpace(await dbBytes(), 'the database export');
  fs.mkdirSync(BACKUPS, { recursive: true });
  const name = `ghost-db-${stamp()}.sql`;
  const file = path.join(BACKUPS, name);
  // The same client wp-cli's `db export` uses in runonflux/wp-nginx (the MariaDB one), so it goes
  // through the shared-db operator the way WordPress's exports already do. Written by the dump
  // itself (--result-file), not buffered here: a large database must not need its size in RAM.
  try {
    await run('mariadb-dump', [...clientArgs(cfg), '--single-transaction', '--skip-lock-tables', '--no-tablespaces', `--result-file=${file}.part`, cfg.database], { env: { MYSQL_PWD: cfg.password } });
  } catch (e) {
    fs.rmSync(`${file}.part`, { force: true });
    throw e;
  }
  fs.renameSync(`${file}.part`, file);
  const pruned = prune();
  out({ file: name, bytes: fs.statSync(file).size, path: `appdata/.flux-backups/${name}`, pruned });
}

function contentPath(given, { ext }) {
  const src = path.resolve(CONTENT, String(given || ''));
  if (!src.startsWith(`${CONTENT}/`) || !fs.existsSync(src) || !fs.statSync(src).isFile()) fail(`No such file on the content volume: ${given}`);
  if (!ext.test(src)) fail(`Wrong file type: ${path.basename(src)}`);
  return src;
}

async function dbImport(given) {
  if (!given) fail('Usage: db import <file.sql>');
  const cfg = dbConfig(ghostEnv());
  const src = contentPath(given, { ext: /\.sql$/i });
  // Out of wherever the upload landed (it may be a served folder) before anything else. Same
  // volume, so a rename; into the folder Ghost never serves.
  fs.mkdirSync(BACKUPS, { recursive: true });
  const work = path.join(BACKUPS, `import-${Date.now()}.sql.part`);
  fs.renameSync(src, work);
  try {
    // Ghost is stopped while its tables are replaced under it, and started after: it caches
    // settings, and a Ghost reading half-imported tables can crash and take the container (and
    // this import) with it.
    await withHold(`db import ${path.basename(src)}`, () => run('mariadb', [...clientArgs(cfg), cfg.database], { env: { MYSQL_PWD: cfg.password }, input: work }));
  } finally {
    fs.rmSync(work, { force: true });
  }
  out({ imported: path.basename(src), restarted: true });
}

async function contentBackup() {
  ensureSpace(dirSize(CONTENT, new Set(['.flux-backups', 'logs'])), 'the content backup');
  fs.mkdirSync(BACKUPS, { recursive: true });
  const name = `ghost-content-${stamp()}.tar.gz`;
  const file = path.join(BACKUPS, name);
  try {
    await run('tar', ['-czf', `${file}.part`, '-C', CONTENT, '--exclude=./.flux-backups', '--exclude=./logs', '.']);
  } catch (e) {
    fs.rmSync(`${file}.part`, { force: true });
    throw e;
  }
  fs.renameSync(`${file}.part`, file);
  const pruned = prune();
  out({ file: name, bytes: fs.statSync(file).size, path: `appdata/.flux-backups/${name}`, pruned });
}

async function contentRestore(given) {
  if (!given) fail('Usage: content restore <ghost-content-....tar.gz>');
  const name = safeName(given);
  const file = path.join(BACKUPS, name);
  if (!/\.tar\.gz$/.test(name) || !fs.existsSync(file)) fail(`No such content backup: ${name}`);
  // Refuse an archive that would write outside the content folder.
  const list = await run('tar', ['-tzf', file]);
  const bad = list.split('\n').filter(Boolean).find((p) => p.startsWith('/') || p.split('/').includes('..'));
  if (bad) fail(`The archive has an unsafe path: ${bad}`);
  ensureSpace(fs.statSync(file).size * 3, 'the restore');
  await withHold(`content restore ${name}`, () => run('tar', ['-xzf', file, '-C', CONTENT, '--no-same-owner']));
  // Files are owned by `node` again at Ghost's start (the official entrypoint chowns them).
  out({ restored: name, restarted: true, note: 'Files added since the backup are kept; files in the backup are restored.' });
}

function backupsList() { out(listBackups()); }

function backupsDelete(f) {
  const name = safeName(f);
  const p = path.join(BACKUPS, name);
  if (!fs.existsSync(p)) fail(`No such backup: ${name}`);
  fs.rmSync(p);
  out({ deleted: name });
}

const COMMANDS = {
  info: () => info(),
  status: () => status(),
  restart: (a) => restart(a.join(' ')),
  hold: (a) => hold(a.join(' ')),
  release: () => release(),
  'users list': () => usersList(),
  'users reset-password': (a) => usersResetPassword(a[0], a[1]),
  'members signup': (a) => membersSignup(a[0]),
  'themes list': () => themesList(),
  'db size': () => dbSize(),
  'db export': () => dbExport(),
  'db import': (a) => dbImport(a[0]),
  'content backup': () => contentBackup(),
  'content restore': (a) => contentRestore(a[0]),
  'backups list': () => backupsList(),
  'backups delete': (a) => backupsDelete(a[0]),
};

async function main(argv) {
  const two = argv.slice(0, 2).join(' ');
  if (COMMANDS[two]) return COMMANDS[two](argv.slice(2));
  if (COMMANDS[argv[0]] && !argv[0].includes(' ')) return COMMANDS[argv[0]](argv.slice(1));
  return fail(`Unknown command. One of: ${Object.keys(COMMANDS).join(', ')}`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: e.message || String(e) })}\n`);
  process.exit(1);
});
