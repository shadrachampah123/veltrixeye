/**
 * Log/row hygiene for the delivery pipeline (M7.3).
 *
 * Everything a provider returns may travel through three places that are NOT
 * equally trusted:
 *
 *   1. the `last_error` column (visible to operators through the internal
 *      maintenance endpoint),
 *   2. the worker's structured log lines,
 *   3. (never) an HTTP response to a browser — see `notificationDtoSchema`,
 *      which exposes a failure *category* instead of provider text.
 *
 * These helpers make it impossible to leak a credential by accident: any
 * configured secret value that appears in a provider message is replaced
 * before the text is stored or logged.
 */

/** Placeholder substituted for every occurrence of a secret. */
export const REDACTED = '[redacted]';

/** Cap on stored/logged provider error text (a row must stay small). */
export const MAX_ERROR_CHARS = 500;

/**
 * Replace every occurrence of any known secret with {@link REDACTED}.
 *
 * Short values (<= 3 chars) are ignored on purpose: replacing them would
 * shred unrelated text such as numbers. Empties and non-strings are ignored.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length <= 3) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Turn an unknown thrown value into one short, redacted, single-line string.
 *
 * `err.message` is used (never a stack trace: stacks contain file paths and,
 * for some libraries, the full request including credentials). Provider
 * messages are truncated, newline-collapsed and stripped of known secrets.
 */
export function describeError(
  err: unknown,
  secrets: readonly (string | undefined | null)[] = [],
  maxChars = MAX_ERROR_CHARS,
): string {
  const raw =
    err instanceof Error
      ? [err.name, err.message].filter((part) => part && part.length > 0).join(': ')
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const cleaned = redactSecrets(raw.replace(/\s+/g, ' ').trim(), secrets);
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}
