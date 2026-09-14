import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiProxyTarget } from '../vite.config.mjs';

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
