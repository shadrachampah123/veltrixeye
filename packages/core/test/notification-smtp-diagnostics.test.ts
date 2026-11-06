import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySmtpError } from '../src/notifications/email.js';

test('SMTP diagnostics classify connection timeouts without exposing credentials', () => {
  const secret = 'resend-api-secret-value';
  const result = classifySmtpError(
    Object.assign(new Error('Connection timed out while authenticating'), { code: 'ETIMEDOUT' }),
    [secret],
  );

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.failureCategory, 'timeout');
  assert.doesNotMatch(result.error, new RegExp(secret));
});

test('SMTP diagnostics preserve safe SMTP response codes', () => {
  const result = classifySmtpError(
    Object.assign(new Error('SMTP server rejected authentication'), {
      code: 'EAUTH',
      responseCode: 535,
      response: '535 Authentication credentials invalid',
    }),
  );

  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.failureCategory, 'configuration');
  assert.equal(result.responseCode, '535');
});

test('SMTP socket timeout is classified as an uncertain provider outcome', () => {
  const result = classifySmtpError(
    Object.assign(new Error('Socket timeout'), { code: 'ESOCKET' }),
  );

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.failureCategory, 'timeout');
});
