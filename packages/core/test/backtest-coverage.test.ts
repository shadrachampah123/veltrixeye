/**
 * M6.2 — long-window backtest coverage (focused regression tests).
 *
 * These tests pin the two halves of the fix:
 *
 *  1. the loader must size EVERY role's window from that role's own period, so
 *     a long backtest never replays stale/incomplete bias or entry candles;
 *  2. a required bias/entry series that is missing or already exhausted at an
 *     anchor FAILS CLOSED — it is an error, never a confident replay of
 *     history that has ended.
 *
 * No database, no provider, no wall clock: the service tests drive
 * `BacktestService` with a store that synthesizes candles and a pool that
 * records (and never performs) writes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';

import {
  BACKTEST_ENGINE_VERSION,
  MAX_BACKTEST_ROLE_CANDLES,
  MAX_BACKTEST_STEPS,
  strategyVersionConfigSchema,
  timeframeMinutes,
  type BacktestEngineResult,
  type CandleDto,
  type StrategyRuleGroup,
  type StrategyVersionConfig,
  type Timeframe,
} from '@veltrixeye/contracts';
import {
  anchorHorizonMs,
  requiredCoverageRoles,
  roleCoverageWindow,
  runBacktest,
  setupCoverageWindow,
} from '../src/backtest/engine.js';
import { requiredWindows } from '../src/strategies/evaluation/service.js';
import { CandleStore } from '../src/market-data/candles.js';
import { BacktestService } from '../src/backtest/service.js';
import type { StrategyService } from '../src/strategies/strategies.js';
import { isDomainError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Deterministic builders
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Every fixture candle is aligned to this grid (2027-01-15T00:00:00Z). */
const T0 = 1_800_000_000_000;

function candle(time: number, open: number, high: number, low: number, close: number): CandleDto {
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close), 'fixture violates OHLC invariant');
  return { time, open, high, low, close, volume: null };
}

/** Flat candle — never a pin, never touches a 10-pip level around 100. */
const FLAT = (time: number): CandleDto => candle(time, 100, 100.0005, 99.9998, 100.0002);
/** Bullish rejection (lowerWick/body ≥ 2) — the entry-role signal used below. */
const PIN = (time: number): CandleDto => candle(time, 100, 100.0005, 99.998, 100);

function cond(
  conditionType: string,
  classification: 'required' | 'optional' | 'confirmation' | 'disqualifying',
  timeframeRole: 'htf_bias' | 'setup' | 'entry' | 'any',
  params: Record<string, unknown> = {},
): StrategyRuleGroup['conditions'][number] {
  return { conditionType, classification, timeframeRole, params, position: 0 };
}

function group(name: string, logic: 'AND' | 'OR', conditions: StrategyRuleGroup['conditions']): StrategyRuleGroup {
  return { name, logic, position: 0, conditions };
}

function mkConfig(
  ruleGroups: StrategyRuleGroup[],
  timeframes: { htf_bias: Timeframe; setup: Timeframe; entry: Timeframe } = {
    htf_bias: '1d',
    setup: '4h',
    entry: '15m',
  },
): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes,
    marketScope: { mode: 'all' },
    risk: {
      minRr: 2,
      stopLossMethod: 'fixed',
      stopLossBuffer: 10,
      stopLossBufferUnit: 'pips',
      takeProfitMethod: 'rr',
      tp1Rr: 1,
      tp2Rr: 2,
      tp3Rr: 3,
      minQualityScore: 65,
    },
    ruleGroups,
  });
}

/** Every setup candle qualifies; the entry role decides. */
const ENTRY_GATED = () =>
  mkConfig([
    group('Gate', 'AND', [
      cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 }),
      cond('rejection_candle', 'required', 'entry', { direction: 'bullish', minWickBodyRatio: 2 }),
    ]),
  ]);

/** Setup-only version: it never reads the bias or entry series. */
const SETUP_ONLY = () =>
  mkConfig([group('Pass', 'AND', [cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 })])]);

/** Bias-gated version (M3's htf_alignment reads the htf_bias role). */
const BIAS_GATED = (timeframes?: { htf_bias: Timeframe; setup: Timeframe; entry: Timeframe }) =>
  mkConfig(
    [
      group('Bias', 'AND', [
        cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 }),
        cond('htf_alignment', 'required', 'htf_bias', { direction: 'either', source: 'trend' }),
      ]),
    ],
    timeframes,
  );

const INSTRUMENT = { assetClass: 'forex', symbol: 'EURUSD' };

function run(opts: {
  config: StrategyVersionConfig;
  setup: CandleDto[];
  htf?: CandleDto[];
  entry?: CandleDto[];
  fromMs: number;
  toMs: number;
  direction?: 'long' | 'short' | 'both';
}): BacktestEngineResult {
  return runBacktest({
    config: opts.config,
    instrument: INSTRUMENT,
    candles: { htf_bias: opts.htf ?? [], setup: opts.setup, entry: opts.entry ?? [] },
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    direction: opts.direction ?? 'long',
  });
}

const periodMs = (tf: Timeframe): number => timeframeMinutes(tf) * MINUTE;

/** Run `fn` and hand back what it threw (fails the test when it does not throw). */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('expected the replay to be refused');
}

/**
 * 600 four-hour setup candles (2 400 h ≈ 100 days) with four 15m entry candles
 * each. Entry candles are FLAT until `switchIndex` and PINs afterwards, so a
 * signal can only exist at an anchor whose own newest entry candle is a pin —
 * replaying an older (stale) entry candle is immediately visible as a missing
 * or spurious signal.
 */
function longWindow(opts: { setupCount?: number; entryPerSetup?: number; switchIndex?: number } = {}) {
  const setupCount = opts.setupCount ?? 600;
  const entryPerSetup = opts.entryPerSetup ?? 16; // 4h setup ⇒ 16 × 15m candles
  const switchIndex = opts.switchIndex ?? 2000;
  const setupPeriod = 4 * HOUR;
  const entryPeriod = setupPeriod / entryPerSetup;
  const setup: CandleDto[] = Array.from({ length: setupCount }, (_, i) => FLAT(T0 + i * setupPeriod));
  const entry: CandleDto[] = Array.from({ length: setupCount * entryPerSetup }, (_, i) =>
    (i >= switchIndex ? PIN : FLAT)(T0 + i * entryPeriod),
  );
  const anchors = setup.map((_, i) => T0 + (i + 1) * setupPeriod);
  return {
    setup,
    entry,
    anchors,
    setupPeriod,
    entryPeriod,
    switchIndex,
    /** First anchor that legitimately sees a pin entry candle. */
    firstSignalAt: T0 + switchIndex * entryPeriod + entryPeriod,
    fromMs: T0,
    toMs: T0 + setupCount * setupPeriod + 1,
  };
}

// ---------------------------------------------------------------------------
// 1. Loader coverage is sized per role, not per anchor
// ---------------------------------------------------------------------------

describe('m6.2 loader coverage is sized from each role period', () => {
  test('the setup window covers warm-up + every evaluated anchor + the max-hold exit tail', () => {
    const config = ENTRY_GATED();
    const warmup = requiredWindows(config).setup;
    const maxHold = 100;
    const window = setupCoverageWindow({ config, fromMs: T0, toMs: T0 + 10 * DAY, maxHoldCandles: maxHold });

    assert.equal(window.to, T0 + 10 * DAY, 'nothing past the range end can be read');
    assert.equal(window.from, T0 - (warmup + 1) * periodMs('4h'), 'warm-up candles are loaded before fromMs');
    assert.equal(window.limit, warmup + 1 + MAX_BACKTEST_STEPS + maxHold + 2);
    assert.ok(
      window.limit <= MAX_BACKTEST_ROLE_CANDLES,
      'the setup role can never breach the per-role cap',
    );
  });

  test('a fine entry role is covered for the full anchor horizon (the long-window regression)', () => {
    const config = ENTRY_GATED();
    const { setup, entry, anchors, setupPeriod, entryPeriod, fromMs, toMs } = longWindow();

    const setupWindow = setupCoverageWindow({ config, fromMs, toMs, maxHoldCandles: 100 });
    const loadedSetup = setup.slice(0, setupWindow.limit); // ascending store read
    const horizonMs = anchorHorizonMs({ setup: loadedSetup, setupPeriodMs: setupPeriod, fromMs, toMs });
    assert.equal(horizonMs, anchors[anchors.length - 1], 'horizon is the last anchor the run evaluates');

    const entryWindow = roleCoverageWindow({ role: 'entry', config, fromMs, horizonMs });
    // Every entry candle that can be closed at an anchor is inside the window…
    const needed = entry.filter((c) => c.time + entryPeriod <= horizonMs).length;
    assert.ok(
      entryWindow.to >= horizonMs,
      `entry window must reach the horizon (to=${entryWindow.to}, horizon=${horizonMs})`,
    );
    assert.ok(
      entryWindow.limit >= needed + requiredWindows(config).entry,
      `entry limit ${entryWindow.limit} must cover ${needed} in-range candles plus warm-up`,
    );

    // …and the pre-M6.2 budget (one candle per step, per role) did NOT:
    // 600 anchors × 16 entry candles each needs 9 600, the old cap was ~2 620.
    const legacyLimit = Math.min(10000, requiredWindows(config).entry + MAX_BACKTEST_STEPS + 500);
    assert.ok(
      legacyLimit < needed,
      `the legacy per-role budget (${legacyLimit}) truncated the entry series at ${needed} candles — ` +
        'every later anchor replayed the same stale entry candle',
    );
    assert.ok(entryWindow.limit > legacyLimit);
  });

  test('the horizon stops at the MAX_BACKTEST_STEPS-th anchor — bias/entry coverage never overshoots it', () => {
    const config = ENTRY_GATED();
    const shapeCount = MAX_BACKTEST_STEPS + 250;
    const setup = Array.from({ length: shapeCount }, (_, i) => FLAT(T0 + i * periodMs('4h')));
    const fromMs = T0;
    const toMs = T0 + shapeCount * periodMs('4h') + 1;
    const setupWindow = setupCoverageWindow({ config, fromMs, toMs, maxHoldCandles: 100 });
    const horizonMs = anchorHorizonMs({
      setup: setup.slice(0, setupWindow.limit),
      setupPeriodMs: periodMs('4h'),
      fromMs,
      toMs,
    });
    assert.equal(horizonMs, T0 + MAX_BACKTEST_STEPS * periodMs('4h'), 'capped at the MAX_BACKTEST_STEPS-th close');

    // Coverage for the finer roles is measured to that horizon — not to toMs,
    // which would load candles the replay can never consume.
    const entryWindow = roleCoverageWindow({ role: 'entry', config, fromMs, horizonMs });
    assert.ok(entryWindow.to <= horizonMs + periodMs('15m'));
    const fullRangeEntryWindow = roleCoverageWindow({ role: 'entry', config, fromMs, horizonMs: toMs });
    assert.ok(fullRangeEntryWindow.limit > entryWindow.limit);
  });

  test('coverage is required only for roles the version actually reads', () => {
    assert.deepEqual(requiredCoverageRoles(SETUP_ONLY()), { htf_bias: false, setup: true, entry: false });
    assert.deepEqual(requiredCoverageRoles(ENTRY_GATED()), { htf_bias: false, setup: true, entry: true });
    assert.deepEqual(requiredCoverageRoles(BIAS_GATED()), { htf_bias: true, setup: true, entry: false });
  });
});

// ---------------------------------------------------------------------------
// 2. Long windows replay covered candles
// ---------------------------------------------------------------------------

describe('m6.2 long-window replays use covered role candles', () => {
  test('every signal is priced off its own newest entry candle (no stale prefix)', () => {
    const config = ENTRY_GATED();
    const { setup, entry, anchors, firstSignalAt, fromMs, toMs } = longWindow();

    const result = run({ config, setup, entry, fromMs, toMs, direction: 'long' });

    assert.equal(result.stepsEvaluated, anchors.length, 'every setup close in range was evaluated');
    assert.ok(!result.notes.some((n) => n.includes('MAX_BACKTEST_STEPS')), '600 anchors is under the step cap');
    assert.ok(result.trades.length > 0, 'the window is long enough to contain the switch');
    for (const trade of result.trades) {
      assert.ok(
        trade.signalAsOfMs >= firstSignalAt,
        `signal ${new Date(trade.signalAsOfMs).toISOString()} predates the switch — it used a stale entry candle`,
      );
    }
    // …and the late anchors signal too: coverage reached the end of the range.
    const expected = anchors.filter((a) => a >= firstSignalAt).length;
    assert.equal(result.trades.length, expected, 'every post-switch anchor signalled');
    assert.equal(result.trades[result.trades.length - 1]!.signalAsOfMs, anchors[anchors.length - 1]);
  });

  test('a series ending exactly at the last anchor is complete, not stale (off-by-one boundary)', () => {
    const config = ENTRY_GATED();
    const { setup, entry, anchors, entryPeriod, switchIndex, fromMs, toMs } = longWindow();
    // Truncate precisely at the horizon: the last loaded entry candle closes on
    // the last anchor, so there is nothing missing.
    const lastAnchor = anchors[anchors.length - 1]!;
    const covered = entry.filter((c) => c.time + entryPeriod <= lastAnchor);
    assert.ok(covered.length > switchIndex);
    const result = run({ config, setup, entry: covered, fromMs, toMs, direction: 'long' });
    assert.equal(result.stepsEvaluated, anchors.length);
    assert.ok(result.trades.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fail closed on stale/missing required role candles
// ---------------------------------------------------------------------------

describe('m6.2 fails closed when a required role is stale or missing', () => {
  test('a truncated entry series (the pre-M6.2 loader bug) is refused, not replayed', () => {
    const config = ENTRY_GATED();
    const { setup, entry, fromMs, toMs } = longWindow();
    // Exactly what the old per-role budget returned: an ascending prefix that
    // stops long before the anchors it is supposed to feed.
    const legacyLimit = Math.min(10000, requiredWindows(config).entry + MAX_BACKTEST_STEPS + 500);
    const truncated = entry.slice(0, legacyLimit);

    const err = captureError(() => run({ config, setup, entry: truncated, fromMs, toMs, direction: 'long' }));
    assert.equal(isDomainError(err), true);
    assert.match((err as Error).message, /entry timeframe ends at/);
    assert.match((err as Error).message, /stale entry candles/);
  });

  test('a missing entry series is refused (never a silent zero-trade run)', () => {
    const config = ENTRY_GATED();
    const { setup, fromMs, toMs } = longWindow();
    const err = captureError(() => run({ config, setup, entry: [], fromMs, toMs, direction: 'long' }));
    assert.equal(isDomainError(err), true);
    assert.match((err as Error).message, /no entry-timeframe candles were loaded/);
  });

  test('a stale bias (htf) series is refused, and a covered one replays', () => {
    const config = BIAS_GATED({ htf_bias: '1d', setup: '1h', entry: '1h' });
    const setup = Array.from({ length: 200 }, (_, i) => FLAT(T0 + i * HOUR));
    const fromMs = T0;
    const toMs = T0 + 200 * HOUR + 1;
    const rising = (n: number): CandleDto[] =>
      Array.from({ length: n }, (_, i) => candle(T0 - 25 * DAY + i * DAY, 90 + i, 91 + i, 89 + i, 90 + i));

    // Covered: last daily candle closes after the last anchor.
    const covered = rising(34);
    const ok = run({ config, setup, htf: covered, fromMs, toMs, direction: 'both' });
    assert.equal(ok.stepsEvaluated, 200);
    assert.ok(ok.trades.length > 0, 'the bias gate is actually consumed');
    assert.ok(ok.trades.every((t) => t.direction === 'long'), 'rising HTF trend blocks shorts');

    // Stale: history stops 3+ days before the last anchors.
    const stale = rising(30);
    const err = captureError(() => run({ config, setup, htf: stale, fromMs, toMs, direction: 'both' }));
    assert.equal(isDomainError(err), true);
    assert.match((err as Error).message, /bias \(htf_bias\) timeframe ends at/);
    assert.match((err as Error).message, /stale bias/);
  });

  test('roles the version never reads are not required (no false refusals)', () => {
    const { setup, fromMs, toMs } = longWindow();
    // SETUP_ONLY never touches the bias/entry series — empty is fine.
    const result = run({ config: SETUP_ONLY(), setup, entry: [], htf: [], fromMs, toMs, direction: 'long' });
    assert.equal(result.stepsEvaluated, setup.length);
    assert.ok(result.trades.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 4. BacktestService: covered loads + fail-closed bounds
// ---------------------------------------------------------------------------

interface CapturedQuery {
  timeframe: Timeframe;
  from: number;
  to: number;
  limit: number;
}

/**
 * A CandleStore that behaves like the real one (ascending rows inside
 * [from, to), capped at `limit`) over a synthetic series, and records every
 * request so the test can assert on coverage instead of on results alone.
 */
function fakeStore(series: Partial<Record<Timeframe, CandleDto[]>>, calls: CapturedQuery[]): CandleStore {
  const store = new CandleStore({} as unknown as pg.Pool);
  Object.assign(store, {
    resolveInstrument: async () => ({
      id: 'inst-1',
      assetClass: 'forex' as const,
      symbol: 'EURUSD',
      displayName: null,
    }),
    queryCandles: async (args: {
      instrumentId: string;
      timeframe: Timeframe;
      from: number;
      to: number;
      limit: number;
    }): Promise<CandleDto[]> => {
      calls.push({ timeframe: args.timeframe, from: args.from, to: args.to, limit: args.limit });
      return (series[args.timeframe] ?? [])
        .filter((c) => c.time >= args.from && c.time < args.to)
        .slice(0, args.limit);
    },
  });
  return store;
}

/** Pool stand-in: records everything, performs nothing. */
function fakePool(): {
  pool: pg.Pool;
  connects: number;
  trades: number[][];
  runRows: Record<string, unknown>[];
} {
  const state = { connects: 0, trades: [] as number[][], runRows: [] as Record<string, unknown>[] };
  const client = {
    query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      const p = params ?? [];
      if (/INSERT INTO backtest_runs/.test(sql)) {
        const row = {
          id: 'run-1',
          user_id: p[0],
          strategy_id: p[1],
          strategy_version_id: p[2],
          instrument_id: p[3],
          direction: p[4],
          engine_version: p[5],
          from_ms: String(p[6]),
          to_ms: String(p[7]),
          exit_policy: p[8],
          cost_policy: p[9],
          config_hash: p[10],
          status: p[11],
          steps_evaluated: p[12],
          setups_detected: p[13],
          trades_closed: p[14],
          expectancy_r: p[15] === null ? null : String(p[15]),
          win_rate: p[16] === null ? null : String(p[16]),
          profit_factor: p[17] === null ? null : String(p[17]),
          max_drawdown_r: p[18] === null ? null : String(p[18]),
          metrics: p[19],
          notes: p[20],
          created_at: new Date(T0),
        };
        state.runRows.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO backtest_trades/.test(sql)) {
        state.trades.push(p as number[]);
        return { rows: [] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ c: 0 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => {
      state.connects += 1;
      return client;
    },
    query: async () => ({ rows: [] }),
  };
  return { pool: pool as unknown as pg.Pool, ...state };
}

function fakeStrategies(config: StrategyVersionConfig): StrategyService {
  return {
    getVersion: async () => ({ status: 'published', config, versionNumber: 1 }),
  } as unknown as StrategyService;
}

describe('m6.2 BacktestService coverage', () => {
  test('a long window is loaded covered: the entry role reaches the anchor horizon', async () => {
    const config = ENTRY_GATED();
    const win = longWindow();
    const calls: CapturedQuery[] = [];
    const db = fakePool();
    const service = new BacktestService(
      db.pool,
      fakeStrategies(config),
      fakeStore({ '1d': [], '4h': win.setup, '15m': win.entry }, calls),
    );

    const result = await service.createBacktest({
      userId: 'user-1',
      strategyId: '11111111-1111-1111-1111-111111111111',
      versionId: '22222222-2222-2222-2222-222222222222',
      instrument: INSTRUMENT,
      direction: 'long',
      from: win.fromMs,
      to: win.toMs,
      nowMs: win.toMs + DAY,
    });

    // Setup first (it defines the anchors), then entry to the horizon. This
    // version reads no bias condition, so the bias role is never loaded (M6.2
    // follow-up: an unused role is neither capped nor queried).
    assert.deepEqual(
      calls.map((c) => c.timeframe),
      ['4h', '15m'],
    );
    const [setupCall] = calls;
    const entryCall = calls.find((c) => c.timeframe === '15m')!;
    assert.equal(setupCall!.timeframe, '4h');

    const horizonMs = win.anchors[win.anchors.length - 1]!;
    assert.ok(entryCall.to >= horizonMs, 'entry window must reach the last evaluated anchor');
    // …and the rows it returned are not exhausted before that anchor.
    const entryRows = win.entry.filter((c) => c.time >= entryCall.from && c.time < entryCall.to).slice(0, entryCall.limit);
    assert.equal(entryRows.length, win.entry.filter((c) => c.time >= entryCall.from && c.time < entryCall.to).length,
      'the entry cap did not truncate the covered window');
    const lastEntry = entryRows[entryRows.length - 1]!;
    assert.ok(lastEntry.time + win.entryPeriod >= horizonMs, 'the newest entry candle is current at the horizon');

    // The replay used them: signals only where the current entry candle is a pin.
    assert.equal(result.run.engineVersion, BACKTEST_ENGINE_VERSION);
    assert.equal(result.run.metrics.stepsEvaluated, win.anchors.length);
    const expected = win.anchors.filter((a) => a >= win.firstSignalAt).length;
    assert.equal(db.trades.length, expected, 'one persisted trade per post-switch anchor');
    for (const t of db.trades) {
      assert.ok(Number(t[4]) >= win.firstSignalAt, 'no trade was priced off a stale entry candle');
    }
    // The unread bias role was never loaded, so it cannot bound the run.
    assert.ok(!calls.some((c) => c.timeframe === '1d'));
  });

  test('a range no role window can cover fails closed — no truncated replay, no writes', async () => {
    const config = ENTRY_GATED(); // 4h setup / 15m entry ⇒ 16 entry candles per anchor
    const win = longWindow({ setupCount: MAX_BACKTEST_STEPS + 200 });
    const calls: CapturedQuery[] = [];
    const db = fakePool();
    const service = new BacktestService(
      db.pool,
      fakeStrategies(config),
      fakeStore({ '1d': [], '4h': win.setup, '15m': win.entry }, calls),
    );

    const err = await service
      .createBacktest({
        userId: 'user-1',
        strategyId: '11111111-1111-1111-1111-111111111111',
        versionId: '22222222-2222-2222-2222-222222222222',
        instrument: INSTRUMENT,
        direction: 'long',
        from: win.fromMs,
        to: win.toMs,
        nowMs: win.toMs + DAY,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.ok(err instanceof Error, 'the run must be refused');
    assert.equal(isDomainError(err), true);
    assert.match(err.message, /too long to cover/);
    assert.match(err.message, /entry timeframe \(15m\)/);
    assert.match(err.message, new RegExp(String(MAX_BACKTEST_ROLE_CANDLES)));
    assert.equal(db.connects, 0, 'nothing was persisted');
    assert.equal(db.trades.length, 0);
    // Only the anchor-defining setup read happened (the horizon — and hence
    // the bias/entry requirement — is unknown until it returns).
    assert.deepEqual(
      calls.map((c) => c.timeframe),
      ['4h'],
    );
  });

  test('a store that truncates a required role surfaces as a fail-closed error, not a replay', async () => {
    const config = ENTRY_GATED();
    const win = longWindow();
    const calls: CapturedQuery[] = [];
    const db = fakePool();
    // Simulate a store that silently caps the entry role mid-range.
    const entrySeries = win.entry.slice(0, Math.floor(win.entry.length / 2));
    const service = new BacktestService(
      db.pool,
      fakeStrategies(config),
      fakeStore({ '1d': [], '4h': win.setup, '15m': entrySeries }, calls),
    );

    const err = await service
      .createBacktest({
        userId: 'user-1',
        strategyId: '11111111-1111-1111-1111-111111111111',
        versionId: '22222222-2222-2222-2222-222222222222',
        instrument: INSTRUMENT,
        direction: 'long',
        from: win.fromMs,
        to: win.toMs,
        nowMs: win.toMs + DAY,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.ok(err instanceof Error, 'a truncated entry series must not produce a run');
    assert.equal(isDomainError(err), true);
    assert.match(err.message, /stale entry candles/);
    assert.equal(db.connects, 0, 'the failure happened before any write');
    assert.equal(db.trades.length, 0);
  });

  test('an unused role over the 60 000-candle cap is neither refused nor queried (no false refusal)', async () => {
    // SETUP_ONLY reads only the setup series, but its version still pins a 1m
    // bias AND a 1m entry timeframe. Over this ~100-day range each of those
    // roles would need ~144 000 candles — far past MAX_BACKTEST_ROLE_CANDLES.
    // A role the version never reads can never make the replay stale, so the
    // cap must not refuse the run, and the store must never be asked for rows
    // the engine cannot consume.
    const config = mkConfig(
      [group('Pass', 'AND', [cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 })])],
      { htf_bias: '1m', setup: '4h', entry: '1m' },
    );
    const win = longWindow();
    const calls: CapturedQuery[] = [];
    const db = fakePool();
    // The store really holds > 60 000 hypothetical 1m candles: the pre-fix
    // loader sized a coverage window for the unused role from this timeframe,
    // crossed the cap, and refused an otherwise valid backtest.
    const hypothetical = Array.from({ length: MAX_BACKTEST_ROLE_CANDLES + 1 }, (_, i) => FLAT(T0 + i * MINUTE));
    const service = new BacktestService(
      db.pool,
      fakeStrategies(config),
      fakeStore({ '1m': hypothetical, '4h': win.setup, '15m': win.entry }, calls),
    );

    const result = await service.createBacktest({
      userId: 'user-1',
      strategyId: '11111111-1111-1111-1111-111111111111',
      versionId: '22222222-2222-2222-2222-222222222222',
      instrument: INSTRUMENT,
      direction: 'long',
      from: win.fromMs,
      to: win.toMs,
      nowMs: win.toMs + DAY,
    });

    assert.equal(result.created, true, 'the run must not be refused');
    assert.equal(result.run.metrics.stepsEvaluated, win.anchors.length);
    assert.deepEqual(
      calls.map((c) => c.timeframe),
      ['4h'],
      'only the anchor-defining setup role is loaded',
    );
    assert.ok(!calls.some((c) => c.timeframe === '1m'), 'the unused bias/entry roles were never queried');

    // Sanity: had those roles been treated as required, the run would indeed
    // have been refused at the cap.
    for (const role of ['htf_bias', 'entry'] as const) {
      const window = roleCoverageWindow({ role, config, fromMs: win.fromMs, horizonMs: win.toMs });
      assert.ok(window.limit > MAX_BACKTEST_ROLE_CANDLES, `${role} window would breach the cap if required`);
    }
  });
});
