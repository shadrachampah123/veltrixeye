# Gold v8 production evidence diagnostic (read-only)

A **local, operator-run** script that collects evidence about the Gold (XAUUSD)
v8 strategy from the production database and writes it to a local report.

```
scripts/diagnostics/gold-v8-production-evidence.ts
```

It answers four questions from the database and nothing else:

1. the stored `timeframe_role` and `anchorOffsetCandles` of the v8
   liquidity-sweep condition, and which timeframe that role resolves to (is it
   really the 4H series?);
2. the authoritative XAUUSD pip size (`instrument_risk_specs.pip_size`);
3. the candle coverage the evaluation engine can read per role timeframe;
4. the setup / alert / delivery evidence that exists for that version and
   instrument.

It **advises nothing and changes nothing**.

## Where the evidence goes

Evidence is written to a **local directory on the operator's machine** —
`--out <dir>`, default `diagnostics-out/`, which is gitignored:

```
diagnostics-out/gold-v8-production-evidence.json
diagnostics-out/gold-v8-production-evidence.md
```

It is **not** uploaded to a GitHub Actions artifact, **not** copied into a job
summary, and **not** printed to a log or terminal. On success stdout carries a
short three-line status only — completion and output directory, the
`secretsRedacted` result, and a reminder that the report is not uploaded.
Errors print a machine-readable code (a SQLSTATE or a Node TLS code) and never
the driver message, the stack, or the connection string.

Retention is the operator's file system. There is no public copy: a short
artifact retention period is not an access control, so no artifact exists.

**An existing report is never overwritten.** Before anything else — before the
credential is read and before any connection is attempted — the script checks
whether `gold-v8-production-evidence.json` or `gold-v8-production-evidence.md`
already exists in `--out`. If either does, the run **refuses with exit 2** and
writes nothing. The check is repeated at write time and both files are opened
exclusively, so an earlier report also survives a run that finishes while
another is reading. Nothing is deleted or renamed: move the old report aside, or
pass a different `--out`. That way a refused or failed run can never be mistaken
for a successful one, and no other file in the directory is touched.

## There is deliberately no CI workflow for this

No GitHub Actions workflow runs this script, and no repository or environment
secret is wired to it. A public repository cannot keep a production-evidence
artifact private, and a workflow on an ordinary branch would let any branch push
obtain the production credential.

Adding CI execution later is allowed **only** with all of the following, which
this change deliberately does not provide:

- a **protected GitHub Environment** (for example `production-diagnostics`) with
  **required reviewers**, so a run cannot start without an explicit approval;
- `DATABASE_URL` stored as a secret **of that environment only**, scoped to the
  single diagnostic step (never job-level, so `npm ci`, checkout and every other
  step run without it);
- **no upload of production evidence** to artifacts, summaries or logs — a
  private, access-controlled destination instead (or no CI run at all);
- actions pinned to immutable commit SHAs;
- `pull_request`/`pull_request_target` triggers must stay absent.

Until every one of those is configured **and verified**, the diagnostic stays
local-only. That is the current state.

## Running it

```bash
DATABASE_URL='postgres://<ro-role>:<password>@<host>:5432/<db>?sslmode=verify-full' \
  npx tsx scripts/diagnostics/gold-v8-production-evidence.ts \
  --strategy <strategy-uuid | exact strategy name> \
  --version 8 \
  --symbol XAUUSD \
  --asset-class commodity \
  --out diagnostics-out
```

Exit codes: `0` evidence collected, `2` configuration refused (nothing
attempted — including a report that already exists in `--out`), `3` a safety
condition failed, a query failed, an ambiguous target was found, or the report
could not be written (in every case: no new report).

### Connection requirements (enforced, not advisory)

- **`--strategy` is required** and must be a strategy UUID **or the exact
  (full) strategy name**. There is no default and no substring matching. If the
  selector matches more than one strategy, or the selected strategy has more
  than one version with the requested number, the run **aborts** rather than
  reporting evidence for an arbitrary one.
- **`--version` is strict.** It must be a whole number greater than zero and
  within JavaScript's safe integer range (`Number.isSafeInteger`). `abc`, `9x`,
  `0`, `-3`, `8.5` and digit strings beyond `Number.MAX_SAFE_INTEGER`
  (`9007199254740992`, `99999999999999999999`) are refused with exit 2 — the run
  never falls back to the default 8, because that would collect evidence for a
  version the operator did not ask for. Omitting the flag altogether means
  version 8.
- **The URL must name the role and the database.** `postgres://user:password@host:5432/database`
  is the expected shape; a URL without a user, or without a database path, is
  refused with exit 2. `pg` fills a missing user, password, host, port or database
  from the environment (`val()` in `pg/lib/connection-parameters.js`), so an
  incomplete URL would silently describe a target the operator never named.
  `PGUSER`, `PGDATABASE`, `PGPASSWORD`, `PGHOST`, `PGPORT` and `PGSERVICE` are
  refused outright for the same reason: the target comes from `DATABASE_URL`
  only, and nothing from a credential is printed.
- **TLS is `verify-full` and nothing else.** `DATABASE_SSL_MODE` may only be
  `verify-full` (the default). The URL may carry exactly one query parameter,
  once: `sslmode=verify-full`. Every other parameter is refused — `options`,
  `host`, `port`, `user`, `password`, `db`, `application_name`,
  `statement_timeout`, `search_path`, any `ssl*` setting, `uselibpqcompat`, and
  anything unknown — because `pg` merges the parsed connection string over the
  explicit pool configuration, so `?options=-c default_transaction_read_only=off`
  would otherwise disable the read-only session default. **A repeated parameter
  is refused too**, in any case and even when every value is acceptable
  (`?sslmode=verify-full&sslmode=verify-full`): with two values it is ambiguous
  which one the driver honours.
  `NODE_TLS_REJECT_UNAUTHORIZED=0` and any libpq `PGSSL*` override in the
  environment are refused as well.
- **The database role must be least-privilege.** The script reads
  `default_transaction_read_only`, `transaction_read_only`, `is_superuser` and
  the role's effective INSERT/UPDATE/DELETE privileges on the tables it touches,
  and **aborts** unless the session is read-only and the role holds no write
  privilege and is not a superuser. A writable role is a refusal, not a warning.
  If production needs a custom CA, that is a configuration blocker to report —
  not a reason to relax verification here.
  The probe is answered by `has_table_privilege(current_user, …)` for the tables
  it touches. If one of those tables does not exist in the connected database,
  that query itself fails (SQLSTATE `42P01`), and the run **refuses with exit 3
  and writes no report** — a missing table is a fail-closed refusal, never an
  assumed privilege.

### What it can never do

- It opens one connection, runs `BEGIN READ ONLY`, sends only `SELECT`
  statements through a guard that refuses any query outside that transaction, and
  always `ROLLBACK`s (on success and on failure).
- It does not run migrations or seed scripts, does not construct `ScannerService`,
  `SetupService`, `AlertService` or `NotificationWorker`, performs no scan, sends
  no notification, places no order, and touches no broker or execution service.
- It reads no `users` rows and no `notification_deliveries.recipient`; free-text
  error columns pass through a redactor and are truncated.

`declaredNotVerified` in the report lists these design intents explicitly, so
they are never mistaken for measured evidence.

## Reading the report

- `candles` in the coverage table is the **total number of rows stored** for that
  timeframe, all time. It is **not** contiguous evaluable coverage: rows may have
  gaps, and the engine reads a bounded window (`requiredWindows()` in core —
  minimum 120 candles plus a margin). Compare `first open` / `last open` and the
  declared lookback before concluding coverage is sufficient.
- `safety.*` booleans are computed at runtime from what the server reported, and
  the run aborts rather than producing a report when a condition fails.

## Gold v8 is not modified by this script

The diagnostic is read-only. Pausing, activating, publishing, unpublishing or
editing Gold v8, changing strategy eligibility, enabling automation, or changing
paper/live execution settings is outside its capability and outside its scope.
