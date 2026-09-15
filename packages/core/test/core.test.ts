import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  TIMEFRAMES,
  ProviderError,
  type Candle,
  type HistoricalCandlesRequest,
  type MarketDataProvider,
  type NormalizedInstrument,
  type Timeframe,
} from '@veltrixeye/contracts';
import {
  createPool,
  runMigrations,
  migrationStatus,
  MIGRATIONS_DIR,
  hashPassword,
  verifyPassword,
  UserService,
  SessionService,
  MAX_SESSIONS_LISTED,
  StrategyService,
  AuditService,
  isDomainError,
  qualityGrade,
  createProviderRegistry,
  CandleStore,
  IngestionService,
  mapProviderError,
  missingRanges,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5434;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let sessions: SessionService;
let strategies: StrategyService;
let audit: AuditService;

const uniqueEmail = () => `trader_${randomBytes(6).toString('hex')}@example.com`;
const PASSWORD = 'correct-horse-42';

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-core');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  audit = new AuditService(pool);
  users = new UserService(pool);
  sessions = new SessionService(pool, 30);
  strategies = new StrategyService(pool, audit);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

function first<T>(rows: readonly T[] | undefined, what: string): T {
  const item = rows?.[0];
  assert.ok(item, `${what} exists`);
  return item;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('migrations', () => {
  test('are idempotent and recorded with checksums', async () => {
    const second = await runMigrations(pool, MIGRATIONS_DIR);
    assert.equal(second.applied.length, 0);
    assert.ok(second.alreadyApplied.length >= 7);
    const res = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    assert.ok(res.rows[0].n >= 7);
  });

  test('refuse to continue when an applied migration changes (drift)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vex-mig-'));
    const files = (await import('node:fs')).readdirSync(MIGRATIONS_DIR);
    for (const f of files) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(tmp, f));
    // tamper with an already-applied migration
    const target = path.join(tmp, files[0]!);
    const content = (await import('node:fs')).readFileSync(target, 'utf8') + '\n-- tampered\n';
    (await import('node:fs')).writeFileSync(target, content);
    await assert.rejects(
      () => runMigrations(pool, tmp),
      (err: Error) => err.message.includes('immutable') && err.message.includes('new migration'),
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  test('migrationStatus reports a fully migrated schema (no writes)', async () => {
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.appliedCount, before.rows[0]!.n);
    assert.equal(status.expectedCount, status.appliedCount);
    assert.deepEqual(status.pending, []);
    assert.equal(status.checksumsMatch, true);
    assert.ok(status.latestApplied?.endsWith('.sql'));
  });

  test('migrationStatus reports pending migrations shipped by a newer build', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vex-mig-status-'));
    const files = (await import('node:fs')).readdirSync(MIGRATIONS_DIR);
    for (const f of files) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(tmp, f));
    // A migration that exists in the build but has not been applied yet.
    (await import('node:fs')).writeFileSync(path.join(tmp, '9999_not_applied_yet.sql'), '-- noop\n');

    const status = await migrationStatus(pool, tmp);
    assert.deepEqual(status.pending, ['9999_not_applied_yet.sql']);
    assert.equal(status.expectedCount, status.appliedCount + 1);
    assert.equal(status.checksumsMatch, true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Users & passwords
// ---------------------------------------------------------------------------

describe('users', () => {
  test('creates a user and stores an Argon2id hash (never plaintext)', async () => {
    const email = uniqueEmail();
    const user = await users.create({ email, passwordHash: await hashPassword(PASSWORD), name: 'Ada' });
    assert.ok(user.id);
    assert.equal(user.email, email);
    assert.equal(user.plan, 'free');

    const row = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    const hash = row.rows[0]?.password_hash ?? '';
    assert.ok(hash.startsWith('$argon2id$'), 'hash must be argon2id');
    assert.ok(!hash.includes(PASSWORD), 'plaintext must never be stored');
    assert.equal(await verifyPassword(hash, PASSWORD), true);
    assert.equal(await verifyPassword(hash, 'wrong-pass-1'), false);
  });

  test('enforces case-insensitive email uniqueness', async () => {
    const email = uniqueEmail();
    await users.create({ email, passwordHash: await hashPassword(PASSWORD), name: 'A' });
    await assert.rejects(
      async () => users.create({ email: email.toUpperCase(), passwordHash: await hashPassword(PASSWORD), name: 'B' }),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
  });

  test('finds users by email case-insensitively', async () => {
    const email = uniqueEmail();
    await users.create({ email, passwordHash: await hashPassword(PASSWORD), name: 'A' });
    const found = await users.findByEmail(email.toUpperCase());
    assert.ok(found);
    assert.equal(found.email, email);
    assert.equal(await users.findByEmail('nobody@nowhere.example'), null);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('sessions', () => {
  test('create / find / revoke lifecycle', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'S' });
    const { token, record } = await sessions.create(user.id, { ip: '1.2.3.4', userAgent: 'test-agent' });
    assert.equal(token.length, 64);
    assert.equal(record.userId, user.id);

    const found = await sessions.findByToken(token);
    assert.ok(found);
    assert.equal(found.userId, user.id);

    // only the hash is stored
    const row = await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE id = $1', [record.id]);
    assert.notEqual(row.rows[0]?.token_hash, token);

    await sessions.revoke(token);
    assert.equal(await sessions.findByToken(token), null);
  });

  test('expired sessions are rejected', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'E' });
    const { token } = await sessions.create(user.id, {});
    await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 hour\' WHERE user_id = $1', [user.id]);
    assert.equal(await sessions.findByToken(token), null);
  });

  test('revokeAllForUser invalidates every session', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'R' });
    const a = await sessions.create(user.id, {});
    const b = await sessions.create(user.id, {});
    await sessions.revokeAllForUser(user.id);
    assert.equal(await sessions.findByToken(a.token), null);
    assert.equal(await sessions.findByToken(b.token), null);
  });

  test('listForUser marks the current session and hides revoked', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'L' });
    const a = await sessions.create(user.id, { userAgent: 'device-a' });
    const b = await sessions.create(user.id, { userAgent: 'device-b' });
    await sessions.revoke(b.token);

    const list = await sessions.listForUser(user.id, a.token);
    assert.equal(list.length, 1);
    const current = first(list, 'session row');
    assert.equal(current.current, true);
    assert.equal(current.userAgent, 'device-a');
  });

  // M7.2: the session list is bounded so `GET /api/users/me` cannot grow
  // without limit (a session is minted on every login and lives up to the TTL).
  test('listForUser is capped at MAX_SESSIONS_LISTED, newest first', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'C' });
    const extra = MAX_SESSIONS_LISTED + 5;
    let newest: string | null = null;
    for (let i = 0; i < extra; i++) {
      const s = await sessions.create(user.id, { userAgent: `cap-device-${i}` });
      newest = s.token;
    }

    const list = await sessions.listForUser(user.id, newest);
    assert.equal(list.length, MAX_SESSIONS_LISTED, 'list must be capped, not unbounded');
    const ids = new Set(list.map((s) => s.id));
    assert.equal(ids.size, MAX_SESSIONS_LISTED, 'no duplicates in the capped list');
    const current = list.filter((s) => s.current);
    assert.equal(current.length, 1);
    assert.ok(current[0], 'current session present');
    assert.ok(list[0], 'list non-empty');
    assert.equal(current[0].id, list[0].id, 'newest session is first');
  });

  // M7.2: expired sessions are removed at boot (the API runs no scheduler by
  // design). deleteExpired must remove ONLY expired rows.
  test('deleteExpired removes only expired sessions', async () => {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'X' });
    const live = await sessions.create(user.id, { userAgent: 'live-device' });
    const expired = await sessions.create(user.id, { userAgent: 'expired-device' });
    await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [expired.record.id]);

    const removed = await sessions.deleteExpired();
    assert.ok(removed >= 1, 'at least the seeded expired session was removed');

    assert.ok(await sessions.findByToken(live.token), 'live session survives');
    assert.equal(await sessions.findByToken(expired.token), null, 'expired session is gone');
  });
});

// ---------------------------------------------------------------------------
// Strategies & versions
// ---------------------------------------------------------------------------

const FULL_CONFIG = {
  timeframes: { htf_bias: '1d' as const, setup: '1h' as const, entry: '15m' as const },
  marketScope: { mode: 'instruments' as const, instruments: [{ assetClass: 'forex' as const, symbol: 'eurusd' }] },
  sessionFilters: [{ session: 'london' as const, mode: 'include' as const, timezone: 'exchange' as const }],
  risk: { minRr: 2, stopLossMethod: 'structure' as const, stopLossBuffer: 1, stopLossBufferUnit: 'pips' as const, takeProfitMethod: 'rr' as const, tp1Rr: 1, tp2Rr: 2, tp3Rr: 3, minQualityScore: 70 },
  filters: [{ type: 'news' as const, enabled: true, params: { maxImportance: 'high', beforeMinutes: 30, afterMinutes: 30 } }],
  ruleGroups: [
    {
      name: 'HTF Bias',
      logic: 'AND' as const,
      position: 0,
      conditions: [
        { conditionType: 'htf_alignment', classification: 'required' as const, timeframeRole: 'htf_bias' as const, params: { direction: 'bullish' }, position: 0 },
      ],
    },
    {
      name: 'Entry',
      logic: 'AND' as const,
      position: 1,
      conditions: [
        { conditionType: 'liquidity_sweep', classification: 'required' as const, timeframeRole: 'setup' as const, params: { side: 'below' }, position: 0 },
        { conditionType: 'order_block', classification: 'confirmation' as const, timeframeRole: 'entry' as const, params: { kind: 'bullish' }, position: 1 },
        { conditionType: 'engulfing_candle', classification: 'optional' as const, timeframeRole: 'entry' as const, params: { direction: 'bullish' }, position: 2 },
        { conditionType: 'spread_filter', classification: 'disqualifying' as const, timeframeRole: 'any' as const, params: { max: 3 }, position: 3 },
      ],
    },
  ],
};

async function makeUser(): Promise<string> {
  const u = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'Owner' });
  return u.id;
}

describe('strategies', () => {
  test('create strategy with full config and read it back (round-trip)', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, {
      name: 'Liquidity Sweep Reversal',
      description: 'Reference strategy foundation',
      version: FULL_CONFIG,
    });

    assert.equal(detail.name, 'Liquidity Sweep Reversal');
    assert.equal(detail.versionCount, 1);
    const v = first(detail.versions, 'version');
    assert.equal(v.status, 'draft');
    assert.equal(v.versionNumber, 1);

    // timeframes round-trip
    assert.deepEqual(detail.currentVersion ?? detail.versions, detail.versions); // sanity: shapes exist
    const v0 = first(detail.versions, 'version');
    const cfg = v0.id
      ? (await strategies.getVersion(owner, detail.id, v0.id)).config
      : null;
    assert.ok(cfg);
    assert.deepEqual(cfg.timeframes, FULL_CONFIG.timeframes);
    // instrument normalized to uppercase
    assert.equal(cfg.marketScope?.mode, 'instruments');
    assert.equal(cfg.marketScope?.instruments?.[0]?.symbol, 'EURUSD');
    assert.equal(cfg.marketScope?.instruments?.[0]?.assetClass, 'forex');
    assert.deepEqual(cfg.sessionFilters, FULL_CONFIG.sessionFilters);
    assert.equal(cfg.risk?.minRr, 2);
    assert.equal(cfg.risk?.minQualityScore, 70);
    assert.equal(cfg.filters?.length, 1);
    assert.equal(cfg.filters?.[0]?.params?.maxImportance, 'high');
    // rule groups + conditions round-trip incl. all four classifications
    assert.equal(cfg.ruleGroups.length, 2);
    const allConds = cfg.ruleGroups.flatMap((g) => g.conditions);
    assert.equal(allConds.length, 5); // 1 HTF-bias + 4 entry conditions
    const classes = allConds.map((c) => c.classification).sort();
    assert.deepEqual(classes, ['confirmation', 'disqualifying', 'optional', 'required', 'required']);
    assert.equal(allConds.find((c) => c.conditionType === 'liquidity_sweep')?.params?.side, 'below');
  });

  test('creates an empty draft when no config is provided', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Empty Draft' });
    assert.equal(detail.versionCount, 1);
    assert.equal(first(detail.versions, 'version').status, 'draft');
    assert.equal(detail.currentVersion, null);
  });

  // M7.2: the shared `instruments` table is platform-managed reference data.
  // A version config may only REFERENCE existing instruments; user input must
  // not mint new rows or rewrite shared display names (the pre-M7.2 upsert
  // allowed both, polluting every user's scope-"all" evaluations and lists).
  test('a version config cannot reference an instrument outside the platform universe', async () => {
    const owner = await makeUser();
    const before = Number((await pool.query('SELECT count(*)::text AS n FROM instruments')).rows[0].n);

    await assert.rejects(
      async () =>
        strategies.createStrategy(owner, {
          name: 'Unknown Instrument',
          version: {
            marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'ZZUNKNOWN' }] },
          },
        }),
      (err: unknown) => isDomainError(err) && err.code === 'invalid_input',
    );

    assert.equal(
      Number((await pool.query('SELECT count(*)::text AS n FROM instruments')).rows[0].n),
      before,
      'no new instrument row may be created',
    );
  });

  test('a user-supplied displayName cannot rewrite a shared instrument', async () => {
    const owner = await makeUser();
    const dbBefore = (
      await pool.query('SELECT display_name FROM instruments WHERE asset_class = $1 AND symbol = $2', ['forex', 'EURUSD'])
    ).rows[0]?.display_name;

    await strategies.createStrategy(owner, {
      name: 'DisplayName Rewrite',
      version: {
        marketScope: {
          mode: 'instruments',
          instruments: [{ assetClass: 'forex', symbol: 'EURUSD', displayName: 'EVIL REWRITE' }],
        },
      },
    });

    const dbAfter = (
      await pool.query('SELECT display_name FROM instruments WHERE asset_class = $1 AND symbol = $2', ['forex', 'EURUSD'])
    ).rows[0]?.display_name;
    assert.equal(dbAfter, dbBefore, 'shared display_name must be untouched');
    assert.notEqual(dbAfter, 'EVIL REWRITE');
  });

  test('enforces unique strategy name per user (case-insensitive)', async () => {
    const owner = await makeUser();
    await strategies.createStrategy(owner, { name: 'Unique Name Test' });
    await assert.rejects(
      () => strategies.createStrategy(owner, { name: 'unique name test' }),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
  });

  test('user isolation: another user cannot read, update or delete', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Private Strategy' });

    // list
    const otherList = await strategies.listStrategies(other);
    assert.equal(otherList.length, 0);

    // get
    await assert.rejects(() => strategies.getStrategy(other, detail.id), (e: unknown) => isDomainError(e) && e.code === 'not_found');
    // update
    await assert.rejects(() => strategies.updateStrategy(other, detail.id, { name: 'Hacked' }), (e: unknown) => isDomainError(e) && e.code === 'not_found');
    // delete
    await assert.rejects(() => strategies.deleteStrategy(other, detail.id), (e: unknown) => isDomainError(e) && e.code === 'not_found');

    // still intact for the owner
    const still = await strategies.getStrategy(owner, detail.id);
    assert.equal(still.name, 'Private Strategy');
  });

  test('versioning: new versions increment and clone configuration', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Versioned', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);

    // publish v1 first
    await strategies.publishVersion(owner, detail.id, v1.id);

    const v2 = await strategies.createVersion(owner, detail.id, { fromVersionId: v1.id, changelog: 'tighten risk' });
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.status, 'draft');
    assert.equal(v2.changelog, 'tighten risk');
    // cloned config
    assert.deepEqual(v2.config.timeframes, FULL_CONFIG.timeframes);
    assert.equal(v2.config.ruleGroups.length, 2);

    // a second concurrent draft is rejected (single-draft rule)
    await assert.rejects(
      () => strategies.createVersion(owner, detail.id, {}),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
  });

  test('publish gate: incomplete config cannot be published', async () => {
    const owner = await makeUser();
    // empty draft
    const empty = await strategies.createStrategy(owner, { name: 'Incomplete' });
    await assert.rejects(
      () => strategies.publishVersion(owner, empty.id, first(empty.versions, 'version').id),
      (err: unknown) => isDomainError(err) && err.code === 'invalid_input',
    );

    // conditions but only optional/disqualifying (never passable)
    const partial = await strategies.createStrategy(owner, {
      name: 'Only Optionals',
      version: {
        timeframes: { htf_bias: '1d', setup: '1h', entry: '15m' },
        marketScope: { mode: 'all' },
        risk: { minRr: 2 },
        ruleGroups: [
          {
            name: 'G',
            logic: 'AND',
            position: 0,
            conditions: [{ conditionType: 'support', classification: 'optional', timeframeRole: 'setup', params: {}, position: 0 }],
          },
        ],
      },
    });
    await assert.rejects(
      () => strategies.publishVersion(owner, partial.id, first(partial.versions, 'version').id),
      (err: unknown) => isDomainError(err) && err.code === 'invalid_input',
    );
  });

  test('publish sets status + timestamp and freezes the version', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Freezable', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    const published = await strategies.publishVersion(owner, detail.id, v1.id);
    assert.equal(published.status, 'published');
    assert.ok(published.publishedAt);

    const refreshed = await strategies.getStrategy(owner, detail.id);
    assert.equal(refreshed.currentVersion?.versionNumber, 1);
  });

  test('immutability (service): published versions cannot be updated or deleted', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Immutable', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    await strategies.publishVersion(owner, detail.id, v1.id);

    await assert.rejects(
      () => strategies.updateVersionConfig(owner, detail.id, v1.id, { config: FULL_CONFIG }),
      (err: unknown) => isDomainError(err) && err.code === 'immutable',
    );
    await assert.rejects(
      () => strategies.deleteStrategy(owner, detail.id),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
    // re-publishing is not allowed
    await assert.rejects(
      () => strategies.publishVersion(owner, detail.id, v1.id),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
  });

  test('immutability (database): raw SQL cannot modify a published version or its config', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'DB Immutable', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    await strategies.publishVersion(owner, detail.id, v1.id);

    const versionId = v1.id;

    // 1) version row UPDATE
    await assert.rejects(
      () => pool.query('UPDATE strategy_versions SET changelog = $2 WHERE id = $1', [versionId, 'sneaky']),
      (err: unknown) => (err as { message?: string })?.message?.includes('immutable'),
    );
    // 2) version row DELETE
    await assert.rejects(
      () => pool.query('DELETE FROM strategy_versions WHERE id = $1', [versionId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('immutable'),
    );
    // 3) config INSERT
    await assert.rejects(
      () => pool.query("INSERT INTO strategy_timeframes (version_id, role, timeframe) VALUES ($1, 'entry', '5m')", [versionId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('immutable'),
    );
    // 4) risk UPDATE
    await assert.rejects(
      () => pool.query('UPDATE strategy_risk_config SET min_rr = 99 WHERE version_id = $1', [versionId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('immutable'),
    );
    // 5) condition UPDATE (via group join)
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE strategy_conditions SET condition_type = 'bos'
           WHERE group_id IN (SELECT id FROM strategy_rule_groups WHERE version_id = $1)`,
          [versionId],
        ),
      (err: unknown) => (err as { message?: string })?.message?.includes('immutable'),
    );
    // config is untouched
    const risk = await pool.query<{ min_rr: string }>('SELECT min_rr FROM strategy_risk_config WHERE version_id = $1', [versionId]);
    assert.equal(first(risk.rows, 'risk config row').min_rr, '2.00');
  });

  test('deprecation: allowed once, then republish is blocked; current falls back', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Deprecatable', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    await strategies.publishVersion(owner, detail.id, v1.id);

    const v2 = await strategies.createVersion(owner, detail.id, { fromVersionId: v1.id });
    // v2 is a draft — publish it
    await strategies.publishVersion(owner, detail.id, v2.id);
    let s = await strategies.getStrategy(owner, detail.id);
    assert.equal(s.currentVersion?.versionNumber, 2);

    // deprecate v2 → current falls back to v1
    await strategies.deprecateVersion(owner, detail.id, v2.id);
    s = await strategies.getStrategy(owner, detail.id);
    assert.equal(s.currentVersion?.versionNumber, 1);

    // republishing a deprecated version is blocked
    await assert.rejects(
      () => strategies.publishVersion(owner, detail.id, v2.id),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
    // deprecating an already-deprecated version is blocked
    await assert.rejects(
      () => strategies.deprecateVersion(owner, detail.id, v2.id),
      (err: unknown) => isDomainError(err) && err.code === 'conflict',
    );
    // deprecating v1 (currently published) IS allowed; no published version remains
    const depV1 = await strategies.deprecateVersion(owner, detail.id, v1.id);
    assert.equal(depV1.status, 'deprecated');
    s = await strategies.getStrategy(owner, detail.id);
    assert.equal(s.currentVersion, null);
  });

  test('drafts remain fully editable until published', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Editable Draft', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);

    const updated = await strategies.updateVersionConfig(owner, detail.id, v1.id, {
      config: {
        timeframes: { htf_bias: '4h', setup: '1h', entry: '5m' },
        marketScope: { mode: 'all' },
        risk: { minRr: 3, takeProfitMethod: 'rr', tp1Rr: 1, tp2Rr: 2, tp3Rr: 4 },
        ruleGroups: [
          {
            name: 'Only',
            logic: 'OR',
            position: 0,
            conditions: [{ conditionType: 'bos', classification: 'required', timeframeRole: 'setup', params: { direction: 'either' }, position: 0 }],
          },
        ],
      },
    });
    assert.deepEqual(updated.config.timeframes, { htf_bias: '4h', setup: '1h', entry: '5m' });
    assert.equal(updated.config.risk?.minRr, 3);
    assert.equal(updated.config.ruleGroups.length, 1);
    assert.equal(first(first(updated.config.ruleGroups, 'rule group').conditions, 'condition').conditionType, 'bos');
  });

  test('delete works for draft-only strategies and cascades', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Deletable', version: FULL_CONFIG });
    await strategies.deleteStrategy(owner, detail.id);
    await assert.rejects(() => strategies.getStrategy(owner, detail.id), (e: unknown) => isDomainError(e) && e.code === 'not_found');
    const leftover = await pool.query('SELECT count(*)::int AS n FROM strategy_versions WHERE strategy_id = $1', [detail.id]);
    assert.equal(leftover.rows[0].n, 0);
  });

  test('condition params are stored as structured JSONB, not an opaque blob', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Structured Params', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    const res = await pool.query<{ condition_type: string; params: Record<string, unknown> }>(
      `SELECT c.condition_type, c.params FROM strategy_conditions c
       JOIN strategy_rule_groups g ON g.id = c.group_id WHERE g.version_id = $1`,
      [v1.id],
    );
    const sweep = res.rows.find((r) => r.condition_type === 'liquidity_sweep');
    assert.ok(sweep);
    assert.equal(sweep.params.side, 'below');
    assert.equal(typeof sweep.params.lookbackCandles, 'number'); // JSONB number, not string
  });
});

// ---------------------------------------------------------------------------
// Setup lifecycle foundation
// ---------------------------------------------------------------------------

describe('setup lifecycle (foundation schema)', () => {
  test('setups reference strategy versions and enforce state values', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Setup Host', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    const inst = await pool.query<{ id: string }>(
      "SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'",
    );
    const instrumentId = first(inst.rows, 'seeded instrument').id;

    const setup = await pool.query<{ id: string }>(
      `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
       VALUES ($1, $2, 'developing', 'long', now(), 1_700_000_000_000) RETURNING id`,
      [v1.id, instrumentId],
    );
    const setupId = first(setup.rows, 'setup').id;

    // invalid state rejected by the CHECK constraint
    await assert.rejects(
      () =>
        pool.query(`UPDATE setups SET state = 'sleeping' WHERE id = $1`, [setupId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('state'),
    );
  });

  test('setup_state_events is append-only', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Event Host', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    const inst = await pool.query<{ id: string }>(
      "SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'",
    );
    const setup = await pool.query<{ id: string }>(
      `INSERT INTO setups (strategy_version_id, instrument_id, direction, detected_at, as_of_ms) VALUES ($1, $2, 'short', now(), 1_700_000_001_000) RETURNING id`,
      [v1.id, first(inst.rows, 'seeded instrument').id],
    );
    const setupId = first(setup.rows, 'setup').id;
    const ev = await pool.query(
      `INSERT INTO setup_state_events (setup_id, from_state, to_state, reason)
       VALUES ($1, NULL, 'developing', 'detected') RETURNING id`,
      [setupId],
    );
    const eventId = first(ev.rows, 'event').id;
    await assert.rejects(
      () => pool.query(`UPDATE setup_state_events SET reason = 'edited' WHERE id = $1`, [eventId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('append-only'),
    );
  });

  test('setup_scores enforces 0-100 and known grades, and is append-only', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Score Host', version: FULL_CONFIG });
    const v1 = detail.versions[0];
    assert.ok(v1);
    const inst = await pool.query<{ id: string }>(
      "SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'",
    );
    const setup = await pool.query<{ id: string }>(
      `INSERT INTO setups (strategy_version_id, instrument_id, direction, detected_at, as_of_ms) VALUES ($1, $2, 'long', now(), 1_700_000_002_000) RETURNING id`,
      [v1.id, first(inst.rows, 'seeded instrument').id],
    );
    const setupId = first(setup.rows, 'setup').id;
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO setup_scores (setup_id, engine_version, total, grade, components, as_of_ms) VALUES ($1, 'e1', 150, 'A+', '[]', 1700000000000)`,
          [setupId],
        ),
      (err: unknown) => (err as { message?: string })?.message?.includes('total'),
    );
    const ok = await pool.query(
      `INSERT INTO setup_scores (setup_id, engine_version, total, grade, components, as_of_ms)
       VALUES ($1, 'e1', 87, 'A', '[{"name":"structure","weight":1,"score":87,"explanation":"strong"}]', 1700000000000) RETURNING id`,
      [setupId],
    );
    const okId = first(ok.rows, 'score row').id;
    await assert.rejects(
      () => pool.query(`DELETE FROM setup_scores WHERE id = $1`, [okId]),
      (err: unknown) => (err as { message?: string })?.message?.includes('append-only'),
    );
  });

  test('grade mapping is consistent with stored grades', () => {
    assert.equal(qualityGrade(87), 'A');
    assert.equal(qualityGrade(150), 'A+');
    assert.equal(qualityGrade(50), 'ignore');
  });
});

// ---------------------------------------------------------------------------
// Provider registry (foundation)
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  test('starts empty (M1) and rejects duplicate ids', () => {
    const reg = createProviderRegistry();
    assert.equal(reg.size, 0);
    assert.deepEqual(reg.list(), []);
    const provider = {
      id: 'test-provider',
      name: 'Test',
      capabilities: { historical: false, realtime: false, timeframes: ['1m'] as const, maxLookbackDays: 0 },
      getSymbols: async () => [],
      getHistoricalCandles: async () => [],
      subscribeRealtime: () => {
        throw new Error('not implemented');
      },
      getTradingSessions: async () => [],
      getMarketStatus: async () => ({ instrument: { assetClass: 'forex', symbol: 'X' } as never, state: 'unknown' as const }),
    };
    reg.register(provider);
    assert.equal(reg.size, 1);
    assert.throws(() => reg.register(provider), /already registered/);
    assert.equal(reg.get('test-provider')?.name, 'Test');
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('audit', () => {
  test('records security-relevant events', async () => {
    const owner = await makeUser();
    const detail = await strategies.createStrategy(owner, { name: 'Audited' });
    await strategies.publishVersion(owner, detail.id, first(detail.versions, 'version').id).catch(() => {});
    const res = await pool.query<{ action: string }>(
      'SELECT action FROM audit_events WHERE user_id = $1 ORDER BY created_at',
      [owner],
    );
    assert.ok(res.rows.some((r) => r.action === 'strategy.created'));
  });
});

// ---------------------------------------------------------------------------
// M2 market data: migration 0008, candle store, ingestion
// ---------------------------------------------------------------------------

const M2_NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function m2Candle(time: number, close = 1.05, volume: number | null = 100): Candle {
  return { time, open: 1, high: 1.1, low: 0.9, close, volume, state: 'closed' };
}

/** Deterministic provider stub: serves aligned bars across the requested range. */
function gridGen(stepMs: number): (req: HistoricalCandlesRequest) => Candle[] {
  return (req) => {
    const out: Candle[] = [];
    const start = req.from - (req.from % stepMs);
    for (let t = start; t < req.to; t += stepMs) out.push(m2Candle(t));
    return out;
  };
}

class FakeProvider implements MarketDataProvider {
  readonly name = 'Fake Provider';
  readonly capabilities = { historical: true, realtime: false, timeframes: TIMEFRAMES, maxLookbackDays: 2190 };
  readonly calls: HistoricalCandlesRequest[] = [];

  constructor(
    readonly id: string,
    private readonly gen: (req: HistoricalCandlesRequest) => Candle[],
  ) {}

  async getSymbols(): Promise<NormalizedInstrument[]> {
    return [];
  }

  async getHistoricalCandles(req: HistoricalCandlesRequest): Promise<Candle[]> {
    this.calls.push(req);
    return this.gen(req);
  }

  subscribeRealtime(): never {
    throw new Error('no realtime');
  }

  async getTradingSessions(): Promise<[]> {
    return [];
  }

  async getMarketStatus(instrument: NormalizedInstrument) {
    return { instrument, state: 'unknown' as const };
  }
}

function m2Setup(gen: (req: HistoricalCandlesRequest) => Candle[], providerId = 'twelve-data') {
  const registry = createProviderRegistry();
  const fake = new FakeProvider(providerId, gen);
  registry.register(fake);
  const store = new CandleStore(pool);
  const ingestion = new IngestionService(pool, registry, store);
  return { registry, fake, store, ingestion };
}

async function latestRun() {
  const res = await pool.query<{
    trigger: string;
    status: string;
    provider_slug: string;
    request: Record<string, unknown>;
    candles_upserted: number;
    error: string | null;
    initiated_by: string | null;
    finished_at: Date | null;
  }>('SELECT trigger, status, provider_slug, request, candles_upserted, error, initiated_by, finished_at FROM ingestion_runs ORDER BY started_at DESC LIMIT 1');
  return first(res.rows, 'ingestion run');
}

describe('m2 migration', () => {
  test('0008 seeds the provider, 8 mappings, and excludes SPX500', async () => {
    const provider = await pool.query<{ status: string }>("SELECT status FROM data_providers WHERE slug = 'twelve-data'");
    assert.equal(first(provider.rows, 'provider row').status, 'active');

    const mappings = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM instrument_provider_symbols');
    assert.equal(Number(first(mappings.rows, 'mapping count').n), 8);

    const spx = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM instrument_provider_symbols m
       JOIN instruments i ON i.id = m.instrument_id WHERE i.symbol = 'SPX500'`,
    );
    assert.equal(Number(first(spx.rows, 'spx mapping count').n), 0);

    // tables exist and accept the documented shapes
    await pool.query('SELECT count(*) FROM candles');
    await pool.query('SELECT count(*) FROM ingestion_runs');
  });
});

describe('m2 candle store', () => {
  test('resolves instruments case-insensitively; unknown returns null', async () => {
    const store = new CandleStore(pool);
    const eurusd = await store.resolveInstrument('forex', 'eurusd');
    assert.ok(eurusd);
    assert.equal(eurusd.symbol, 'EURUSD');
    assert.equal(eurusd.assetClass, 'forex');
    assert.equal(eurusd.displayName, 'EUR / USD');
    // SPX500 keeps its M1 identifier (exclusion is at the mapping/ingestion layer)
    assert.ok(await store.resolveInstrument('index', 'SPX500'));
    assert.equal(await store.resolveInstrument('forex', 'NOPE'), null);
  });

  test('upsert/query round-trips ascending candles with numeric types', async () => {
    const store = new CandleStore(pool);
    const inst = first([await store.resolveInstrument('forex', 'EURUSD')], 'eurusd')!;
    const t0 = M2_NOW - 5 * DAY;
    const n = await store.upsertCandles({
      instrumentId: inst.id,
      timeframe: '1d',
      providerSlug: 'twelve-data',
      candles: [m2Candle(t0), m2Candle(t0 + DAY, 1.06, null), m2Candle(t0 + 2 * DAY)],
    });
    assert.equal(n, 3);
    const rows = await store.queryCandles({ instrumentId: inst.id, timeframe: '1d', from: t0, to: t0 + 3 * DAY, limit: 10 });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.time),
      [t0, t0 + DAY, t0 + 2 * DAY],
    );
    assert.equal(typeof rows[0]!.open, 'number');
    assert.equal(rows[0]!.open, 1);
    assert.equal(rows[1]!.volume, null);
    assert.equal(rows[2]!.volume, 100);
  });

  test('upsert is idempotent: corrections overwrite, batches dedupe (last wins)', async () => {
    const store = new CandleStore(pool);
    const inst = (await store.resolveInstrument('forex', 'EURUSD'))!;
    const t0 = M2_NOW - 5 * DAY;
    await store.upsertCandles({
      instrumentId: inst.id,
      timeframe: '1d',
      providerSlug: 'twelve-data',
      candles: [m2Candle(t0, 1.09), m2Candle(t0, 1.08)],
    });
    const rows = await store.queryCandles({ instrumentId: inst.id, timeframe: '1d', from: t0, to: t0 + 3 * DAY, limit: 10 });
    assert.equal(rows.length, 3); // still 3 rows — correction, not duplication
    assert.equal(rows[0]!.close, 1.08); // last wins
  });

  test('upsert rejects invalid candles and persists nothing', async () => {
    const store = new CandleStore(pool);
    const inst = (await store.resolveInstrument('forex', 'EURUSD'))!;
    const t0 = M2_NOW - 5 * DAY;
    const before = await store.queryCandles({ instrumentId: inst.id, timeframe: '1d', from: t0, to: t0 + 3 * DAY, limit: 10 });
    const bad = [
      { ...m2Candle(t0), time: 0 },
      { ...m2Candle(t0), open: Number.NaN },
      { ...m2Candle(t0), open: 0 },
      { ...m2Candle(t0), low: 5 },
      { ...m2Candle(t0), high: 0.1 },
      { ...m2Candle(t0), volume: -1 },
    ];
    for (const candle of bad) {
      await assert.rejects(
        () => store.upsertCandles({ instrumentId: inst.id, timeframe: '1d', providerSlug: 'twelve-data', candles: [candle] }),
        (e: unknown) => isDomainError(e) && e.code === 'invalid_input',
        JSON.stringify(candle),
      );
    }
    const after = await store.queryCandles({ instrumentId: inst.id, timeframe: '1d', from: t0, to: t0 + 3 * DAY, limit: 10 });
    assert.equal(after.length, before.length);
  });

  test('rangeStats reports count/earliest/latest; empty windows are zeroed', async () => {
    const store = new CandleStore(pool);
    const inst = (await store.resolveInstrument('forex', 'EURUSD'))!;
    const t0 = M2_NOW - 5 * DAY;
    const stats = await store.rangeStats({ instrumentId: inst.id, timeframe: '1d', from: t0, to: t0 + 3 * DAY });
    assert.equal(stats.count, 3);
    assert.equal(stats.earliest, t0);
    assert.equal(stats.latest, t0 + 2 * DAY);
    const empty = await store.rangeStats({ instrumentId: inst.id, timeframe: '1d', from: t0 + 100 * DAY, to: t0 + 101 * DAY });
    assert.deepEqual(empty, { count: 0, earliest: null, latest: null });
  });

  test('pruneBeyondRetention deletes only rows older than the cutoff', async () => {
    const store = new CandleStore(pool);
    const inst = (await store.resolveInstrument('forex', 'EURUSD'))!;
    const removed = await store.pruneBeyondRetention({ instrumentId: inst.id, timeframe: '1d', cutoffMs: M2_NOW - 3 * DAY });
    assert.equal(removed, 2); // t0 and t0+DAY fall before the cutoff
    const rows = await store.queryCandles({ instrumentId: inst.id, timeframe: '1d', from: 0, to: M2_NOW, limit: 10 });
    assert.equal(rows.length, 1);
    const removedAgain = await store.pruneBeyondRetention({ instrumentId: inst.id, timeframe: '1d', cutoffMs: M2_NOW - 3 * DAY });
    assert.equal(removedAgain, 0);
  });
});

describe('m2 missingRanges', () => {
  test('head/tail gap math', () => {
    assert.deepEqual(missingRanges(0, 10, null, null, 1), [[0, 10]]);
    assert.deepEqual(missingRanges(0, 10, 2, 8, 1), [
      [0, 2],
      [8, 10],
    ]);
    assert.deepEqual(missingRanges(0, 10, 0, 8, 1), [[8, 10]]);
    assert.deepEqual(missingRanges(0, 10, 2, 10, 1), [[0, 2]]);
    assert.deepEqual(missingRanges(0, 10, 0, 10, 1), []);
  });
});

describe('m2 mapProviderError', () => {
  test('maps every failure kind to its domain code', () => {
    const codeOf = (err: unknown): string => {
      assert.ok(isDomainError(err), 'expected a DomainError');
      return err.code;
    };
    assert.equal(codeOf(mapProviderError(new ProviderError('rate_limited', 'x'))), 'rate_limited');
    assert.equal(codeOf(mapProviderError(new ProviderError('invalid_request', 'x'))), 'invalid_input');
    assert.equal(codeOf(mapProviderError(new ProviderError('not_found', 'x'))), 'not_found');
    assert.equal(codeOf(mapProviderError(new ProviderError('unavailable', 'x'))), 'provider_unavailable');
    assert.equal(codeOf(mapProviderError(new ProviderError('unauthorized', 'x'))), 'provider_unavailable');
    const plain = new Error('boom');
    assert.equal(mapProviderError(plain), plain);
    assert.equal(codeOf(mapProviderError('weird')), 'internal');
  });
});

describe('m2 ingestion reads', () => {
  test('fetch-through fills an empty range, then serves covered windows from store', async () => {
    const { fake, ingestion } = m2Setup(gridGen(DAY));
    const from = Date.UTC(2026, 8, 10); // aligned to midnight
    const to = Date.UTC(2026, 8, 13);
    const first = await ingestion.getCandles({ assetClass: 'forex', symbol: 'USDJPY', timeframe: '1d', from, to, limit: 500, nowMs: M2_NOW });
    assert.equal(first.fetchedFromProvider, true);
    assert.equal(first.candles.length, 3);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual([fake.calls[0]!.from, fake.calls[0]!.to], [from, to]);

    // a window fully inside stored bars (latest >= to) is a pure cache hit
    const bar = first.candles[1]!;
    const second = await ingestion.getCandles({ assetClass: 'forex', symbol: 'USDJPY', timeframe: '1d', from: bar.time, to: bar.time + 1, limit: 500, nowMs: M2_NOW });
    assert.equal(second.fetchedFromProvider, false);
    assert.equal(fake.calls.length, 1); // no second provider call
    assert.deepEqual(second.candles, [bar]);
  });

  test('fetch-through fills head AND tail gaps (at most two calls)', async () => {
    const { fake, store, ingestion } = m2Setup(gridGen(HOUR));
    const inst = (await store.resolveInstrument('forex', 'GBPUSD'))!;
    const t0 = M2_NOW - 6 * HOUR;
    await store.upsertCandles({ instrumentId: inst.id, timeframe: '1h', providerSlug: 'twelve-data', candles: [m2Candle(t0 + 2 * HOUR)] });
    const res = await ingestion.getCandles({ assetClass: 'forex', symbol: 'GBPUSD', timeframe: '1h', from: t0, to: t0 + 5 * HOUR, limit: 500, nowMs: M2_NOW });
    assert.equal(res.fetchedFromProvider, true);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(
      fake.calls.map((c) => [c.from, c.to]),
      [
        [t0, t0 + 2 * HOUR],
        [t0 + 2 * HOUR, t0 + 5 * HOUR],
      ],
    );
    assert.deepEqual(
      res.candles.map((c) => c.time),
      [t0, t0 + HOUR, t0 + 2 * HOUR, t0 + 3 * HOUR, t0 + 4 * HOUR],
    );
  });

  test('successful fetch-through records a completed run', async () => {
    const run = await latestRun();
    assert.equal(run.trigger, 'fetch_through');
    assert.equal(run.status, 'completed');
    assert.equal(run.provider_slug, 'twelve-data');
    assert.ok(run.finished_at !== null);
  });

  test('over-limit ranges are rejected, never truncated', async () => {
    const { ingestion } = m2Setup(() => []);
    const t0 = M2_NOW - 5 * DAY;
    await assert.rejects(
      () => ingestion.getCandles({ assetClass: 'forex', symbol: 'EURUSD', timeframe: '1d', from: t0, to: M2_NOW, limit: 0, nowMs: M2_NOW }),
      (e: unknown) => isDomainError(e) && e.code === 'invalid_input',
    );
  });

  test('ranges before retention are rejected without calling the provider', async () => {
    const { fake, ingestion } = m2Setup(gridGen(DAY));
    await assert.rejects(
      () =>
        ingestion.getCandles({
          assetClass: 'stock',
          symbol: 'AAPL',
          timeframe: '1d',
          from: M2_NOW - 1825 * DAY - 1,
          to: M2_NOW - 1825 * DAY + DAY,
          limit: 500,
          nowMs: M2_NOW,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'invalid_input',
    );
    assert.equal(fake.calls.length, 0);
  });

  test('unknown instruments are rejected without calling the provider', async () => {
    const { fake, ingestion } = m2Setup(gridGen(DAY));
    await assert.rejects(
      () => ingestion.getCandles({ assetClass: 'forex', symbol: 'NOPE', timeframe: '1d', from: M2_NOW - DAY, to: M2_NOW, limit: 500, nowMs: M2_NOW }),
      (e: unknown) => isDomainError(e) && e.code === 'not_found',
    );
    assert.equal(fake.calls.length, 0);
  });

  test('empty registry answers provider_unavailable', async () => {
    const store = new CandleStore(pool);
    const ingestion = new IngestionService(pool, createProviderRegistry(), store);
    await assert.rejects(
      () => ingestion.getCandles({ assetClass: 'etf', symbol: 'SPY', timeframe: '1d', from: M2_NOW - DAY, to: M2_NOW, limit: 500, nowMs: M2_NOW }),
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });

  test('provider failure maps to provider_unavailable and records a failed run', async () => {
    const owner = await makeUser();
    const { ingestion } = m2Setup(() => {
      throw new ProviderError('unavailable', 'upstream down');
    });
    await assert.rejects(
      () =>
        ingestion.getCandles({
          assetClass: 'commodity',
          symbol: 'XAUUSD',
          timeframe: '15m',
          from: M2_NOW - HOUR,
          to: M2_NOW,
          limit: 500,
          nowMs: M2_NOW,
          initiatedBy: owner,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
    const run = await latestRun();
    assert.equal(run.trigger, 'fetch_through');
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'unavailable: upstream down');
    assert.equal(run.initiated_by, owner);
  });

  test('the store is global: different users read identical candles', async () => {
    const { ingestion } = m2Setup(gridGen(DAY));
    const a = await makeUser();
    const b = await makeUser();
    const query = { assetClass: 'crypto' as const, symbol: 'ETHUSD', timeframe: '1d' as Timeframe, from: M2_NOW - 2 * DAY, to: M2_NOW, limit: 500, nowMs: M2_NOW };
    const ra = await ingestion.getCandles({ ...query, initiatedBy: a });
    const rb = await ingestion.getCandles({ ...query, initiatedBy: b });
    assert.deepEqual(rb.candles, ra.candles);
  });
});

describe('m2 ingestion backfill', () => {
  test('bounded backfill completes and closes its run', async () => {
    const owner = await makeUser();
    const { fake, ingestion } = m2Setup((req) =>
      gridGen(req.timeframe === '1d' ? DAY : HOUR)(req),
    );
    const from = M2_NOW - 2 * DAY;
    const res = await ingestion.backfill({
      instruments: [{ assetClass: 'crypto', symbol: 'BTCUSD' }],
      timeframes: ['1d', '1h'],
      from,
      to: M2_NOW,
      initiatedBy: owner,
      nowMs: M2_NOW,
    });
    assert.equal(res.status, 'completed');
    assert.equal(res.provider, 'twelve-data');
    assert.equal(res.pairs.length, 2);
    assert.ok(res.pairs.every((p) => p.status === 'completed' && p.error === null));
    assert.equal(res.candlesUpserted, 3 + 48);
    assert.equal(fake.calls.length, 2);
    assert.ok(res.runId.length > 0);

    const row = await pool.query<{ status: string; candles_upserted: number; finished_at: Date | null }>(
      'SELECT status, candles_upserted, finished_at FROM ingestion_runs WHERE id = $1',
      [res.runId],
    );
    assert.equal(first(row.rows, 'run row').status, 'completed');
    assert.equal(first(row.rows, 'run row').candles_upserted, 51);
    assert.ok(first(row.rows, 'run row').finished_at !== null);
  });

  test('one failing pair yields partial (others still complete)', async () => {
    const owner = await makeUser();
    const { ingestion } = m2Setup((req) => {
      if (req.timeframe === '1h') throw new ProviderError('unavailable', 'hourly down');
      return gridGen(DAY)(req);
    });
    const res = await ingestion.backfill({
      instruments: [{ assetClass: 'stock', symbol: 'AAPL' }],
      timeframes: ['1d', '1h'],
      from: M2_NOW - 2 * DAY,
      to: M2_NOW,
      initiatedBy: owner,
      nowMs: M2_NOW,
    });
    assert.equal(res.status, 'partial');
    assert.equal(res.pairs.length, 2);
    assert.equal(res.pairs[0]!.status, 'completed');
    assert.equal(res.pairs[1]!.status, 'failed');
    assert.equal(res.pairs[1]!.error, 'unavailable: hourly down');
  });

  test('over-cap backfills are rejected before any fetch', async () => {
    const owner = await makeUser();
    const { fake, ingestion } = m2Setup(gridGen(DAY));
    await assert.rejects(
      () =>
        ingestion.backfill({
          instruments: [
            { assetClass: 'crypto', symbol: 'BTCUSD' },
            { assetClass: 'crypto', symbol: 'ETHUSD' },
          ],
          timeframes: ['1m'],
          from: M2_NOW - 30 * DAY, // inside retention, over the 50k cap
          to: M2_NOW,
          initiatedBy: owner,
          nowMs: M2_NOW,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'invalid_input',
    );
    assert.equal(fake.calls.length, 0);
  });

  test('unknown instruments and out-of-retention ranges are rejected', async () => {
    const owner = await makeUser();
    const { fake, ingestion } = m2Setup(gridGen(DAY));
    await assert.rejects(
      () =>
        ingestion.backfill({
          instruments: [{ assetClass: 'forex', symbol: 'NOPE' }],
          timeframes: ['1d'],
          from: M2_NOW - DAY,
          to: M2_NOW,
          initiatedBy: owner,
          nowMs: M2_NOW,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'not_found',
    );
    await assert.rejects(
      () =>
        ingestion.backfill({
          instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }],
          timeframes: ['1d'],
          from: M2_NOW - 1826 * DAY,
          to: M2_NOW - 1825 * DAY,
          initiatedBy: owner,
          nowMs: M2_NOW,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'invalid_input',
    );
    assert.equal(fake.calls.length, 0);
  });

  test('falls back to any registered historical provider; empty registry fails', async () => {
    const owner = await makeUser();
    const { ingestion } = m2Setup(gridGen(DAY), 'other-vendor');
    const res = await ingestion.backfill({
      instruments: [{ assetClass: 'etf', symbol: 'SPY' }],
      timeframes: ['1d'],
      from: M2_NOW - DAY,
      to: M2_NOW,
      initiatedBy: owner,
      nowMs: M2_NOW,
    });
    assert.equal(res.provider, 'other-vendor');

    const empty = new IngestionService(pool, createProviderRegistry(), new CandleStore(pool));
    await assert.rejects(
      () =>
        empty.backfill({
          instruments: [{ assetClass: 'etf', symbol: 'SPY' }],
          timeframes: ['1d'],
          from: M2_NOW - DAY,
          to: M2_NOW,
          initiatedBy: owner,
          nowMs: M2_NOW,
        }),
      (e: unknown) => isDomainError(e) && e.code === 'provider_unavailable',
    );
  });
});

describe('m2 coverage', () => {
  test('ledger reflects stored candles; SPX500 never appears', async () => {
    const store = new CandleStore(pool);
    const all = await store.getCoverage({});
    const btc = all.find((r) => r.symbol === 'BTCUSD' && r.timeframe === '1d');
    assert.ok(btc);
    assert.equal(btc.assetClass, 'crypto');
    assert.equal(btc.candleCount, 3);
    assert.ok(btc.earliestTime !== null && btc.latestTime !== null && btc.earliestTime < btc.latestTime);
    assert.ok(!all.some((r) => r.symbol === 'SPX500'), 'SPX500 has no coverage');

    const inst = (await store.resolveInstrument('crypto', 'BTCUSD'))!;
    const filtered = await store.getCoverage({ instrumentId: inst.id });
    assert.ok(filtered.length >= 2);
    assert.ok(filtered.every((r) => r.symbol === 'BTCUSD'));
    const hourly = await store.getCoverage({ timeframe: '1h' });
    assert.ok(hourly.length >= 1);
    assert.ok(hourly.every((r) => r.timeframe === '1h'));
  });
});
