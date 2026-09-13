import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
 * Secrets policy: the ONLY secret this service needs is the DATABASE_URL
 * credentials (the database account itself). Session tokens are server-side
 * (random per session, stored hashed) — no JWT secret is required.
 * See docs/environment.md and docs/security.md.
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
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately loud: a misconfigured environment must fail at boot, not at runtime.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export function isProduction(config: AppConfig): boolean {
  return config.NODE_ENV === 'production';
}
