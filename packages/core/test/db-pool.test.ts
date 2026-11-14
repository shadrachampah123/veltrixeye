/**
 * Unit tests for the database connection-pool SSL-mode configuration.
 *
 * These tests exercise `createPool()` purely as a configuration factory: they
 * inspect the options handed to `pg.Pool` and never open a real database
 * connection. The pool constructor is lazy, so `pool.options.ssl` reflects
 * exactly the SSL configuration derived from `DatabaseConfig` without any
 * network activity.
 *
 * Covered behavior:
 *  - `disable`      -> no SSL option at all.
 *  - `require`      -> `rejectUnauthorized: false` (unchanged).
 *  - `verify-full`  -> `rejectUnauthorized: true`.
 *  - `verify-full`  -> supplied CA certificate is passed through.
 *  - missing CA     -> `ca` is omitted entirely (no `ca: undefined`).
 *  - defaults        -> pool size / application_name / connection string
 *                       remain unchanged.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import type pg from 'pg';
import type { ConnectionOptions } from 'node:tls';
import { createPool, type DatabaseConfig } from '../src/db/pool.js';

// A deliberately unreachable address: the pool is lazy and never connects in
// these tests, so this is never dialed. It guards against accidental real
// connections if pool construction ever became eager.
const UNUSED_URL = 'postgres://unused:unused@127.0.0.1:1/unused';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n';

/** Pools created during the suite, ended once after all tests run. */
const created: pg.Pool[] = [];

function makePool(config: Partial<DatabaseConfig> = {}): pg.Pool {
  const pool = createPool({ databaseUrl: UNUSED_URL, ...config });
  created.push(pool);
  return pool;
}

/**
 * Return the pool's ssl object, asserting it is a TLS connection-options
 * object (i.e. not `undefined` and not a boolean).
 */
function sslObject(pool: pg.Pool): ConnectionOptions {
  const ssl = pool.options.ssl;
  assert.ok(
    ssl !== undefined && typeof ssl !== 'boolean',
    'expected a TLS connection-options object for the configured ssl mode',
  );
  return ssl as ConnectionOptions;
}

after(async () => {
  await Promise.all(created.map((pool) => pool.end()));
});

describe('createPool SSL-mode configuration', () => {
  test('disable produces no SSL option', () => {
    const pool = makePool({ sslMode: 'disable' });
    assert.equal(pool.options.ssl, undefined);
  });

  test('require retains rejectUnauthorized: false', () => {
    const pool = makePool({ sslMode: 'require' });
    const ssl = sslObject(pool);
    assert.equal(ssl.rejectUnauthorized, false);
  });

  test('verify-full produces rejectUnauthorized: true', () => {
    const pool = makePool({ sslMode: 'verify-full' });
    const ssl = sslObject(pool);
    assert.equal(ssl.rejectUnauthorized, true);
  });

  test('verify-full passes through a supplied CA certificate (string)', () => {
    const pool = makePool({ sslMode: 'verify-full', ca: CA_PEM });
    const ssl = sslObject(pool);
    assert.equal(ssl.ca, CA_PEM);
  });

  test('verify-full passes through a supplied CA certificate (Buffer)', () => {
    const ca = Buffer.from(CA_PEM, 'utf8');
    const pool = makePool({ sslMode: 'verify-full', ca });
    const ssl = sslObject(pool);
    assert.equal(ssl.ca, ca);
  });

  test('verify-full passes through a supplied CA certificate (array)', () => {
    const ca = [
      CA_PEM,
      Buffer.from('-----BEGIN CERTIFICATE-----\nOTHER\n-----END CERTIFICATE-----\n'),
    ];
    const pool = makePool({ sslMode: 'verify-full', ca });
    const ssl = sslObject(pool);
    assert.equal(ssl.ca, ca);
  });

  test('missing CA does not produce a ca key', () => {
    const pool = makePool({ sslMode: 'verify-full' });
    const ssl = sslObject(pool);
    // `ca` must be omitted entirely, not present as `undefined`.
    assert.equal('ca' in ssl, false);
    assert.equal(ssl.ca, undefined);
  });

  test('existing defaults and options remain unchanged', () => {
    const pool = makePool({ sslMode: 'disable', max: 4 });
    assert.equal(pool.options.connectionString, UNUSED_URL);
    assert.equal(pool.options.application_name, 'veltrixeye');
    assert.equal(pool.options.max, 4);

    // Default pool size is 10 when max is omitted.
    const defaultPool = makePool({ sslMode: 'disable' });
    assert.equal(defaultPool.options.max, 10);

    // require mode still omits ca (CA is only applied for verify-full).
    const requirePool = makePool({ sslMode: 'require', ca: CA_PEM });
    const requireSsl = sslObject(requirePool);
    assert.equal(requireSsl.rejectUnauthorized, false);
    assert.equal('ca' in requireSsl, false);
  });
});
