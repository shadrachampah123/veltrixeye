import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * M9.2 SecretManager abstraction — AES-256-GCM authenticated encryption
 * for webhook signing secrets and push subscription keys at rest.
 *
 * Production must FAIL CLOSED if encryption is required but
 * WEBHOOK_SECRET_ENCRYPTION_KEY is missing or invalid.
 *
 * Format: v<version>:<base64(iv 12B + authTag 16B + ciphertext)>
 * Versioning allows future key rotation without data loss.
 */

export const SECRET_MANAGER_KEY_VERSION = 1;
export const SECRET_MANAGER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface EncryptedSecret {
  ciphertext: string;
  keyVersion: number;
}

export interface SecretManager {
  readonly keyVersion: number;
  encrypt(plaintext: string): EncryptedSecret;
  decrypt(ciphertext: string, keyVersion: number): string;
  isEncrypted(value: string): boolean;
}

export class SecretManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretManagerError';
  }
}

function parseBase64Key(raw: string): Buffer {
  if (!raw || raw.trim() === '') {
    throw new SecretManagerError('WEBHOOK_SECRET_ENCRYPTION_KEY is required for secret encryption');
  }
  // Accept base64 (standard or url-safe) or hex? Spec says 32-byte base64.
  let normalized = raw.trim();
  // Try base64 decode
  try {
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length === 32) return buf;
    // Try base64url
    const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const buf2 = Buffer.from(padded, 'base64');
    if (buf2.length === 32) return buf2;
  } catch {
    // fall through
  }
  // Try hex
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }
  throw new SecretManagerError(
    'WEBHOOK_SECRET_ENCRYPTION_KEY must be 32 bytes base64-encoded (or 64 hex chars)',
  );
}

export class EnvKeySecretManager implements SecretManager {
  readonly keyVersion: number;
  private readonly key: Buffer;

  constructor(rawKey: string = '', keyVersion = SECRET_MANAGER_KEY_VERSION) {
    this.key = parseBase64Key(rawKey);
    this.keyVersion = keyVersion;
  }

  static fromEnv(): SecretManager {
    const raw = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    const env = process.env.NODE_ENV || 'development';
    return createSecretManager(raw, env);
  }

  encrypt(plaintext: string): EncryptedSecret {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new SecretManagerError('Plaintext must be non-empty string');
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(SECRET_MANAGER_ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new SecretManagerError('Failed to generate auth tag');
    }
    const combined = Buffer.concat([iv, authTag, encrypted]);
    const b64 = combined.toString('base64');
    return {
      ciphertext: `v${this.keyVersion}:${b64}`,
      keyVersion: this.keyVersion,
    };
  }

  decrypt(ciphertext: string, keyVersion: number): string {
    if (!ciphertext || typeof ciphertext !== 'string') {
      throw new SecretManagerError('Ciphertext must be non-empty string');
    }
    if (keyVersion !== this.keyVersion) {
      throw new SecretManagerError(`Unsupported key version ${keyVersion}, expected ${this.keyVersion}`);
    }
    const match = /^v(\d+):(.+)$/.exec(ciphertext);
    if (!match) {
      throw new SecretManagerError('Invalid ciphertext format, expected v<version>:<base64>');
    }
    const version = Number(match[1]);
    if (version !== keyVersion) {
      throw new SecretManagerError(`Ciphertext version ${version} does not match keyVersion ${keyVersion}`);
    }
    const b64 = match[2]!;
    let combined: Buffer;
    try {
      combined = Buffer.from(b64, 'base64');
    } catch {
      throw new SecretManagerError('Ciphertext base64 decoding failed');
    }
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new SecretManagerError('Ciphertext too short');
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    try {
      const decipher = createDecipheriv(SECRET_MANAGER_ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      return decrypted;
    } catch (err) {
      throw new SecretManagerError(`Decryption failed: ${(err as Error).message}`);
    }
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && /^v\d+:.+$/.test(value);
  }
}

/**
 * No-op manager for tests/dev fixtures ONLY.
 * Never use in production — it stores plaintext as ciphertext.
 * Production must fail closed, not silently fall back.
 */
export class NoopSecretManager implements SecretManager {
  readonly keyVersion = 0;
  encrypt(plaintext: string): EncryptedSecret {
    return { ciphertext: `v0:${Buffer.from(plaintext, 'utf8').toString('base64')}`, keyVersion: 0 };
  }
  decrypt(ciphertext: string, _keyVersion: number): string {
    const match = /^v0:(.+)$/.exec(ciphertext);
    if (!match) throw new SecretManagerError('Invalid noop ciphertext');
    return Buffer.from(match[1]!, 'base64').toString('utf8');
  }
  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith('v0:');
  }
}

/**
 * Alias for EnvKeySecretManager — historical name used in tests.
 */
export const AesGcmSecretManager = EnvKeySecretManager;

export function isNoopManager(manager: SecretManager): boolean {
  return manager instanceof NoopSecretManager;
}

/**
 * Factory that enforces fail-closed in production.
 * - If rawKey is present and valid → EnvKeySecretManager
 * - If rawKey missing and NODE_ENV=production → throw (fail closed)
 * - If rawKey missing and not production → NoopSecretManager (explicit dev/test only)
 */
export function createSecretManager(rawKey: string | undefined, nodeEnv: string): SecretManager {
  const env = nodeEnv || process.env.NODE_ENV || 'development';
  if (rawKey && rawKey.trim() !== '') {
    return new EnvKeySecretManager(rawKey);
  }
  if (env === 'production') {
    throw new SecretManagerError(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production for secret encryption at rest. ' +
        'Generate with: openssl rand -base64 32. ' +
        'Render encrypted env vars alone do NOT constitute application-level database secret protection.',
    );
  }
  // Dev/test fallback — explicitly non-production only
  return new NoopSecretManager();
}

export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  // Re-export via secret-manager for convenience, delegates to redact module
  // Avoid circular import by inlining simple logic
  if (!text) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length <= 3) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  return out;
}

/**
 * Helper to determine if a value looks like an encrypted secret.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^v\d+:.+$/.test(value);
}
