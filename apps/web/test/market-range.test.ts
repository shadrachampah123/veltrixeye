/**
 * Regression tests for the historical-candles request window.
 *
 * Background: the instrument page derived its start time purely from
 * `limit × timeframe`, with no regard for retention. Retention caps how far
 * back any candles read may reach, and the API rejects a range that starts
 * before the cutoff (`assertWithinRetention` → `invalidInput`) rather than
 * truncating it — so the page rendered a validation error for selections that
 * are perfectly ordinary:
 *
 *   - 5,000 daily candles spans ~13.7 years against a 1,825-day cap
 *   - 5,000 4-hour candles spans ~833 days against a 365-day cap
 *   - 5,000 weekly candles spans ~96 years against a 1,825-day cap
 *
 * The fix clamps the start to the retention cutoff, matching the clamp the
 * scheduled warmer already applies. These tests pin that contract.
 *
 * Run: npm run test --workspace @veltrixeye/web
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION_DAYS, retentionCutoffMs, TIMEFRAMES, type Timeframe } from '@veltrixeye/contracts';
import { candleRequestRange, TIMEFRAME_MINUTES } from '../lib/market-range';

/** Timeframes the instrument page offers. */
const PAGE_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
/** Candle-count options the instrument page offers. */
const PAGE_LIMITS = [100, 500, 1000, 5000];

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY_MS = 86_400_000;

/** The start the page used to compute — unbounded by retention. */
function preFixFrom(timeframe: Timeframe, limit: number, nowMs: number): number {
  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 1440;
  return nowMs - limit * minutes * 60_000;
}

test('every selectable timeframe × candle count stays inside the retention window', () => {
  // This is the regression itself: before the clamp, a handful of these
  // combinations started before the cutoff and the API rejected them.
  for (const timeframe of PAGE_TIMEFRAMES) {
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      const cutoff = retentionCutoffMs(timeframe, range.to);
      const label = `${timeframe} @ ${limit}`;
      assert.ok(
        range.from >= cutoff,
        `${label}: start ${new Date(range.from).toISOString()} precedes cutoff ${new Date(cutoff).toISOString()}, so the API would reject the read`,
      );
      assert.ok(range.from < range.to, `${label}: window must be non-empty`);
    }
  }
});

test('every canonical timeframe × candle count stays inside the retention window', () => {
  // Not just the ones the page currently offers — a new option must not
  // reintroduce a rejected range.
  for (const timeframe of TIMEFRAMES) {
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      assert.ok(
        range.from >= retentionCutoffMs(timeframe, range.to),
        `${timeframe} @ ${limit}: start precedes the retention cutoff`,
      );
    }
  }
});

test('the selections that used to be rejected now clamp to the cutoff exactly', () => {
  const cases: { timeframe: Timeframe; limit: number }[] = [
    { timeframe: '1d', limit: 5000 },
    { timeframe: '1w', limit: 5000 },
    { timeframe: '4h', limit: 5000 },
  ];

  for (const { timeframe, limit } of cases) {
    const label = `${timeframe} @ ${limit}`;

    // Pre-fix behaviour: this start is inside the retention window's past, so
    // the guard would have thrown. Documents the bug, not just the fix.
    assert.ok(
      preFixFrom(timeframe, limit, NOW) < retentionCutoffMs(timeframe, NOW),
      `${label}: expected the unclamped start to breach retention`,
    );

    const range = candleRequestRange(timeframe, limit, NOW);
    assert.equal(range.clamped, true, `${label}: should report a shortened window`);
    assert.equal(range.from, retentionCutoffMs(timeframe, NOW), `${label}: clamps to the cutoff`);
    assert.equal(range.to, NOW);
    assert.equal(range.retentionDays, RETENTION_DAYS[timeframe]);
  }
});

test('daily candles clamp to the 1,825-day cap', () => {
  const range = candleRequestRange('1d', 5000, NOW);
  assert.equal(RETENTION_DAYS['1d'], 1825);
  assert.equal(NOW - range.from, 1825 * DAY_MS);
});

test('4-hour candles clamp to the 365-day cap', () => {
  const range = candleRequestRange('4h', 5000, NOW);
  assert.equal(RETENTION_DAYS['4h'], 365);
  assert.equal(NOW - range.from, 365 * DAY_MS);
});

test('selections that already fit are left untouched, not clamped', () => {
  for (const timeframe of PAGE_TIMEFRAMES) {
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      if (range.from !== preFixFrom(timeframe, limit, NOW)) continue;
      assert.equal(range.clamped, false, `${timeframe} @ ${limit}: should not report clamping`);
      const minutes = TIMEFRAME_MINUTES[timeframe] ?? 1440;
      assert.equal(range.to - range.from, limit * minutes * 60_000, `${timeframe} @ ${limit}: full span preserved`);
    }
  }
});

test('short daily and max 1-minute selections fit, so they are not clamped', () => {
  // 500 daily candles ≈ 1.4 years, well inside the 1,825-day cap.
  const daily = candleRequestRange('1d', 500, NOW);
  assert.equal(daily.clamped, false);
  assert.equal(NOW - daily.from, 500 * DAY_MS);

  // 5,000 1-minute candles ≈ 3.5 days, well inside the 30-day cap.
  const minute = candleRequestRange('1m', 5000, NOW);
  assert.equal(minute.clamped, false);
  assert.equal(minute.retentionDays, 30);
});

test('the retention day count is reported for every timeframe', () => {
  for (const timeframe of TIMEFRAMES) {
    assert.equal(candleRequestRange(timeframe, 5000, NOW).retentionDays, RETENTION_DAYS[timeframe]);
  }
});
