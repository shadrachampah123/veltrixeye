/**
 * Production Gold (XAUUSD) v8 diagnostic — READ-ONLY evidence collector.
 *
 * WHY THIS EXISTS
 *   The Gold (XAUUSD) strategy's version 8 must be diagnosed from PRODUCTION
 *   DATA, not from an assumption. This script answers, from the database and
 *   nothing else:
 *
 *     1. the stored `timeframe_role` and `anchorOffsetCandles` of the v8
 *        liquidity-sweep condition, and which TIMEFRAME that role resolves to
 *        (i.e. whether it is in fact the 4H series);
 *     2. the authoritative XAUUSD pip size (`instrument_risk_specs.pip_size`);
 *     3. the candle coverage that evaluation can actually read per role;
 *     4. the setup / alert / delivery evidence that exists for v8 + XAUUSD.
 *
 *   It ADVISES NOTHING and CHANGES NOTHING. A correction may only be proposed
 *   after this evidence is read, and v8 itself is never modified here.
 *
 * SAFETY CONTRACT (enforced by code, not by convention)
 *
 *   - READ-ONLY CONNECTION. The pool is opened with the libpq startup option
 *     `-c default_transaction_read_only=on`, so EVERY session the pool ever
 *     hands out defaults to a read-only transaction.
 *
 *   - SINGLE EXPLICIT READ-ONLY TRANSACTION. Every query runs inside one
 *     `BEGIN READ ONLY` … `ROLLBACK`. Even a superuser role cannot write
 *     inside a READ ONLY transaction, so no future edit to a query string can
 *     turn this into a mutation.
 *
 *   - DATABASE TEXT CANNOT BECOME MARKUP. Every value the report renders goes
 *     through one of three helpers: `mdCell` (table cells: doubled backslashes,
 *     escaped pipes, collapsed newlines, neutralised backticks, escaped HTML
 *     entities), `mdCode` (the inside of an inline code span: collapsed
 *     newlines, neutralised backticks) or `mdText` (`mdCode` plus escaped `&`,
 *     `<` and `>` for ordinary text and bullets); structured payloads use
 *     `jsonBlock`, whose fence is longer than any backtick run it contains. A
 *     database value therefore cannot add a heading, a fence, a table row, a
 *     list item or a raw HTML element to the report. Literal prose is never
 *     built from data.
 *
 *   - THE REPORT PROVES IT. The evidence records `transaction_read_only` and
 *     the connecting role's effective INSERT/UPDATE/DELETE privileges as
 *     BOOLEANS via `has_table_privilege(current_user, …)`. The role NAME is
 *     never printed.
 *
 *   - NO SECRET IS EVER PRINTED. The connection string is read from
 *     `process.env.DATABASE_URL` and never logged. Every message that could
 *     carry driver output passes through `redact()`, which strips
 *     `postgres://…` / `postgresql://…` URLs, `password=…`, bearer tokens and
 *     e-mail addresses before anything reaches stdout/stderr or the report.
 *     A missing `DATABASE_URL` is a hard stop (exit 2) — no credential is
 *     invented, guessed or defaulted.
 *
 *   - NO REPORT ON STDOUT OR STDERR. The evidence is written to the JSON and
 *     Markdown files only. On success stdout carries three status lines: the
 *     completion line with the output directory, the `secretsRedacted` result,
 *     and a reminder that nothing is uploaded. Errors print a machine-readable
 *     code (SQLSTATE or Node TLS code), never the driver message, stack or
 *     connection string.
 *
 *   - NOTHING IS TRIGGERED. This file imports `pg` and `node:*` ONLY. It never
 *     constructs `ScannerService`, `AlertService`, `NotificationWorker`,
 *     `SetupService`, or any execution/risk service, so it cannot start a
 *     scan, generate an alert, drain the notification outbox, or place an
 *     order. It opens no socket other than the single read-only Postgres
 *     connection — no HTTP, no SMTP, no webhook, no push.
 *
 *   - NO PERSONAL DATA. No e-mail address, no `users` row and no
 *     `notification_deliveries.recipient` is ever selected. Free-text error
 *     columns (`scanner_runs.error`, `notification_deliveries.last_error`)
 *     pass through `redact()` and are truncated.
 *
 *   - READ COST IS BOUNDED. `SET LOCAL statement_timeout = '30s'` applies to the
 *     whole read-only transaction (transaction-local, not session-wide). The
 *     open-ended, row-returning queries carry a `LIMIT` (`Q_MIGRATIONS` 5,
 *     `Q_LATEST_SETUPS` 10, `Q_SETUP_EVENTS` 200, `Q_ALERTS` 25, the two delivery
 *     queries 100, `Q_SCANNER_RUNS` 5); the rest are bounded by their predicate
 *     and shape — one row per strategy, role or timeframe, and single rows for
 *     `Q_CONNECTION`, `Q_SERVER_VERSION` and `Q_SSL`. `Q_SETUP_SCORES` is the one
 *     row-returning query with no LIMIT and no one-row shape: its predicate
 *     restricts it to the at most ten setups selected above, and its per-setup
 *     row count is bounded only by the 30 s statement timeout. So not every
 *     query needs a LIMIT to be bounded, and the exception is named here rather
 *     than glossed over.
 *
 *   - THE TARGET IS EXPLICIT. `DATABASE_URL` must name the connecting role AND
 *     the database. `pg` fills a missing user, password, host, port or database
 *     from the environment, so an incomplete URL would silently describe a
 *     target nobody named; `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGHOST`,
 *     `PGPORT` and `PGSERVICE` are refused for the same reason. The target is
 *     exactly what the operator typed, or the run stops (exit 2).
 *
 *   - AN EARLIER REPORT IS NEVER OVERWRITTEN. If `--out` already holds a report,
 *     the run refuses with exit 2 before the credential is even read, and the
 *     write itself is exclusive (`wx`). A refused or failed run can therefore
 *     never be mistaken for a successful one, and nothing is deleted.
 *
 *   - FAIL CLOSED ON CONFIGURATION. `DATABASE_URL` may carry ONE query
 *     parameter: `sslmode=verify-full`. Every other parameter is refused before
 *     a connection is attempted — `options`, `host`, `port`, `user`,
 *     `password`, `db`, `application_name`, `statement_timeout`, `search_path`,
 *     any `ssl*` setting, `uselibpqcompat`, and anything unrecognised. This
 *     matters because `pg` merges the parsed connection string OVER the explicit
 *     pool configuration (`Object.assign({}, config, parse(connectionString))`),
 *     so `?options=-c default_transaction_read_only=off` would otherwise
 *     silently disable the session read-only default below.
 *
 *   - SAFETY CONDITIONS ARE ENFORCED, NOT REPORTED. After `BEGIN READ ONLY` the
 *     script reads `default_transaction_read_only`, `transaction_read_only`,
 *     `is_superuser` and the role's effective INSERT/UPDATE/DELETE privileges
 *     for the tables it touches, and ABORTS (exit 3, nothing written) unless
 *     every one of them is safe. A writable or superuser role is refused, so
 *     the least-privilege requirement is enforced rather than documented.
 *
 *   - AUTHENTICATED TLS ONLY. The only accepted mode is `verify-full`
 *     (certificate chain AND hostname verified). It is the default. There is
 *     no fallback to unauthenticated TLS and no fallback to plaintext: a
 *     `DATABASE_SSL_MODE` other than `verify-full`, an `sslmode` other than
 *     `verify-full` in the URL, any other `ssl*` URL parameter (which would
 *     override the pool's TLS setting), `NODE_TLS_REJECT_UNAUTHORIZED=0`, or
 *     any libpq `PGSSL*` override in the environment each stop the run with
 *     exit 2 before any connection is attempted.
 *
 *   - SAFETY FIELDS ARE MEASURED, NOT ASSERTED. The `safety.*` booleans in the
 *     report are computed at runtime (see `ReadOnlySession`, `evaluateSafety`
 *     and the output check in `main()`). The list of things this script is
 *     designed NOT to trigger is kept separately as `declaredNotVerified` and
 *     is labelled as declared design intent, not as verified evidence.
 *
 *   - LOCAL RUN ONLY. This script is NOT wired to a GitHub Actions workflow and
 *     receives no CI secret. Evidence is written to a gitignored local directory
 *     on the operator's machine (`--out`, default `diagnostics-out/`), never to
 *     a workflow artifact, job summary or public log. Running it in CI against
 *     the production database would require a protected GitHub Environment with
 *     required reviewers; that precondition is documented in
 *     `docs/diagnostics/gold-v8-production-evidence.md` and is deliberately NOT
 *     satisfied by this change, so no CI job can reach production.
 *
 * USAGE
 *   DATABASE_URL='postgres://user:password@host:5432/db?sslmode=verify-full' \
 *     npx tsx scripts/diagnostics/gold-v8-production-evidence.ts \
 *       --strategy <uuid|exact strategy name> [--version 8] \
 *       [--symbol XAUUSD] [--asset-class commodity] [--out <dir>]
 *   (DATABASE_SSL_MODE defaults to verify-full; it is the only accepted value.
 *   --version, when given, must be a whole number > 0: an invalid value is
 *   refused with exit 2 rather than replaced by the default 8.)
 *
 * EXIT CODES
 *   0  evidence collected (whether or not anything is found)
 *   2  DATABASE_URL missing, empty or incomplete, TLS or connection configuration
 *      refused, an ambient libpq variable set, a report already present in
 *      --out, an --out path that exists but is not a directory, or an invalid
 *      argument (for example a non-integer --version) — nothing attempted
 *   3  connection or query failure, ambiguous target, failed safety check, the
 *      output check failed, or the report could not be written (including an
 *      --out that became un-writable after the pre-flight checks) — no new report
 */
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

// ---------------------------------------------------------------------------
// Redaction — applied to every string that reaches an output stream.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s'"`<>]+/gi,
  /password\s*=\s*[^\s;'"`<>]+/gi,
  /bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /(?:^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/** Strip anything that could carry a credential out of `text`. */
function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** Truncate + redact free-text DB columns before they enter the report. */
function safeText(value: unknown, max = 300): string | null {
  if (value === null || value === undefined) return null;
  return redact(String(value)).slice(0, max);
}

/**
 * Literal secret values that must never appear in output: the whole
 * connection string and, when present, its password (encoded and decoded).
 */
function secretValuesFrom(rawUrl: string): string[] {
  const values = [rawUrl];
  try {
    const url = new URL(rawUrl);
    for (const p of [url.password, safeDecode(url.password)]) {
      if (p.length >= 4) values.push(p);
    }
  } catch {
    // Unparseable URL: the raw value above is still checked.
  }
  return values;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when `text` still contains credential material (before or after redaction). */
function leaksSecret(text: string, secretValues: readonly string[]): boolean {
  if (secretValues.some((v) => text.includes(v))) return true;
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Scrub credential material from one string: redaction patterns plus literal secrets. */
function scrubSecrets(text: string, secretValues: readonly string[]): string {
  let out = redact(text);
  for (const v of secretValues) out = out.split(v).join('[redacted]');
  return out;
}

/**
 * Apply `fn` to every string in a JSON-like value (keys included). Plain and
 * null-prototype objects are walked, so a row object cannot slip past the
 * check. Dates and other class instances are returned unchanged; they carry no
 * free text that this report renders.
 */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[fn(k)] = mapStrings(v, fn);
    }
    return out as T;
  }
  return value;
}

/**
 * The only capability `ReadOnlySession` needs. Declaring it explicitly keeps the
 * class testable with a fake client and usable with both `pg.Client` (local
 * scripts, tests) and `pg.PoolClient` (the pool in `main()`).
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Guard for every query the script issues. It refuses to run a query unless
 * the explicit `BEGIN READ ONLY` transaction is open, and it records what the
 * server reported from inside that transaction. The report's
 * `everyQueryRanInsideBeginReadOnly` is derived from these runtime facts.
 */
class ReadOnlySession {
  private open = false;
  private observedReadOnly = false;
  private rolledBack = false;
  private violations = 0;

  constructor(private readonly client: Queryable) {}

  /**
   * Open the read-only transaction AND verify it. `BEGIN READ ONLY` is executed,
   * then the server itself is asked for `transaction_read_only`; a server that
   * did not honour it is a hard failure rather than something the report merely
   * records. This is also what makes `allQueriesInsideReadOnly` a measured fact
   * instead of an assumption about the caller.
   */
  async begin(): Promise<void> {
    await this.client.query('BEGIN READ ONLY');
    this.open = true;
    const res = await this.query<{ v: string }>("SELECT current_setting('transaction_read_only') AS v");
    const value = String(res.rows[0]?.['v'] ?? '');
    this.observedReadOnly = value === 'on';
    if (!this.observedReadOnly) {
      this.open = false;
      throw new Error(
        `refusing to continue: the server did not open a read-only transaction (transaction_read_only='${value}')`,
      );
    }
  }

  /** Record `transaction_read_only` as the server reported it inside the transaction. */
  observeTransactionReadOnly(value: string): void {
    this.observedReadOnly = value === 'on';
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    if (!this.open) {
      this.violations += 1;
      throw new Error('internal: query issued outside the explicit read-only transaction');
    }
    return this.client.query<R>(text, values);
  }

  async end(): Promise<void> {
    await this.client.query('ROLLBACK');
    this.open = false;
    this.rolledBack = true;
  }

  /** True only if the txn was observed read-only, every query ran inside it, and it was rolled back. */
  get allQueriesInsideReadOnly(): boolean {
    return this.violations === 0 && this.observedReadOnly && this.rolledBack;
  }
}

/**
 * The ONLY query parameter DATABASE_URL may carry. `pg` merges the parsed
 * connection string over the explicit pool config
 * (`Object.assign({}, config, parse(connectionString))` in
 * `pg/lib/connection-parameters.js`), and `pg-connection-string` copies every
 * query parameter into that config. An allowlist is therefore the only safe
 * rule: anything else can rewrite the host, the credentials, the startup
 * options (`?options=-c default_transaction_read_only=off`) or the TLS settings.
 */
export const ALLOWED_URL_PARAMS: readonly string[] = ['sslmode'];

/**
 * Validate the query parameters of DATABASE_URL against the allowlist. Returns a
 * message, or null when the URL is acceptable. The URL is never included in a
 * message, and a parameter NAME is never echoed: a name is user-supplied and can
 * carry credential material (for example `ssl<password>`).
 */
export function connectionUrlProblem(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'DATABASE_URL could not be parsed as a URL (URL-encode special characters in the password). Nothing was attempted.';
  }
  // The target must be EXPLICIT. `pg` resolves every missing piece of the target
  // from the environment (`val()` in `pg/lib/connection-parameters.js`), so a URL
  // without a user or without a database would silently take PGUSER / PGDATABASE
  // or the operating-system user name. The evidence must describe the database
  // and role the operator named, so both parts are required and neither is
  // defaulted. No value from the URL is ever echoed.
  if (url.username === '') {
    return (
      'DATABASE_URL does not name the connecting role. Use postgres://user:password@host:5432/database — ' +
      'without a user, pg falls back to PGUSER or the operating-system user name. Nothing was attempted.'
    );
  }
  if (url.pathname.replace(/^\//, '') === '') {
    return (
      'DATABASE_URL does not name the database. Use postgres://user:password@host:5432/database — ' +
      'without a database path, pg falls back to PGDATABASE or the user name. Nothing was attempted.'
    );
  }
  // Every occurrence is checked, and a repeated key is refused outright: a
  // duplicate could hide a weaker value behind an acceptable first one
  // (`sslmode=verify-full&sslmode=disable`), and even a benign-looking
  // repetition (`sslmode=verify-full&sslmode=verify-full`) makes it ambiguous
  // which value the driver will honour. One parameter, once, or nothing.
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams.entries()) {
    const k = key.toLowerCase();
    if (seen.has(k)) {
      return (
        'DATABASE_URL repeats a query parameter. Each parameter may appear at most once — ' +
        'remove the duplicate. Nothing was attempted.'
      );
    }
    seen.add(k);
    if (!ALLOWED_URL_PARAMS.includes(k)) {
      return (
        'DATABASE_URL carries a query parameter that is not allowed. Only `sslmode=verify-full` is accepted; ' +
        'parameters such as options, host, port, user, password, db, application_name, statement_timeout, ' +
        'search_path, ssl* or uselibpqcompat can override the connection. Remove it. Nothing was attempted.'
      );
    }
    if (value !== 'verify-full') {
      return 'DATABASE_URL sets sslmode to a value other than verify-full. Only authenticated TLS is accepted; remove the parameter or set it to verify-full. Nothing was attempted.';
    }
  }
  return null;
}

/**
 * libpq-style TLS overrides that pg honours from the environment. Any of these
 * would change the trust anchors or disable verification, so their presence is
 * refused outright — the script configures TLS itself and nothing else may.
 */
export const REFUSED_TLS_ENV_VARS: readonly string[] = [
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLPASSWORD',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLNEGOTIATION',
  'PGREQUIRESSL',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

/**
 * Returns a message when the environment attempts to reconfigure TLS or the
 * connection, otherwise null. Pure: takes the environment explicitly so the
 * refusal paths are testable without touching `process.env`.
 */
export function tlsEnvProblem(env: Record<string, string | undefined>): string | null {
  if (env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    return 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification for the whole process. Unset it. Nothing was attempted.';
  }
  for (const name of REFUSED_TLS_ENV_VARS) {
    if (name === 'NODE_TLS_REJECT_UNAUTHORIZED') continue;
    const value = env[name];
    if (value !== undefined && value !== '') {
      return `${name} is set. TLS and the connection are configured by this script only (verify-full); unset it. Nothing was attempted.`;
    }
  }
  return null;
}

/**
 * libpq connection variables that `pg` honours from the environment for the parts
 * of the target DATABASE_URL already states. Since the URL must name the role and
 * the database (`connectionUrlProblem`), any of these being set can only mean the
 * operator meant a different target than the one passed — so they are refused
 * instead of merged. Nothing here reads or prints a value.
 */
export const REFUSED_CONNECTION_ENV_VARS: readonly string[] = [
  'PGUSER',
  'PGDATABASE',
  'PGPASSWORD',
  'PGHOST',
  'PGPORT',
  'PGSERVICE',
];

/**
 * Returns a message when the environment carries a libpq connection variable
 * that could silently retarget the connection, otherwise null. Pure: takes the
 * environment explicitly, like `tlsEnvProblem`.
 */
export function connectionTargetEnvProblem(env: Record<string, string | undefined>): string | null {
  for (const name of REFUSED_CONNECTION_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return `${name} is set. The connection target comes from DATABASE_URL only — this script never merges an ambient libpq variable; unset it. Nothing was attempted.`;
    }
  }
  return null;
}

/**
 * The safety verdict for the session, computed from what the server reported.
 * Pure and exhaustive: every fact that is not explicitly safe is a violation, so
 * a missing or unexpected value fails closed.
 */
export interface SessionFacts {
  defaultTransactionReadOnly: string;
  transactionReadOnly: string;
  isSuperuser: string;
  /**
   * `has_table_privilege` answers, by human-readable label. Only an explicit
   * `false` means "cannot write": `true` is a write grant and `null` (the value
   * `factsFromConnectionRow` uses for a missing or non-boolean answer) means the
   * answer was never established. Both are refusals.
   */
  writePrivileges: Record<string, boolean | null>;
}

/**
 * Column in Q_CONNECTION → the write privilege it reports. The label is what the
 * refusal message shows; the column is what the server answered.
 */
export const WRITE_PRIVILEGE_COLUMNS: Readonly<Record<string, string>> = {
  'INSERT on setups': 'can_insert_setups',
  'UPDATE on setups': 'can_update_setups',
  'DELETE on setups': 'can_delete_setups',
  'INSERT on alerts': 'can_insert_alerts',
  'UPDATE on alerts': 'can_update_alerts',
  'INSERT on alert_deliveries': 'can_insert_alert_deliveries',
  'UPDATE on notification_deliveries': 'can_update_notification_deliveries',
  'INSERT on notification_deliveries': 'can_insert_notification_deliveries',
  'INSERT on scanner_runs': 'can_insert_scanner_runs',
  'UPDATE on scanner_cursors': 'can_update_scanner_cursors',
  'UPDATE on strategies': 'can_update_strategies',
  'UPDATE on strategy_versions': 'can_update_strategy_versions',
};

/**
 * Build the safety facts from a real Q_CONNECTION row. Shared by `main()` and the
 * tests, so the tests exercise the exact mapping production uses — an unexpected
 * or missing value stays `''`/`null` and therefore fails closed.
 */
export function factsFromConnectionRow(row: Record<string, unknown>): SessionFacts {
  const writePrivileges: Record<string, boolean | null> = {};
  for (const [label, column] of Object.entries(WRITE_PRIVILEGE_COLUMNS)) {
    const value = row[column];
    writePrivileges[label] = typeof value === 'boolean' ? value : null;
  }
  return {
    defaultTransactionReadOnly: String(row['default_tx_read_only'] ?? ''),
    transactionReadOnly: String(row['tx_read_only'] ?? ''),
    isSuperuser: String(row['is_superuser'] ?? ''),
    writePrivileges,
  };
}

export function evaluateSafety(facts: SessionFacts): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  /**
   * A write privilege is safe ONLY when the server answered an explicit
   * `false`. `true` is a grant; `null`, `undefined` or any other value means the
   * answer was never established. An unverifiable privilege must never be read
   * as permission, so both cases are violations.
   */
  const checkPrivilege = (label: string, value: boolean | null | undefined): void => {
    if (value === false) return;
    if (value === true) {
      violations.push(`the connecting role holds ${label} — use a least-privilege role`);
      return;
    }
    const got = value === null ? 'null' : value === undefined ? 'missing' : typeof value;
    violations.push(`the ${label} privilege was not answered with an explicit false (got ${got}) — refusing to continue`);
  };

  if (facts.defaultTransactionReadOnly !== 'on') {
    violations.push(
      `default_transaction_read_only is '${facts.defaultTransactionReadOnly}' (expected 'on') — the session was not opened read-only`,
    );
  }
  if (facts.transactionReadOnly !== 'on') {
    violations.push(`transaction_read_only is '${facts.transactionReadOnly}' (expected 'on') — the transaction is not read-only`);
  }
  // Exactly 'off' is safe. 'on' is a superuser; '', 'unknown' or any other
  // value means superuser status was not established, which is equally unsafe.
  if (facts.isSuperuser !== 'off') {
    violations.push(
      facts.isSuperuser === 'on'
        ? 'the connecting role is a superuser — use a least-privilege role'
        : `is_superuser is '${facts.isSuperuser}' (expected 'off') — superuser status could not be established`,
    );
  }

  // Every privilege the session must NOT hold, by canonical label, so a map
  // that simply omits an answer cannot pass vacuously. Any additional entry is
  // checked too, so an unrecognised grant cannot hide.
  const checked = new Set<string>();
  for (const label of Object.keys(WRITE_PRIVILEGE_COLUMNS)) {
    checked.add(label);
    checkPrivilege(label, facts.writePrivileges?.[label]);
  }
  for (const [label, value] of Object.entries(facts.writePrivileges ?? {})) {
    if (!checked.has(label)) checkPrivilege(label, value);
  }

  return { ok: violations.length === 0, violations };
}

/**
 * The machine-readable error code of a driver or Node error, for printing.
 * Postgres SQLSTATE codes (e.g. 28P01 bad password, 3D000 no such database,
 * 42501 permission denied) and Node TLS codes (e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE)
 * carry no data. Error MESSAGES are never printed: a database message can echo
 * row values, and a connection message can echo the URL. Anything that is not a
 * short code prints as UNKNOWN.
 */
function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  strategy: string;
  version: number;
  symbol: string;
  assetClass: string;
  outDir: string;
}

/**
 * A command-line value the operator must fix. Thrown by `parseOptions` and
 * turned into exit code 2 by `main()`, so an invalid argument can never fall
 * back to a default and silently collect evidence for a different target.
 */
export class OptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionError';
  }
}

export function parseOptions(argv: readonly string[]): Options {
  const opts: Options = {
    // No default: a default like 'gold' used to be a substring match that could
    // silently select any of several strategies. The target must be explicit.
    strategy: '',
    version: 8,
    symbol: 'XAUUSD',
    assetClass: 'commodity',
    outDir: 'diagnostics-out',
  };
  const read = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const strategy = read('--strategy');
  if (strategy) opts.strategy = strategy;
  // `--version` is strict: digits only, a SAFE integer, greater than zero.
  // `abc`, `9x`, `8.5`, `-3`, `0` and digit strings beyond
  // Number.MAX_SAFE_INTEGER are REFUSED (OptionError → exit 2). Falling back to
  // the default 8 would collect evidence for a version the operator did not ask
  // for, which is the same silent wrong-target failure the strategy selector
  // removed; an unsafe integer would silently land on a different number than
  // the one typed.
  if (argv.includes('--version')) {
    const raw = read('--version');
    const parsed = raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new OptionError(
        '--version must be a whole number greater than zero and within the safe integer range ' +
          '(for example --version 8). The given value was refused rather than replaced with the ' +
          'default. Nothing was attempted.',
      );
    }
    opts.version = parsed;
  }
  const symbol = read('--symbol');
  if (symbol) opts.symbol = symbol.toUpperCase();
  const assetClass = read('--asset-class');
  if (assetClass) opts.assetClass = assetClass;
  const out = read('--out');
  if (out) opts.outDir = out;
  return opts;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ConnectionEvidence {
  database: string;
  serverVersion: string;
  /** Requested by this run (configuration, not observed). */
  tlsRequestedMode: 'verify-full';
  /** Observed from pg_stat_ssl for this session. */
  ssl: boolean | null;
  defaultTransactionReadOnly: string;
  transactionReadOnly: string;
  /** `on` when the connecting role is a superuser — always a refusal. */
  isSuperuser: string;
  statementTimeout: string;
  /** Label → `has_table_privilege` answer. Any `true` is a refusal. */
  privileges: Record<string, boolean | null>;
}

interface StrategyRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  version_count: number;
  match_reason: string;
}

interface VersionRow {
  id: string;
  strategy_id: string;
  version_number: number;
  status: string;
  published_at: string | null;
  changelog: string | null;
}

interface TimeframeRow {
  role: string;
  timeframe: string;
}

interface ConditionRow {
  group_id: string;
  group_name: string;
  group_logic: string;
  group_position: number;
  condition_id: string | null;
  condition_type: string | null;
  classification: string | null;
  timeframe_role: string | null;
  params: Record<string, unknown> | null;
  position: number | null;
}

interface RiskRow {
  min_rr: string;
  stop_loss_method: string;
  stop_loss_buffer: string;
  stop_loss_buffer_unit: string;
  take_profit_method: string;
  tp1_rr: string;
  tp2_rr: string;
  tp3_rr: string;
  min_quality_score: number;
}

interface CandleCoverageRow {
  timeframe: string;
  candles: number;
  first_ts: string | null;
  last_ts: string | null;
  last_fetched_at: string | null;
}

interface SetupRow {
  id: string;
  state: string;
  direction: string;
  detected_at: string;
  as_of_ms: string;
  entry_price: string | null;
  stop_loss_price: string | null;
  tp1_price: string | null;
  tp2_price: string | null;
  tp3_price: string | null;
  quality_score: number | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
  expires_at: string | null;
}

interface AlertRow {
  id: string;
  setup_id: string;
  direction: string;
  trigger_state: string;
  quality_score: number;
  min_quality_score: number;
  title: string;
  status: string;
  acknowledged_at: string | null;
  created_at: string;
}

interface ScannerRunRow {
  id: string;
  status: string;
  provider_slug: string;
  started_at: string;
  finished_at: string | null;
  strategies_scanned: number;
  instruments_scanned: number;
  candles_fetched: number;
  setups_detected: number;
  setups_created: number;
  alerts_created: number;
  stale_rejections: number;
  provider_failures: number;
  symbols_processed: unknown;
  timeframes_processed: unknown;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Engine conventions mirrored from packages/core (documented, never re-derived)
//
// `conditionRole()` in packages/core/src/strategies/evaluation/engine.ts is the
// SINGLE role convention. It is restated here verbatim so the report can label
// which series a condition reads; the authoritative implementation lives in
// core and is not duplicated for evaluation — this script evaluates nothing.
// ---------------------------------------------------------------------------

type CandleRole = 'htf_bias' | 'setup' | 'entry';

function conditionRole(conditionType: string, timeframeRole: string): CandleRole {
  if (timeframeRole === 'any') {
    return conditionType === 'htf_alignment' ? 'htf_bias' : 'setup';
  }
  if (timeframeRole === 'htf_bias') return 'htf_bias';
  if (timeframeRole === 'entry') return 'entry';
  return 'setup';
}

/**
 * `anchorOffsetOf()` from packages/contracts — the defensive read the engine
 * uses: absent, non-numeric, non-integer or non-positive ⇒ 0. Reproduced here
 * so the report can state the STORED value and the EFFECTIVE value separately
 * (a stored `null`/`"1"`/0 is all evidence).
 */
function effectiveAnchorOffset(params: Record<string, unknown> | null): number {
  const value = params?.['anchorOffsetCandles'];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Queries — every one is a SELECT.
// ---------------------------------------------------------------------------

export const Q_CONNECTION = `
  SELECT
    current_database()                                                   AS database,
    current_setting('default_transaction_read_only')                     AS default_tx_read_only,
    current_setting('transaction_read_only')                             AS tx_read_only,
    current_setting('is_superuser')                                      AS is_superuser,
    current_setting('statement_timeout')                                 AS statement_timeout,
    has_table_privilege(current_user, 'setups', 'INSERT')                AS can_insert_setups,
    has_table_privilege(current_user, 'setups', 'UPDATE')                AS can_update_setups,
    has_table_privilege(current_user, 'setups', 'DELETE')                AS can_delete_setups,
    has_table_privilege(current_user, 'alerts', 'INSERT')                AS can_insert_alerts,
    has_table_privilege(current_user, 'alerts', 'UPDATE')                AS can_update_alerts,
    has_table_privilege(current_user, 'alert_deliveries', 'INSERT')      AS can_insert_alert_deliveries,
    has_table_privilege(current_user, 'notification_deliveries', 'UPDATE') AS can_update_notification_deliveries,
    has_table_privilege(current_user, 'notification_deliveries', 'INSERT') AS can_insert_notification_deliveries,
    has_table_privilege(current_user, 'scanner_runs', 'INSERT')          AS can_insert_scanner_runs,
    has_table_privilege(current_user, 'scanner_cursors', 'UPDATE')       AS can_update_scanner_cursors,
    has_table_privilege(current_user, 'strategies', 'UPDATE')            AS can_update_strategies,
    has_table_privilege(current_user, 'strategy_versions', 'UPDATE')     AS can_update_strategy_versions
`;

const Q_SERVER_VERSION = `SELECT version() AS server_version`;

const Q_SSL = `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;

/** Latest applied migration — proves which schema the evidence came from. */
const Q_MIGRATIONS = `
  SELECT version, name, applied_at
  FROM schema_migrations
  ORDER BY version DESC
  LIMIT 5
`;

/**
 * Strategy lookup by EXACT id. No substring and no scope-based matching: both
 * were sources of ambiguity (several `gold…` strategies matched one selector and
 * the first row silently won). Exactly one row can come back.
 */
const Q_STRATEGY_BY_ID = `
  SELECT s.id,
         s.name,
         s.status,
         s.created_at,
         (SELECT count(*)::int FROM strategy_versions v WHERE v.strategy_id = s.id) AS version_count,
         'matched by exact strategy id' AS match_reason
  FROM strategies s
  WHERE s.id = $1::uuid
`;

/** Strategy lookup by EXACT, case-insensitive name (not a substring). */
const Q_STRATEGY_BY_NAME = `
  SELECT s.id,
         s.name,
         s.status,
         s.created_at,
         (SELECT count(*)::int FROM strategy_versions v WHERE v.strategy_id = s.id) AS version_count,
         'matched by exact strategy name' AS match_reason
  FROM strategies s
  WHERE lower(s.name) = lower($1)
  ORDER BY s.id
  LIMIT 5
`;

const Q_VERSIONS = `
  SELECT id, strategy_id, version_number, status, published_at, changelog
  FROM strategy_versions
  WHERE strategy_id = ANY($1::uuid[])
  ORDER BY strategy_id, version_number DESC
`;

const Q_TIMEFRAMES = `
  SELECT role, timeframe FROM strategy_timeframes WHERE version_id = $1 ORDER BY role
`;

const Q_RISK = `
  SELECT min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
         take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score
  FROM strategy_risk_config WHERE version_id = $1
`;

const Q_SCOPE = `
  SELECT sc.mode,
         COALESCE(
           json_agg(json_build_object('assetClass', i.asset_class, 'symbol', i.symbol)
                    ORDER BY i.asset_class, i.symbol) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json
         ) AS instruments
  FROM strategy_market_scopes sc
  LEFT JOIN strategy_market_scope_instruments si ON si.version_id = sc.version_id
  LEFT JOIN instruments i ON i.id = si.instrument_id
  WHERE sc.version_id = $1
  GROUP BY sc.mode
`;

const Q_CONDITIONS = `
  SELECT g.id                 AS group_id,
         g.name               AS group_name,
         g.logic              AS group_logic,
         g.position           AS group_position,
         c.id                 AS condition_id,
         c.condition_type     AS condition_type,
         c.classification     AS classification,
         c.timeframe_role     AS timeframe_role,
         c.params             AS params,
         c.position           AS position
  FROM strategy_rule_groups g
  LEFT JOIN strategy_conditions c ON c.group_id = g.id
  WHERE g.version_id = $1
  ORDER BY g.position, c.position
`;

const Q_SESSION_FILTERS = `
  SELECT session, mode, timezone FROM strategy_session_filters WHERE version_id = $1 ORDER BY session
`;

const Q_FILTERS = `
  SELECT filter_type, enabled, params, position FROM strategy_filters WHERE version_id = $1 ORDER BY position
`;

const Q_INSTRUMENT_SPEC = `
  SELECT i.id, i.asset_class, i.symbol, i.display_name,
         r.contract_size, r.pip_size, r.pnl_mode, r.quote_currency,
         r.min_quantity, r.quantity_step, r.max_quantity,
         (r.instrument_id IS NULL) AS spec_missing
  FROM instruments i
  LEFT JOIN instrument_risk_specs r ON r.instrument_id = i.id
  WHERE i.asset_class = $1 AND i.symbol = $2
`;

const Q_CANDLE_COVERAGE = `
  SELECT c.timeframe,
         count(*)::int                                   AS candles,
         min(c.ts)                                       AS first_ts,
         max(c.ts)                                       AS last_ts,
         max(c.fetched_at)                               AS last_fetched_at
  FROM candles c
  JOIN instruments i ON i.id = c.instrument_id
  WHERE i.asset_class = $1 AND i.symbol = $2
  GROUP BY c.timeframe
  ORDER BY c.timeframe
`;

const Q_SETUP_STATE_COUNTS = `
  SELECT state, count(*)::int AS setups
  FROM setups
  WHERE strategy_version_id = $1 AND instrument_id = $2
  GROUP BY state
  ORDER BY state
`;

const Q_SETUP_TOTAL = `
  SELECT count(*)::int AS total FROM setups WHERE strategy_version_id = $1 AND instrument_id = $2
`;

const Q_LATEST_SETUPS = `
  SELECT id, state, direction, detected_at, as_of_ms,
         entry_price, stop_loss_price, tp1_price, tp2_price, tp3_price,
         quality_score, metadata, updated_at, expires_at
  FROM setups
  WHERE strategy_version_id = $1 AND instrument_id = $2
  ORDER BY as_of_ms DESC
  LIMIT 10
`;

const Q_SETUP_SCORES = `
  SELECT setup_id, engine_version, total, grade, components, created_at
  FROM setup_scores
  WHERE setup_id = ANY($1::uuid[])
  ORDER BY setup_id, created_at DESC
`;

const Q_SETUP_EVENTS = `
  SELECT setup_id, from_state, to_state, reason, created_at
  FROM setup_state_events
  WHERE setup_id = ANY($1::uuid[])
  ORDER BY setup_id, id
  LIMIT 200
`;

const Q_ALERTS = `
  SELECT id, setup_id, direction, trigger_state, quality_score, min_quality_score,
         title, status, acknowledged_at, created_at
  FROM alerts
  WHERE strategy_version_id = $1 AND instrument_id = $2
  ORDER BY created_at DESC
  LIMIT 25
`;

const Q_ALERT_DELIVERIES = `
  SELECT d.alert_id, d.channel, d.status, d.attempt, d.error, d.created_at
  FROM alert_deliveries d
  JOIN alerts a ON a.id = d.alert_id
  WHERE a.strategy_version_id = $1 AND a.instrument_id = $2
  ORDER BY d.alert_id, d.id
  LIMIT 100
`;

const Q_NOTIFICATION_DELIVERIES = `
  SELECT d.alert_id, d.channel, d.template, d.status, d.attempts, d.max_attempts,
         d.failure_category, d.last_error, d.next_attempt_at, d.delivered_at, d.created_at
  FROM notification_deliveries d
  JOIN alerts a ON a.id = d.alert_id
  WHERE a.strategy_version_id = $1 AND a.instrument_id = $2
  ORDER BY d.created_at DESC
  LIMIT 100
`;

const Q_SCANNER_RUNS = `
  SELECT id, status, provider_slug, started_at, finished_at,
         strategies_scanned, instruments_scanned, candles_fetched,
         setups_detected, setups_created, alerts_created,
         stale_rejections, provider_failures,
         symbols_processed, timeframes_processed, error
  FROM scanner_runs
  ORDER BY started_at DESC
  LIMIT 5
`;

const Q_SCANNER_CURSORS = `
  SELECT timeframe, last_candle_time, last_scan_at, updated_at
  FROM scanner_cursors
  WHERE strategy_version_id = $1 AND instrument_id = $2
  ORDER BY timeframe
`;

// ---------------------------------------------------------------------------
// Unambiguous target selection (pure — unit tested)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The refusal printed when a strategy has several versions with the requested
 * number, so the operator can see exactly which rows collided. Kept as a pure
 * function (and unit tested) because a wrong separator here silently collapses
 * a multi-row refusal into one unreadable line.
 */
export function versionAmbiguityMessage(
  strategyName: string,
  version: number,
  ids: readonly string[],
): string {
  return [
    `[gold-diagnostic] refusing to continue: strategy '${strategyName}' has ${ids.length} versions numbered ${version}.`,
    ...ids.map((id) => `  - ${id}`),
    '  Nothing was read. Fix the data or select a version that is unique.',
  ].join('\n');
}

export function isStrategyUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export type StrategyChoice =
  | { kind: 'ok'; row: StrategyRow }
  | { kind: 'none' }
  | { kind: 'ambiguous'; label: string; names: string[] };

/**
 * Exactly one strategy, or a refusal. A selector that matches several strategies
 * is NEVER resolved by taking the first row: the report would silently describe
 * the wrong strategy, which is worse than collecting no evidence.
 */
export function chooseStrategy(rows: readonly StrategyRow[], selector: string): StrategyChoice {
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'ok', row: rows[0]! };
  return {
    kind: 'ambiguous',
    label: isStrategyUuid(selector) ? 'strategy id' : 'strategy name',
    names: rows.map((r) => `${r.name} (${r.id})`),
  };
}

export type VersionChoice =
  | { kind: 'ok'; version: VersionRow }
  | { kind: 'none' }
  | { kind: 'ambiguous'; ids: string[] };

/** Exactly one version with this number for the selected strategy, or a refusal. */
export function chooseVersion(versions: readonly VersionRow[], versionNumber: number): VersionChoice {
  const matching = versions.filter((v) => Number(v.version_number) === versionNumber);
  if (matching.length === 0) return { kind: 'none' };
  if (matching.length === 1) return { kind: 'ok', version: matching[0]! };
  return { kind: 'ambiguous', ids: matching.map((v) => `${v.id} v${v.version_number}`) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface Evidence {
  generatedAt: string;
  target: Options;
  /**
   * Runtime-measured safety facts. Each is computed from what the session and
   * the output actually were. A fact that cannot be established stays false.
   */
  safety: {
    /** `default_transaction_read_only` reported as `on` for this session. */
    connectionOpenedWithDefaultTransactionReadOnly: boolean;
    /** Every query went through `ReadOnlySession` inside an observed read-only txn, which was rolled back. */
    everyQueryRanInsideBeginReadOnly: boolean;
    /** No credential material was found in the output before the final scrub. */
    secretsRedacted: boolean;
  };
  /**
   * DECLARED design intent. These describe what the code is written not to
   * do. They are NOT verified by this run and the report labels them so.
   */
  declaredNotVerified: {
    triggersNothing: string[];
  };
  connection: ConnectionEvidence | null;
  migrations: { version: number; name: string; applied_at: string }[];
  candidateStrategies: StrategyRow[];
  versions: VersionRow[];
  v8: {
    found: boolean;
    id: string | null;
    status: string | null;
    publishedAt: string | null;
    changelog: string | null;
  } | null;
  timeframes: TimeframeRow[];
  risk: RiskRow | null;
  marketScope: { mode: string; instruments: unknown } | null;
  conditions: ConditionRow[];
  conditionRoleResolution: {
    conditionId: string;
    conditionType: string;
    storedTimeframeRole: string;
    resolvedRole: CandleRole;
    resolvedTimeframe: string | null;
    roleTimeframeRowPresent: boolean;
    is4h: boolean;
    storedAnchorOffsetCandles: unknown;
    storedAnchorOffsetType: string;
    effectiveAnchorOffsetCandles: number;
    classification: string | null;
    group: string;
    groupLogic: string;
    params: Record<string, unknown> | null;
    lookbackCandles: number | null;
    deepestDeclaredRead: number | null;
    candlesStoredForRole: number | null;
  }[];
  liquiditySweepFocus: {
    count: number;
    entries: {
      conditionId: string;
      group: string;
      storedTimeframeRole: string;
      resolvedTimeframe: string | null;
      is4h: boolean | null;
      storedAnchorOffsetCandles: unknown;
      effectiveAnchorOffsetCandles: number;
      params: Record<string, unknown> | null;
    }[];
  };
  sessionFilters: { session: string; mode: string; timezone: string }[];
  filters: { filter_type: string; enabled: boolean; params: unknown; position: number }[];
  instrument: Record<string, unknown> | null;
  candleCoverage: CandleCoverageRow[];
  setups: {
    total: number;
    byState: { state: string; setups: number }[];
    latest: SetupRow[];
    scores: unknown[];
    stateEvents: unknown[];
  };
  alerts: AlertRow[];
  alertDeliveries: {
    alert_id: string;
    channel: string;
    status: string;
    attempt: number;
    error: string | null;
    created_at: string;
  }[];
  notificationDeliveries: {
    alert_id: string;
    channel: string;
    template: string;
    status: string;
    attempts: number;
    max_attempts: number;
    failure_category: string;
    last_error: string | null;
    next_attempt_at: string;
    delivered_at: string | null;
    created_at: string;
  }[];
  scannerRuns: ScannerRunRow[];
  scannerCursors: { timeframe: string; last_candle_time: string; last_scan_at: string; updated_at: string }[];
  notes: string[];
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // An invalid argument is a refusal (exit 2), never a silent fall back to a
  // default: collecting evidence for a target the operator did not ask for is
  // worse than collecting none.
  let opts: Options;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OptionError) {
      console.error(`[gold-diagnostic] ${err.message}`);
      return 2;
    }
    console.error('[gold-diagnostic] invalid command-line arguments. Nothing was attempted.');
    return 2;
  }
  const notes: string[] = [];

  // --- the output path must be usable, and is never overwritten --------------
  // Both checks run before the credential is looked at and before any connection:
  // a report that already exists belongs to some other run, and this run must not
  // be able to leave it looking like fresh evidence. Nothing is deleted.
  const outputProblem = outputPathProblem(opts.outDir);
  if (outputProblem !== null) {
    console.error(`[gold-diagnostic] refusing to run: ${outputProblem}`);
    return 2;
  }
  const staleOutput = existingReportProblem(opts.outDir);
  if (staleOutput !== null) {
    console.error(`[gold-diagnostic] refusing to run: ${staleOutput}`);
    return 2;
  }

  const rawUrl = process.env['DATABASE_URL'];
  if (!rawUrl || rawUrl.trim() === '') {
    console.error(
      [
        '[gold-diagnostic] DATABASE_URL is not set — nothing was attempted.',
        '',
        '  Supply it yourself in your local shell. It is never read from a',
        '  repository or environment secret — no workflow is wired to it. The',
        '  variable must be named exactly:',
        '',
        '      DATABASE_URL',
        '',
        '  holding a connection string for a role with READ-ONLY grants on the',
        '  production database (SELECT on: strategies, strategy_versions,',
        '  strategy_timeframes, strategy_rule_groups, strategy_conditions,',
        '  strategy_risk_config, strategy_market_scopes,',
        '  strategy_market_scope_instruments, strategy_session_filters,',
        '  strategy_filters, instruments, instrument_risk_specs, candles,',
        '  setups, setup_state_events, setup_scores, alerts, alert_deliveries,',
        '  notification_deliveries, scanner_runs, scanner_cursors,',
        '  schema_migrations).',
        '',
        '  No credential is invented, defaulted or guessed, and the secret is',
        '  never printed. Set DATABASE_URL in your own shell, then re-run locally.',
      ].join('\n'),
    );
    return 2;
  }

  // --- target selection is mandatory -----------------------------------------
  // There is deliberately no default. A default such as 'gold' used to match any
  // strategy whose name contained it, and the first row silently won.
  if (opts.strategy.trim() === '') {
    console.error(
      [
        '[gold-diagnostic] --strategy is required. Nothing was attempted.',
        '',
        '  Pass the strategy UUID, or its EXACT (full) name:',
        '',
        '      --strategy 6f1c…                      # uuid',
        "      --strategy 'Gold Break & Retest Test Pro VI'   # exact name",
        '',
        '  A substring is not accepted: it can match several strategies.',
      ].join('\n'),
    );
    return 2;
  }

  // --- TLS and connection configuration: fail-closed -------------------------
  // verify-full is the default and the ONLY accepted mode. Nothing falls back
  // to unauthenticated TLS or to plaintext. If the production database needs a
  // private CA, that is a configuration blocker to report, not a reason to
  // disable verification here.
  const sslMode = process.env['DATABASE_SSL_MODE']?.trim() || 'verify-full';
  if (sslMode !== 'verify-full') {
    console.error(
      '[gold-diagnostic] DATABASE_SSL_MODE must be verify-full (the only accepted value). ' +
        'Unauthenticated TLS and plaintext are refused. Nothing was attempted.',
    );
    return 2;
  }
  const envProblem = tlsEnvProblem(process.env as Record<string, string | undefined>);
  if (envProblem !== null) {
    console.error(`[gold-diagnostic] ${envProblem}`);
    return 2;
  }
  const targetEnvProblem = connectionTargetEnvProblem(process.env as Record<string, string | undefined>);
  if (targetEnvProblem !== null) {
    console.error(`[gold-diagnostic] ${targetEnvProblem}`);
    return 2;
  }
  const urlProblem = connectionUrlProblem(rawUrl);
  if (urlProblem !== null) {
    console.error(`[gold-diagnostic] ${urlProblem}`);
    return 2;
  }
  const secretValues = secretValuesFrom(rawUrl);

  const pool = new pg.Pool({
    connectionString: rawUrl,
    max: 2,
    // Certificate chain and hostname are both verified (Node TLS default for
    // rejectUnauthorized: true). The URL is checked above so that it cannot
    // override this with sslmode/ssl parameters.
    ssl: { rejectUnauthorized: true },
    application_name: 'veltrixeye-gold-diagnostic',
    // The load-bearing safety switch: EVERY session this pool opens comes up
    // with read-only as its transaction default.
    options: '-c default_transaction_read_only=on',
  });

  const evidence: Evidence = {
    generatedAt: new Date().toISOString(),
    target: opts,
    // Starts false. Each flag is set to true only by a runtime check below.
    safety: {
      connectionOpenedWithDefaultTransactionReadOnly: false,
      everyQueryRanInsideBeginReadOnly: false,
      secretsRedacted: false,
    },
    declaredNotVerified: {
      triggersNothing: [
        'no ScannerService — no scan is started',
        'no AlertService — no alert is generated',
        'no NotificationWorker — the outbox is not drained',
        'no SetupService — no detection is run',
        'no execution/risk service — no order is placed',
        'no outbound HTTP/SMTP/webhook/push — the only socket is one read-only Postgres connection',
      ],
    },
    connection: null,
    migrations: [],
    candidateStrategies: [],
    versions: [],
    v8: null,
    timeframes: [],
    risk: null,
    marketScope: null,
    conditions: [],
    conditionRoleResolution: [],
    liquiditySweepFocus: { count: 0, entries: [] },
    sessionFilters: [],
    filters: [],
    instrument: null,
    candleCoverage: [],
    setups: { total: 0, byState: [], latest: [], scores: [], stateEvents: [] },
    alerts: [],
    alertDeliveries: [],
    notificationDeliveries: [],
    scannerRuns: [],
    scannerCursors: [],
    notes,
  };

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`[gold-diagnostic] cannot reach the database (error code: ${errorCodeOf(err)}). The driver message is withheld; it can contain the connection string.`);
    await pool.end().catch(() => {});
    return 3;
  }

  const ro = new ReadOnlySession(client);
  try {
    // One explicit read-only transaction for the whole session: nothing this
    // script ever issues can mutate the database, whatever the role's grants.
    // Every later query goes through `ro`, which refuses to run outside it.
    await ro.begin();
    // Bound the read cost on a live production database.
    await ro.query("SET LOCAL statement_timeout = '30s'");

    const connRes = await ro.query<Record<string, unknown>>(Q_CONNECTION);
    const versionRes = await ro.query<{ server_version: string }>(Q_SERVER_VERSION);
    let sslValue: boolean | null = null;
    try {
      const sslRes = await ro.query<{ ssl: boolean }>(Q_SSL);
      sslValue = sslRes.rows[0]?.ssl ?? null;
    } catch {
      sslValue = null; // pg_stat_ssl unavailable — not evidence, ignored
    }
    const c = connRes.rows[0] ?? {};
    // Runtime facts, read from the server rather than assumed — the same helper
    // the tests use, so an unexpected answer fails closed on both paths.
    const facts = factsFromConnectionRow(c);
    ro.observeTransactionReadOnly(facts.transactionReadOnly);
    evidence.safety.connectionOpenedWithDefaultTransactionReadOnly = facts.defaultTransactionReadOnly === 'on';

    // FAIL CLOSED: a session that is not provably read-only, or a role that can
    // write, is refused before a single evidence query runs.
    const safety = evaluateSafety(facts);
    if (!safety.ok) {
      console.error(
        [
          '[gold-diagnostic] refusing to continue: the session is not provably safe.',
          ...safety.violations.map((v) => `  - ${v}`),
          '  Nothing further was read and no report was written.',
        ].join('\n'),
      );
      await ro.end().catch(() => {});
      return 3;
    }

    evidence.connection = {
      database: String(c['database'] ?? ''),
      serverVersion: redact(String(versionRes.rows[0]?.server_version ?? '')),
      tlsRequestedMode: 'verify-full',
      ssl: sslValue,
      defaultTransactionReadOnly: facts.defaultTransactionReadOnly,
      transactionReadOnly: facts.transactionReadOnly,
      isSuperuser: facts.isSuperuser,
      statementTimeout: String(c['statement_timeout'] ?? ''),
      privileges: facts.writePrivileges,
    };

    try {
      const migRes = await ro.query<{ version: number; name: string; applied_at: string }>(Q_MIGRATIONS);
      evidence.migrations = migRes.rows.map((r) => ({
        version: Number(r.version),
        name: String(r.name),
        applied_at: isoOrNull(r.applied_at) ?? '',
      }));
    } catch {
      notes.push('schema_migrations could not be read (absent or no privilege) — schema version unverified.');
    }

    // --- strategy: EXACT id or EXACT name, never a substring -------------------
    const byId = isStrategyUuid(opts.strategy);
    const stratRes = byId
      ? await ro.query<StrategyRow>(Q_STRATEGY_BY_ID, [opts.strategy.trim()])
      : await ro.query<StrategyRow>(Q_STRATEGY_BY_NAME, [opts.strategy.trim()]);
    evidence.candidateStrategies = stratRes.rows;
    const choice = chooseStrategy(stratRes.rows, opts.strategy);

    if (choice.kind === 'ambiguous') {
      // Refuse rather than pick one: reporting evidence for the wrong strategy is
      // worse than reporting none.
      console.error(
        [
          `[gold-diagnostic] refusing to continue: --strategy matched ${choice.names.length} strategies by ${choice.label}.`,
          ...choice.names.map((n) => `  - ${n}`),
          '  Pass the strategy UUID with --strategy <uuid> (or make the name unique). Nothing was read.',
        ].join('\n'),
      );
      await ro.end().catch(() => {});
      return 3;
    }
    if (choice.kind === 'none') {
      console.error(
        `[gold-diagnostic] no strategy matches ${byId ? 'the id' : 'the exact name'} given by --strategy. ` +
          'Nothing was read. (Matching is exact: a UUID or the full strategy name, never a substring.)',
      );
      await ro.end().catch(() => {});
      return 3;
    }
    const selectedStrategy = choice.row;

    // --- versions ------------------------------------------------------------
    {
      const verRes = await ro.query<VersionRow>(Q_VERSIONS, [[selectedStrategy.id]]);
      evidence.versions = verRes.rows.map((r) => ({
        id: String(r.id),
        strategy_id: String(r.strategy_id),
        version_number: Number(r.version_number),
        status: String(r.status),
        published_at: isoOrNull(r.published_at),
        changelog: safeText(r.changelog, 500),
      }));
    }

    // --- instrument + authoritative pip size ----------------------------------
    // Reported whether or not the target version exists: a missing pip size is
    // itself the finding, so it must never be hidden behind "no v8".
    const instRes = await ro.query<Record<string, unknown>>(Q_INSTRUMENT_SPEC, [opts.assetClass, opts.symbol]);
    evidence.instrument = instRes.rows[0]
      ? {
          id: String(instRes.rows[0]['id'] ?? ''),
          assetClass: String(instRes.rows[0]['asset_class'] ?? ''),
          symbol: String(instRes.rows[0]['symbol'] ?? ''),
          displayName: instRes.rows[0]['display_name'] ?? null,
          specPresent: instRes.rows[0]['spec_missing'] === false,
          pipSize: instRes.rows[0]['pip_size'] ?? null,
          contractSize: instRes.rows[0]['contract_size'] ?? null,
          pnlMode: instRes.rows[0]['pnl_mode'] ?? null,
          quoteCurrency: instRes.rows[0]['quote_currency'] ?? null,
        }
      : null;
    if (!evidence.instrument) {
      notes.push(`Instrument ${opts.assetClass}/${opts.symbol} is not present in the production database.`);
    } else if (evidence.instrument['specPresent'] !== true) {
      notes.push(
        `No instrument_risk_specs row exists for ${opts.assetClass}/${opts.symbol} — ` +
          'a pips-denominated stop-loss buffer fails closed for BOTH directions by design.',
      );
    }
    const instrumentId = evidence.instrument ? String(evidence.instrument['id']) : null;

    // --- candle coverage ------------------------------------------------------
    const covRes = await ro.query<CandleCoverageRow>(Q_CANDLE_COVERAGE, [opts.assetClass, opts.symbol]);
    evidence.candleCoverage = covRes.rows.map((r) => ({
      timeframe: String(r.timeframe),
      candles: Number(r.candles),
      first_ts: r.first_ts === null ? null : String(r.first_ts),
      last_ts: r.last_ts === null ? null : String(r.last_ts),
      last_fetched_at: isoOrNull(r.last_fetched_at),
    }));
    const candlesByTimeframe = new Map<string, number>(
      evidence.candleCoverage.map((r) => [r.timeframe, Number(r.candles)]),
    );

    const versionChoice = chooseVersion(evidence.versions, opts.version);
    if (versionChoice.kind === 'ambiguous') {
      console.error(versionAmbiguityMessage(selectedStrategy.name, opts.version, versionChoice.ids));
      await ro.end().catch(() => {});
      return 3;
    }
    const v8 = versionChoice.kind === 'ok' ? versionChoice.version : null;
    if (!v8) {
      notes.push(
        `No version_number = ${opts.version} exists for strategy '${selectedStrategy.name}'. ` +
          'v8 configuration evidence is therefore ABSENT, not zero-valued.',
      );
    } else {
      evidence.v8 = {
        found: true,
        id: v8.id,
        status: v8.status,
        publishedAt: v8.published_at,
        changelog: v8.changelog,
      };

      const tfRes = await ro.query<TimeframeRow>(Q_TIMEFRAMES, [v8.id]);
      evidence.timeframes = tfRes.rows.map((r) => ({ role: String(r.role), timeframe: String(r.timeframe) }));
      const roleToTimeframe = new Map<string, string>(evidence.timeframes.map((t) => [t.role, t.timeframe]));

      const riskRes = await ro.query<RiskRow>(Q_RISK, [v8.id]);
      evidence.risk = riskRes.rows[0] ?? null;

      const scopeRes = await ro.query<{ mode: string; instruments: unknown }>(Q_SCOPE, [v8.id]);
      evidence.marketScope = scopeRes.rows[0] ?? null;

      const condRes = await ro.query<ConditionRow>(Q_CONDITIONS, [v8.id]);
      evidence.conditions = condRes.rows.map((r) => ({
        group_id: String(r.group_id),
        group_name: String(r.group_name),
        group_logic: String(r.group_logic),
        group_position: Number(r.group_position),
        condition_id: r.condition_id ? String(r.condition_id) : null,
        condition_type: r.condition_type ? String(r.condition_type) : null,
        classification: r.classification ? String(r.classification) : null,
        timeframe_role: r.timeframe_role ? String(r.timeframe_role) : null,
        params: (r.params ?? null) as Record<string, unknown> | null,
        position: r.position === null || r.position === undefined ? null : Number(r.position),
      }));

      const sfRes = await ro.query<{ session: string; mode: string; timezone: string }>(Q_SESSION_FILTERS, [
        v8.id,
      ]);
      evidence.sessionFilters = sfRes.rows;

      const fRes = await ro.query<{ filter_type: string; enabled: boolean; params: unknown; position: number }>(
        Q_FILTERS,
        [v8.id],
      );
      evidence.filters = fRes.rows;

      // --- per-condition role resolution -------------------------------------
      evidence.conditionRoleResolution = evidence.conditions
        .filter((c) => c.condition_id !== null && c.condition_type !== null)
        .map((c) => {
          const type = String(c.condition_type);
          const storedRole = String(c.timeframe_role);
          const resolvedRole = conditionRole(type, storedRole);
          const tf = roleToTimeframe.get(resolvedRole) ?? null;
          const params = c.params;
          const lookbackRaw = params?.['lookbackCandles'];
          const lookback = num(lookbackRaw);
          const offset = effectiveAnchorOffset(params);
          const storedOffset = params ? (params['anchorOffsetCandles'] ?? null) : null;
          return {
            conditionId: String(c.condition_id),
            conditionType: type,
            storedTimeframeRole: storedRole,
            resolvedRole,
            resolvedTimeframe: tf,
            roleTimeframeRowPresent: tf !== null,
            is4h: tf === '4h',
            storedAnchorOffsetCandles: storedOffset,
            storedAnchorOffsetType:
              storedOffset === null ? 'absent' : Array.isArray(storedOffset) ? 'array' : typeof storedOffset,
            effectiveAnchorOffsetCandles: offset,
            classification: c.classification,
            group: c.group_name,
            groupLogic: c.group_logic,
            params,
            lookbackCandles: lookback,
            // Lower bound only: the engine also enforces a 120-candle minimum
            // window and adds a 60-candle margin (requiredWindows() in core).
            deepestDeclaredRead: (lookback ?? 0) > 0 || offset > 0 ? (lookback ?? 0) + offset : null,
            candlesStoredForRole: tf === null ? null : (candlesByTimeframe.get(tf) ?? 0),
          };
        });

      const sweeps = evidence.conditionRoleResolution.filter((c) => c.conditionType === 'liquidity_sweep');
      evidence.liquiditySweepFocus = {
        count: sweeps.length,
        entries: sweeps.map((s) => ({
          conditionId: s.conditionId,
          group: s.group,
          storedTimeframeRole: s.storedTimeframeRole,
          resolvedTimeframe: s.resolvedTimeframe,
          is4h: s.roleTimeframeRowPresent ? s.is4h : null,
          storedAnchorOffsetCandles: s.storedAnchorOffsetCandles,
          effectiveAnchorOffsetCandles: s.effectiveAnchorOffsetCandles,
          params: s.params,
        })),
      };
      if (sweeps.length === 0) {
        notes.push(`v${opts.version} contains NO liquidity_sweep condition — the 4H sweep premise is absent.`);
      }

      // --- setup / alert / delivery evidence ---------------------------------
      if (instrumentId) {
        const totalRes = await ro.query<{ total: number }>(Q_SETUP_TOTAL, [v8.id, instrumentId]);
        evidence.setups.total = Number(totalRes.rows[0]?.total ?? 0);

        const stateRes = await ro.query<{ state: string; setups: number }>(Q_SETUP_STATE_COUNTS, [
          v8.id,
          instrumentId,
        ]);
        evidence.setups.byState = stateRes.rows.map((r) => ({ state: String(r.state), setups: Number(r.setups) }));

        const latestRes = await ro.query<SetupRow>(Q_LATEST_SETUPS, [v8.id, instrumentId]);
        evidence.setups.latest = latestRes.rows.map((r) => ({
          id: String(r.id),
          state: String(r.state),
          direction: String(r.direction),
          detected_at: isoOrNull(r.detected_at) ?? '',
          as_of_ms: String(r.as_of_ms),
          entry_price: r.entry_price === null ? null : String(r.entry_price),
          stop_loss_price: r.stop_loss_price === null ? null : String(r.stop_loss_price),
          tp1_price: r.tp1_price === null ? null : String(r.tp1_price),
          tp2_price: r.tp2_price === null ? null : String(r.tp2_price),
          tp3_price: r.tp3_price === null ? null : String(r.tp3_price),
          quality_score: num(r.quality_score),
          metadata: (r.metadata ?? null) as Record<string, unknown> | null,
          updated_at: isoOrNull(r.updated_at) ?? '',
          expires_at: isoOrNull(r.expires_at),
        }));

        const setupIds = evidence.setups.latest.map((s) => s.id);
        if (setupIds.length > 0) {
          const scoresRes = await ro.query<Record<string, unknown>>(Q_SETUP_SCORES, [setupIds]);
          evidence.setups.scores = scoresRes.rows.map((r) => ({
            setupId: String(r['setup_id'] ?? ''),
            engineVersion: String(r['engine_version'] ?? ''),
            total: num(r['total']),
            grade: String(r['grade'] ?? ''),
            components: r['components'] ?? null,
            createdAt: isoOrNull(r['created_at']),
          }));

          const evRes = await ro.query<Record<string, unknown>>(Q_SETUP_EVENTS, [setupIds]);
          evidence.setups.stateEvents = evRes.rows.map((r) => ({
            setupId: String(r['setup_id'] ?? ''),
            fromState: r['from_state'] ?? null,
            toState: String(r['to_state'] ?? ''),
            reason: safeText(r['reason'], 280),
            createdAt: isoOrNull(r['created_at']),
          }));
        }

        const alertRes = await ro.query<AlertRow>(Q_ALERTS, [v8.id, instrumentId]);
        evidence.alerts = alertRes.rows.map((r) => ({
          id: String(r.id),
          setup_id: String(r.setup_id),
          direction: String(r.direction),
          trigger_state: String(r.trigger_state),
          quality_score: Number(r.quality_score),
          min_quality_score: Number(r.min_quality_score),
          title: safeText(r.title, 280) ?? '',
          status: String(r.status),
          acknowledged_at: isoOrNull(r.acknowledged_at),
          created_at: isoOrNull(r.created_at) ?? '',
        }));

        const adRes = await ro.query<Record<string, unknown>>(Q_ALERT_DELIVERIES, [v8.id, instrumentId]);
        evidence.alertDeliveries = adRes.rows.map((r) => ({
          alert_id: String(r['alert_id'] ?? ''),
          channel: String(r['channel'] ?? ''),
          status: String(r['status'] ?? ''),
          attempt: Number(r['attempt'] ?? 0),
          error: safeText(r['error'], 300),
          created_at: isoOrNull(r['created_at']) ?? '',
        }));

        const ndRes = await ro.query<Record<string, unknown>>(Q_NOTIFICATION_DELIVERIES, [v8.id, instrumentId]);
        evidence.notificationDeliveries = ndRes.rows.map((r) => ({
          alert_id: String(r['alert_id'] ?? ''),
          channel: String(r['channel'] ?? ''),
          template: String(r['template'] ?? ''),
          status: String(r['status'] ?? ''),
          attempts: Number(r['attempts'] ?? 0),
          max_attempts: Number(r['max_attempts'] ?? 0),
          failure_category: String(r['failure_category'] ?? ''),
          last_error: safeText(r['last_error'], 300),
          next_attempt_at: isoOrNull(r['next_attempt_at']) ?? '',
          delivered_at: isoOrNull(r['delivered_at']),
          created_at: isoOrNull(r['created_at']) ?? '',
        }));

        const curRes = await ro.query<Record<string, unknown>>(Q_SCANNER_CURSORS, [v8.id, instrumentId]);
        evidence.scannerCursors = curRes.rows.map((r) => ({
          timeframe: String(r['timeframe'] ?? ''),
          last_candle_time: String(r['last_candle_time'] ?? ''),
          last_scan_at: isoOrNull(r['last_scan_at']) ?? '',
          updated_at: isoOrNull(r['updated_at']) ?? '',
        }));
      }

    }

    // --- scanner runs (global, non-identifying columns only) ------------------
    const runRes = await ro.query<ScannerRunRow>(Q_SCANNER_RUNS);
    evidence.scannerRuns = runRes.rows.map((r) => ({
      id: String(r.id),
      status: String(r.status),
      provider_slug: String(r.provider_slug),
      started_at: isoOrNull(r.started_at) ?? '',
      finished_at: isoOrNull(r.finished_at),
      strategies_scanned: Number(r.strategies_scanned),
      instruments_scanned: Number(r.instruments_scanned),
      candles_fetched: Number(r.candles_fetched),
      setups_detected: Number(r.setups_detected),
      setups_created: Number(r.setups_created),
      alerts_created: Number(r.alerts_created),
      stale_rejections: Number(r.stale_rejections),
      provider_failures: Number(r.provider_failures),
      symbols_processed: r.symbols_processed ?? null,
      timeframes_processed: r.timeframes_processed ?? null,
      error: safeText(r.error, 300),
    }));

    await ro.end();
    evidence.safety.everyQueryRanInsideBeginReadOnly = ro.allQueriesInsideReadOnly;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[gold-diagnostic] query failed (error code: ${errorCodeOf(err)}). The database message is withheld; it can contain row values.`);
    return 3;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }

  // --- output check: measure, scrub, verify — before anything is written ----
  // Every string in the evidence (keys included) is checked for credential
  // material. `secretsRedacted` is true only if the raw evidence was already
  // clean. If anything had to be scrubbed, the report says so.
  const leakedBeforeScrub = anyStringLeaks(evidence, secretValues);
  const finalEvidence: Evidence = mapStrings(evidence, (s) => scrubSecrets(s, secretValues));
  finalEvidence.safety.secretsRedacted = !leakedBeforeScrub;
  if (anyStringLeaks(finalEvidence, secretValues)) {
    console.error('[gold-diagnostic] output check failed: credential material survived scrubbing. Nothing was written.');
    return 3;
  }

  // --- write report ---------------------------------------------------------
  // `writeReport` re-checks for an existing report and opens both files
  // exclusively, so an earlier report is never replaced — even if another run
  // finished while this one was reading.
  try {
    writeReport(opts.outDir, finalEvidence);
  } catch (err) {
    if (err instanceof ReportWriteError) {
      console.error(`[gold-diagnostic] ${err.stale ? 'refusing to write' : 'report'} ${err.message}`);
      return 3;
    }
    throw err;
  }

  // stdout carries a status line only. The report is never printed and never
  // uploaded: it stays in the two local files above, inside a gitignored
  // directory on the operator's machine.
  console.info(`[gold-diagnostic] completed. Evidence written to ${opts.outDir}/ (JSON and Markdown).`);
  console.info(`[gold-diagnostic] output check: secretsRedacted=${finalEvidence.safety.secretsRedacted}.`);
  console.info('[gold-diagnostic] The report is NOT printed here and is NOT uploaded anywhere. It stays local.');
  return 0;
}

// ---------------------------------------------------------------------------
// Output files: a previous report is never overwritten
// ---------------------------------------------------------------------------

export const REPORT_JSON_NAME = 'gold-v8-production-evidence.json';
export const REPORT_MD_NAME = 'gold-v8-production-evidence.md';

export function reportPaths(outDir: string): { jsonPath: string; mdPath: string } {
  return { jsonPath: path.join(outDir, REPORT_JSON_NAME), mdPath: path.join(outDir, REPORT_MD_NAME) };
}

/**
 * Refuse an `--out` that exists but is not a directory. Without this check the
 * run would connect, read the whole database and only then fail in `mkdirSync`
 * with a bare `EEXIST`; a path that cannot hold the report is a configuration
 * refusal (exit 2), decided before the credential is read and before any
 * connection is opened. A path that does not exist yet is fine — it is created
 * on write — and nothing is ever deleted or created here.
 */
export function outputPathProblem(outDir: string): string | null {
  let stat;
  try {
    stat = statSync(outDir);
  } catch {
    return null; // missing: fine, the write creates it
  }
  if (stat.isDirectory()) return null;
  return (
    `--out '${outDir}' exists but is not a directory. Pass a directory path — it is created if it does not ` +
    'exist, and the two report files are written inside it. Nothing was attempted and nothing was modified.'
  );
}

/**
 * Refuse to write over an existing report. A refused or failed run must never be
 * mistakable for a successful one, so an earlier report is neither deleted nor
 * replaced: the operator moves it aside or passes another `--out`. Only the two
 * report file names are ever considered — nothing else in the directory is
 * touched.
 */
export function existingReportProblem(outDir: string): string | null {
  const { jsonPath, mdPath } = reportPaths(outDir);
  const present = [jsonPath, mdPath].filter((file) => existsSync(file));
  if (present.length === 0) return null;
  return [
    `a report already exists in ${outDir}/:`,
    ...present.map((file) => `  - ${file}`),
    "  An earlier run wrote it, so this run writes nothing and the old report cannot be",
    "  mistaken for this run's evidence. Move it aside (or pass a different --out).",
  ].join('\n');
}

/**
 * Thrown when the report cannot be written: either a report is already there
 * (`stale`, a refusal) or the write itself failed. `main()` maps both to exit 3.
 */
export class ReportWriteError extends Error {
  constructor(
    message: string,
    readonly stale: boolean,
  ) {
    super(message);
    this.name = 'ReportWriteError';
  }
}

/** The two filesystem calls `writeReport` makes, injectable so a failing write is testable. */
export interface ReportWriteIo {
  writeFile?: (file: string, data: string, options: { encoding: 'utf8'; flag: 'wx' }) => void;
  removeFile?: (file: string) => void;
}

/**
 * Render and write the report. This is the ONLY write path — `main()` uses it and
 * so do the tests — and it never replaces an existing report: the guard runs
 * again here, and both files are opened with the exclusive `wx` flag, so an
 * earlier report survives even if another run finished during this one.
 *
 * The pair is written JSON-first, Markdown-second. If the Markdown write fails,
 * the JSON this attempt just created is removed again, so a failed run cannot
 * leave a JSON-only report (with this run's `generatedAt`) behind. Nothing else
 * is ever deleted: the guard and the `wx` flag together mean the JSON can only
 * be this attempt's file, and a pre-existing report is refused before any write.
 */
export function writeReport(
  outDir: string,
  evidence: Parameters<typeof renderMarkdown>[0],
  io: ReportWriteIo = {},
): { jsonPath: string; mdPath: string } {
  const writeFile = io.writeFile ?? ((file, data, options) => writeFileSync(file, data, options));
  const removeFile = io.removeFile ?? ((file) => unlinkSync(file));
  const stale = existingReportProblem(outDir);
  if (stale !== null) throw new ReportWriteError(stale, true);
  const markdown = renderMarkdown(evidence);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    throw new ReportWriteError(
      `could not be written: the output directory could not be created (error code: ${errorCodeOf(err)}); nothing was written`,
      false,
    );
  }
  const { jsonPath, mdPath } = reportPaths(outDir);
  let jsonCreated = false;
  try {
    writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    jsonCreated = true;
    writeFile(mdPath, markdown, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // Only the JSON created by THIS attempt is removed; a pre-existing file is
    // refused earlier and the `wx` flag forbids replacing one.
    let cleanup = '';
    if (jsonCreated) {
      try {
        removeFile(jsonPath);
      } catch {
        cleanup = `; the partial JSON at ${jsonPath} could not be removed and should be deleted by hand`;
      }
    }
    throw new ReportWriteError(
      `could not be written (error code: ${errorCodeOf(err)}); no existing file was overwritten${cleanup}`,
      false,
    );
  }
  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** True if any string in `value` (keys included) still carries credential material. */
function anyStringLeaks(value: unknown, secretValues: readonly string[]): boolean {
  let found = false;
  mapStrings(value, (s) => {
    if (leaksSecret(s, secretValues)) found = true;
    return s;
  });
  return found;
}

/**
 * JSON in a fenced code block whose fence is longer than any backtick run in the
 * payload. A value containing ``` would otherwise close the fence early and
 * inject arbitrary Markdown into the report.
 */
export function jsonBlock(value: unknown): string {
  const body = JSON.stringify(value ?? null, null, 2);
  const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}json`, body, fence].join('\n');
}

/**
 * Escape the three HTML-sensitive characters, ampersand FIRST so the entities
 * this inserts are not escaped again. Markdown passes raw HTML through, so a
 * database value containing `<img …>` would otherwise become a live element in
 * the report; `&lt;` renders as the character the operator needs to read.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A database-derived value placed INSIDE an inline code span. Code spans are
 * literal: HTML is not parsed there and a pipe cannot split a cell, so only the
 * two characters that could end the span early are neutralised — newlines are
 * collapsed and backticks become apostrophes. The value stays byte-readable.
 */
export function mdCode(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'");
}

/**
 * A value placed inside a Markdown table cell: backslashes are doubled first,
 * then pipes are escaped (they would split the row), newlines collapsed,
 * backticks neutralised and HTML entities escaped. Doubling the backslashes
 * first is what keeps the pipe behind an ODD number of backslashes — otherwise
 * `a\|b` would render as an escaped backslash followed by a live cell
 * delimiter.
 */
export function mdCell(value: unknown): string {
  return escapeHtml(
    String(value ?? '')
      // Backslashes FIRST. Escaping `|` alone is not enough: a value that already
      // contains `a\|b` would otherwise become `a\\|b`, where Markdown reads
      // `\\` as an escaped backslash and lets the `|` act as a cell delimiter —
      // an even number of backslashes un-escapes the pipe. Doubling first means
      // the pipe always ends up behind an ODD number of backslashes, so it is
      // always escaped.
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]+/g, ' ')
      .replace(/`/g, "'"),
  );
}

/**
 * A database-derived value rendered as ordinary Markdown TEXT — a heading, a
 * bullet line or the inside of an inline code span. `mdCell` cannot be used here
 * (it escapes table separators), so this does the other half of the job:
 * newlines are collapsed, so a value can never begin a new Markdown line (a
 * heading, a fence, a table row or a list item), and backticks are removed, so a
 * value can never open or close a code span or a fence. The value stays
 * readable; only characters that are Markdown structure are neutralised.
 *
 * It then escapes `&`, `<` and `>`: Markdown renders raw HTML, so a database
 * value such as `<img src=x onerror=…>` would otherwise become a live element.
 * The escaped form still reads as the original text.
 *
 * Every interpolation of database-, server- or operator-derived text in
 * `renderMarkdown` goes through `mdCell` (table cells), `mdCode` (the inside of
 * an inline code span), `jsonBlock` (structured payloads) or this function.
 * Literal report prose is never built from data.
 */
export function mdText(value: unknown): string {
  return escapeHtml(mdCode(value));
}

/**
 * One Markdown table row. EVERY cell goes through `mdCell`, so a database value
 * cannot inject a column separator, a newline or a code fence — there is no way
 * to add a row and forget to escape it.
 */
export function mdRow(cells: readonly unknown[]): string {
  return `| ${cells.map((cell) => mdCell(cell)).join(' | ')} |`;
}

export function renderMarkdown(e: Evidence): string {
  const out: string[] = [];
  out.push('# Production Gold diagnostics — v8/XAUUSD evidence (read-only)');
  out.push('');
  out.push(`Generated (UTC): \`${mdCode(e.generatedAt)}\``);
  out.push('');
  out.push(`Target: exact strategy selector \`${mdCode(e.target.strategy)}\`, version \`${e.target.version}\`, instrument \`${mdCode(e.target.assetClass)}/${mdCode(e.target.symbol)}\`.`);
  out.push('');
  out.push('> This report is EVIDENCE ONLY. It changes nothing and recommends nothing.');
  out.push('');

  out.push('## 1. Safety / read-only proof');
  out.push('');
  out.push('### 1.1 Runtime-verified (measured during this run)');
  out.push('');
  out.push(`- Connection opened with \`default_transaction_read_only=on\`: **${e.safety.connectionOpenedWithDefaultTransactionReadOnly}**`);
  out.push(`- Every query ran inside one \`BEGIN READ ONLY\` … \`ROLLBACK\` (server reported read-only; no query issued outside it): **${e.safety.everyQueryRanInsideBeginReadOnly}**`);
  out.push(`- No credential material in the raw output before the final scrub (\`false\` = material was found and scrubbed): **${e.safety.secretsRedacted}**`);
  out.push('');
  out.push('### 1.2 Declared design intent (NOT verified by this run)');
  out.push('');
  out.push('These describe what the code is written not to do. They are not runtime evidence.');
  out.push('');
  for (const line of e.declaredNotVerified.triggersNothing) out.push(`- ${mdText(line)}`);
  out.push('');
  if (e.connection) {
    out.push(`- Database: \`${mdCode(e.connection.database)}\` (role name intentionally not printed)`);
    out.push(`- Server: ${mdText(e.connection.serverVersion.split(',').slice(0, 1).join(''))}`);
    out.push(`- TLS requested by this run: \`${e.connection.tlsRequestedMode}\` (configuration: certificate chain and hostname verified by the client)`);
    out.push(`- TLS observed for this session (\`pg_stat_ssl\`): ${e.connection.ssl === null ? 'unknown' : e.connection.ssl ? 'yes' : 'no'}`);
    out.push(`- \`default_transaction_read_only\` = \`${mdCode(e.connection.defaultTransactionReadOnly)}\``);
    out.push(`- \`transaction_read_only\` (inside the txn) = \`${mdCode(e.connection.transactionReadOnly)}\``);
    out.push(`- \`statement_timeout\` = \`${mdCode(e.connection.statementTimeout)}\``);
    out.push('');
    out.push('Effective privileges of the connecting role (booleans via `has_table_privilege`):');
    out.push('');
    out.push('| privilege | value |');
    out.push('| --- | --- |');
    for (const [k, v] of Object.entries(e.connection.privileges)) {
      out.push(mdRow([k, v === null ? 'unknown' : String(v)]));
    }
    out.push('');
  }
  if (e.migrations.length > 0) {
    out.push('Latest applied migrations:');
    out.push('');
    out.push('| version | name | applied_at |');
    out.push('| --- | --- | --- |');
    for (const m of e.migrations) out.push(mdRow([m.version, m.name, m.applied_at]));
    out.push('');
  }

  out.push('## 2. Candidate strategies');
  out.push('');
  if (e.candidateStrategies.length === 0) {
    out.push('_None matched._');
  } else {
    out.push('| id | name | status | versions | created_at | matched because |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of e.candidateStrategies) {
      out.push(mdRow([s.id, s.name, s.status, s.version_count, isoOrNull(s.created_at) ?? '', s.match_reason]));
    }
  }
  out.push('');

  out.push('## 3. Versions of the matched strategies');
  out.push('');
  if (e.versions.length === 0) {
    out.push('_None._');
  } else {
    out.push('| version | id | status | published_at | changelog |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const v of e.versions) {
      out.push(mdRow([v.version_number, v.id, v.status, v.published_at ?? '—', v.changelog ?? '—']));
    }
  }
  out.push('');

  out.push(`## 4. v${e.target.version} configuration`);
  out.push('');
  if (!e.v8?.found) {
    out.push(`_v${e.target.version} was not found — the configuration evidence below is ABSENT, not zero._`);
    out.push('');
  } else {
    out.push(`- version id: \`${mdCode(e.v8.id)}\``);
    out.push(`- status: \`${mdCode(e.v8.status)}\`${e.v8.status !== 'published' ? '  ⚠ not published — a non-published version is never scanned' : ''}`);
    out.push(`- published_at: ${e.v8.publishedAt === null ? '—' : mdText(e.v8.publishedAt)}`);
    out.push('');
    out.push('### 4.1 Role → timeframe');
    out.push('');
    if (e.timeframes.length === 0) {
      out.push('_No `strategy_timeframes` rows._');
    } else {
      out.push('| role | timeframe |');
      out.push('| --- | --- |');
      for (const t of e.timeframes) out.push(mdRow([t.role, t.timeframe]));
    }
    out.push('');
    out.push('### 4.2 Risk config');
    out.push('');
    out.push(e.risk ? jsonBlock(e.risk) : '_No `strategy_risk_config` row._');
    out.push('');
    out.push('### 4.3 Market scope');
    out.push('');
    out.push(e.marketScope ? jsonBlock(e.marketScope) : '_No `strategy_market_scopes` row._');
    out.push('');
    out.push('### 4.4 All conditions, with the role each one reads');
    out.push('');
    if (e.conditionRoleResolution.length === 0) {
      out.push('_No conditions._');
    } else {
      out.push('| # | group (logic) | type | classification | stored `timeframe_role` | resolves to role | that role\'s timeframe | is 4h | stored `anchorOffsetCandles` | effective offset | lookback | stored candles for that tf |');
      out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      e.conditionRoleResolution.forEach((c, i) => {
        out.push(
          mdRow([
            i + 1,
            `${c.group} (${c.groupLogic})`,
            c.conditionType,
            c.classification,
            c.storedTimeframeRole,
            c.resolvedRole,
            c.resolvedTimeframe ? c.resolvedTimeframe : '⚠ no row',
            c.roleTimeframeRowPresent ? (c.is4h ? 'yes' : 'no') : '?',
            `${JSON.stringify(c.storedAnchorOffsetCandles)} (${c.storedAnchorOffsetType})`,
            c.effectiveAnchorOffsetCandles,
            c.lookbackCandles ?? '—',
            c.candlesStoredForRole ?? '—',
          ]),
        );
      });
      out.push('');
      out.push(
        '`deepestDeclaredRead` per condition (lookback + offset — a LOWER BOUND; the engine also enforces a 120-candle minimum window and adds a 60-candle margin):',
      );
      out.push('');
      out.push('| type | role | timeframe | lookback | offset | deepest declared read | candles stored |');
      out.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const c of e.conditionRoleResolution) {
        out.push(
          mdRow([
            c.conditionType,
            c.resolvedRole,
            c.resolvedTimeframe ? c.resolvedTimeframe : '—',
            c.lookbackCandles ?? '—',
            c.effectiveAnchorOffsetCandles,
            c.deepestDeclaredRead ?? '—',
            c.candlesStoredForRole ?? '—',
          ]),
        );
      }
    }
    out.push('');
    out.push('### 4.5 4H liquidity-sweep focus');
    out.push('');
    if (e.liquiditySweepFocus.count === 0) {
      out.push(`_v${e.target.version} contains no \`liquidity_sweep\` condition._`);
    } else {
      out.push(jsonBlock(e.liquiditySweepFocus));
    }
    out.push('');
    out.push('### 4.6 Session + strategy filters');
    out.push('');
    out.push(jsonBlock({ sessionFilters: e.sessionFilters, filters: e.filters }));
    out.push('');
  }

  out.push('## 5. Instrument and authoritative pip size');
  out.push('');
  out.push(e.instrument ? jsonBlock(e.instrument) : '_Instrument not found._');
  out.push('');

  out.push('## 6. Candle coverage for the target instrument');
  out.push('');
  out.push(
    '_`candles` is the total number of rows stored for that timeframe, all time. It is **not** a contiguous ' +
      'evaluable window: rows may have gaps, and the window the engine actually reads is bounded by ' +
      '`requiredWindows()` in core (minimum 120 candles plus a margin). Compare `first open`/`last open` ' +
      'and the declared lookback before concluding that coverage is sufficient._',
  );
  out.push('');
  if (e.candleCoverage.length === 0) {
    out.push('_No candles stored for this instrument — every condition will report `insufficient_data`._');
  } else {
    out.push('| timeframe | candles (all time) | first open (epoch ms) | last open (epoch ms) | last fetched (UTC) |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const c of e.candleCoverage) {
      out.push(mdRow([c.timeframe, c.candles, c.first_ts ?? '—', c.last_ts ?? '—', c.last_fetched_at ?? '—']));
    }
  }
  out.push('');

  out.push('## 7. Setup / alert / delivery evidence');
  out.push('');
  out.push(`Total setups for this version + instrument: **${e.setups.total}**`);
  out.push('');
  if (e.setups.byState.length > 0) {
    out.push('| state | setups |');
    out.push('| --- | --- |');
    for (const s of e.setups.byState) out.push(mdRow([s.state, s.setups]));
  } else {
    out.push('_No setups._');
  }
  out.push('');
  out.push('### 7.1 Latest setups (≤10)');
  out.push('');
  out.push(e.setups.latest.length > 0 ? jsonBlock(e.setups.latest) : '_None._');
  out.push('');
  out.push('### 7.2 Setup scores for those setups');
  out.push('');
  out.push(e.setups.scores.length > 0 ? jsonBlock(e.setups.scores) : '_None._');
  out.push('');
  out.push('### 7.3 Setup state events for those setups');
  out.push('');
  out.push(e.setups.stateEvents.length > 0 ? jsonBlock(e.setups.stateEvents) : '_None._');
  out.push('');
  out.push('### 7.4 Alerts');
  out.push('');
  out.push(e.alerts.length > 0 ? jsonBlock(e.alerts) : '_No alerts for this version + instrument._');
  out.push('');
  out.push('### 7.5 `alert_deliveries` (M6 stub ledger)');
  out.push('');
  out.push(e.alertDeliveries.length > 0 ? jsonBlock(e.alertDeliveries) : '_None._');
  out.push('');
  out.push('### 7.6 `notification_deliveries` (M7.3 outbox — recipient omitted)');
  out.push('');
  out.push(e.notificationDeliveries.length > 0 ? jsonBlock(e.notificationDeliveries) : '_None._');
  out.push('');

  out.push('## 8. Scanner evidence');
  out.push('');
  out.push('### 8.1 Cursors for this version + instrument');
  out.push('');
  out.push(e.scannerCursors.length > 0 ? jsonBlock(e.scannerCursors) : '_No scanner cursor has ever been written for this version + instrument._');
  out.push('');
  out.push('### 8.2 Last 5 scanner runs (non-identifying columns only)');
  out.push('');
  out.push(e.scannerRuns.length > 0 ? jsonBlock(e.scannerRuns) : '_No scanner run has ever been recorded._');
  out.push('');

  out.push('## 9. Notes recorded while collecting');
  out.push('');
  if (e.notes.length === 0) {
    out.push('_None._');
  } else {
    for (const n of e.notes) out.push(`- ${mdText(n)}`);
  }
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Module exports for the security test-suite.
//
// Importing this file has NO side effects: `main()` is invoked only when the file
// is executed directly (`tsx scripts/diagnostics/...`), never on import. That is
// what lets the tests drive the real safety primitives — the read-only session,
// the post-connect assertions, the selection logic and the scrubber — instead of
// asserting a re-implementation of them.
// ---------------------------------------------------------------------------
export {
  ReadOnlySession,
  anyStringLeaks,
  errorCodeOf,
  mapStrings,
  redact,
  scrubSecrets,
  secretValuesFrom,
  main,
};

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(`[gold-diagnostic] unexpected failure (error code: ${errorCodeOf(err)}). The message is withheld.`);
      process.exit(3);
    });
}
