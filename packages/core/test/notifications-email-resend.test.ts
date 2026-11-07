import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResendEmailProvider,
  isResendConfigured,
} from '../src/notifications/email-resend.js';
import type { NotificationSendRequest } from '../src/notifications/provider.js';

const request = {
  jobId: 'job-123',
  idempotencyKey: 'stable-key-123',
  channel: 'email',
  recipient: 'learner@example.com',
  template: 'alert.email.v1',
  payload: { subject: 'Alert subject', text: 'Alert body' },
  attempt: 1,
  timeoutMs: 1000,
} as unknown as NotificationSendRequest;

test('Resend configuration requires both API key and sender', () => {
  assert.equal(isResendConfigured({ apiKey: 're_test', from: 'Alerts <alerts@example.com>' }), true);
  assert.equal(isResendConfigured({ apiKey: '', from: 'Alerts <alerts@example.com>' }), false);
  assert.equal(isResendConfigured({ apiKey: 're_test', from: '' }), false);
});

test('sends through HTTPS with a stable idempotency key and redacted description', async () => {
  let capturedUrl = '';
  let captured: RequestInit | undefined;
  const provider = createResendEmailProvider(
    { apiKey: 're_secret_test_key', from: 'VeltrixEye <alerts@example.com>' },
    async (input, init) => {
      capturedUrl = String(input);
      captured = init;
      return new Response(JSON.stringify({ id: 'resend-message-1' }), { status: 200 });
    },
  );

  assert.equal(provider.configured, true);
  assert.equal(provider.name, 'resend');
  assert.equal(JSON.stringify(provider.describe()).includes('re_secret_test_key'), false);
  const result = await provider.send(request);

  assert.equal(capturedUrl, 'https://api.resend.com/emails');
  assert.equal((captured?.headers as Record<string, string>)['Idempotency-Key'], 'stable-key-123');
  assert.equal((captured?.headers as Record<string, string>).Authorization, 'Bearer re_secret_test_key');
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    from: 'VeltrixEye <alerts@example.com>',
    to: ['learner@example.com'],
    subject: 'Alert subject',
    text: 'Alert body',
    headers: {
      'X-VeltrixEye-Job-Id': 'job-123',
      'X-VeltrixEye-Template': 'alert.email.v1',
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    },
  });
  assert.deepEqual(result, {
    outcome: 'delivered',
    providerMessageId: 'resend-message-1',
    providerResponseCode: '200',
  });
});

test('classifies invalid credentials as configuration and invalid messages as permanent', async () => {
  const unauthorized = createResendEmailProvider(
    { apiKey: 're_secret', from: 'alerts@example.com' },
    async () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }),
  );
  const invalid = createResendEmailProvider(
    { apiKey: 're_secret', from: 'alerts@example.com' },
    async () => new Response(JSON.stringify({ message: 'Invalid recipient' }), { status: 422 }),
  );
  assert.equal((await unauthorized.send(request)).failureCategory, 'configuration');
  assert.equal((await unauthorized.send(request)).outcome, 'unavailable');
  assert.equal((await invalid.send(request)).failureCategory, 'permanent');
  assert.equal((await invalid.send(request)).outcome, 'permanent');
});

test('classifies rate limits and provider errors as retryable without leaking credentials', async () => {
  const provider = createResendEmailProvider(
    { apiKey: 're_secret', from: 'alerts@example.com' },
    async () => new Response(JSON.stringify({ message: 're_secret rejected' }), { status: 429 }),
  );
  const result = await provider.send(request);
  assert.equal(result.outcome, 'retryable');
  assert.equal(result.failureCategory, 'transient');
  assert.equal(result.error?.includes('re_secret'), false);
});

test('classifies request aborts as timeouts', async () => {
  const provider = createResendEmailProvider(
    { apiKey: 're_secret', from: 'alerts@example.com' },
    async (_input, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  );
  const result = await provider.send({ ...request, timeoutMs: 5 });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.failureCategory, 'timeout');
});
