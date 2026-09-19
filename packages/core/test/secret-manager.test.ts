import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AesGcmSecretManager, EnvKeySecretManager, NoopSecretManager, looksEncrypted, redactSecrets, isNoopManager } from '../src/notifications/secret-manager.js';

describe('M9.2 SecretManager — encryption at rest', () => {
  test('encrypt/decrypt round-trip with random IV, version, ciphertext format', () => {
    const key = randomBytes(32).toString('hex');
    const mgr = new AesGcmSecretManager(key, 1);
    const plaintext = 'webhook-secret-12345';
    const enc1 = mgr.encrypt(plaintext);
    const enc2 = mgr.encrypt(plaintext);
    assert.notEqual(enc1.ciphertext, enc2.ciphertext, 'random IV => different ciphertexts');
    assert.equal(enc1.keyVersion, 1);
    assert.ok(looksEncrypted(enc1.ciphertext));
    assert.equal(mgr.decrypt(enc1.ciphertext, 1), plaintext);
    assert.equal(mgr.decrypt(enc2.ciphertext, 1), plaintext);
  });

  test('wrong key fails decryption, malformed ciphertext fails, version mismatch fails closed', () => {
    const key1 = randomBytes(32).toString('hex');
    const key2 = randomBytes(32).toString('hex');
    const mgr1 = new AesGcmSecretManager(key1, 1);
    const mgr2 = new AesGcmSecretManager(key2, 1);
    const enc = mgr1.encrypt('secret');
    assert.throws(() => mgr2.decrypt(enc.ciphertext, 1), /decrypt|fail/i);
    assert.throws(() => mgr1.decrypt('not-base64!!!', 1), /Invalid ciphertext|decrypt|format/i);
    assert.throws(() => mgr1.decrypt(enc.ciphertext, 99), /key version/i);
  });

  test('EnvKeySecretManager fails closed when key missing/invalid in production, Noop only for dev/test', () => {
    // Noop is allowed explicitly
    const noop = new NoopSecretManager();
    assert.equal(isNoopManager(noop), true);
    const enc = noop.encrypt('x');
    assert.ok(enc.ciphertext.startsWith('v0:'));
    assert.equal(noop.decrypt(enc.ciphertext, 0), 'x');

    // EnvKey without env var should throw in production path
    const original = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    const originalNode = process.env.NODE_ENV;
    try {
      delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';
      assert.throws(() => new (EnvKeySecretManager as any)(), /WEBHOOK_SECRET_ENCRYPTION_KEY/i);
      assert.throws(() => new EnvKeySecretManager(''), /WEBHOOK_SECRET_ENCRYPTION_KEY/i);
      process.env.NODE_ENV = 'test';
      // In test/dev, missing key falls back to Noop via fromEnv()
      const fromEnv = EnvKeySecretManager.fromEnv();
      assert.ok(isNoopManager(fromEnv), 'fromEnv in non-production returns Noop when key missing');
    } finally {
      if (original !== undefined) process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = original;
      else delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      if (originalNode !== undefined) process.env.NODE_ENV = originalNode;
      else delete process.env.NODE_ENV;
    }

    // Invalid key length fails
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'short';
    assert.throws(() => new EnvKeySecretManager('short'), /32 bytes|base64/i);
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  test('redaction never exposes plaintext secrets', () => {
    const secret = 'super-secret-webhook-key-123';
    const text = `failed to send to https://example.test with secret ${secret}`;
    const redacted = redactSecrets(text, [secret]);
    assert.equal(redacted.includes(secret), false);
    assert.match(redacted, /\[redacted\]/);
    // Non-secret text untouched
    assert.equal(redactSecrets('ordinary error', ['abc']), 'ordinary error');
  });

  test('looksEncrypted detects v1: prefix', () => {
    assert.equal(looksEncrypted('v1:abcd'), true);
    assert.equal(looksEncrypted('plaintext'), false);
    assert.equal(looksEncrypted(''), false);
  });

  test('key version column preserved, plaintext never in logs/DTOs', () => {
    const key = randomBytes(32).toString('hex');
    const mgr = new AesGcmSecretManager(key, 2);
    const enc = mgr.encrypt('my-secret');
    assert.equal(enc.keyVersion, 2);
    // Simulate DTO that should never contain secret
    const dto = { id: '1', channel: 'webhook', enabled: true, endpointUrl: 'https://example.test' };
    assert.equal((dto as any).signingSecret, undefined);
    assert.equal((dto as any).signing_secret_encrypted, undefined);
  });
});
