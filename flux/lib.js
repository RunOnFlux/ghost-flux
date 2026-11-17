'use strict';

/**
 * Pure helpers of the supervisor. No side effects at require time, so the unit tests import it.
 */

/** The public URL Ghost is told it lives at. */
function resolveUrl(env, appName) {
  const explicit = String(env.url || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (appName) return `https://${String(appName).toLowerCase()}.app.runonflux.io`;
  return `http://localhost:${env.FLUX_PUBLIC_PORT || 2368}`;
}

const isSet = (v) => v !== undefined && String(v).trim() !== '';

/**
 * The environment Ghost is started with: the customer's and the spec's variables, plus the
 * defaults this image owns. A variable that is already set always wins, so every default can be
 * overridden from the app spec.
 */
function ghostEnv(env, { appName } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (isSet(v)) out[k] = v; // empty = unset (Flux env)
  const def = (k, v) => { if (!isSet(out[k])) out[k] = v; };

  out.url = resolveUrl(out, appName);
  // Ghost listens on loopback only; nginx publishes it (see nginx.conf.template).
  out.server__host = '127.0.0.1';
  out.server__port = String(env.FLUX_GHOST_PORT || 2369);
  // Logs to stdout only: the content folder is replicated between nodes (r:), and three nodes
  // appending to the same replicated log file is a sync conflict every minute.
  out.logging__transports = '["stdout"]';
  def('logging__level', 'info');

  // The database: the operator of this app, exactly where WordPress finds it.
  if (isSet(out.database__connection__host) || isSet(out.database__connection__password)) {
    def('database__client', 'mysql');
    if (appName) def('database__connection__host', `fluxoperator_${appName}`);
    def('database__connection__port', '3307');
    def('database__connection__user', 'root');
    def('database__connection__database', 'ghost');
    def('database__connection__charset', 'utf8mb4');
  }

  // Mail. Ghost's default `Direct` transport delivers from the container itself, which on a Flux
  // node means unauthenticated SMTP from a residential or datacentre IP: rejected or spam. Without
  // an SMTP server configured, transactional mail is off, and so is staff device verification,
  // which would otherwise email a code to the owner at every new-device login and lock them out.
  const hasMail = isSet(out.mail__transport) && out.mail__transport !== 'Direct';
  if (!hasMail) {
    def('security__staffDeviceVerification', 'false');
  } else {
    def('security__staffDeviceVerification', 'true');
  }

  // ENCRYPTED OR NOT AT ALL. nodemailer upgrades a plain SMTP connection with STARTTLS only when
  // the server offers it, and otherwise sends everything, the SMTP login included, in clear text.
  // So unless the connection is TLS from the start (`secure`, port 465), STARTTLS is required:
  // a server that cannot encrypt gets no mail rather than the password. Setting
  // mail__options__requireTLS=false is the explicit, deliberate way out.
  if (/^smtp$/i.test(String(out.mail__transport || ''))
    && String(out.mail__options__secure).toLowerCase() !== 'true') {
    def('mail__options__requireTLS', 'true');
  }
  out.paths__contentPath = '/var/lib/ghost/content';
  out.NODE_ENV = 'production';
  return out;
}

/**
 * One line for the log about how mail leaves this container. Port 25 gets a warning: many
 * providers and node operators block outbound 25, and it is not meant for submission anyway.
 */
function mailSummary(env) {
  const t = String(env.mail__transport || '');
  if (!t || t === 'Direct') return 'not configured (member sign-in, invites and password resets cannot be emailed)';
  const host = env.mail__options__host || env.mail__options__service || '?';
  const port = String(env.mail__options__port || '');
  let tls = 'its own transport';
  if (/^smtp$/i.test(t)) {
    if (String(env.mail__options__secure).toLowerCase() === 'true') tls = 'TLS';
    else if (String(env.mail__options__requireTLS).toLowerCase() === 'true') tls = 'STARTTLS required';
    else tls = 'UNENCRYPTED ALLOWED (mail__options__requireTLS=false)';
  }
  const warn = port === '25' ? '; WARNING: port 25 is often blocked outbound, use 465 or 587' : '';
  return `${t} via ${host}${port ? `:${port}` : ''}, ${tls}${warn}`;
}

/** The protocol nginx forwards to Ghost: the one in Ghost's own URL, or Ghost loops redirecting. */
function forwardedProto(url) {
  return /^https:/i.test(String(url)) ? 'https' : 'http';
}

// --- the node's role ---------------------------------------------------------------------------

/** `ip`, `ip:port` or `[v6]:port` -> the host part. */
function hostOf(addr) {
  const s = String(addr || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'));
  const parts = s.split(':');
  return parts.length === 2 ? parts[0] : s;
}

/**
 * This node's role in the shared-db cluster, from the local operator's /status and FluxOS's
 * address for this node (hostinfo):
 *
 *   'master'   the operator's master is our address, and no other member shares it
 *   'standby'  the operator names another address as master
 *   'unknown'  no answer, no master yet, no address of ours, or our address is shared (several
 *              nodes behind one public IP: the address cannot tell them apart)
 *
 * Flux's domain manager sends a shared-db app's traffic to the master's node only (every other
 * server is HAProxy `backup`), so 'standby' means: serving nobody right now. 'unknown' is treated
 * like 'master' everywhere: never restarted by the image, background jobs on.
 */
function roleOf(status, myIp) {
  const me = hostOf(myIp);
  if (!me || !status || typeof status !== 'object') return 'unknown';
  const master = hostOf(status.masterIP);
  if (!master) return 'unknown';
  const members = Array.isArray(status.clusterStatus) ? status.clusterStatus : [];
  if (members.filter((m) => hostOf(m && m.ip) === me).length > 1) return 'unknown';
  return master === me ? 'master' : 'standby';
}

/**
 * Ghost's background jobs run in EVERY Ghost process: on three nodes, Mailgun's event API would
 * be polled three times and the same counters written three times. A standby runs none of them;
 * the master (or a node that cannot tell) runs Ghost's defaults or whatever the spec set.
 */
const STANDBY_OFF = {
  backgroundJobs__emailAnalytics: 'false',
  backgroundJobs__clickTrackingLastSeenAtUpdater: 'false',
  emailAnalytics__enabled: 'false',
};

function roleEnv(env, role) {
  return role === 'standby' ? { ...env, ...STANDBY_OFF } : { ...env };
}

/**
 * Whether the watcher may restart Ghost now, and why. PURE: every input is passed in.
 *
 *   s.role          role now;  s.stable  true when the same role was seen at the previous check too
 *   s.startedAs     the role Ghost was started with (decides its jobs)
 *   s.booted        Ghost has answered 200 since it was started: its migrations are done
 *   s.lockHeld      knex-migrator's lock is taken (null: could not be read)
 *   s.changed       what Ghost caches at boot (settings, theme settings, theme files) changed
 *   s.sinceRestart  ms since the last restart this image made (Infinity: none)
 *
 * The guards are what the first version lacked (it killed Ghost mid-migration and left the
 * database locked): nothing happens before Ghost has booted, while a migration lock is held or
 * unreadable, on a role seen only once, or within two minutes of the last restart. An 'unknown'
 * role never restarts anything.
 */
const MIN_RESTART_GAP_MS = 120000;

function decide(s) {
  if (!s.booted) return { restart: false, why: 'not booted' };
  if (s.lockHeld !== false) return { restart: false, why: 'migration lock held or unreadable' };
  if (!s.stable || s.role === 'unknown') return { restart: false, why: 'role not settled' };
  if (s.sinceRestart < (s.minGapMs ?? MIN_RESTART_GAP_MS)) return { restart: false, why: 'restarted recently' };
  if (s.role === 'master' && s.startedAs === 'standby') {
    return { restart: true, why: 'promoted to master: background jobs on, fresh settings' };
  }
  if (s.role === 'standby' && s.startedAs !== 'standby') {
    return { restart: true, why: 'standby: background jobs off' };
  }
  if (s.role === 'standby' && s.changed) {
    return { restart: true, why: 'settings or theme changed on the master' };
  }
  return { restart: false, why: 'nothing to do' };
}

/** Warnings the panel shows, from the configuration Ghost runs with and the volume. */
function warningsOf(env, { signupAccess, freeBytes, totalBytes } = {}) {
  const w = [];
  const mail = isSet(env.mail__transport) && env.mail__transport !== 'Direct';
  if (!mail) w.push('mail-not-configured');
  if (!mail && signupAccess && signupAccess !== 'none') w.push('members-signup-without-mail');
  if (mail && /^smtp$/i.test(env.mail__transport) && String(env.mail__options__secure) !== 'true'
    && String(env.mail__options__requireTLS) === 'false') w.push('mail-unencrypted-allowed');
  if (String(env.mail__options__port || '') === '25') w.push('mail-port-25');
  if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0
    && (freeBytes < 1e9 || freeBytes / totalBytes < 0.1)) w.push('disk-low');
  return w;
}

/** Backups to delete so that `keep` of each kind remain, newest kept. */
function backupsToPrune(files, keep) {
  const byKind = {};
  for (const f of files) (byKind[f.kind] = byKind[f.kind] || []).push(f);
  const out = [];
  for (const list of Object.values(byKind)) {
    list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    out.push(...list.slice(Math.max(0, keep)));
  }
  return out;
}

module.exports = {
  resolveUrl,
  ghostEnv,
  mailSummary,
  forwardedProto,
  hostOf,
  roleOf,
  roleEnv,
  decide,
  warningsOf,
  backupsToPrune,
  MIN_RESTART_GAP_MS,
};
