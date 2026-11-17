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
