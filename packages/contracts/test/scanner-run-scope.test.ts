/**
 * Run-scope contract (`GET /api/scanner/runs?scope=`).
 *
 * The invariants these tests exist to protect:
 *  - `mine` is the default, so a client that never sends `scope` keeps exactly
 *    the behaviour (and the privacy boundary) it had before scopes existed;
 *  - only the three documented values are accepted — the scope is an enum, never
 *    free text that could reach the SQL builder;
 *  - the query stays strict, so an unknown parameter is a 400 rather than a
 *    silently ignored filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCANNER_RUN_SCOPES, scannerRunListQuerySchema } from '../src/index.js';

test('the scope enum is exactly mine | system | all', () => {
  assert.deepEqual([...SCANNER_RUN_SCOPES], ['mine', 'system', 'all']);
});

test('scope defaults to mine so an old client is unaffected', () => {
  const parsed = scannerRunListQuerySchema.safeParse({});
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.scope, 'mine');
    assert.equal(parsed.data.limit, 20);
  }
});

test('every documented scope parses', () => {
  for (const scope of SCANNER_RUN_SCOPES) {
    const parsed = scannerRunListQuerySchema.safeParse({ scope });
    assert.equal(parsed.success, true, scope);
    if (parsed.success) assert.equal(parsed.data.scope, scope);
  }
});

test('an unknown scope is rejected, never coerced', () => {
  for (const scope of ['everything', 'MINE', 'system;--', '']) {
    assert.equal(scannerRunListQuerySchema.safeParse({ scope }).success, false, `scope=${scope}`);
  }
});

test('scope composes with the existing filters without widening them', () => {
  const parsed = scannerRunListQuerySchema.safeParse({ scope: 'all', status: 'failed', limit: '50' });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data, { scope: 'all', status: 'failed', limit: 50 });
  }
  assert.equal(scannerRunListQuerySchema.safeParse({ limit: 101 }).success, false, 'limit cap still applies');
  assert.equal(scannerRunListQuerySchema.safeParse({ scope: 'all', extra: '1' }).success, false, 'strict query');
});
