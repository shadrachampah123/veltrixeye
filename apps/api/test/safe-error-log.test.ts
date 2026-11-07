/**
 * Unit tests for the API's safe error-logging module.
 *
 * These pin the two properties the security fix depends on:
 *  1. no credential — configured or merely credential-SHAPED — survives
 *     redaction, and
 *  2. an exception object is projected into a bounded, allow-listed
 *     structure, so its stack and every other property are dropped.
 *
 * The integration test in `billing-payment-records.test.ts` exercises the
 * real route and captures the real log sink; this file pins the scrubber
 * itself, including shapes that route cannot produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOGGED_ERROR_CHARS,
  REDACTED,
  configuredSecrets,
  describeErrorForLog,
  logErrorSafely,
  redactSensitiveText,
} from '../src/safe-error-log.js';
import { loadConfig } from '../src/config.js';

const SK_TEST = 'sk_test_0123456789abcdef0123456789abcdef01234567';
/**
 * A synthetic live-mode key shape, assembled at runtime: GitHub push
 * protection matches the literal `sk_live_…` string, and this fixture is not a
 * credential. Joining the parts keeps the scanner out of the way while the
 * value the scrubber has to catch is exactly the same.
 */
const SK_LIVE = ['sk', 'live', '89abcdef0123456789abcdef0123456789abcdef'].join('_');
const AUTH_CODE = 'AUTH_0123456789abcdef0123456789abcdef';
const DB_PASSWORD = 'sup3rs3cr3t';
const CONNECTION_STRING = `postgres://veltrix:${DB_PASSWORD}@db.internal.veltrixeye.internal:5432/veltrix`;
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const OPAQUE_SECRET = 'VeltrixEye-Opaque-Configured-Secret-42';
const RESEND_API_KEY = 'resend-secret-value-for-redaction-test';

function text(...parts: string[]): string {
  return parts.join(' ');
}

/** Escape a literal for use inside a `RegExp` (`[redacted]` has metacharacters). */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every credential shape a leak could take, in one string. */
function everyCredentialShape(): string {
  return text(
    'read failed',
    SK_TEST,
    SK_LIVE,
    `authorization_code=${AUTH_CODE}`,
    `connecting to ${CONNECTION_STRING}`,
    `Authorization: Bearer ${JWT}`,
    'password=hunter2-hunter2',
    'api_key: "abc123def456"',
    'AKIAIOSFODNN7EXAMPLE',
    OPAQUE_SECRET,
  );
}

test('redactSensitiveText removes every credential shape from one message', () => {
  const out = redactSensitiveText(everyCredentialShape(), [OPAQUE_SECRET]);

  for (const secret of [SK_TEST, SK_LIVE, AUTH_CODE, DB_PASSWORD, JWT, OPAQUE_SECRET]) {
    assert.ok(!out.includes(secret), `log must not contain ${secret.slice(0, 12)}…`);
  }
  assert.doesNotMatch(out, /sk_(?:test|live)_[A-Za-z0-9]{8,}/i);
  assert.doesNotMatch(out, /AUTH_[0-9a-f]{10,}/i);
  assert.doesNotMatch(out, /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i);
  assert.doesNotMatch(out, /postgres:\/\/[^/\s@]*:[^/\s@]*@/i);
  // A credential pair is either gone or carries only the placeholder value.
  assert.doesNotMatch(out, new RegExp(`(?:password|api[_-]?key)\\s*[=:]\\s*(?!${literal(REDACTED)})\\S+`, 'i'));
  assert.doesNotMatch(out, /AKIA[0-9A-Z]{16}/);
  assert.ok(!out.includes('hunter2-hunter2'));
  assert.ok(!out.includes('abc123def456'));

  // Redaction is visible, and ordinary diagnostic text survives it.
  assert.ok(out.includes(REDACTED));
  assert.match(out, /read failed/);
  assert.match(out, /db\.internal\.veltrixeye\.internal:5432/, 'the host stays for diagnosis');
});

test('redactSensitiveText redacts a PEM private-key block', () => {
  const pem = [
    'tls init failed -----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAx7y8QpQ2Vv6p9m1nQ0pQ2Vv6p9m1nQ0pQ2Vv6p9m1nQ0pQ2',
    '-----END RSA PRIVATE KEY----- after 2 attempts',
  ].join('\n');
  const out = redactSensitiveText(pem);
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'));
  assert.ok(!out.includes('BEGIN RSA PRIVATE KEY'));
  assert.match(out, /tls init failed/);
  assert.match(out, /after 2 attempts/);
});

test('redactSensitiveText leaves ordinary error text alone', () => {
  const ordinary = 'connect ECONNREFUSED 127.0.0.1:5432 — relation "billing_verified_transactions" does not exist';
  assert.equal(redactSensitiveText(ordinary, [OPAQUE_SECRET]), ordinary);
  assert.equal(redactSensitiveText('', []), '');
});

test('redactSensitiveText removes configured secrets that match no known shape', () => {
  const message = `provider answered 401 for key ${OPAQUE_SECRET} (mode test)`;
  assert.equal(
    redactSensitiveText(message, [OPAQUE_SECRET]),
    `provider answered 401 for key ${REDACTED} (mode test)`,
  );
  // Without the configured value there is no shape to match, so nothing changes.
  assert.equal(redactSensitiveText(message, []), message);
});

test('describeErrorForLog projects an Error into type/message/code only', () => {
  const err = new Error(`read failed ${SK_TEST}`) as Error & { code: string };
  err.code = '28P01';
  err.stack = `Error: read failed ${SK_TEST}\n    at /app/src/routes/billing.ts:42:11`;

  const log = describeErrorForLog(err, []);

  assert.deepEqual(Object.keys(log).sort(), ['code', 'message', 'type']);
  assert.equal(log.type, 'Error');
  assert.equal(log.code, '28P01');
  assert.ok(!log.message.includes(SK_TEST));
  assert.match(log.message, /read failed/);
  assert.ok(!JSON.stringify(log).includes('billing.ts'), 'the stack never reaches the log');
  assert.ok(!('stack' in log));
});

test('describeErrorForLog never serialises a thrown object whole', () => {
  const thrown = { message: `denied ${AUTH_CODE}`, connectionParameters: { password: DB_PASSWORD } };
  const log = describeErrorForLog(thrown, []);
  assert.equal(log.type, 'object');
  assert.ok(!log.message.includes(AUTH_CODE));
  assert.ok(!JSON.stringify(log).includes(DB_PASSWORD));
  assert.equal(log.code, undefined);
});

test('describeErrorForLog bounds and flattens a hostile message', () => {
  const err = new Error(`x\n\ty `.repeat(MAX_LOGGED_ERROR_CHARS));
  const log = describeErrorForLog(err, []);
  assert.ok(log.message.length <= MAX_LOGGED_ERROR_CHARS, 'the message is capped');
  assert.ok(!log.message.includes('\n'), 'newlines are collapsed');
});

test('describeErrorForLog handles string, empty and undefined throws', () => {
  assert.equal(describeErrorForLog('plain failure', []).type, 'string');
  assert.equal(describeErrorForLog('plain failure', []).message, 'plain failure');

  for (const thrown of [undefined, null, 42, {}]) {
    const log = describeErrorForLog(thrown, []);
    assert.equal(typeof log.type, 'string');
    assert.equal(log.type.length > 0, true);
    assert.equal(typeof log.message, 'string');
    assert.equal(log.message, 'unknown error', 'nothing useful to say is said safely');
    assert.equal(log.code, undefined);
  }
  // An Error with no message stays empty: nothing is invented, nothing leaks.
  assert.equal(describeErrorForLog(new Error(''), []).message, '');
});

test('configuredSecrets collects deployment credentials, including the DATABASE_URL password', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: CONNECTION_STRING,
    PAYSTACK_SECRET_KEY: SK_TEST,
    PAYSTACK_MODE: 'test',
    SMTP_PASS: 'smtp-pass-word',
    RESEND_API_KEY,
    SMTP_HOST: '',
    NOTIFICATION_WORKER_TOKEN: 'worker-token-value',
    WEBHOOK_SECRET_ENCRYPTION_KEY: 'encryption-key-value',
    VAPID_PRIVATE_KEY: 'vapid-private-value',
    TWELVE_DATA_API_KEY: 'twelve-data-value',
  });

  const secrets = configuredSecrets(config);
  for (const expected of [
    CONNECTION_STRING,
    DB_PASSWORD,
    SK_TEST,
    'smtp-pass-word',
    RESEND_API_KEY,
    'worker-token-value',
    'encryption-key-value',
    'vapid-private-value',
    'twelve-data-value',
  ]) {
    assert.ok(secrets.includes(expected), `expected ${expected} to be treated as a secret`);
  }
  // Empty values are dropped: an empty needle would match everywhere.
  assert.ok(!secrets.includes(''));
  assert.ok(secrets.every((secret) => secret.length > 0));
});

test('configuredSecrets tolerates a DATABASE_URL that is not a URL', () => {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'not-a-url', PAYSTACK_SECRET_KEY: '' });
  assert.ok(configuredSecrets(config).includes('not-a-url'));
});

test('logErrorSafely writes a redacted structured line and never the thrown object', () => {
  const lines: { obj: unknown; msg?: string }[] = [];
  const logger = {
    error: (obj: unknown, msg?: string) => {
      lines.push({ obj, msg });
    },
  };
  const err = new Error(`records read failed ${SK_TEST} via ${CONNECTION_STRING}`) as Error & {
    code: string;
  };
  err.code = '57P01';

  logErrorSafely(
    logger,
    err,
    'verified payment records unavailable',
    { route: '/api/billing/verified-payment-records', billingMode: 'test', secret: SK_TEST },
    [SK_TEST],
  );

  assert.equal(lines.length, 1);
  const { obj, msg } = lines[0] as { obj: Record<string, unknown>; msg?: string };
  assert.equal(msg, 'verified payment records unavailable');
  assert.equal(obj.route, '/api/billing/verified-payment-records');
  assert.equal(obj.billingMode, 'test');
  assert.equal(obj.secret, REDACTED, 'context values go through the same scrubber');

  const error = obj.error as Record<string, unknown>;
  assert.equal(error.type, 'Error');
  assert.equal(error.code, '57P01');
  assert.ok(!('stack' in error));

  const serialised = JSON.stringify(obj);
  for (const secret of [SK_TEST, DB_PASSWORD]) {
    assert.ok(!serialised.includes(secret), 'the credential must not reach the sink');
  }
  assert.ok(!serialised.includes(err.stack ?? ''), 'the stack must not reach the sink');
  assert.match(serialised, /records read failed/);
});

test('logErrorSafely drops undefined context fields and keeps non-string values', () => {
  const lines: unknown[] = [];
  logErrorSafely({ error: (obj: unknown) => lines.push(obj) }, new Error('boom'), 'failed', {
    attempt: 2,
    retried: true,
    missing: undefined,
  });
  const obj = lines[0] as Record<string, unknown>;
  assert.equal(obj.attempt, 2);
  assert.equal(obj.retried, true);
  assert.ok(!('missing' in obj));
});
