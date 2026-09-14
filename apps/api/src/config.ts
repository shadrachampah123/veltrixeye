import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_TRUSTED_PROXIES, parseTrustedProxies } from './trust-proxy.js';

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
});

/**
 * Validated environment plus the derived values the app needs at boot.
 * `trustedProxies` is `TRUSTED_PROXY_CIDRS` parsed, validated and normalised
 * (see apps/api/src/trust-proxy.ts) — the list handed to Fastify's
 * `trustProxy`, which is what makes `req.ip` non-client-controlled.
 */
export type AppConfig = z.infer<typeof envSchema> & { trustedProxies: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
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
  return { ...result.data, trustedProxies };
}

export function isProduction(config: AppConfig): boolean {
  return config.NODE_ENV === 'production';
}
