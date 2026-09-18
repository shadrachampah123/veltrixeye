import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { postPinnedHttps } from '../src/notifications/webhook-transport.js';
import {
  createWebhookNotificationProvider,
  WEBHOOK_PROVIDER_NAME,
  NotificationPreferenceService,
  isUnsafeAddress,
  resolveWebhookDestination,
  type NotificationSendRequest,
} from '../src/index.js';

const payload: NotificationSendRequest['payload'] = {
  template: 'alert.email.v1',
  subject: 'EURUSD long setup confirmed',
  text: 'VeltrixEye alert',
  data: {
    alertId: '11111111-1111-4111-8111-111111111111', setupId: '22222222-2222-4222-8222-222222222222',
    strategyId: '33333333-3333-4333-8333-333333333333', strategyVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 1, instrument: { assetClass: 'forex', symbol: 'EURUSD' }, timeframe: '1h',
    direction: 'long', triggerState: 'confirmed', qualityScore: 80, qualityGrade: 'B', minQualityScore: 65,
    entryPrice: 1.1, stopLossPrice: 1, tp1Price: 1.2, tp2Price: null, tp3Price: null,
    detectedAt: new Date(1_800_000_000_000).toISOString(), generatedAt: new Date(1_800_000_000_000).toISOString(),
  },
};
const request: NotificationSendRequest = {
  jobId: '55555555-5555-4555-8555-555555555555', idempotencyKey: 'a'.repeat(64), channel: 'webhook',
  recipient: 'https://8.8.8.8/alerts', template: payload.template, payload, attempt: 1, timeoutMs: 1000,
};

afterEach(() => { delete (globalThis as { fetch?: unknown }).fetch; });

test('M9.1 webhook provider registers as configured and posts JSON', async () => {
  const received: { body: string; headers: Record<string, string> } = { body: '', headers: {} };
  const provider = createWebhookNotificationProvider({
    timeoutMs: 5000,
    transport: async (_destination, body, headers) => { received.body = body; received.headers = headers; return { statusCode: 202 }; },
  });
  assert.equal(provider.name, WEBHOOK_PROVIDER_NAME);
  assert.equal(provider.configured, true);
  const result = await provider.send(request);
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.providerResponseCode, '202');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.match(received.body, /idempotencyKey/);
});

test('M9.1 preference service persists webhook settings without returning the secret', async () => {
  const row = {
    id: '66666666-6666-4666-8666-666666666666', user_id: '11111111-1111-4111-8111-111111111111',
    channel: 'webhook', enabled: true, endpoint_url: 'https://hooks.example.test/alerts', signing_secret: 'secret',
    created_at: new Date(1_800_000_000_000), updated_at: new Date(1_800_000_000_000),
  };
  const fakePool = { query: async () => ({ rows: [row] }) } as never;
  const service = new NotificationPreferenceService(fakePool);
  const preference = await service.upsert(row.user_id, {
    channel: 'webhook', endpointUrl: row.endpoint_url, signingSecret: row.signing_secret,
  });
  assert.equal(preference.endpointUrl, row.endpoint_url);
  assert.equal('signingSecret' in preference, false);
  await assert.rejects(() => service.upsert(row.user_id, {
    channel: 'webhook', endpointUrl: 'http://hooks.example.test/alerts', signingSecret: 'secret',
  }));
});

test('M9.1 explicit global email opt-out prevents targeting and enqueue', async () => {
  const disabledPrefs = { rows: [{ id: 'p', user_id: 'u', channel: 'email', enabled: false, endpoint_url: null, signing_secret: null, created_at: new Date(), updated_at: new Date() }] };
  const route = { rows: [{ strategy_id: 's', muted: false, channels: ['email'] }] };
  const pool = { query: async (sql: string) => {
    if (sql.includes('notification_user_settings')) return { rows: [] };
    if (sql.includes('strategy_notification_preferences')) return route;
    if (sql.includes('notification_preferences')) return disabledPrefs;
    return { rows: [{ email: 'owner@example.test' }] };
  } } as never;
  const service = new NotificationPreferenceService(pool);
  const targets = await service.deliveryTargets('u', 's', pool, new Date());
  const enqueueCount = targets.filter((target) => target.channel === 'email').length;
  assert.deepEqual(targets, []);
  assert.equal(enqueueCount, 0);

  const noPreferencePool = { query: async (sql: string) => {
    if (sql.includes('notification_user_settings') || sql.includes('strategy_notification_preferences') || sql.includes('notification_preferences')) return { rows: [] };
    return { rows: [{ email: 'owner@example.test' }] };
  } } as never;
  assert.deepEqual((await service.deliveryTargets('u', 's', noPreferencePool, new Date())).map((target) => target.channel), ['email']);
});

test('M9.1 webhook provider rejects non-HTTPS endpoints without network I/O', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  const result = await createWebhookNotificationProvider().send({ ...request, recipient: 'http://example.test/hook' });
  assert.equal(result.outcome, 'permanent');
  assert.equal(result.failureCategory, 'permanent');
});

test('M9.1 effective routing honors quiet hours and per-strategy channel routing', async () => {
  const settings = { rows: [{ quiet_hours_start_minute: null, quiet_hours_end_minute: null, quiet_hours_timezone: 'UTC' }] };
  const route = { rows: [{ strategy_id: 's', muted: false, channels: ['webhook'] }] };
  const prefs = { rows: [{ id: 'p', user_id: 'u', channel: 'webhook', enabled: true, endpoint_url: 'https://hooks.example.test', signing_secret: 'secret', created_at: new Date(), updated_at: new Date() }] };
  const fakePool = { query: async (sql: string) => sql.includes('notification_user_settings') ? settings : sql.includes('strategy_notification_preferences') ? route : prefs } as never;
  const service = new NotificationPreferenceService(fakePool);
  const targets = await service.deliveryTargets('u', 's', fakePool, new Date('2026-01-01T12:00:00Z'));
  assert.deepEqual(targets.map((target) => target.channel), ['webhook']);
  const globallyDisabled = { query: async (sql: string) => sql.includes('strategy_notification_preferences') ? route : { rows: [] } } as never;
  assert.deepEqual(await service.deliveryTargets('u', 's', globallyDisabled, new Date('2026-01-01T12:00:00Z')), []);

  const quietPool = { query: async (sql: string) => sql.includes('notification_user_settings') ? { rows: [{ quiet_hours_start_minute: 0, quiet_hours_end_minute: 1440, quiet_hours_timezone: 'UTC' }] } : { rows: [] } } as never;
  assert.deepEqual(await service.deliveryTargets('u', 's', quietPool, new Date('2026-01-01T12:00:00Z')), []);
});

test('M9.1 webhook security rejects private, reserved and metadata destinations', async () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1']) {
    assert.equal(isUnsafeAddress(ip), true, ip);
    await assert.rejects(() => resolveWebhookDestination(`https://${ip}/hook`));
  }
  for (const ip of ['::', '::1', '100::1', '2001:0::1', '2001:1::1', '2001:2::1', '2001:3::1', '2001:4:112::1', '2001:10::1', '2001:20::1', '2001:30::1', '2001:db8::1', '2002::1', '3fff::1', '5f00::1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8']) {
    assert.equal(isUnsafeAddress(ip), true, ip);
    await assert.rejects(() => resolveWebhookDestination(`https://[${ip}]/hook`));
  }
  await assert.rejects(() => resolveWebhookDestination('https://user:pass@8.8.8.8/hook'));
  await assert.rejects(() => resolveWebhookDestination('https://does-not-exist.invalid/hook'));
  await assert.rejects(() => resolveWebhookDestination('http://8.8.8.8/hook'));
  await assert.rejects(() => resolveWebhookDestination('https://localhost/hook'));
});

test('M9.1 pinned transport sends to the resolved address without redirecting', async () => {
  const key = readFileSync(fileURLToPath(new URL('./fixtures/webhook-test-key.pem', import.meta.url)));
  const cert = readFileSync(fileURLToPath(new URL('./fixtures/webhook-test-cert.pem', import.meta.url)));
  const server = https.createServer({ key, cert }, (incoming, response) => {
    assert.equal(incoming.headers.host?.split(':')[0], '127.0.0.1');
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await postPinnedHttps({
      url: new URL(`https://localhost:${address.port}/actual`), address: '127.0.0.1', family: 4, ca: cert.toString(),
    }, '{}', { 'content-type': 'application/json' }, 1000);
    assert.equal(result.statusCode, 204);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('M9.1 DNS timeout and rebinding checks fail closed', async () => {
  const delayedLookup = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [{ address: '8.8.8.8', family: 4 as const }];
  }) as never;
  await assert.rejects(() => resolveWebhookDestination('https://delayed.example.test/hook', 5, delayedLookup), /timed out/);
  const rebindingLookup = (async () => [
    { address: '8.8.8.8', family: 4 as const },
    { address: '127.0.0.1', family: 4 as const },
  ]) as never;
  await assert.rejects(() => resolveWebhookDestination('https://rebind.example.test/hook', 100, rebindingLookup), /private or reserved/);
});

test('M9.1 absolute transport deadline covers a continuously streaming response', async () => {
  const key = readFileSync(fileURLToPath(new URL('./fixtures/webhook-test-key.pem', import.meta.url)));
  const cert = readFileSync(fileURLToPath(new URL('./fixtures/webhook-test-cert.pem', import.meta.url)));
  const server = https.createServer({ key, cert }, (_incoming, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write('x'), 10);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(() => postPinnedHttps({
      url: new URL(`https://localhost:${address.port}/stream`), address: '127.0.0.1', family: 4, ca: cert.toString(),
    }, '{}', {}, 80), /timed out/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('M9.1 webhook security signs the exact body and never follows redirects', async () => {
  const secret = 'webhook-test-secret';
  let captured = { body: '', headers: {} as Record<string, string>, calls: 0 };
  const provider = createWebhookNotificationProvider({
    transport: async (_destination, body, headers) => {
      captured = { body, headers, calls: captured.calls + 1 };
      return { statusCode: 302 };
    },
  });
  const result = await provider.send({ ...request, signingSecret: secret });
  assert.equal(result.outcome, 'permanent');
  assert.equal(captured.calls, 1);
  assert.equal(captured.headers['x-veltrixeye-idempotency-key'], request.idempotencyKey);
  assert.equal(captured.headers['x-veltrixeye-signature'], `sha256=${createHmac('sha256', secret).update(captured.body).digest('hex')}`);
  assert.equal(captured.body.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
