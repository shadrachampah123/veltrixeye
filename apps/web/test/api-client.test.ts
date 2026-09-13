/**
 * Regression tests for the API client's request shapes.
 *
 * Background: the client previously sent `Content-Type: application/json` on
 * EVERY request, including body-less ones. Fastify rejects an empty body with
 * a JSON content-type (400, FST_ERR_CTP_EMPTY_JSON_BODY) before the route
 * handler runs — so `logout` and session `DELETE`/revoke silently failed in
 * the browser, the session was never revoked, and the login page bounced
 * signed-out users back to /dashboard.
 *
 * These tests pin the client's contract:
 *   - body-less calls must NOT declare a JSON content-type
 *   - body-bearing calls must still send `Content-Type: application/json`
 *
 * Run: npm run test --workspace @veltrixeye/web
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/api';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: RecordedCall[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const contentTypeOf = (call: RecordedCall): string | null =>
  new Headers(call.init?.headers).get('content-type');

test('api.logout() — body-less POST sends NO Content-Type (Fastify rejects empty JSON bodies)', async () => {
  await api.logout();
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const call = calls[0];
  assert.ok(call, 'fetch was called');
  assert.equal(call.url, '/api/auth/logout');
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.init?.body, undefined, 'no body');
  assert.equal(contentTypeOf(call), null, 'must not declare an empty JSON body');
});

test('api.deleteSession() — body-less DELETE sends NO Content-Type', async () => {
  await api.deleteSession('sess-123');
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const call = calls[0];
  assert.ok(call, 'fetch was called');
  assert.equal(call.url, '/api/users/me/sessions/sess-123');
  assert.equal(call.init?.method, 'DELETE');
  assert.equal(call.init?.body, undefined, 'no body');
  assert.equal(contentTypeOf(call), null, 'must not declare an empty JSON body');
});

test('api.login() — body-bearing POST still sends Content-Type: application/json + JSON body', async () => {
  await api.login({ email: 'trader@example.com', password: 'hunter22' });
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const call = calls[0];
  assert.ok(call, 'fetch was called');
  assert.equal(call.url, '/api/auth/login');
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json', 'JSON content-type preserved for bodies');
  assert.equal(call.init?.body, JSON.stringify({ email: 'trader@example.com', password: 'hunter22' }));
});

test('api.register() — body-bearing POST still sends Content-Type: application/json + JSON body', async () => {
  await api.register({ email: 'trader@example.com', password: 'hunter22' });
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const call = calls[0];
  assert.ok(call, 'fetch was called');
  assert.equal(call.url, '/api/auth/register');
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json', 'JSON content-type preserved for bodies');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { email: 'trader@example.com', password: 'hunter22' });
});
