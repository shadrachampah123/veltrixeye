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
 * The clamp keeps a safety margin past the cutoff because the browser and the
 * API disagree about "now": the window is derived from the browser's clock
 * while `assertWithinRetention` validates against the server's. A start sitting
 * exactly on the browser's cutoff is therefore still too old for a server that
 * is a few seconds ahead, and the read is rejected. The skew tests below model
 * exactly that.
 *
 * Run: npm run test --workspace @veltrixeye/web
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION_DAYS, retentionCutoffMs, TIMEFRAMES, type Timeframe } from '@veltrixeye/contracts';
import { candleRequestRange, RETENTION_SAFETY_MARGIN_MS, TIMEFRAME_MINUTES } from '../lib/market-range';

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

/**
 * The API's retention guard, evaluated with the server's clock.
 *
 * `skewMs` is how far the server runs ahead of the browser (positive = server
 * ahead, which is the dangerous direction). The API compares `from` against
 * `retentionCutoffMs(timeframe, Date.now())` on its own machine.
 */
function serverRejects(from: number, timeframe: Timeframe, browserNowMs: number, skewMs: number): boolean {
  return from < retentionCutoffMs(timeframe, browserNowMs + skewMs);
}

/** Clock skews exercised: browser behind and ahead of the server. */
const SKEWS_MS = [-60_000, -1_000, 0, 1, 250, 1_000, 5_000, 30_000, 59_000, 60_000];

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

test('the selections that used to be rejected now clamp to the cutoff plus the margin', () => {
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
    assert.equal(
      range.from,
      retentionCutoffMs(timeframe, NOW) + RETENTION_SAFETY_MARGIN_MS,
      `${label}: clamps to the cutoff plus the safety margin`,
    );
    assert.equal(range.to, NOW);
    assert.equal(range.retentionDays, RETENTION_DAYS[timeframe]);
  }
});

test('daily candles clamp to the 1,825-day cap', () => {
  const range = candleRequestRange('1d', 5000, NOW);
  assert.equal(RETENTION_DAYS['1d'], 1825);
  assert.equal(NOW - range.from, 1825 * DAY_MS - RETENTION_SAFETY_MARGIN_MS);
});

test('4-hour candles clamp to the 365-day cap', () => {
  const range = candleRequestRange('4h', 5000, NOW);
  assert.equal(RETENTION_DAYS['4h'], 365);
  assert.equal(NOW - range.from, 365 * DAY_MS - RETENTION_SAFETY_MARGIN_MS);
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

// --- Clock-skew regressions -------------------------------------------------
//
// The window is derived from the browser's clock; the API validates `from`
// against its own. If the browser is behind the server, a start that lands
// exactly on the browser's cutoff is still before the server's later cutoff —
// which is what kept 4H requests failing in production even after PR #100
// clamped them. The margin below is what makes those reads stick.

test('the safety margin is a conservative 60 seconds', () => {
  assert.equal(RETENTION_SAFETY_MARGIN_MS, 60_000);
  // The margin must be larger than any plausible NTP-level skew, so the clamp
  // is what decides the start rather than the margin being an accident of size.
  assert.ok(
    RETENTION_SAFETY_MARGIN_MS > 5_000,
    'margin should comfortably exceed observed clock skew',
  );
});

test('clamping to the cutoff alone would be rejected by a server a few seconds ahead', () => {
  // Documents the bug: the pre-margin clamp sat exactly on the browser cutoff,
  // so a server ahead by even a second saw a start before its own cutoff.
  const cutoff = retentionCutoffMs('4h', NOW);
  for (const skewMs of [1, 250, 1_000, 5_000, 30_000, 60_000]) {
    assert.ok(
      serverRejects(cutoff, '4h', NOW, skewMs),
      `a start on the browser cutoff should be rejected when the server is ${skewMs}ms ahead`,
    );
  }
});

test('every selectable selection survives a server clock ahead of the browser', () => {
  for (const timeframe of PAGE_TIMEFRAMES) {
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      for (const skewMs of SKEWS_MS) {
        assert.ok(
          !serverRejects(range.from, timeframe, NOW, skewMs),
          `${timeframe} @ ${limit} with ${skewMs}ms skew: start ${new Date(range.from).toISOString()} precedes the server cutoff ${new Date(retentionCutoffMs(timeframe, NOW + skewMs)).toISOString()}`,
        );
      }
    }
  }
});

test('every canonical selection survives a server clock ahead of the browser', () => {
  for (const timeframe of TIMEFRAMES) {
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      for (const skewMs of SKEWS_MS) {
        assert.ok(
          !serverRejects(range.from, timeframe, NOW, skewMs),
          `${timeframe} @ ${limit} with ${skewMs}ms skew: start precedes the server cutoff`,
        );
      }
    }
  }
});

test('the 4H / 5,000-candle request stays inside the server window when the server is ahead', () => {
  // The production regression: 5,000 4-hour candles span ~833 days against a
  // 365-day cap, so the selection is clamped — and the clamped start has to
  // clear the *server's* cutoff, not the browser's.
  const range = candleRequestRange('4h', 5000, NOW);
  assert.equal(range.clamped, true);
  assert.equal(range.from, retentionCutoffMs('4h', NOW) + RETENTION_SAFETY_MARGIN_MS);
  assert.equal(range.retentionDays, 365);

  for (const skewMs of SKEWS_MS) {
    assert.ok(
      !serverRejects(range.from, '4h', NOW, skewMs),
      `4h @ 5000 with ${skewMs}ms skew: the API would reject the read`,
    );
  }

  // The window is still the full retention span minus the margin: at most one
  // 4-hour candle of history is traded for surviving the server's validation.
  assert.equal(range.to - range.from, 365 * DAY_MS - RETENTION_SAFETY_MARGIN_MS);
});

test('the margin is sized to cover a full minute of server lead, and no more is assumed', () => {
  // Boundary: the margin is exactly what a 60-second server lead needs, so it
  // is neither arbitrary nor silently dependent on skew being tiny.
  const cutoff = retentionCutoffMs('4h', NOW);
  assert.ok(
    serverRejects(cutoff + RETENTION_SAFETY_MARGIN_MS - 1, '4h', NOW, RETENTION_SAFETY_MARGIN_MS),
    'one millisecond short of the margin is still too old for a server a minute ahead',
  );
  assert.ok(
    !serverRejects(cutoff + RETENTION_SAFETY_MARGIN_MS, '4h', NOW, RETENTION_SAFETY_MARGIN_MS),
    'the clamped start clears a server a full minute ahead',
  );

  // A browser that runs ahead of the server needs no margin at all, and adding
  // one does not hurt: the start is even further inside the server's window.
  assert.ok(!serverRejects(cutoff, '4h', NOW, -60_000), 'a server behind the browser accepts the bare cutoff');
  assert.ok(
    !serverRejects(cutoff + RETENTION_SAFETY_MARGIN_MS, '4h', NOW, -60_000),
    'and accepts the clamped start too',
  );
});

test('the resolved window never spans more than the selected candle count', () => {
  // The fix must not trade one rejection for another by silently shrinking the
  // requested limit: an unclamped selection keeps exactly `limit` candles, and
  // a clamped one keeps no more than `limit`.
  for (const timeframe of TIMEFRAMES) {
    const periodMs = (TIMEFRAME_MINUTES[timeframe] ?? 1440) * 60_000;
    for (const limit of PAGE_LIMITS) {
      const range = candleRequestRange(timeframe, limit, NOW);
      const candles = (range.to - range.from) / periodMs;
      assert.ok(candles <= limit, `${timeframe} @ ${limit}: window spans ${candles} candles`);
      assert.ok(range.from < range.to, `${timeframe} @ ${limit}: window must be non-empty`);
    }
  }
});

test('the margin costs at most one candle of the requested span', () => {
  // Sanity bound on the margin itself: it must stay negligible relative to the
  // shortest selectable bar, so clamping never visibly shortens a selection.
  // (For 1m the margin is exactly one candle; for every longer bar, less.)
  for (const timeframe of PAGE_TIMEFRAMES) {
    const periodMs = (TIMEFRAME_MINUTES[timeframe] ?? 1440) * 60_000;
    assert.ok(
      RETENTION_SAFETY_MARGIN_MS <= periodMs,
      `${timeframe}: margin is more than a whole candle`,
    );
  }
});
