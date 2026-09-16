import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiProxyTarget, resolveWebPort } from '../vite.config.mjs';

test('development proxy follows the configured local API port', () => {
  assert.equal(resolveApiProxyTarget({ PORT: '43173' }), 'http://127.0.0.1:43173');
  assert.equal(resolveApiProxyTarget({ HOST: 'localhost', PORT: '5000' }), 'http://localhost:5000');
  assert.equal(resolveApiProxyTarget({ HOST: '::1', PORT: '5001' }), 'http://[::1]:5001');
});

test('development proxy rejects non-loopback and invalid port settings', () => {
  assert.throws(() => resolveApiProxyTarget({ HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => resolveApiProxyTarget({ PORT: 'not-a-port' }), /integer between 1 and 65535/);
  assert.throws(() => resolveApiProxyTarget({ PORT: '70000' }), /integer between 1 and 65535/);
});

test('development web port is configurable and validated', () => {
  assert.equal(resolveWebPort({}), 5173);
  assert.equal(resolveWebPort({ WEB_PORT: '55173' }), 55173);
  assert.throws(() => resolveWebPort({ WEB_PORT: 'nope' }), /WEB_PORT/);
  assert.throws(() => resolveWebPort({ WEB_PORT: '65536' }), /WEB_PORT/);
});
