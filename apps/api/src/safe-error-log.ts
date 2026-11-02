/**
 * Safe, structured error logging for the HTTP API.
 *
 * WHY THIS EXISTS
 * ---------------
 * Handing a caught exception straight to a logger (`req.log.error({ err })`)
 * is the easiest way to leak a credential: pino serialises the whole object,
 * which includes `stack` — and, depending on the library, the error's other
 * enumerable properties. A driver error can carry the connection string it
 * failed with, a provider error can echo the key/authorization code it sent,
 * and a stack can contain file paths and request material. Log sinks are
 * routinely shipped to third-party aggregators, so anything written here has
 * left the trust boundary.
 *
 * The rule this module enforces: **an exception object never reaches the
 * logger**. A handler logs a fixed, allow-listed projection of it —
 * `type`, a redacted/truncated `message`, and a short `code` — plus context
 * values that have been through the same scrubber.
 *
 * What redaction covers:
 *  - credentials this deployment actually configured (`configuredSecrets`);
 *  - credential SHAPES, whether or not they were configured: connection
 *    strings with inline user-info, `Authorization: Bearer/Basic` header
 *    values, JWTs, vendor keys (`sk_test_…`, `sk_live_…`, `pk_live_…`),
 *    AWS access-key ids, PEM private-key blocks and `password=…` /
 *    `token=…` / `authorization_code=…` style pairs;
 *  - stack traces (never logged at all).
 *
 * What is deliberately preserved, because operators need it to diagnose:
 * the error type, the redacted message, the short driver code (`28P01`,
 * `ECONNREFUSED`, `57P01`), the route, the HTTP method, the Fastify request
 * id and the server-selected billing mode.
 */
import type { FastifyBaseLogger } from 'fastify';
import { redactSecrets } from '@veltrixeye/core';
import type { AppConfig } from './config.js';

/** Placeholder substituted for every credential-shaped value. */
export const REDACTED = '[redacted]';

/** Cap on a logged error message — a log line must stay small and bounded. */
export const MAX_LOGGED_ERROR_CHARS = 300;

/** Cap on every other logged string field (type, code, context values). */
export const MAX_LOGGED_FIELD_CHARS = 64;

/**
 * Credential shapes that are scrubbed wherever they appear, independent of
 * what this deployment configured. Order matters: the broader structural
 * patterns (PEM blocks, JWTs, connection strings) run before the
 * `key=value` fallback so a header such as
 * `Authorization: Bearer eyJ…` is removed as one unit.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [pattern: RegExp, replacement: string])[] = [
  // PEM private-key blocks (SMTP/TLS/VAPID keys are multi-line).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // JSON Web Tokens: three base64url segments starting with a `{"` header.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Any URL carrying inline user-info: postgres://user:password@host/db.
  // The host is kept — it says WHICH database refused — the credentials are not.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*?@/gi, `$1${REDACTED}@`],
  // `Authorization: Bearer …` / `Basic …` header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Vendor keys with a mode prefix: sk_test_…, sk_live_…, pk_live_…, rk_test_…
  [/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/gi, REDACTED],
  // Vendor keys without a mode prefix (Stripe-style, long opaque secrets).
  [/\b(?:sk|pk)_[A-Za-z0-9]{24,}\b/gi, REDACTED],
  // AWS access-key ids (long-lived and short-lived).
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, REDACTED],
  // Reusable provider authorization codes, e.g. Paystack's `AUTH_…`.
  [/\bAUTH_[A-Za-z0-9]{12,}\b/g, REDACTED],
  /**
   * `key=value` / `key: value` credential pairs. The negative look-behind
   * lets an underscore-prefixed name match (`db_password=…`) while still
   * refusing a match inside an unrelated word (`bypass=true`,
   * `token_type=Bearer`). The value alternative covers a quoted value, a bare
   * token and an `Authorization: Bearer <x>` / `Basic <x>` header value, so a
   * short header value cannot survive behind a matched key.
   */
  [
    new RegExp(
      '(?<![A-Za-z0-9$])' +
        '((?:authorization(?:[_-]?code)?|access[_-]?token|refresh[_-]?token|id[_-]?token|' +
        'api[_-]?key|apikey|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|' +
        'pass(?:word|wd|phrase)?|pwd|credential(?:s)?|signature|sig|cookie|set-cookie|' +
        'session[_-]?token|token)\\s*[=:]\\s*)' +
        '(?:"[^"]*"|\'[^\']*\'|(?:Bearer|Basic)\\s+[^\\s,;&"\\\']+|[^\\s,;&"\\\']+)',
      'gi',
    ),
    `$1${REDACTED}`,
  ],
];

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Remove known secrets and every credential SHAPE from one string.
 *
 * Configured secrets are matched first (exact, whole value) and the
 * shape-based patterns second, so a deployment-specific key that does not
 * look like anything is still removed.
 */
export function redactSensitiveText(
  text: string,
  secrets: readonly (string | undefined | null)[] = [],
): string {
  let out = redactSecrets(text, secrets);
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Collapse whitespace so one failure cannot sprawl over many log lines. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function errorType(err: unknown): string {
  if (err instanceof Error) return err.name !== '' ? err.name : 'Error';
  if (typeof err === 'string') return 'string';
  return typeof err;
}

/**
 * The message (never the stack, never the rest of the object). A non-Error
 * throw contributes only its own `message` string — an object is never
 * serialised whole, because its other properties are exactly what must not
 * be logged.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown error';
}

/**
 * A short driver/library code (`28P01`, `42P01`, `ECONNREFUSED`) when the
 * throw carries one. Codes are bounded and non-secret, and they are what an
 * operator greps for, so they survive redaction — but they are still scrubbed
 * and truncated like every other string.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') return code;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return undefined;
}

/** The redacted, truncated, structured projection of a thrown value. */
export interface SafeErrorLog {
  /** `Error.name` (or `typeof err`) — never a stack trace. */
  type: string;
  /** Whitespace-collapsed, redacted, length-bounded message. */
  message: string;
  /** Short driver/library code when the throw carried one. */
  code?: string;
}

/**
 * Turn an unknown thrown value into the ONLY error shape that may be logged.
 * The original object (and therefore its stack and every extra property) is
 * dropped here and can never reach a sink.
 */
export function describeErrorForLog(
  err: unknown,
  secrets: readonly (string | undefined | null)[] = [],
): SafeErrorLog {
  const log: SafeErrorLog = {
    type: truncate(redactSensitiveText(singleLine(errorType(err)), secrets), MAX_LOGGED_FIELD_CHARS),
    message: truncate(
      redactSensitiveText(singleLine(errorMessage(err)), secrets),
      MAX_LOGGED_ERROR_CHARS,
    ),
  };
  const code = errorCode(err);
  if (code !== undefined) {
    log.code = truncate(redactSensitiveText(singleLine(code), secrets), MAX_LOGGED_FIELD_CHARS);
  }
  return log;
}

/**
 * Every credential this deployment was configured with, for exact-value
 * redaction. Read once at boot (or once per route registration) — never per
 * request. Empty values are dropped: `redactSecrets` would ignore them
 * anyway, and an empty needle can match everywhere.
 */
export function configuredSecrets(config: AppConfig): string[] {
  const values: (string | undefined)[] = [
    config.DATABASE_URL,
    config.PAYSTACK_SECRET_KEY,
    config.TWELVE_DATA_API_KEY,
    config.SMTP_USER,
    config.SMTP_PASS,
    config.VAPID_PRIVATE_KEY,
    config.WEBHOOK_SECRET_ENCRYPTION_KEY,
    config.NOTIFICATION_WORKER_TOKEN,
    config.SCANNER_WORKER_TOKEN,
    config.FX_SOURCE_WORKER_TOKEN,
    config.notification.email.pass,
    config.notification.push.privateKey,
    config.notification.secret.encryptionKey,
    config.notification.worker.token,
    config.scanner.workerToken,
    config.fxSource.workerToken,
  ];
  // The database password on its own: an error may echo just the credential.
  try {
    const url = new URL(config.DATABASE_URL);
    const password = decodeURIComponent(url.password);
    if (password !== '') values.push(password);
  } catch {
    // Not a parseable URL — the raw value is already in the list.
  }
  return values.filter((value): value is string => typeof value === 'string' && value !== '');
}

/** The minimal logger surface this module needs (a Fastify/pino request log). */
export type SafeErrorLogger = Pick<FastifyBaseLogger, 'error'>;

/**
 * Log one failure as a bounded, redacted, structured line.
 *
 * The thrown value is passed to {@link describeErrorForLog} — never to the
 * logger — and every context string goes through the same scrubber, so a
 * credential cannot reach the sink through a context field either.
 */
export function logErrorSafely(
  logger: SafeErrorLogger,
  err: unknown,
  logMessage: string,
  context: Readonly<Record<string, string | number | boolean | undefined>> = {},
  secrets: readonly (string | undefined | null)[] = [],
): void {
  const safeContext: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    safeContext[key] =
      typeof value === 'string'
        ? truncate(redactSensitiveText(singleLine(value), secrets), MAX_LOGGED_FIELD_CHARS)
        : value;
  }
  logger.error({ ...safeContext, error: describeErrorForLog(err, secrets) }, logMessage);
}
