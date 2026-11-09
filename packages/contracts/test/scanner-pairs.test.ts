/**
 * Phase B — per-pair scanner observability contract.
 *
 * The invariants these tests exist to protect:
 *  - the four pair outcomes are mutually exclusive, so their sum is always
 *    `totals.pairs` (the reconciliation the dashboard relies on);
 *  - totals are NOT derived from the stored sample: a truncated run still
 *    reports every pair;
 *  - a historical run (no `pairs` key) parses as `null` — "detail unavailable",
 *    never "zero pairs";
 *  - an unknown future version is refused rather than guessed;
 *  - the optional `conditionSummary` on a detection item does not change the
 *    shape of a detection response that omits it (M4 compatibility).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCANNER_PAIR_OUTCOMES,
  SCANNER_RUN_PAIR_ITEMS_MAX,
  conditionSummarySchema,
  detectionItemDtoSchema,
  readScannerRunPairs,
  scannerRunPairsSchema,
} from '../src/index.js';

const strategyId = '11111111-1111-4111-8111-111111111111';

function block(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    totals: { pairs: 2, evaluated: 1, cursor_skipped: 1, stale: 0, failed: 0 },
    conditions: { satisfied: 2, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
    truncated: false,
    items: [
      {
        strategyId,
        assetClass: 'crypto',
        symbol: 'BTCUSD',
        timeframe: '1h',
        outcome: 'evaluated',
        cursorMs: 1_700_000_000_000,
        anchorMs: 1_700_003_600_000,
        reason: null,
        conditions: { satisfied: 2, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
        failureReasons: ['rule group "Structure" (AND) is not satisfied'],
      },
      {
        strategyId,
        assetClass: 'crypto',
        symbol: 'ETHUSD',
        timeframe: '1h',
        outcome: 'cursor_skipped',
        cursorMs: 1_700_000_000_000,
        anchorMs: 1_700_003_600_000,
        reason: 'cursor_hit',
      },
    ],
    ...overrides,
  };
}

test('a well-formed block round-trips', () => {
  const parsed = scannerRunPairsSchema.safeParse(block());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.totals.pairs, 2);
    assert.equal(parsed.data.items.length, 2);
  }
});

test('the four outcomes are mutually exclusive and sum to totals.pairs', () => {
  assert.deepEqual([...SCANNER_PAIR_OUTCOMES], ['evaluated', 'cursor_skipped', 'stale', 'failed']);

  const inconsistent = scannerRunPairsSchema.safeParse(
    block({ totals: { pairs: 3, evaluated: 1, cursor_skipped: 1, stale: 0, failed: 0 } }),
  );
  assert.equal(inconsistent.success, false, 'a totals sum that disagrees with pairs must be rejected');
});

test('an unknown outcome is rejected', () => {
  const invalid = block({
    totals: { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 1, failed: 0 },
    items: [
      {
        strategyId,
        assetClass: 'crypto',
        symbol: 'BTCUSD',
        timeframe: '1h',
        outcome: 'skipped_for_fun',
        cursorMs: null,
        anchorMs: null,
        reason: null,
      },
    ],
  });
  assert.equal(scannerRunPairsSchema.safeParse(invalid).success, false);
});

test('items must be exactly min(cap, totals.pairs) — the sample is bounded but the totals are not', () => {
  // 250 pairs, 200 stored: valid and flagged as truncated.
  const big = block({
    totals: { pairs: 250, evaluated: 250, cursor_skipped: 0, stale: 0, failed: 0 },
    truncated: true,
    items: Array.from({ length: SCANNER_RUN_PAIR_ITEMS_MAX }, (_, index) => ({
      strategyId,
      assetClass: 'crypto',
      symbol: `SYM${index}`,
      timeframe: '1h',
      outcome: 'evaluated',
      cursorMs: 1_700_000_000_000,
      anchorMs: 1_700_003_600_000,
      reason: null,
    })),
  });
  assert.equal(scannerRunPairsSchema.safeParse(big).success, true);

  // The same totals with only one item stored is inconsistent.
  const shortSample = block({
    totals: { pairs: 250, evaluated: 250, cursor_skipped: 0, stale: 0, failed: 0 },
    truncated: true,
    items: [{ strategyId, assetClass: 'crypto', symbol: 'BTCUSD', timeframe: '1h', outcome: 'evaluated', cursorMs: null, anchorMs: null, reason: null }],
  });
  assert.equal(scannerRunPairsSchema.safeParse(shortSample).success, false);
});

test('historical and malformed metadata parse as null (detail unavailable, never zero)', () => {
  assert.equal(readScannerRunPairs(undefined), null);
  assert.equal(readScannerRunPairs(null), null);
  assert.equal(readScannerRunPairs({}), null);
  assert.equal(readScannerRunPairs({ triggeredBy: 'system', candles: { store: 0, provider: 0, total: 0 } }), null);
  assert.equal(readScannerRunPairs({ pairs: { v: 2, totals: {} } }), null, 'a future version is refused, not guessed');
  assert.equal(readScannerRunPairs({ pairs: 'nope' }), null);
  const good = readScannerRunPairs({ pairs: block() });
  assert.equal(good?.totals.pairs, 2);
});

test('the condition summary is a pure count shape shared by detection and runs', () => {
  const summary = { satisfied: 1, unsatisfied: 2, insufficient_data: 3, unsupported: 4 };
  assert.equal(conditionSummarySchema.safeParse(summary).success, true);
  assert.equal(conditionSummarySchema.safeParse({ satisfied: -1 }).success, false);
  assert.equal(conditionSummarySchema.safeParse({ satisfied: 1, extra: 0 }).success, false);
});

test('a detection item is unchanged when diagnostics are not requested', () => {
  const base = {
    direction: 'long',
    qualified: false,
    setup: null,
    created: false,
    failureReasons: ['rule group "Structure" (AND) is not satisfied'],
  };
  const withoutDiagnostics = detectionItemDtoSchema.safeParse(base);
  assert.equal(withoutDiagnostics.success, true, 'the M4 response shape is unchanged');

  const withDiagnostics = detectionItemDtoSchema.safeParse({
    ...base,
    conditionSummary: { satisfied: 0, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
  });
  assert.equal(withDiagnostics.success, true, 'the scanner may opt in to the summary');
});
