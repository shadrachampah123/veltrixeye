import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_NOTIFICATION_BASE_BACKOFF_MS,
  DEFAULT_NOTIFICATION_BATCH_SIZE,
  DEFAULT_NOTIFICATION_JITTER_MS,
  DEFAULT_NOTIFICATION_LEASE_MS,
  DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
  DEFAULT_NOTIFICATION_MAX_BACKOFF_MS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  DEFAULT_NOTIFICATION_WORKER_INTERVAL_MS,
  MAX_NOTIFICATION_BATCH_SIZE,
} from '@veltrixeye/contracts';
import type { SmtpEmailConfig as SmtpEmailConfigShape } from '@veltrixeye/core';
import { validateExecutionTransportConfig } from '@veltrixeye/core';
import { DEFAULT_TRUSTED_PROXIES, parseTrustedProxies } from './trust-proxy.js';

/**
 * Integer environment value with a range. An EMPTY string is treated as
 * "not set" (platform dashboards often write an empty value for a secret the
 * operator skipped), so it falls back to the default instead of failing the
 * boot with `NaN`.
 */
function intEnv(min: number, max: number, fallback: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(min).max(max).default(fallback),
  );
}

/** Strict boolean: only the exact strings `true` / `false` are accepted. */
function boolEnv(fallback: boolean) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  );
}

/**
 * Minimal .env loader (no dependency): reads the repo-root .env and fills
 * process.env for keys that are not already set. Real environment variables
 * always win.
 */
export function loadDotEnv(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  let text: string;
  try {
    text = readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return; // no .env — everything must come from the real environment
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Environment configuration (fail-fast at boot).
 *
 * Secrets policy: this service needs two secrets — the DATABASE_URL
 * credentials (the database account itself) and the market-data provider key
 * (TWELVE_DATA_API_KEY; server-side only, never sent to browsers).
 * Session tokens are server-side (random per session, stored hashed) — no
 * JWT secret is required. See docs/environment.md and docs/security.md.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Port the API listens on. */
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** TLS for the database connection. */
  DATABASE_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  /** Max pool size for the database. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  /** Session cookie name (renaming requires re-login). */
  SESSION_COOKIE_NAME: z.string().min(3).max(64).default('ve_session'),
  /**
   * Cookie Secure flag:
   *  - 'auto'   secure only in production (default)
   *  - 'always' always secure
   *  - 'never'  never secure (local http testing only)
   */
  COOKIE_SECURE: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Session lifetime in days. */
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(30),
  /** fastify log level. */
  LOG_LEVEL: z.string().min(1).default('info'),
  /**
   * Proxy addresses allowed to speak for the client in `X-Forwarded-For`
   * (comma- or whitespace-separated CIDRs / IPs, plus proxy-addr's named
   * ranges `loopback`, `linklocal`, `uniquelocal`).
   *
   * This is a SECURITY boundary, not a convenience flag: it decides which IP
   * every rate limit is keyed on and which IP lands in `audit_events.ip`. The
   * default pins exactly the infrastructure in front of this service on Render
   * (Cloudflare's published edge ranges + Render's internal load-balancer
   * hops), so a client-supplied `X-Forwarded-For` can never choose its own
   * bucket. Widen it only for a hop you actually operate — e.g. add Vercel's
   * Static IP egress addresses to attribute web-proxied traffic per browser.
   * A `/0` entry is rejected at boot. See apps/api/src/trust-proxy.ts.
   */
  TRUSTED_PROXY_CIDRS: z.string().min(1).default(DEFAULT_TRUSTED_PROXIES.join(',')),
  /**
   * Twelve Data API key (M2 primary provider). Empty = no market data: the
   * API boots and market routes answer 502. Server-side only — the vendor
   * takes it in query strings, so it must never reach logs or browsers.
   * Production user-facing display requires a Business (Venture+) plan —
   * see docs/provider-licensing.md.
   */
  TWELVE_DATA_API_KEY: z.string().max(128).default(''),
  /** Provider REST base (override for tests only). */
  TWELVE_DATA_BASE_URL: z.string().url().default('https://api.twelvedata.com'),
  /** Per-request upstream timeout. */
  TWELVE_DATA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** Client-side upstream cap — keep under the plan's credits/min. */
  TWELVE_DATA_MAX_RPM: z.coerce.number().int().min(1).max(10000).default(50),
  /** Pinned crypto venue (defines the stored series — don't change casually). */
  TWELVE_DATA_CRYPTO_EXCHANGE: z.string().min(1).max(32).default('Binance'),

  /* ---------------------------------------------------------------------- */
  /* M7.3 — alert notification delivery (outbox + worker + email provider)    */
  /* ---------------------------------------------------------------------- */

  /**
   * SMTP host for the email channel. EMPTY = email delivery is unavailable:
   * outbox jobs are still created, and the worker records them `unavailable`
   * instead of pretending to deliver. Server-side only, never logged.
   */
  SMTP_HOST: z.string().max(255).default(''),
  /** SMTP port (587 = submission + STARTTLS, 465 = implicit TLS). */
  SMTP_PORT: intEnv(1, 65535, 587),
  /** 'auto' = implicit TLS on port 465 only; STARTTLS is required otherwise. */
  SMTP_SECURE: z.enum(['auto', 'always', 'never']).default('auto'),
  /** SMTP username (often the vendor's API key). Empty = no AUTH. */
  SMTP_USER: z.string().max(255).default(''),
  /** SMTP password / API secret. NEVER logged, never returned by any route. */
  SMTP_PASS: z.string().max(512).default(''),
  /** From address of alert email, e.g. `VeltrixEye Alerts <alerts@…>`. */
  NOTIFICATION_FROM: z.string().max(320).default(''),
  /** Per-attempt provider budget (the worker's lease is the backstop). */
  NOTIFICATION_PROVIDER_TIMEOUT_MS: intEnv(1_000, 120_000, DEFAULT_NOTIFICATION_TIMEOUT_MS),
  /** Bound on send attempts per job (1–10, schema-bounded). */
  NOTIFICATION_MAX_ATTEMPTS: intEnv(1, 10, DEFAULT_NOTIFICATION_MAX_ATTEMPTS),
  /** Backoff base: attempt n waits `base * 2^(n-1)` ms, capped at the max. */
  NOTIFICATION_BACKOFF_BASE_MS: intEnv(1_000, 600_000, DEFAULT_NOTIFICATION_BASE_BACKOFF_MS),
  NOTIFICATION_BACKOFF_MAX_MS: intEnv(1_000, 21_600_000, DEFAULT_NOTIFICATION_MAX_BACKOFF_MS),
  /** Deterministic per-job jitter (0 disables) that spreads retry bursts. */
  NOTIFICATION_BACKOFF_JITTER_MS: intEnv(0, 60_000, DEFAULT_NOTIFICATION_JITTER_MS),
  /** How long a claimed job may stay `processing` before it is recovered. */
  NOTIFICATION_LEASE_MS: intEnv(5_000, 3_600_000, DEFAULT_NOTIFICATION_LEASE_MS),
  /**
   * Run the delivery worker inside the API process on an interval. The API is
   * a long-lived container, so this is the simplest correct invocation; an
   * external scheduler (Render Cron Job) can additionally call the
   * token-protected internal endpoint, and both are safe to run at once.
   */
  NOTIFICATION_WORKER_ENABLED: boolEnv(true),
  NOTIFICATION_WORKER_INTERVAL_MS: intEnv(5_000, 3_600_000, DEFAULT_NOTIFICATION_WORKER_INTERVAL_MS),
  NOTIFICATION_WORKER_BATCH_SIZE: intEnv(1, MAX_NOTIFICATION_BATCH_SIZE, DEFAULT_NOTIFICATION_BATCH_SIZE),
  /**
   * Shared secret for `POST /api/internal/notifications/deliveries/*`.
   * EMPTY = those routes do not exist (404), so an unconfigured deployment
   * exposes no administrative surface at all.
   */
  NOTIFICATION_WORKER_TOKEN: z.string().max(256).default(''),
  /** Retention: how long terminal jobs are kept for auditing. */
  NOTIFICATION_RETENTION_DELIVERED_DAYS: intEnv(1, 3650, 30),
  NOTIFICATION_RETENTION_FAILED_DAYS: intEnv(1, 3650, 120),

  /* ---------------------------------------------------------------------- */
  /* M9.2 — push channel + secret hardening                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * 32-byte base64-encoded key for AES-256-GCM encryption of webhook signing
   * secrets and push subscription keys at rest. Server-side only, never logged,
   * never returned. Production MUST fail closed if missing/invalid when
   * encryption is required — Render's encrypted env vars alone do NOT
   * constitute application-level database secret protection.
   * Generate with: openssl rand -base64 32
   */
  WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().max(512).default(''),
  /** VAPID public key (base64url) for Web Push — safe to expose via authenticated endpoint */
  VAPID_PUBLIC_KEY: z.string().max(512).default(''),
  /** VAPID private key (base64url) — server-only, never logged, never returned */
  VAPID_PRIVATE_KEY: z.string().max(512).default(''),
  /** VAPID subject — mailto: or https:// */
  VAPID_SUBJECT: z.string().max(320).default(''),
  /** Enable push channel */
  PUSH_ENABLED: boolEnv(true),
  /** Push provider timeout */
  PUSH_PROVIDER_TIMEOUT_MS: intEnv(1_000, 120_000, 15_000),

  /* ---------------------------------------------------------------------- */
  /* M7.5 — live scanner (production market-data and scanner pipeline)       */
  /* ---------------------------------------------------------------------- */

  /**
   * Run the live scanner inside the API process on an interval.
   * The scanner processes real production market data through the full
   * strategy pipeline and generates alerts. It uses advisory locking to
   * prevent overlapping scans and respects subscription entitlements.
   * Disabled by default in development (manual trigger via API).
   */
  SCANNER_ENABLED: boolEnv(false),
  SCANNER_INTERVAL_MS: intEnv(30_000, 3_600_000, 300_000), // 5 minutes default
  SCANNER_PROVIDER_TIMEOUT_MS: intEnv(1_000, 120_000, 15_000),
  SCANNER_MAX_RETRIES: intEnv(0, 10, 3),
  SCANNER_RETRY_BASE_MS: intEnv(100, 60_000, 1_000),
  SCANNER_RETRY_MAX_MS: intEnv(1_000, 120_000, 10_000),

  /* ---------------------------------------------------------------------- */
  /* M8.6 — kill-switch & safety controls                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Deployment-level global kill switch. `true` pins the PLATFORM-wide switch
   * ON for every account regardless of database state — the operator's last-
   * resort brake (usable even when normal tooling/DB access is degraded).
   * It can only be cleared by changing the deployment environment; no API
   * route or profile row can un-pin it. Fail-closed default: absent/false.
   * Live execution is impossible in this platform either way — this stops
   * paper simulation and any future intake, nothing more.
   */
  EXECUTION_GLOBAL_KILL_SWITCH: boolEnv(false),
});

/** Email-channel configuration passed to the SMTP provider adapter. */
export type NotificationEmailConfig = SmtpEmailConfigShape & { timeoutMs: number };

export interface NotificationPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface NotificationSecretConfig {
  encryptionKey: string;
}

/** Everything the delivery pipeline needs, derived once at boot. */
export interface NotificationConfig {
  email: NotificationEmailConfig;
  push: NotificationPushConfig;
  secret: NotificationSecretConfig;
  retry: {
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    jitterMs: number;
    leaseMs: number;
    batchSize: number;
    timeoutMs: number;
  };
  worker: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    /** Empty ⇒ the internal worker routes are not registered (404). */
    token: string;
  };
  retention: { deliveredRetentionDays: number; failedRetentionDays: number };
}

export interface ScannerConfig {
  enabled: boolean;
  intervalMs: number;
  providerTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

/**
 * Validated environment plus the derived values the app needs at boot.
 * `trustedProxies` is `TRUSTED_PROXY_CIDRS` parsed, validated and normalised
 * (see apps/api/src/trust-proxy.ts) — the list handed to Fastify's
 * `trustProxy`, which is what makes `req.ip` non-client-controlled.
 * `notification` is the M7.3 delivery configuration (email credentials,
 * retry policy, worker invocation, retention).
 * `scanner` is the M7.5 live scanner configuration.
 */
export type AppConfig = z.infer<typeof envSchema> & {
  trustedProxies: string[];
  notification: NotificationConfig;
  scanner: ScannerConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // M10 validates opt-in transport settings without enabling or registering a transport.
  validateExecutionTransportConfig(env);
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately loud: a misconfigured environment must fail at boot, not at runtime.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  let trustedProxies: string[];
  try {
    trustedProxies = parseTrustedProxies(result.data.TRUSTED_PROXY_CIDRS);
  } catch (err) {
    // Same fail-fast contract as the schema above: a malformed trust list must
    // stop the boot rather than silently change who may speak for the client.
    throw new Error(`Invalid environment configuration:\n  - TRUSTED_PROXY_CIDRS: ${(err as Error).message}`);
  }

  const values = result.data;
  return {
    ...values,
    trustedProxies,
    notification: {
      email: {
        host: values.SMTP_HOST,
        port: values.SMTP_PORT,
        // 'auto': implicit TLS on the submission-over-TLS port, STARTTLS otherwise.
        secure:
          values.SMTP_SECURE === 'always'
            ? true
            : values.SMTP_SECURE === 'never'
              ? false
              : values.SMTP_PORT === 465,
        user: values.SMTP_USER,
        pass: values.SMTP_PASS,
        from: values.NOTIFICATION_FROM,
        timeoutMs: values.NOTIFICATION_PROVIDER_TIMEOUT_MS,
      },
      push: {
        publicKey: values.VAPID_PUBLIC_KEY,
        privateKey: values.VAPID_PRIVATE_KEY,
        subject: values.VAPID_SUBJECT,
        enabled: values.PUSH_ENABLED,
        timeoutMs: values.PUSH_PROVIDER_TIMEOUT_MS,
      },
      secret: {
        encryptionKey: values.WEBHOOK_SECRET_ENCRYPTION_KEY,
      },
      retry: {
        maxAttempts: values.NOTIFICATION_MAX_ATTEMPTS,
        baseBackoffMs: values.NOTIFICATION_BACKOFF_BASE_MS,
        maxBackoffMs: values.NOTIFICATION_BACKOFF_MAX_MS,
        jitterMs: values.NOTIFICATION_BACKOFF_JITTER_MS,
        leaseMs: values.NOTIFICATION_LEASE_MS,
        batchSize: values.NOTIFICATION_WORKER_BATCH_SIZE,
        timeoutMs: values.NOTIFICATION_PROVIDER_TIMEOUT_MS,
      },
      worker: {
        enabled: values.NOTIFICATION_WORKER_ENABLED,
        intervalMs: values.NOTIFICATION_WORKER_INTERVAL_MS,
        batchSize: values.NOTIFICATION_WORKER_BATCH_SIZE,
        token: values.NOTIFICATION_WORKER_TOKEN,
      },
      retention: {
        deliveredRetentionDays: values.NOTIFICATION_RETENTION_DELIVERED_DAYS,
        failedRetentionDays: values.NOTIFICATION_RETENTION_FAILED_DAYS,
      },
    },
    scanner: {
      enabled: values.SCANNER_ENABLED,
      intervalMs: values.SCANNER_INTERVAL_MS,
      providerTimeoutMs: values.SCANNER_PROVIDER_TIMEOUT_MS,
      maxRetries: values.SCANNER_MAX_RETRIES,
      retryBaseMs: values.SCANNER_RETRY_BASE_MS,
      retryMaxMs: values.SCANNER_RETRY_MAX_MS,
    },
  };
}

export function isProduction(config: AppConfig): boolean {
  return config.NODE_ENV === 'production';
}
