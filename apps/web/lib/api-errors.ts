import { ApiError } from '@/lib/api';

/**
 * Shared API-error → user-facing-copy helpers (M6 Phase 4).
 *
 * The API is the authority on *what* went wrong; these helpers only decide how
 * it is worded. Nothing here invents detail: the API's own safe `message` is
 * used verbatim whenever it exists, and a stack trace, database error or
 * provider credential can never reach the browser because the API's central
 * error handler (`apps/api/src/errors.ts`) already replaced it with a generic
 * message. The `internal` branch below deliberately says nothing technical.
 */

/** Status buckets the UI words differently from a plain validation failure. */
export type ApiErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'conflict'
  | 'invalid_input'
  | 'server';

export function classifyApiError(err: unknown): ApiErrorKind {
  if (!(err instanceof ApiError)) return 'server';
  if (err.status === 401 || err.code === 'unauthorized') return 'unauthorized';
  if (err.status === 404 || err.code === 'not_found') return 'not_found';
  if (err.status === 429 || err.code === 'rate_limited') return 'rate_limited';
  if (err.status === 409) return 'conflict';
  if (err.status === 400 || err.code === 'invalid_input') return 'invalid_input';
  return 'server';
}

/**
 * A short, safe sentence for any API failure.
 *
 * `fallback` is used for the cases where the API's message would be either
 * missing or unhelpful to a trader (network failure, 5xx). Server-supplied
 * messages for 4xx are surfaced as-is: they are already written for clients
 * (e.g. "Only published versions can be backtested — a draft is still
 * mutable. Publish the version first.").
 */
export function describeApiError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  switch (classifyApiError(err)) {
    case 'unauthorized':
      return 'Your session is no longer valid. Sign in again to continue.';
    case 'not_found':
      return err instanceof ApiError && err.message
        ? err.message
        : 'Not found, or it belongs to another account.';
    case 'rate_limited':
      return err instanceof ApiError && err.message
        ? err.message
        : 'Too many requests. Wait a moment and try again.';
    case 'conflict':
    case 'invalid_input':
      return err instanceof ApiError && err.message ? err.message : fallback;
    case 'server':
    default:
      return fallback;
  }
}

/**
 * Per-field messages from a 400 `invalid_input` response
 * (`error.fields: { "<path>": ["message", …] }`). Non-400 errors map to nothing
 * so a server failure can never be painted as a form mistake.
 */
export function fieldErrorsFromApiError(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || classifyApiError(err) !== 'invalid_input' || !err.fields) return {};
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(err.fields)) {
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const message = messages[0];
    if (typeof message === 'string' && message !== '') out[key] = message;
  }
  return out;
}

/** The first per-field message for a path, when the API supplied one. */
export function fieldErrorFor(errors: Record<string, string>, path: string): string | undefined {
  return errors[path];
}
