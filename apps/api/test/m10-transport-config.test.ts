import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test' };
// Configuration parsing only: no database, terminal or broker connection.
for (const mode of [undefined, 'disabled', 'dry-run']) {
  test(`M10 API config ${String(mode)} requires no MT5 credentials`, () => {
    assert.doesNotThrow(() => loadConfig({ ...base, EXECUTION_TRANSPORT_MODE: mode }));
  });
}
for (const runtime of ['test', 'production']) {
  test(`M10 API ${runtime} refuses live opt-in with missing configuration`, () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: runtime, EXECUTION_TRANSPORT_MODE: 'mt5-live' }), /Live MT5 configuration missing/);
  });
  test(`M10 API ${runtime} refuses live opt-in even with complete dummy configuration`, () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: runtime, EXECUTION_TRANSPORT_MODE: 'mt5-live',
      MT5_SERVER: 'dummy', MT5_LOGIN: 'dummy', MT5_PASSWORD: 'dummy', MT5_GATEWAY_URL: 'dummy',
    }), /Live MT5 transport is prohibited in M10/);
  });
}
test('M10 API transport configuration diagnostics do not reflect secret-like invalid input', () => {
  assert.throws(() => loadConfig({ ...base, EXECUTION_TRANSPORT_MODE: 'SENTINEL_SECRET' }), (error: unknown) => {
    assert.match(String(error), /Invalid EXECUTION_TRANSPORT_MODE/);
    assert.doesNotMatch(String(error), /SENTINEL/); return true;
  });
});
