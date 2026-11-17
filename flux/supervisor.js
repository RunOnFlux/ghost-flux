'use strict';

/**
 * PID 1 (under tini). Configures Ghost, starts it, opens the public port when it answers, and
 * keeps a standby node ready to take over.
 *
 *  1. URL: on Flux the default is <appName>.app.runonflux.io; the app name comes from FluxOS's
 *     host service (fluxnode.service:16101/hostinfo).
 *  2. nginx gives Ghost the X-Forwarded-Proto Flux's HAProxy does not send, and listens only while
 *     Ghost answers: Flux checks this app with a bare TCP connect.
 *  3. Ghost starts only once the shared-db operator accepts connections, and a migration lock left
 *     by a Ghost stopped mid-migration is released (see clearStaleMigrationLock).
 *  4. ROLE. Flux sends traffic only to the shared-db master's node. Ghost was not written for
 *     several processes on one database: each one caches its settings and theme at boot and runs
 *     its own background jobs. So a standby runs no background jobs and restarts whenever what
 *     Ghost caches has changed (it serves nobody, so that costs nothing), and a node promoted to
 *     master restarts once with its jobs on. The decision is lib.decide; its guards are the
 *     lesson of the first version, which restarted Ghost during its first migration and left the
 *     database locked: never before Ghost has booted, never while a migration lock is held.
 *  5. CONTROL. `flux-ghost restart|hold|release` (the panel) ask through /run/flux/request.json;
 *     the supervisor answers in /run/flux/state.json.
 *
 * Ghost or nginx exiting on its own ends the container: its lifecycle is FluxOS's.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./lib');
const db = require('./db');

const CONTENT = '/var/lib/ghost/content';
const INSTALL = '/var/lib/ghost';
const RUN = '/run/flux';
const REQUEST = path.join(RUN, 'request.json');
const STATE = path.join(RUN, 'state.json');
// Flux stops a container with Docker's default 10 s; a restart we make ourselves can wait longer.
const STOP_MS_ON_EXIT = 9000;
const STOP_MS_ON_RESTART = 30000;
const WATCH_MS = Number(process.env.FLUX_WATCH_SECONDS || 60) * 1000;
const HOLD_MAX_MS = Number(process.env.FLUX_HOLD_MAX_SECONDS || 1800) * 1000;
const WATCH_ON = String(process.env.FLUX_ROLE_WATCH || 'true') !== 'false';

const log = (...a) => console.log(`[flux ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function getJson(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** FluxOS's view of this container: { appName, ip }, or nulls off Flux. */
async function hostInfo() {
  for (let i = 0; i < 3; i += 1) {
    const r = await getJson('http://fluxnode.service:16101/hostinfo');
    if (r && r.status === 'success' && r.data) return { appName: r.data.appName || null, ip: r.data.ip || null };
    if (i < 2) await sleep(3000);
  }
  return { appName: process.env.FLUX_APP_NAME || null, ip: null };
}

// --- state ----------------------------------------------------------------------------------------

const S = {
  env: null,
  host: null,
  ghost: null, // child process
  nginx: null, // child process
  ghostState: 'stopped', // stopped | starting | running | held
  ready: false, // answered 200 since its last start
  startedAs: 'unknown',
  role: 'unknown',
  roleStable: false,
  lastRestartAt: 0,
  holdUntil: 0,
  baseline: null, // fingerprint taken when Ghost first answered after its start
  busy: false, // a restart / hold / release in progress
  stopping: false,
  lastAction: null,
};

function writeState() {
  const st = {
    ghost: S.ghostState,
    ready: S.ready,
    role: S.role,
    startedAs: S.startedAs,
    publicPortOpen: Boolean(S.nginx),
    lastRestartAt: S.lastRestartAt ? new Date(S.lastRestartAt).toISOString() : null,
    holdUntil: S.holdUntil ? new Date(S.holdUntil).toISOString() : null,
    lastAction: S.lastAction,
  };
  try { fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(`${STATE}.tmp`, STATE); } catch { /* best effort */ }
}

// --- processes ------------------------------------------------------------------------------------

function writeNginxConf(env) {
  const tpl = fs.readFileSync('/flux/nginx.conf.template', 'utf8');
  let host = 'localhost';
  try { host = new URL(env.url).host; } catch { /* keep */ }
  const conf = tpl
    .split('__PROTO__').join(lib.forwardedProto(env.url))
    .split('__PUBLIC_PORT__').join(String(process.env.FLUX_PUBLIC_PORT || 2368))
    .split('__GHOST_PORT__').join(String(env.server__port))
    .split('__HOST__').join(host);
  fs.writeFileSync('/etc/nginx/nginx.conf', conf);
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const t = setTimeout(() => { child.kill('SIGKILL'); }, ms);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function shutdown(code, why) {
  if (S.stopping) return;
  S.stopping = true;
  log(`stopping: ${why}`);
  if (S.nginx) { const n = S.nginx; S.nginx = null; n.kill('SIGQUIT'); await waitExit(n, 2000); }
  if (S.ghost) { S.ghost.kill('SIGTERM'); await waitExit(S.ghost, STOP_MS_ON_EXIT); }
  process.exit(code);
}

function openPort() {
  if (S.nginx || S.stopping) return;
  const n = spawn('nginx', ['-g', 'daemon off;'], { stdio: 'inherit' });
  S.nginx = n;
  n.on('exit', (c, s) => { if (S.nginx === n) shutdown(1, `nginx exited (${c ?? s})`); });
  writeState();
}

async function closePort() {
  if (!S.nginx) return;
  const n = S.nginx;
  S.nginx = null; // before the kill: its exit is then not a failure
  n.kill('SIGQUIT');
  await waitExit(n, 5000);
  writeState();
}

function startGhost(role) {
  S.startedAs = role;
  S.ready = false;
  S.baseline = null;
  S.ghostState = 'starting';
  const env = lib.roleEnv(S.env, role);
  log(`starting Ghost ${process.env.GHOST_VERSION} at ${env.url} (${role === 'standby' ? 'standby: background jobs off' : `role ${role}`})`);
  // The official entrypoint: chowns the content to `node`, seeds the default themes, drops root.
  const g = spawn('/usr/local/bin/docker-entrypoint.sh', ['node', 'current/index.js'], { cwd: INSTALL, env, stdio: 'inherit' });
  S.ghost = g;
  g.on('exit', (c, s) => {
    if (S.ghost !== g) return; // stopped on purpose
    S.ghost = null;
    shutdown(c === 0 ? 0 : 1, `Ghost exited (${c ?? s})`);
  });
  writeState();
}

async function stopGhost() {
  if (!S.ghost) return;
  const g = S.ghost;
  S.ghost = null; // before the kill: its exit is then not a failure
  g.kill('SIGTERM');
  await waitExit(g, STOP_MS_ON_RESTART);
  S.ghostState = 'stopped';
  S.ready = false;
  writeState();
}

/** Ghost itself answers 200 on loopback. */
function ghostAnswers() {
  let host = 'localhost';
  try { host = new URL(S.env.url).host; } catch { /* keep */ }
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: Number(S.env.server__port),
      path: '/ghost/api/admin/site/',
      headers: { Host: host, 'X-Forwarded-Proto': lib.forwardedProto(S.env.url) },
      timeout: 5000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// --- database ------------------------------------------------------------------------------------

const hasDb = () => S.env.database__client === 'mysql';

async function waitForDatabase() {
  if (!hasDb()) { log('no MySQL configured: Ghost uses SQLite (local runs only)'); return; }
  const where = `${S.env.database__connection__host}:${S.env.database__connection__port}`;
  for (let i = 0; !S.stopping; i += 1) {
    try { await db.ping(S.env); log(`database ${where} answers`); return; } catch (e) {
      if (i % 6 === 0) log(`waiting for the database ${where}: ${e.code || e.message}`);
      await sleep(5000);
    }
  }
}

/**
 * A Ghost stopped during a migration (FluxOS redeploys or restarts a container at any time, also
 * in the first minute of a new app) leaves knex-migrator's lock taken, and every later start
 * exits with "Migration lock was never released". Measured: Ghost resumes a half-done first
 * initialisation once the lock is released. A FRESH lock may be another node migrating right now
 * (three nodes start together), so it is waited out; only one older than any real migration is
 * released. Override with FLUX_MIGRATION_LOCK_MAX_SECONDS.
 */
async function clearStaleMigrationLock() {
  if (!hasDb()) return;
  const maxAge = Number(process.env.FLUX_MIGRATION_LOCK_MAX_SECONDS || 600);
  for (let i = 0; !S.stopping; i += 1) {
    let lock;
    try { lock = await db.migrationLock(S.env); } catch (e) { log(`migration lock check failed: ${e.code || e.message}`); return; }
    if (!lock || !lock.locked) return;
    if (lock.ageSeconds >= maxAge) {
      log(`migration lock held for ${lock.ageSeconds}s with no migration finishing: releasing it`);
      await db.releaseMigrationLock(S.env);
      return;
    }
    if (i % 6 === 0) log(`a migration holds the lock (${lock.ageSeconds}s); waiting for it, up to ${maxAge}s`);
    await sleep(10000);
  }
}

async function lockHeld() {
  if (!hasDb()) return false;
  try { const l = await db.migrationLock(S.env); return Boolean(l && l.locked); } catch { return null; }
}

/** Theme files and routes/redirects: the other things Ghost loads once. Path + size + mtime. */
function filesFingerprint() {
  const parts = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 8 && e.name !== 'node_modules') walk(p, depth + 1); continue; }
      try { const s = fs.lstatSync(p); parts.push(`${p}:${s.size}:${Math.floor(s.mtimeMs)}`); } catch { /* gone */ }
    }
  };
  walk(path.join(CONTENT, 'themes'), 0);
  walk(path.join(CONTENT, 'settings'), 0);
  parts.sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

async function fingerprint() {
  let d = null;
  if (hasDb()) { try { d = await db.fingerprint(S.env); } catch { return null; } }
  return `${d}|${filesFingerprint()}`;
}

async function currentRole() {
  if (!hasDb() || !S.host.appName) return 'unknown';
  const port = process.env.FLUX_OPERATOR_API_PORT || 7071;
  return lib.roleOf(await getJson(`http://fluxoperator_${S.host.appName}:${port}/status`), S.host.ip);
}

// --- actions ---------------------------------------------------------------------------------------

/** Waits for Ghost to answer, then opens the public port. Gives up if Ghost is replaced or held. */
async function openWhenReady() {
  const g = S.ghost;
  for (let i = 0; !S.stopping && S.ghost === g && g; i += 1) {
    if (await ghostAnswers()) {
      S.ready = true;
      S.ghostState = 'running';
      S.baseline = await fingerprint();
      log('Ghost answers: opening the public port');
      openPort();
      return;
    }
    if (i > 0 && i % 30 === 0) log(`Ghost is not answering yet (${i * 2}s); the public port stays closed`);
    await sleep(2000);
  }
}

async function restart(why, role) {
  S.busy = true;
  try {
    log(`restarting Ghost: ${why}`);
    // Closed first: a node that is not serving must not look healthy to Flux's TCP check.
    await closePort();
    await stopGhost();
    S.lastRestartAt = Date.now();
    startGhost(role);
  } finally {
    S.busy = false;
  }
  openWhenReady();
}

async function handleRequest() {
  let req;
  try { req = JSON.parse(fs.readFileSync(REQUEST, 'utf8')); } catch { return; }
  try { fs.rmSync(REQUEST, { force: true }); } catch { /* gone */ }
  const answer = (ok, message) => { S.lastAction = { id: req.id, action: req.action, ok, message, at: new Date().toISOString() }; writeState(); };
  if (S.busy) { answer(false, 'another action is in progress'); return; }

  if (req.action === 'restart') {
    if (S.ghostState === 'held') { answer(false, 'Ghost is held; release it instead'); return; }
    if (S.ghost && !S.ready) { answer(false, 'Ghost is still starting'); return; }
    if ((await lockHeld()) !== false) { answer(false, 'a database migration holds the lock'); return; }
    await restart(`requested${req.reason ? `: ${req.reason}` : ''}`, S.roleStable ? S.role : S.startedAs);
    answer(true, 'restarted');
  } else if (req.action === 'hold') {
    if (S.ghost && !S.ready) { answer(false, 'Ghost is still starting'); return; }
    S.busy = true;
    try {
      log(`holding Ghost (stopped, port closed)${req.reason ? `: ${req.reason}` : ''}`);
      await closePort();
      await stopGhost();
      S.ghostState = 'held';
      S.holdUntil = Date.now() + HOLD_MAX_MS;
    } finally { S.busy = false; }
    answer(true, 'held');
  } else if (req.action === 'release') {
    if (S.ghostState !== 'held') { answer(false, 'Ghost is not held'); return; }
    S.holdUntil = 0;
    S.busy = true;
    try { S.lastRestartAt = Date.now(); startGhost(S.roleStable ? S.role : 'unknown'); } finally { S.busy = false; }
    openWhenReady();
    answer(true, 'released');
  } else {
    answer(false, `unknown action ${req.action}`);
  }
}

/** Requests every 2 s, the hold's expiry, and the role watch every WATCH_MS. */
async function loop() {
  let lastWatch = Date.now();
  let prevRole = null;
  for (;;) {
    await sleep(2000);
    if (S.stopping) return;
    await handleRequest();
    if (S.ghostState === 'held' && S.holdUntil && Date.now() > S.holdUntil && !S.busy) {
      log('the hold expired: starting Ghost again');
      S.holdUntil = 0;
      S.lastRestartAt = Date.now();
      startGhost(S.roleStable ? S.role : 'unknown');
      openWhenReady();
    }
    if (!WATCH_ON || S.busy || Date.now() - lastWatch < WATCH_MS) continue;
    lastWatch = Date.now();
    if (!hasDb() || !S.ghost) continue;

    const role = await currentRole();
    S.roleStable = role === prevRole;
    if (role !== S.role) log(`role: ${role}`);
    S.role = role;
    prevRole = role;
    let changed = false;
    if (S.ready && role === 'standby') {
      const now = await fingerprint();
      changed = now !== null && S.baseline !== null && now !== S.baseline;
    }
    const verdict = lib.decide({
      role,
      stable: S.roleStable,
      startedAs: S.startedAs,
      booted: S.ready,
      lockHeld: await lockHeld(),
      changed,
      sinceRestart: S.lastRestartAt ? Date.now() - S.lastRestartAt : Infinity,
      minGapMs: Number(process.env.FLUX_MIN_RESTART_GAP_SECONDS || 120) * 1000,
    });
    writeState();
    if (verdict.restart) await restart(verdict.why, role);
  }
}

// --- main -----------------------------------------------------------------------------------------

async function main() {
  log(`ghost-flux ${process.env.FLUX_IMAGE_VERSION} (Ghost ${process.env.GHOST_VERSION})`);
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));

  S.host = await hostInfo();
  if (S.host.appName) log(`Flux app ${S.host.appName}, node ${S.host.ip || 'address unknown'}`);
  S.env = lib.ghostEnv(process.env, { appName: S.host.appName });
  log(`mail: ${lib.mailSummary(S.env)}`);
  fs.mkdirSync(CONTENT, { recursive: true });
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.rmSync(REQUEST, { force: true });
  // What `flux-ghost` (docker exec) reads, so it sees the configuration Ghost was started with.
  fs.writeFileSync(path.join(RUN, 'ghost-env.json'), JSON.stringify(S.env), { mode: 0o600 });
  writeNginxConf(S.env);
  writeState();

  await waitForDatabase();
  await clearStaleMigrationLock();
  if (S.stopping) return;
  // The first role decides only the jobs. A node that cannot tell yet starts like a master
  // (jobs on); if it turns out to be a standby, the watcher restarts it once Ghost has booted.
  S.role = await currentRole();
  startGhost(S.role);
  openWhenReady();
  loop().catch((e) => { log(`control loop stopped: ${e.stack || e}`); });
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
