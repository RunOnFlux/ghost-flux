'use strict';

/**
 * PID 1 (under tini). Prepares Ghost's configuration, starts nginx and Ghost, and nothing more.
 *
 * Why a supervisor and not the official entrypoint alone:
 *
 *  1. Ghost must be told its URL, and on Flux the default one is <appName>.app.runonflux.io; the
 *     app name comes from FluxOS's host service (fluxnode.service:16101/hostinfo).
 *  2. nginx must sit in front to give Ghost the X-Forwarded-Proto Flux's HAProxy does not send.
 *  3. Ghost must not start before the shared-db operator accepts connections: on a fresh app the
 *     cluster takes minutes to form, and Ghost exits on its first refused query.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: restart Ghost on its own. The container's lifecycle is
 * FluxOS's. When Ghost or nginx exits, the container exits and FluxOS restarts it. A supervisor
 * that restarted Ghost itself was tried (1.0.0-dev): it killed Ghost during its first database
 * migration, knex-migrator's lock stayed taken in the database, and no later start could boot.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const lib = require('./lib');
const db = require('./db');

const CONTENT = '/var/lib/ghost/content';
const INSTALL = '/var/lib/ghost';
// Ghost needs time to finish what it is writing (a migration, an upload) before it is killed.
// Flux stops containers with Docker's default 10 s, so this is the most it ever gets there.
const GHOST_STOP_MS = 9000;

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

let ghost = null;
let nginx = null;
let stopping = false;

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
  if (stopping) return;
  stopping = true;
  log(`stopping: ${why}`);
  if (ghost) { ghost.kill('SIGTERM'); await waitExit(ghost, GHOST_STOP_MS); }
  if (nginx) { nginx.kill('SIGQUIT'); await waitExit(nginx, 2000); }
  process.exit(code);
}

function startNginx() {
  nginx = spawn('nginx', ['-g', 'daemon off;'], { stdio: 'inherit' });
  nginx.on('exit', (c, s) => shutdown(1, `nginx exited (${c ?? s})`));
}

function startGhost(env) {
  log(`starting Ghost ${process.env.GHOST_VERSION} at ${env.url}`);
  // The official entrypoint: chowns the content to `node`, seeds the default themes, drops root.
  ghost = spawn('/usr/local/bin/docker-entrypoint.sh', ['node', 'current/index.js'], {
    cwd: INSTALL, env, stdio: 'inherit',
  });
  ghost.on('exit', (c, s) => shutdown(c === 0 ? 0 : 1, `Ghost exited (${c ?? s})`));
}

async function waitForDatabase(env) {
  if (env.database__client !== 'mysql') {
    log('no MySQL configured: Ghost uses SQLite (local runs only)');
    return;
  }
  const host = `${env.database__connection__host}:${env.database__connection__port}`;
  for (let i = 0; !stopping; i += 1) {
    try {
      await db.ping(env);
      log(`database ${host} answers`);
      return;
    } catch (e) {
      if (i % 6 === 0) log(`waiting for the database ${host}: ${e.code || e.message}`);
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
async function clearStaleMigrationLock(env) {
  if (env.database__client !== 'mysql') return;
  const maxAge = Number(process.env.FLUX_MIGRATION_LOCK_MAX_SECONDS || 600);
  for (let i = 0; !stopping; i += 1) {
    let lock;
    try { lock = await db.migrationLock(env); } catch (e) { log(`migration lock check failed: ${e.code || e.message}`); return; }
    if (!lock || !lock.locked) return;
    if (lock.ageSeconds >= maxAge) {
      log(`migration lock held for ${lock.ageSeconds}s with no migration finishing: releasing it`);
      await db.releaseMigrationLock(env);
      return;
    }
    if (i % 6 === 0) log(`a migration holds the lock (${lock.ageSeconds}s); waiting for it, up to ${maxAge}s`);
    await sleep(10000);
  }
}

/**
 * Resolves once Ghost itself answers 200 on loopback.
 *
 * nginx must not listen before this. Flux's domain manager checks a non-WordPress app with a bare
 * TCP connect (no `healthcheck` in its custom.js), and for a shared-db app it sends traffic to the
 * master's node only. An nginx that accepts while Ghost is still booting reads as healthy, so
 * visitors get "starting" instead of being served by a standby. A closed port fails the check and
 * HAProxy moves to the backup.
 */
function ghostAnswers(env) {
  let host = 'localhost';
  try { host = new URL(env.url).host; } catch { /* keep */ }
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: Number(env.server__port),
      path: '/ghost/api/admin/site/',
      headers: { Host: host, 'X-Forwarded-Proto': lib.forwardedProto(env.url) },
      timeout: 5000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function startNginxWhenGhostAnswers(env) {
  for (let i = 0; !stopping; i += 1) {
    if (await ghostAnswers(env)) {
      log('Ghost answers: opening the public port');
      startNginx();
      return;
    }
    if (i > 0 && i % 30 === 0) log(`Ghost is not answering yet (${i * 2}s); the public port stays closed`);
    await sleep(2000);
  }
}

async function main() {
  log(`ghost-flux ${process.env.FLUX_IMAGE_VERSION} (Ghost ${process.env.GHOST_VERSION})`);
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));

  const host = await hostInfo();
  if (host.appName) log(`Flux app ${host.appName}, node ${host.ip || 'address unknown'}`);
  const env = lib.ghostEnv(process.env, { appName: host.appName });
  log(`mail: ${lib.mailSummary(env)}`);
  fs.mkdirSync(CONTENT, { recursive: true });
  // What `flux-ghost` (docker exec) reads, so it sees the configuration Ghost was started with.
  fs.mkdirSync('/run/flux', { recursive: true, mode: 0o700 });
  fs.writeFileSync('/run/flux/ghost-env.json', JSON.stringify(env), { mode: 0o600 });

  writeNginxConf(env);
  await waitForDatabase(env);
  await clearStaleMigrationLock(env);
  if (stopping) return;
  startGhost(env);
  await startNginxWhenGhostAnswers(env);
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
