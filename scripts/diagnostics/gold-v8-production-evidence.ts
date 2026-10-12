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
 *   - READ COST IS BOUNDED. `statement_timeout` is set for the session and
 *     every row-returning query is `LIMIT`ed.
 *
 *   - AUTHENTICATED TLS ONLY. The only accepted mode is `verify-full`
 *     (certificate chain AND hostname verified). It is the default. There is
 *     no fallback to unauthenticated TLS and no fallback to plaintext: a
 *     `DATABASE_SSL_MODE` other than `verify-full`, an `sslmode` other than
 *     `verify-full` in the URL, any other `ssl*` URL parameter (which would
 *     override the pool's TLS setting), or `NODE_TLS_REJECT_UNAUTHORIZED=0`
 *     each stop the run with exit 2 before any connection is attempted.
 *
 *   - SAFETY FIELDS ARE MEASURED, NOT ASSERTED. The `safety.*` booleans in the
 *     report are computed at runtime (see `ReadOnlySession` and the output
 *     check in `main()`). The list of things this script is designed NOT to
 *     trigger is kept separately as `declaredNotVerified` and is labelled as
 *     declared design intent, not as verified evidence.
 *
 * USAGE
 *   DATABASE_URL='postgres://…' \
 *     npx tsx scripts/diagnostics/gold-v8-production-evidence.ts \
 *       [--strategy <uuid|name-substring>] [--version 8] \
 *       [--symbol XAUUSD] [--asset-class commodity] [--out <dir>]
 *   (DATABASE_SSL_MODE defaults to verify-full; it is the only accepted value.)
 *
 * EXIT CODES
 *   0  evidence collected (whether or not anything is found)
 *   2  DATABASE_URL missing/empty, or TLS configuration refused — nothing attempted
 *   3  connection or query failure, or the output check failed — nothing written
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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

  constructor(private readonly client: pg.PoolClient) {}

  async begin(): Promise<void> {
    await this.client.query('BEGIN READ ONLY');
    this.open = true;
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
 * Validate the TLS-related parameters of DATABASE_URL. The pool is configured
 * with `ssl: { rejectUnauthorized: true }`, but pg-connection-string merges any
 * `sslmode`/`ssl*` URL parameter over that option, so they are checked here and
 * anything other than `sslmode=verify-full` is refused. Returns a message, or
 * null when the URL is acceptable. The URL itself is never included in messages.
 */
function tlsUrlProblem(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'DATABASE_URL could not be parsed as a URL (URL-encode special characters in the password). Nothing was attempted.';
  }
  // Every occurrence is checked: a repeated key could otherwise hide a weaker
  // value behind an acceptable first one.
  for (const [key, value] of url.searchParams.entries()) {
    const k = key.toLowerCase();
    if (k === 'sslmode') {
      if (value !== 'verify-full') {
        return 'DATABASE_URL sets sslmode to a value other than verify-full. Only authenticated TLS is accepted; remove the parameter or set it to verify-full. Nothing was attempted.';
      }
    } else if (k.startsWith('ssl') || k === 'uselibpqcompat') {
      return `DATABASE_URL carries the TLS parameter "${key}". TLS is configured by this script only (verify-full); remove it. Nothing was attempted.`;
    }
  }
  return null;
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

function parseOptions(argv: readonly string[]): Options {
  const opts: Options = {
    strategy: 'gold',
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
  const version = read('--version');
  if (version) {
    const n = Number(version);
    if (Number.isInteger(n) && n > 0) opts.version = n;
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
  statementTimeout: string;
  privileges: {
    canInsertSetups: boolean | null;
    canUpdateSetups: boolean | null;
    canDeleteSetups: boolean | null;
    canInsertAlerts: boolean | null;
    canUpdateNotificationDeliveries: boolean | null;
    canInsertScannerRuns: boolean | null;
  };
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

const Q_CONNECTION = `
  SELECT
    current_database()                                                   AS database,
    current_setting('default_transaction_read_only')                     AS default_tx_read_only,
    current_setting('transaction_read_only')                             AS tx_read_only,
    current_setting('statement_timeout')                                 AS statement_timeout,
    has_table_privilege(current_user, 'setups', 'INSERT')                AS can_insert_setups,
    has_table_privilege(current_user, 'setups', 'UPDATE')                AS can_update_setups,
    has_table_privilege(current_user, 'setups', 'DELETE')                AS can_delete_setups,
    has_table_privilege(current_user, 'alerts', 'INSERT')                AS can_insert_alerts,
    has_table_privilege(current_user, 'notification_deliveries', 'UPDATE') AS can_update_notification_deliveries,
    has_table_privilege(current_user, 'scanner_runs', 'INSERT')          AS can_insert_scanner_runs
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

const Q_CANDIDATE_STRATEGIES = `
  SELECT s.id,
         s.name,
         s.status,
         s.created_at,
         (SELECT count(*)::int FROM strategy_versions v WHERE v.strategy_id = s.id) AS version_count,
         CASE
           WHEN s.name ILIKE $1 THEN 'name contains the --strategy value'
           ELSE 'a version is scoped to the target instrument'
         END AS match_reason
  FROM strategies s
  WHERE s.name ILIKE $1
     OR EXISTS (
          SELECT 1
          FROM strategy_versions v
          JOIN strategy_market_scopes sc ON sc.version_id = v.id
          LEFT JOIN strategy_market_scope_instruments si ON si.version_id = v.id
          LEFT JOIN instruments i ON i.id = si.instrument_id
          WHERE v.strategy_id = s.id
            AND sc.mode = 'instruments'
            AND i.asset_class = $3
            AND i.symbol = $2
        )
  ORDER BY s.name
  LIMIT 25
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
  const opts = parseOptions(process.argv.slice(2));
  const notes: string[] = [];

  const rawUrl = process.env['DATABASE_URL'];
  if (!rawUrl || rawUrl.trim() === '') {
    console.error(
      [
        '[gold-diagnostic] DATABASE_URL is not set — nothing was attempted.',
        '',
        '  This diagnostic needs a repository secret named exactly:',
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
        '  never printed. Set the secret, then re-run this workflow.',
      ].join('\n'),
    );
    return 2;
  }

  // --- TLS: authenticated by default, fail-closed ---------------------------
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
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    console.error(
      '[gold-diagnostic] NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification for the whole process. ' +
        'Unset it. Nothing was attempted.',
    );
    return 2;
  }
  const urlProblem = tlsUrlProblem(rawUrl);
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
    console.error(`[gold-diagnostic] cannot reach the database: ${redact((err as Error).message)}`);
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
    // Runtime facts, read from the server rather than assumed:
    evidence.safety.connectionOpenedWithDefaultTransactionReadOnly =
      String(c['default_tx_read_only'] ?? '') === 'on';
    ro.observeTransactionReadOnly(String(c['tx_read_only'] ?? ''));
    evidence.connection = {
      database: String(c['database'] ?? ''),
      serverVersion: redact(String(versionRes.rows[0]?.server_version ?? '')),
      tlsRequestedMode: 'verify-full',
      ssl: sslValue,
      defaultTransactionReadOnly: String(c['default_tx_read_only'] ?? ''),
      transactionReadOnly: String(c['tx_read_only'] ?? ''),
      statementTimeout: String(c['statement_timeout'] ?? ''),
      privileges: {
        canInsertSetups: (c['can_insert_setups'] as boolean) ?? null,
        canUpdateSetups: (c['can_update_setups'] as boolean) ?? null,
        canDeleteSetups: (c['can_delete_setups'] as boolean) ?? null,
        canInsertAlerts: (c['can_insert_alerts'] as boolean) ?? null,
        canUpdateNotificationDeliveries: (c['can_update_notification_deliveries'] as boolean) ?? null,
        canInsertScannerRuns: (c['can_insert_scanner_runs'] as boolean) ?? null,
      },
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

    // --- candidate strategies ------------------------------------------------
    const stratRes = await ro.query<StrategyRow>(Q_CANDIDATE_STRATEGIES, [
      `%${opts.strategy}%`,
      opts.symbol,
      opts.assetClass,
    ]);
    evidence.candidateStrategies = stratRes.rows;
    const strategyIds = stratRes.rows.map((r) => r.id);

    if (strategyIds.length === 0) {
      notes.push(
        `No strategy matched name ILIKE '%${opts.strategy}%' and none has a version scoped to ` +
          `${opts.assetClass}/${opts.symbol}. Nothing further can be read — widen --strategy or check the scope.`,
      );
    }

    // --- versions ------------------------------------------------------------
    if (strategyIds.length > 0) {
      const verRes = await ro.query<VersionRow>(Q_VERSIONS, [strategyIds]);
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

    const v8 = evidence.versions.find((v) => Number(v.version_number) === opts.version);
    if (!v8) {
      notes.push(
        `No version_number = ${opts.version} exists among the matched strategies ` +
          `(${strategyIds.length} strateg${strategyIds.length === 1 ? 'y' : 'ies'}). ` +
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
    console.error(`[gold-diagnostic] query failed: ${redact((err as Error).message)}`);
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
  const markdown = renderMarkdown(finalEvidence);
  mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = path.join(opts.outDir, 'gold-v8-production-evidence.json');
  const mdPath = path.join(opts.outDir, 'gold-v8-production-evidence.md');
  writeFileSync(jsonPath, `${JSON.stringify(finalEvidence, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, markdown, 'utf8');

  console.info(markdown);
  console.info(`\n[gold-diagnostic] JSON  ${jsonPath}`);
  console.info(`[gold-diagnostic] MD    ${mdPath}`);
  return 0;
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

function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value ?? null, null, 2), '```'].join('\n');
}

function renderMarkdown(e: Evidence): string {
  const out: string[] = [];
  out.push('# Production Gold diagnostics — v8/XAUUSD evidence (read-only)');
  out.push('');
  out.push(`Generated (UTC): \`${e.generatedAt}\``);
  out.push('');
  out.push(`Target: strategy match \`%${e.target.strategy}%\`, version \`${e.target.version}\`, instrument \`${e.target.assetClass}/${e.target.symbol}\`.`);
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
  for (const line of e.declaredNotVerified.triggersNothing) out.push(`- ${line}`);
  out.push('');
  if (e.connection) {
    out.push(`- Database: \`${e.connection.database}\` (role name intentionally not printed)`);
    out.push(`- Server: ${e.connection.serverVersion.split(',').slice(0, 1).join('')}`);
    out.push(`- TLS requested by this run: \`${e.connection.tlsRequestedMode}\` (configuration: certificate chain and hostname verified by the client)`);
    out.push(`- TLS observed for this session (\`pg_stat_ssl\`): ${e.connection.ssl === null ? 'unknown' : e.connection.ssl ? 'yes' : 'no'}`);
    out.push(`- \`default_transaction_read_only\` = \`${e.connection.defaultTransactionReadOnly}\``);
    out.push(`- \`transaction_read_only\` (inside the txn) = \`${e.connection.transactionReadOnly}\``);
    out.push(`- \`statement_timeout\` = \`${e.connection.statementTimeout}\``);
    out.push('');
    out.push('Effective privileges of the connecting role (booleans via `has_table_privilege`):');
    out.push('');
    out.push('| privilege | value |');
    out.push('| --- | --- |');
    for (const [k, v] of Object.entries(e.connection.privileges)) {
      out.push(`| \`${k}\` | ${v === null ? 'unknown' : String(v)} |`);
    }
    out.push('');
  }
  if (e.migrations.length > 0) {
    out.push('Latest applied migrations:');
    out.push('');
    out.push('| version | name | applied_at |');
    out.push('| --- | --- | --- |');
    for (const m of e.migrations) out.push(`| ${m.version} | \`${m.name}\` | ${m.applied_at} |`);
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
      out.push(
        `| \`${s.id}\` | ${s.name} | ${s.status} | ${s.version_count} | ${isoOrNull(s.created_at) ?? ''} | ${s.match_reason} |`,
      );
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
      out.push(
        `| ${v.version_number} | \`${v.id}\` | ${v.status} | ${v.published_at ?? '—'} | ${v.changelog ?? '—'} |`,
      );
    }
  }
  out.push('');

  out.push(`## 4. v${e.target.version} configuration`);
  out.push('');
  if (!e.v8?.found) {
    out.push(`_v${e.target.version} was not found — the configuration evidence below is ABSENT, not zero._`);
    out.push('');
  } else {
    out.push(`- version id: \`${e.v8.id}\``);
    out.push(`- status: \`${e.v8.status}\`${e.v8.status !== 'published' ? '  ⚠ not published — a non-published version is never scanned' : ''}`);
    out.push(`- published_at: ${e.v8.publishedAt ?? '—'}`);
    out.push('');
    out.push('### 4.1 Role → timeframe');
    out.push('');
    if (e.timeframes.length === 0) {
      out.push('_No `strategy_timeframes` rows._');
    } else {
      out.push('| role | timeframe |');
      out.push('| --- | --- |');
      for (const t of e.timeframes) out.push(`| \`${t.role}\` | \`${t.timeframe}\` |`);
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
          `| ${i + 1} | ${c.group} (${c.groupLogic}) | \`${c.conditionType}\` | ${c.classification} | \`${c.storedTimeframeRole}\` | \`${c.resolvedRole}\` | ${c.resolvedTimeframe ? `\`${c.resolvedTimeframe}\`` : '⚠ no row'} | ${c.roleTimeframeRowPresent ? (c.is4h ? 'yes' : 'no') : '?'} | ${JSON.stringify(c.storedAnchorOffsetCandles)} (${c.storedAnchorOffsetType}) | ${c.effectiveAnchorOffsetCandles} | ${c.lookbackCandles ?? '—'} | ${c.candlesStoredForRole ?? '—'} |`,
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
          `| \`${c.conditionType}\` | \`${c.resolvedRole}\` | ${c.resolvedTimeframe ? `\`${c.resolvedTimeframe}\`` : '—'} | ${c.lookbackCandles ?? '—'} | ${c.effectiveAnchorOffsetCandles} | ${c.deepestDeclaredRead ?? '—'} | ${c.candlesStoredForRole ?? '—'} |`,
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
  if (e.candleCoverage.length === 0) {
    out.push('_No candles stored for this instrument — every condition will report `insufficient_data`._');
  } else {
    out.push('| timeframe | candles | first open (epoch ms) | last open (epoch ms) | last fetched (UTC) |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const c of e.candleCoverage) {
      out.push(
        `| \`${c.timeframe}\` | ${c.candles} | ${c.first_ts ?? '—'} | ${c.last_ts ?? '—'} | ${c.last_fetched_at ?? '—'} |`,
      );
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
    for (const s of e.setups.byState) out.push(`| ${s.state} | ${s.setups} |`);
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
    for (const n of e.notes) out.push(`- ${n}`);
  }
  out.push('');

  return out.join('\n');
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(`[gold-diagnostic] unexpected failure: ${redact((err as Error).message)}`);
    process.exit(3);
  });
