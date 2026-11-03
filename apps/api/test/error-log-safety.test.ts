/**
 * Logging safety — regression tests for the two places an unhandled failure
 * could write a credential to the production log sink.
 *
 * These tests assert on what an ACTUAL pino logger emits (captured from a
 * stream, through real Fastify serialisation and real redaction), not on what
 * a handler is believed to pass. Logging is disabled outside production, so
 * without a capture sink a logging regression is completely invisible to the
 * rest of the suite — which is exactly how the underlying defect survived.
 *
 * Pinning:
 *
 *  1. CENTRAL HANDLER — an unhandled exception carrying a database password, a
 *     provider key and an authorization code is logged WITHOUT any of them,
 *     without a stack trace, and still with a usable diagnostic.
 *  2. THE HANDLER LOGS ONLY THE ROUTE PATTERN — not the concrete URL, so a
 *     token or identifier living in a query string cannot reach the sink
 *     through the error line. (Fastify's own INFO-level `incoming request`
 *     line DOES log the URL; see the review notes — that is pre-existing
 *     framework behaviour, not something this handler controls.)
 *  3. THE PINO BACKSTOP — if a future call site regresses to a raw
 *     `req.log.error({ err })`, `LOGGER_REDACT_PATHS` still censors the
 *     message. This is the last line of defence, not the primary control.
 *  4. NO SECRETS IS STILL SAFE — `errorHandler` called without configuration
 *     (no secrets, no route info) never leaks a stack.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorHandler } from '../src/errors.js';
import { LOGGER_REDACT_PATHS } from '../src/app.js';
import { configuredSecrets } from '../src/safe-error-log.js';
import { loadConfig } from '../src/config.js';

/**
 * `sk_live_`/`sk_test_`-shaped fixtures are assembled at runtime: GitHub push
 * protection rejects those literals in committed source.
 */
const PROVIDER_KEY = ['sk', 'test', '0123456789abcdef0123456789abcdef01234567'].join('_');
const DB_PASSWORD = 'sup3rs3cr3t-db-pass';
const AUTH_CODE = 'AUTH_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
/** A credential-shaped value living in the query string, never in a secret. */
const URL_TOKEN = 'leak-token-abc123';

const SECRETS = [PROVIDER_KEY, DB_PASSWORD, AUTH_CODE];

/** The kind of error a driver or a provider adapter actually throws. */
function credentialBearingError(): Error {
  const err = new Error(
    `connect ECONNREFUSED to postgres://veltrix:${DB_PASSWORD}@db.internal:5432/veltrix ` +
      `with key ${PROVIDER_KEY} authorization_code=${AUTH_CODE}`,
  );
  err.name = 'Error';
  (err as { code?: string }).code = '28P01';
  return err;
}

/** A pino capture sink configured exactly like production. */
function captureLogger() {
  const lines: string[] = [];
  const sink = { write: (line: string) => { lines.push(String(line)); return true; } };
  return {
    lines,
    /** `stream` + `redact` is the Fastify/pino options form — no pino import. */
    options: {
      level: 'trace',
      stream: sink,
      redact: { paths: LOGGER_REDACT_PATHS, censor: '[redacted]' },
    },
  };
}

/**
 * The single ERROR-level captured log line, parsed.
 *
 * Fastify also writes its own `incoming request` / `request completed` lines at
 * INFO; those are not what these tests are about, so the level is part of the
 * selection.
 */
function loggedLine(lines: string[]) {
  const entries = lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((e): e is Record<string, unknown> => e !== null && e.level === 50);
  assert.equal(entries.length, 1, `expected exactly one error-level line, got ${entries.length}`);
  return entries[0] as Record<string, unknown>;
}

const apps: FastifyInstance[] = [];
after(async () => { await Promise.all(apps.map((a) => a.close())); });

async function buildTestApp(
  loggerOptions: ReturnType<typeof captureLogger>['options'],
  register: (app: FastifyInstance) => void,
) {
  const app = Fastify({ logger: loggerOptions, bodyLimit: 1024 });
  apps.push(app);
  register(app);
  await app.ready();
  return app;
}

test('the central error handler never writes a credential to the log sink', async () => {
  const capture = captureLogger();
  const app = await buildTestApp(capture.options, (a) => {
    // Mirrors the production wiring in buildApp: the handler is registered
    // with the deployment credentials.
    const secrets = configuredSecrets(loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://veltrix:${DB_PASSWORD}@db.internal:5432/veltrix`,
      PAYSTACK_SECRET_KEY: PROVIDER_KEY,
    }));
    a.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) =>
      errorHandler(err as Error, req, reply, secrets),
    );
    a.get('/boom/:id', async () => { throw credentialBearingError(); });
  });

  const res = await app.inject({
    method: 'GET',
    url: `/boom/42?token=${URL_TOKEN}`,
    headers: { authorization: 'Bearer session-jwt-should-never-be-logged' },
  });

  // The client still gets nothing but the generic body.
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body) as unknown, {
    error: { code: 'internal', message: 'An unexpected error occurred' },
  });

  const line = loggedLine(capture.lines);

  // NOTHING sensitive reached the sink.
  for (const secret of [...SECRETS, URL_TOKEN, 'session-jwt-should-never-be-logged']) {
    const where = JSON.stringify(line);
    assert.ok(!where.includes(secret), `credential-shaped value leaked into the log: ${secret}`);
  }

  // The raw exception is not the logged payload at all.
  assert.equal(line.err, undefined, 'a raw `err` key must never be written');
  assert.ok(!('stack' in line), 'a stack trace must never be written');

  // ...but the diagnostic survives.
  const error = line.error as Record<string, unknown> | undefined;
  assert.ok(error, 'a projected `error` object must be written');
  assert.equal(error.type, 'Error');
  assert.equal(error.code, '28P01');
  const message = String(error.message ?? '');
  assert.ok(message.length > 0, 'the message must survive in redacted form');
  assert.ok(message.length <= 300, `the message must be truncated (was ${message.length})`);
  assert.ok(message.includes('[redacted]'), `secrets must be substituted: ${message}`);

  // Operability: the handler is still identifiable.
  assert.equal(line.route, '/boom/:id', 'only the route PATTERN may be logged');
  assert.equal(line.method, 'GET');
  assert.ok(typeof line.requestId === 'string' && line.requestId.length > 0);
  assert.equal(line.msg, 'unhandled error');
});

test('the handler logs only the route pattern, never the concrete URL', async () => {
  const capture = captureLogger();
  const app = await buildTestApp(capture.options, (a) => {
    a.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) =>
      errorHandler(err as Error, req, reply, SECRETS),
    );
    a.get('/secret-path/:id', async () => { throw new Error(`boom ${PROVIDER_KEY}`); });
  });

  await app.inject({ method: 'GET', url: `/secret-path/99?token=${URL_TOKEN}&code=${AUTH_CODE}` });
  const line = loggedLine(capture.lines);
  const serialized = JSON.stringify(line);

  assert.ok(!serialized.includes(URL_TOKEN), 'a query-string token must not be logged');
  assert.ok(!serialized.includes(AUTH_CODE), 'a query-string code must not be logged');
  // The pattern still tells the operator which handler failed.
  assert.equal(line.route, '/secret-path/:id');
  assert.equal(line.url, undefined, 'the handler must never log the raw URL');
});

test('the pino backstop still censors a raw `req.log.error({ err })` regression', async () => {
  const capture = captureLogger();
  const app = await buildTestApp(capture.options, (a) => {
    // Deliberately the UNSAFE shape, to prove LOGGER_REDACT_PATHS is a real
    // second line of defence and not just documentation.
    a.get('/raw', async (req) => {
      req.log.error({ err: credentialBearingError() }, 'raw pass');
      return { ok: true };
    });
  });

  await app.inject({ method: 'GET', url: '/raw' });
  const line = loggedLine(capture.lines);
  const err = line.err as Record<string, unknown> | undefined;
  assert.ok(err, 'expected the raw `err` payload');

  // The message is the part that used to leak everything.
  assert.equal(err.message, '[redacted]', 'the backstop must censor err.message');
  assert.equal(err.stack, '[redacted]', 'the backstop must censor err.stack');
  // Censoring is structural: the type is still there for the operator.
  assert.equal(err.type, 'Error');
});

test('the handler is safe even when called without configured secrets', async () => {
  const capture = captureLogger();
  const app = await buildTestApp(capture.options, (a) => {
    a.setErrorHandler(errorHandler as (err: unknown, req: FastifyRequest, reply: FastifyReply) => void);
    a.get('/unconfigured', async () => { throw new Error('plain failure with no secrets configured'); });
  });

  const res = await app.inject({ method: 'GET', url: '/unconfigured' });
  assert.equal(res.statusCode, 500);

  const line = loggedLine(capture.lines);
  assert.ok(!('stack' in line), 'a stack trace must never be written');
  assert.equal(line.err, undefined);
  const error = line.error as Record<string, unknown> | undefined;
  assert.equal(error?.type, 'Error');
  assert.match(String(error?.message ?? ''), /plain failure/);
});
