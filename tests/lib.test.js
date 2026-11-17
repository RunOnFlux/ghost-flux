'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../flux/lib');

test('resolveUrl', () => {
  assert.strictEqual(lib.resolveUrl({ url: 'https://blog.example.com/' }, 'ghost1'), 'https://blog.example.com');
  assert.strictEqual(lib.resolveUrl({}, 'Ghost123'), 'https://ghost123.app.runonflux.io');
  assert.strictEqual(lib.resolveUrl({}, null), 'http://localhost:2368');
});

test('ghostEnv: database defaults from the app name, spec wins', () => {
  const e = lib.ghostEnv({ database__connection__password: 'pw', url: '' }, { appName: 'ghost1' });
  assert.strictEqual(e.database__client, 'mysql');
  assert.strictEqual(e.database__connection__host, 'fluxoperator_ghost1');
  assert.strictEqual(e.database__connection__port, '3307');
  assert.strictEqual(e.database__connection__database, 'ghost');
  assert.strictEqual(e.url, 'https://ghost1.app.runonflux.io');
  const f = lib.ghostEnv({ database__connection__password: 'pw', database__connection__host: 'h', database__connection__database: 'x' }, { appName: 'a' });
  assert.strictEqual(f.database__connection__host, 'h');
  assert.strictEqual(f.database__connection__database, 'x');
});

test('ghostEnv: no database configured stays SQLite (local runs)', () => {
  const e = lib.ghostEnv({}, {});
  assert.strictEqual(e.database__client, undefined);
});

test('ghostEnv: logs to stdout, Ghost on loopback', () => {
  const e = lib.ghostEnv({ logging__transports: '["file"]', server__host: '::' }, {});
  assert.strictEqual(e.logging__transports, '["stdout"]');
  assert.strictEqual(e.server__host, '127.0.0.1');
  assert.strictEqual(e.server__port, '2369');
});

test('ghostEnv: device verification follows mail', () => {
  assert.strictEqual(lib.ghostEnv({}, {}).security__staffDeviceVerification, 'false');
  assert.strictEqual(lib.ghostEnv({ mail__transport: 'Direct' }, {}).security__staffDeviceVerification, 'false');
  assert.strictEqual(lib.ghostEnv({ mail__transport: 'SMTP' }, {}).security__staffDeviceVerification, 'true');
  assert.strictEqual(lib.ghostEnv({ mail__transport: 'SMTP', security__staffDeviceVerification: 'false' }, {}).security__staffDeviceVerification, 'false');
});

test('ghostEnv: empty values are unset', () => {
  const e = lib.ghostEnv({ url: '  ', mail__transport: '' }, { appName: 'g' });
  assert.strictEqual(e.url, 'https://g.app.runonflux.io');
  assert.strictEqual(e.mail__transport, undefined);
});

test('forwardedProto', () => {
  assert.strictEqual(lib.forwardedProto('https://x'), 'https');
  assert.strictEqual(lib.forwardedProto('http://x'), 'http');
});

test('ghostEnv: SMTP must be encrypted', () => {
  const plain = lib.ghostEnv({ mail__transport: 'SMTP', mail__options__port: '587' }, {});
  assert.strictEqual(plain.mail__options__requireTLS, 'true');
  const tls = lib.ghostEnv({ mail__transport: 'SMTP', mail__options__secure: 'true', mail__options__port: '465' }, {});
  assert.strictEqual(tls.mail__options__requireTLS, undefined);
  const optOut = lib.ghostEnv({ mail__transport: 'SMTP', mail__options__requireTLS: 'false' }, {});
  assert.strictEqual(optOut.mail__options__requireTLS, 'false');
  assert.strictEqual(lib.ghostEnv({}, {}).mail__options__requireTLS, undefined);
});

test('mailSummary', () => {
  assert.match(lib.mailSummary({}), /not configured/);
  assert.match(lib.mailSummary(lib.ghostEnv({ mail__transport: 'SMTP', mail__options__host: 'h', mail__options__port: '587' }, {})), /STARTTLS required/);
  assert.match(lib.mailSummary({ mail__transport: 'SMTP', mail__options__host: 'h', mail__options__port: '465', mail__options__secure: 'true' }), /, TLS/);
  assert.match(lib.mailSummary({ mail__transport: 'SMTP', mail__options__host: 'h', mail__options__port: '25', mail__options__requireTLS: 'false' }), /UNENCRYPTED.*port 25/);
});

test('hostOf', () => {
  assert.strictEqual(lib.hostOf('1.2.3.4:16137'), '1.2.3.4');
  assert.strictEqual(lib.hostOf('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(lib.hostOf('[::1]:80'), '::1');
  assert.strictEqual(lib.hostOf(''), '');
});

test('roleOf', () => {
  const st = (m, ips) => ({ masterIP: m, clusterStatus: ips.map((ip) => ({ ip })) });
  assert.strictEqual(lib.roleOf(st('1.1.1.1', ['1.1.1.1', '2.2.2.2']), '1.1.1.1'), 'master');
  assert.strictEqual(lib.roleOf(st('1.1.1.1:16127', ['1.1.1.1:16127', '2.2.2.2']), '2.2.2.2'), 'standby');
  assert.strictEqual(lib.roleOf(st('', ['1.1.1.1']), '1.1.1.1'), 'unknown');
  assert.strictEqual(lib.roleOf(null, '1.1.1.1'), 'unknown');
  assert.strictEqual(lib.roleOf(st('1.1.1.1', ['1.1.1.1']), null), 'unknown');
  assert.strictEqual(lib.roleOf(st('9.9.9.9:16137', ['9.9.9.9:16137', '9.9.9.9:16147', '3.3.3.3']), '9.9.9.9'), 'unknown');
  assert.strictEqual(lib.roleOf(st('3.3.3.3', ['9.9.9.9:16137', '9.9.9.9:16147', '3.3.3.3']), '9.9.9.9'), 'unknown');
});

test('roleEnv: a standby runs no background jobs, the master keeps the spec', () => {
  const env = { backgroundJobs__emailAnalytics: 'true', x: '1' };
  assert.strictEqual(lib.roleEnv(env, 'standby').backgroundJobs__emailAnalytics, 'false');
  assert.strictEqual(lib.roleEnv(env, 'standby').emailAnalytics__enabled, 'false');
  assert.strictEqual(lib.roleEnv(env, 'master').backgroundJobs__emailAnalytics, 'true');
  assert.strictEqual(lib.roleEnv({}, 'unknown').backgroundJobs__emailAnalytics, undefined);
});

test('decide: the guards come first', () => {
  const ok = { role: 'standby', stable: true, startedAs: 'standby', booted: true, lockHeld: false, changed: true, sinceRestart: Infinity };
  assert.strictEqual(lib.decide(ok).restart, true);
  assert.strictEqual(lib.decide({ ...ok, booted: false }).restart, false); // the 1.0.0-dev failure
  assert.strictEqual(lib.decide({ ...ok, lockHeld: true }).restart, false);
  assert.strictEqual(lib.decide({ ...ok, lockHeld: null }).restart, false);
  assert.strictEqual(lib.decide({ ...ok, stable: false }).restart, false);
  assert.strictEqual(lib.decide({ ...ok, sinceRestart: 1000 }).restart, false);
  assert.strictEqual(lib.decide({ ...ok, changed: false }).restart, false);
});

test('decide: roles', () => {
  const base = { stable: true, booted: true, lockHeld: false, changed: false, sinceRestart: Infinity };
  assert.match(lib.decide({ ...base, role: 'master', startedAs: 'standby' }).why, /promoted/);
  assert.strictEqual(lib.decide({ ...base, role: 'master', startedAs: 'master', changed: true }).restart, false);
  assert.strictEqual(lib.decide({ ...base, role: 'master', startedAs: 'unknown', changed: true }).restart, false);
  assert.match(lib.decide({ ...base, role: 'standby', startedAs: 'unknown' }).why, /jobs off/);
  assert.match(lib.decide({ ...base, role: 'standby', startedAs: 'master' }).why, /jobs off/);
  assert.strictEqual(lib.decide({ ...base, role: 'unknown', startedAs: 'standby', changed: true }).restart, false);
});

test('warningsOf', () => {
  assert.deepStrictEqual(lib.warningsOf({}, { signupAccess: 'all' }), ['mail-not-configured', 'members-signup-without-mail']);
  assert.deepStrictEqual(lib.warningsOf({}, { signupAccess: 'none' }), ['mail-not-configured']);
  assert.deepStrictEqual(lib.warningsOf({ mail__transport: 'SMTP', mail__options__requireTLS: 'false', mail__options__port: '25' }), ['mail-unencrypted-allowed', 'mail-port-25']);
  assert.deepStrictEqual(lib.warningsOf({ mail__transport: 'SMTP', mail__options__secure: 'true' }, { freeBytes: 5e8, totalBytes: 2e10 }), ['disk-low']);
  assert.deepStrictEqual(lib.warningsOf({ mail__transport: 'SMTP', mail__options__secure: 'true' }, { freeBytes: 1e10, totalBytes: 2e10 }), []);
});

test('backupsToPrune keeps the newest of each kind', () => {
  const f = (n, kind, created) => ({ file: n, kind, created });
  const files = [f('d1', 'database', '2026-01-01'), f('d2', 'database', '2026-01-03'), f('d3', 'database', '2026-01-02'), f('c1', 'content', '2026-01-01')];
  assert.deepStrictEqual(lib.backupsToPrune(files, 2).map((x) => x.file), ['d1']);
  assert.deepStrictEqual(lib.backupsToPrune(files, 1).map((x) => x.file).sort(), ['d1', 'd3']);
});
