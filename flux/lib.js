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

module.exports = { resolveUrl, ghostEnv, mailSummary, forwardedProto };
