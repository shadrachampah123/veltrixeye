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

`--out` must be a directory (or a path that does not exist yet, which is created
on write). A path that already exists as a file is refused with **exit 2** before
anything is attempted. If writing the pair fails part-way — the JSON is written
first and the Markdown second — the JSON **this attempt created** is removed
again, so a failed run cannot leave a JSON-only report behind; a file that was
already there is never deleted.

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
attempted — including a report that already exists in `--out`, and an `--out`
path that exists but is not a directory), `3` a safety condition failed, a query
failed, an ambiguous target was found, or the report could not be written (in
every case: no new report).

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

### TLS: what the report proves, and why `pg_stat_ssl` can say `no`

The report now separates three different things that used to be printed next to
each other as if they were one:

| Field | What it is |
| --- | --- |
| TLS requested (`verify-full`) | **configuration**, not evidence: the client verifies the certificate chain *and* the hostname, and has no fallback |
| TLS established by this client | **observed on the socket** that carries the session: encrypted, chain accepted, protocol, cipher, SNI/hostname, server-certificate subject/issuer/validity/SHA-256 |
| Server-side view (`pg_stat_ssl.ssl` for `pg_backend_pid()`) | the **server's** view of its own backend connection |

`pg_stat_ssl` describes the connection the *backend* has, not the one this client
has. Whenever **anything terminates TLS in front of the compute** — a connection
pooler (Neon's `-pooler` host, PgBouncer), a managed provider's front proxy, a
load balancer — the backend row describes *that* inner connection, so it reads
`ssl = false` **while the client session is perfectly encrypted and verified**.

**Direct (non-pooler) Neon endpoints behave the same way.** Neon documents a front
proxy in front of every compute: the client's TLS ends at that proxy, and the
proxy reaches the compute over Neon's internal network, so a direct hostname
(`ep-….eu-central-1.aws.neon.tech`, pooling off) is expected to show
`ssl = false` on the compute exactly like a `-pooler` one. **That is provider
architecture, not something this collector measures.** The report keeps the two
apart on purpose:

- *Measured by this run*: the client socket is encrypted and its certificate was
  accepted for this hostname (protocol, cipher, SNI, certificate fingerprint).
- *Not measured, and not visible from a client*: whatever terminates that socket
  and the hop from there to the compute.

The report therefore explains the mismatch, names the likely party (pooler,
managed-provider front proxy, or an unidentified intermediary), and never claims
that either the client session or the proxy-to-compute hop was verified by it.
That is the exact signature this repository reproduces in
`scripts/diagnostics/test/gold-v8-production-evidence.test.ts` ("a verified
client session still reads ssl = false from pg_stat_ssl behind a TLS-terminating
front end", plus "observes TLS on the same pg client whose queries are
executed"): a local TLS-terminating proxy in front of a plaintext PostgreSQL
yields `encrypted: true`, `authorized: true`, `TLSv1.3` on the client and
`pg_stat_ssl.ssl = false` on the backend, on the same client that runs the
query.

When the two disagree the report says so, in words, and names the cause:
a recognised pooler host (`…-pooler…`, `pgbouncer…`) produces the pooler
explanation; anything else produces "identify what sits between this client and
PostgreSQL before drawing a conclusion". It never presents the mismatch as a
verification failure, and it never treats it as a downgrade.

**Fail-closed rules.** The run refuses with exit 3 — before any evidence query
and before anything is written — unless, on the real socket: the session is
encrypted, Node accepted the chain (`authorized === true`), a peer certificate
was seen, the endpoint is a **DNS name**, and the hostname the certificate was
verified against (`servername`) is the host named in `DATABASE_URL`. Each failure
is reported as its own explicit message:

| Refusal | Why |
| --- | --- |
| not encrypted | the session is plaintext, not TLS |
| certificate not accepted | Node rejected the chain (`authorizationError` is shown) |
| no peer certificate | there is nothing to verify |
| `IPv4` / `IPv6` address literal | `pg` sends no SNI for an IP host, so `verify-full` would degrade to chain-only verification. IPv6 is caught before the bracketed form (`[2001:db8::1]`) can slip past `net.isIP` — that form is normalised first, deliberately, so the refusal is explicit rather than a later handshake failure |
| no SNI/hostname sent | hostname verification cannot have happened |
| SNI/hostname ≠ `DATABASE_URL` host | the chain was checked for a name this run does not claim to have reached (case and a trailing dot are normalised, so neither is a false mismatch) |
| host unreadable from `DATABASE_URL` | hostname verification cannot be confirmed |

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
- Database text is rendered, never interpreted: table cells escape backslashes,
  pipes, newlines, backticks and HTML entities, inline code spans neutralise
  backticks and newlines, and ordinary text, bullets and table cells additionally
  escape `&`, `<`, `>` plus the punctuation that starts an active inline
  construct (`[`, `]`, `*`, `_`, `~`). Structured payloads sit in a fence longer
  than any backtick run they contain. A stored value can therefore read as
  itself, but it cannot add a heading, a fence, a table row, a list item, an HTML
  element, or a link, image or emphasis through Markdown syntax. In the raw `.md`
  file those five characters carry a leading backslash (a migration called
  `0001_init` appears as `0001\_init`), so a `grep` over the file has to expect
  the escape; rendered, the value reads exactly as stored. (A bare `http(s)` URL
  inside a value may still be auto-linked by the renderer — that is the viewer's
  behaviour, not markup the report emits.)

### What `active` and `published` mean (and do not mean)

The report prints `strategies.status` and `strategy_versions.status` verbatim,
and section 9 of the Markdown report restates the meaning as static text. In
short:

- `strategies.status = 'active'` makes a strategy **eligible for the scanner**
  (`getEligibleStrategies` requires `active` **and** a `published` version **and**
  the owner's scanner entitlement **and** its three role timeframes).
- `strategies.status = 'paused'` (or anything other than `active`) removes it
  from scanner eligibility. `SCANNER_ENABLED=false` stops scanning for the whole
  deployment.
- `strategy_versions.status = 'published'` marks the version the scanner reads,
  and freezes its configuration. It is **not** an execution switch.
- Neither value enables automation, execution or trading. Those are governed
  elsewhere: `users.automation_enabled` plus an automation entitlement (no plan
  grants it in this version), an enabled execution profile, thirteen ordered
  execution gates that fail closed, kill switches at global/user/strategy/profile
  scope, and a live-execution path that is refused outright.

So `active` + `published` can produce **scans and alerts**; it cannot place an
order on its own.

### Notification deliveries in the report

Section 7.6 now shows, before the raw rows, a **counts-only** summary
(status, failure category, channel, provider, how many exhausted their attempt
budget, how many failed with no provider reply at all) and, when the counts point
at a known signature, a static interpretation: configuration failures, permanent
rejections, stale rows from a crashed worker, or exhausted attempts with **no
reply at all** — which is a reachability problem (wrong host/port, or outbound
SMTP blocked by the platform) rather than a credential problem. `recipient`,
message ids and free-text provider messages are never summarised. The rows are
read and never modified; the diagnostic never drains the outbox or re-sends
anything.

## Verifying the intended paused state against production (safe procedure)

Nothing in this repository may change Gold v8. To confirm the deployed state
without sharing credentials with anyone, the owner runs the collector locally
against a **read-only** production role, or against a Neon staging branch that is
a copy of production:

```bash
# owner's own shell only; the URL never leaves this machine
read -rs DATABASE_URL && export DATABASE_URL

npm run diagnostics:gold-v8 -- \
  --strategy 92821cf1-5f28-459d9ade-08f078b58134 \
  --version 8 --symbol XAUUSD --asset-class commodity \
  --out ./evidence
```

What to check in the output, in order: `strategies.status` in section 2 (should be
`paused` if the intent is "no scanning"), `strategy_versions.status` in section 3
(`published` is expected and is not a pause switch), `scanner_runs` in section 8
(a scan after a `paused` change would mean something else is enabling it), and
`notification_deliveries` in section 7.6 for delivery health. The run refuses
outright unless the session is TLS-verified, read-only, non-superuser and holds no
write privilege — so it cannot change anything.

Two things the collector deliberately never reads belong to the operator's own
read-only SQL (Neon SQL editor, same credentials, nothing shared):

```sql
-- strategy + version status (what the collector also reports, for cross-check)
SELECT id, name, status FROM strategies WHERE id = '92821cf1-5f28-459d-9ade-08f078b58134';
SELECT version_number, status, published_at FROM strategy_versions
 WHERE strategy_id = '92821cf1-5f28-459d-9ade-08f078b58134' ORDER BY version_number DESC;

-- the controls that would actually allow trading (all must be false/paper)
SELECT automation_enabled FROM users
 WHERE id = (SELECT user_id FROM strategies WHERE id = '92821cf1-5f28-459d-9ade-08f078b58134');
SELECT mode, environment, enabled, connection_status FROM execution_profiles
 WHERE user_id = (SELECT user_id FROM strategies WHERE id = '92821cf1-5f28-459d-9ade-08f078b58134');
```

`SCANNER_ENABLED` and `EXECUTION_GLOBAL_KILL_SWITCH` are deployment environment
variables, not database rows: read them in the hosting dashboard
(`render.yaml` pins `SCANNER_ENABLED=true` and
`EXECUTION_GLOBAL_KILL_SWITCH=false`).

## Gold v8 is not modified by this script

The diagnostic is read-only. Pausing, activating, publishing, unpublishing or
editing Gold v8, changing strategy eligibility, enabling automation, or changing
paper/live execution settings is outside its capability and outside its scope.
