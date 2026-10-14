import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { test } from 'node:test';
import {
  buildMessageId,
  createSmtpEmailProvider,
  renderAlertNotification,
  type NotificationSendRequest,
} from '../src/index.js';

function emailRequest(): NotificationSendRequest {
  const payload = renderAlertNotification({
    alertId: '11111111-1111-4111-8111-111111111111',
    setupId: '22222222-2222-4222-8222-222222222222',
    strategyId: '33333333-3333-4333-8333-333333333333',
    strategyVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 1,
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 80,
    minQualityScore: 65,
    createdAt: '2026-10-01T12:00:00.000Z',
    body: {},
    symbol: 'EURUSD',
    assetClass: 'forex',
    timeframe: 'H1',
  });

  return {
    jobId: 'job-123',
    idempotencyKey: 'a'.repeat(64),
    channel: 'email',
    recipient: 'trader@example.net',
    template: 'alert.email.v1',
    payload,
    attempt: 1,
    timeoutMs: 1_500,
  };
}

function installFakeTransport(sendMail: (message: unknown) => Promise<unknown>) {
  const originalCreateTransport = nodemailer.createTransport;
  const createOptions: unknown[] = [];
  const sentMessages: unknown[] = [];
  const fakeTransport = {
    async sendMail(message: unknown): Promise<unknown> {
      sentMessages.push(message);
      return sendMail(message);
    },
  };

  nodemailer.createTransport = ((options: unknown) => {
    createOptions.push(options);
    return fakeTransport as unknown as ReturnType<typeof nodemailer.createTransport>;
  }) as typeof nodemailer.createTransport;

  return {
    createOptions,
    sentMessages,
    restore(): void {
      nodemailer.createTransport = originalCreateTransport;
    },
  };
}

test('Nodemailer 10 SMTP delivery keeps TLS policy, headers, and retry-stable Message-ID', async () => {
  const fake = installFakeTransport(async () => ({
    messageId: '<accepted@example.net>',
    response: '250 2.0.0 queued',
  }));
  const from = 'VeltrixEye Alerts <alerts@example.com>';

  try {
    const provider = createSmtpEmailProvider({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'smtp-user-test',
      pass: 'smtp-password-test-only',
      from,
    });

    const firstRequest = emailRequest();
    const first = await provider.send(firstRequest);
    const retry = await provider.send({ ...firstRequest, attempt: 2 });

    assert.equal(first.outcome, 'delivered');
    assert.equal(first.providerMessageId, '<accepted@example.net>');
    assert.equal(first.providerResponseCode, '250');
    assert.equal(retry.outcome, 'delivered');
    assert.equal(fake.createOptions.length, 1, 'the SMTP transporter is created lazily and reused');
    assert.equal(fake.sentMessages.length, 2);

    const transportOptions = fake.createOptions[0] as Record<string, unknown>;
    assert.equal(transportOptions.host, 'smtp.example.test');
    assert.equal(transportOptions.port, 587);
    assert.equal(transportOptions.secure, false);
    assert.equal(transportOptions.requireTLS, true, 'STARTTLS remains mandatory on port 587');
    assert.deepEqual(transportOptions.auth, {
      user: 'smtp-user-test',
      pass: 'smtp-password-test-only',
    });
    assert.equal(transportOptions.connectionTimeout, 1_500);
    assert.equal(transportOptions.greetingTimeout, 1_500);
    assert.equal(transportOptions.socketTimeout, 1_500);

    const firstMessage = fake.sentMessages[0] as Record<string, unknown>;
    const retryMessage = fake.sentMessages[1] as Record<string, unknown>;
    const expectedMessageId = buildMessageId(firstRequest.idempotencyKey, from);
    assert.equal(firstMessage.from, from);
    assert.equal(firstMessage.to, firstRequest.recipient);
    assert.equal(firstMessage.subject, firstRequest.payload.subject);
    assert.equal(firstMessage.text, firstRequest.payload.text);
    assert.equal(firstMessage.messageId, expectedMessageId);
    assert.equal(retryMessage.messageId, expectedMessageId, 'retries keep the same Message-ID');

    const headers = firstMessage.headers as Record<string, string>;
    assert.equal(headers['Auto-Submitted'], 'auto-generated');
    assert.equal(headers['X-Auto-Response-Suppress'], 'All');
    assert.equal(headers['X-VeltrixEye-Job-Id'], firstRequest.jobId);
    assert.equal(headers['X-VeltrixEye-Idempotency-Key'], firstRequest.idempotencyKey);
    assert.equal(headers['X-VeltrixEye-Template'], firstRequest.template);
  } finally {
    fake.restore();
  }
});

test('SMTP authentication errors remain unavailable and redact Nodemailer error text', async () => {
  const password = 'smtp-password-test-only';
  const fake = installFakeTransport(async () => {
    throw Object.assign(new Error(`535 authentication failed for ${password}`), { code: 'EAUTH' });
  });

  try {
    const provider = createSmtpEmailProvider({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'smtp-user-test',
      pass: password,
      from: 'VeltrixEye Alerts <alerts@example.com>',
    });

    const result = await provider.send(emailRequest());
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.failureCategory, 'configuration');
    assert.equal(result.error?.includes(password), false);
    assert.match(result.error ?? '', /\[redacted\]/);
  } finally {
    fake.restore();
  }
});
