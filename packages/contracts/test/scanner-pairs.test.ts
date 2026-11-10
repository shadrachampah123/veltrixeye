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
  CONDITION_FAILURE_STATUSES,
  DETECTION_CONDITION_OUTCOMES_MAX,
  DETECTION_CONDITION_TYPES,
  SCANNER_PAIR_OUTCOMES,
  SCANNER_PAIR_STAGES,
  SCANNER_RUN_PAIR_CODE_MAX_CHARS,
  SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX,
  SCANNER_RUN_PAIR_FAILING_MAX,
  SCANNER_RUN_PAIR_ITEMS_MAX,
  conditionFailingCode,
  conditionFailingCodeSchema,
  conditionSummarySchema,
  detectionConditionOutcomeSchema,
  detectionItemDtoSchema,
  parseConditionFailingCode,
  readScannerRunPairAggregate,
  readScannerRunPairs,
  scannerPairDiagnosticsSchema,
  scannerRunPairAggregateSchema,
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
  assert.equal(readScannerRunPairs({ pairs: { v: 99, totals: {} } }), null, 'a future version is refused, not guessed');
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

/*
 * Tenant-facing projection.
 *
 * A run the caller does not own (every system run, every other tenant's run)
 * must not carry `pairs.items[]`: one observation identifies a strategy's
 * instrument, timeframe, candle timing and outcome even without its UUID. The
 * aggregate half must remain readable so outcome breakdowns still work.
 */
test('the aggregate projection parses a full block, ignoring its item sample', () => {
  const full = block();
  const aggregate = readScannerRunPairAggregate({ pairs: full });
  assert.ok(aggregate);
  assert.equal(aggregate.totals.pairs, full.totals.pairs);
  assert.deepEqual(aggregate.conditions, full.conditions);
  assert.equal(aggregate.truncated, full.truncated);
  assert.equal('items' in aggregate, false, 'the projection has no item sample');
});

test('the aggregate projection parses an items-less block — withheld detail is not corruption', () => {
  const { items: _items, ...withoutItems } = block();
  const metadata = { pairs: withoutItems };
  assert.equal(readScannerRunPairs(metadata), null, 'there is no detail to read');
  const aggregate = readScannerRunPairAggregate(metadata);
  assert.ok(aggregate);
  assert.deepEqual(aggregate.totals, { pairs: 2, evaluated: 1, cursor_skipped: 1, stale: 0, failed: 0 });
});

test('the aggregate projection still refuses unreconciled or malformed counters', () => {
  const { items: _items, ...withoutItems } = block();
  assert.equal(
    readScannerRunPairAggregate({ pairs: { ...withoutItems, totals: { pairs: 5, evaluated: 1, cursor_skipped: 0, stale: 0, failed: 0 } } }),
    null,
    'outcomes must still sum to totals.pairs',
  );
  assert.equal(
    readScannerRunPairAggregate({ pairs: { ...withoutItems, v: 99 } }),
    null,
    'an unknown block version is refused even when every counter is valid',
  );
  assert.equal(readScannerRunPairAggregate({}), null);
  assert.equal(readScannerRunPairAggregate(null), null);
  assert.equal(readScannerRunPairAggregate({ pairs: 'nope' }), null);
  assert.equal(readScannerRunPairAggregate({ pairs: [] }), null, 'an array is not a block');
  assert.equal(readScannerRunPairAggregate({ pairs: 7 }), null, 'a primitive is not a block');
  assert.equal(readScannerRunPairAggregate({ pairs: null }), null);
  assert.equal(
    readScannerRunPairAggregate({ pairs: { ...withoutItems, totals: { ...withoutItems.totals, extra: { symbol: 'BTCUSD' } } } }),
    null,
    'nested payloads in the counters are refused',
  );
  assert.equal(scannerRunPairAggregateSchema.safeParse({ v: 1, totals: withoutItems.totals }).success, false);
});

/* ------------------------------------------------------------------------- */
/* PR A — per-pair evaluation diagnostics                                    */
/* ------------------------------------------------------------------------- */

/** A v2 pair carrying the full diagnostics object. */
function v2Item(overrides: Record<string, unknown> = {}) {
  return {
    strategyId,
    assetClass: 'crypto',
    symbol: 'BTCUSD',
    timeframe: '1h',
    outcome: 'evaluated',
    cursorMs: 1_700_000_000_000,
    anchorMs: 1_700_003_600_000,
    reason: null,
    conditions: { satisfied: 1, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
    diagnostics: {
      stage: 'complete',
      codes: ['setup_limit_reached'],
      data: {
        htf: { candles: 60, newestMs: 1_700_000_000_000 },
        setup: { candles: 120, newestMs: 1_700_003_600_000 },
        entry: { candles: 0, newestMs: null },
      },
      directions: {
        long: {
          state: 'not_qualified',
          conditions: { satisfied: 0, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
          failing: ['liquidity_sweep:unsatisfied'],
        },
        short: { state: 'blocked' },
      },
    },
    ...overrides,
  };
}

function v2Block(item: Record<string, unknown> = v2Item()) {
  return {
    v: 2,
    totals: { pairs: 1, evaluated: 1, cursor_skipped: 0, stale: 0, failed: 0 },
    conditions: { satisfied: 1, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
    truncated: false,
    items: [item],
  };
}

test('a v2 block round-trips and a v1 block keeps parsing unchanged', () => {
  const parsed = scannerRunPairsSchema.safeParse(v2Block());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.v, 2);
    assert.equal(parsed.data.items[0]?.diagnostics?.stage, 'complete');
    assert.deepEqual(parsed.data.items[0]?.diagnostics?.directions?.long?.failing, ['liquidity_sweep:unsatisfied']);
  }

  // Version 1 is still readable: historical runs never carried diagnostics.
  assert.equal(scannerRunPairsSchema.safeParse(block()).success, true);
  assert.equal(readScannerRunPairs({ pairs: block() })?.items[0]?.diagnostics, undefined);
});

test('diagnostics are optional — a v2 block without them is valid', () => {
  const { diagnostics: _diagnostics, ...withoutDiagnostics } = v2Item();
  assert.equal(scannerRunPairsSchema.safeParse(v2Block(withoutDiagnostics)).success, true);
});

test('diagnostics are a closed, bounded vocabulary', () => {
  // The stage enum is the published lifecycle list.
  for (const stage of SCANNER_PAIR_STAGES) {
    assert.equal(scannerPairDiagnosticsSchema.safeParse({ stage }).success, true, `${stage} must be a valid stage`);
  }
  assert.equal(scannerPairDiagnosticsSchema.safeParse({ stage: 'almost_done' }).success, false);
  assert.equal(scannerPairDiagnosticsSchema.safeParse({}).success, false, 'a stage is required');

  // Unknown keys never survive — including anything that could smuggle text in.
  assert.equal(scannerPairDiagnosticsSchema.safeParse({ stage: 'complete', note: 'tenant text' }).success, false);
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({ stage: 'complete', directions: { long: { state: 'qualified', detail: 'x' } } })
      .success,
    false,
  );

  // Direction states are the five published values.
  for (const state of ['qualified', 'not_qualified', 'blocked', 'error', 'not_run'] as const) {
    assert.equal(
      scannerPairDiagnosticsSchema.safeParse({ stage: 'detection', directions: { long: { state } } }).success,
      true,
      `${state} must be a valid direction state`,
    );
  }
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({ stage: 'detection', directions: { long: { state: 'passed' } } }).success,
    false,
  );

  // Counts are bounded.
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({ stage: 'detection', codes: Array(SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX + 1).fill('x') })
      .success,
    false,
  );
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({ stage: 'detection', codes: ['x'.repeat(SCANNER_RUN_PAIR_CODE_MAX_CHARS + 1)] })
      .success,
    false,
  );
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({
      stage: 'detection',
      directions: { long: { state: 'not_qualified', failing: Array(SCANNER_RUN_PAIR_FAILING_MAX + 1).fill('a:unsatisfied') } },
    }).success,
    false,
  );
  assert.equal(
    scannerPairDiagnosticsSchema.safeParse({ stage: 'detection', codes: [''] }).success,
    false,
    'an empty code is not a code',
  );
});

test('malformed diagnostics fail the whole block closed, never partially render', () => {
  const broken = v2Block(v2Item({ diagnostics: { stage: 'complete', codes: ['ok'], extra: { symbol: 'BTCUSD' } } }));
  assert.equal(scannerRunPairsSchema.safeParse(broken).success, false);
  assert.equal(readScannerRunPairs({ pairs: broken }), null, 'one corrupt item makes the sample unreadable, not guessed');
  assert.equal(
    readScannerRunPairs({ pairs: v2Block(v2Item({ diagnostics: { stage: 'nope' } })) }),
    null,
    'an unknown stage is refused',
  );
});

test('the aggregate projection of a v2 block still carries no observations', () => {
  const aggregate = readScannerRunPairAggregate({ pairs: v2Block() });
  assert.ok(aggregate);
  assert.equal(aggregate.v, 2);
  assert.equal('items' in aggregate, false);
  assert.equal(JSON.stringify(aggregate).includes('liquidity_sweep'), false, 'diagnostics never reach the aggregate');
});

test('a detection item carries bounded condition failures only when diagnostics are requested', () => {
  const base = { direction: 'long', qualified: false, setup: null, created: false, failureReasons: ['rule group "Structure" (AND) is not satisfied'] };

  const plain = detectionItemDtoSchema.safeParse(base);
  assert.equal(plain.success, true);
  assert.equal(plain.success && 'conditionOutcomes' in plain.data, false, 'the M4 response shape is unchanged');

  const withOutcomes = detectionItemDtoSchema.safeParse({
    ...base,
    conditionSummary: { satisfied: 0, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
    conditionOutcomes: [
      { conditionType: 'liquidity_sweep', status: 'unsatisfied' },
      { conditionType: 'news_filter', status: 'insufficient_data' },
    ],
  });
  assert.equal(withOutcomes.success, true);

  assert.equal(
    detectionItemDtoSchema.safeParse({
      ...base,
      conditionOutcomes: Array(DETECTION_CONDITION_OUTCOMES_MAX + 1).fill({ conditionType: 'fvg', status: 'unsatisfied' }),
    }).success,
    false,
    'the list is bounded',
  );
  assert.equal(
    detectionItemDtoSchema.safeParse({ ...base, conditionOutcomes: [{ conditionType: 'fvg', status: 'skipped' }] }).success,
    false,
    'only the three failure statuses are accepted',
  );
});

/* ------------------------------------------------------------------------- */
/* PR A — failing-condition vocabulary                                       */
/* ------------------------------------------------------------------------- */

test('failing codes are <conditionType>:<status> from the real enums', () => {
  assert.deepEqual(parseConditionFailingCode('liquidity_sweep:unsatisfied'), {
    conditionType: 'liquidity_sweep',
    status: 'unsatisfied',
  });
  assert.deepEqual(parseConditionFailingCode('news_filter:insufficient_data'), {
    conditionType: 'news_filter',
    status: 'insufficient_data',
  });
  assert.equal(conditionFailingCode('fvg', 'unsupported'), 'fvg:unsupported');

  // Not condition evidence, whatever it looks like.
  const rejected = [
    'foo:bar', // unknown condition type
    'liquidity_sweep:satisfied', // a failing entry cannot be satisfied
    'liquidity_sweep:pending', // unknown status
    'liquidity_sweep', // no status
    ':unsatisfied', // no condition type
    'liquidity_sweep:', // empty status
    'LIQUIDITY_SWEEP:unsatisfied', // enum casing
    `fvg:${'x'.repeat(80)}`, // over the budget
    '',
    42,
    null,
    undefined,
    {},
    [],
  ];
  for (const value of rejected) {
    assert.equal(parseConditionFailingCode(value), null, `${String(value)} is not a failing code`);
    assert.equal(conditionFailingCodeSchema.safeParse(value).success, false, `${String(value)} fails the schema`);
  }

  assert.equal(conditionFailingCode('nope', 'unsatisfied'), null);
  assert.equal(conditionFailingCode('fvg', 'satisfied'), null);
  assert.equal(conditionFailingCode(42, 'unsatisfied'), null);
});

test('the diagnostics block refuses arbitrary tokens as condition evidence', () => {
  const withFailing = (failing: unknown) =>
    v2Block(v2Item({ diagnostics: { stage: 'complete', directions: { long: { state: 'not_qualified', failing } } } }));

  assert.equal(scannerRunPairsSchema.safeParse(withFailing(['fvg:unsatisfied'])).success, true);
  assert.equal(scannerRunPairsSchema.safeParse(withFailing(['foo:bar'])).success, false, 'unknown condition type');
  assert.equal(scannerRunPairsSchema.safeParse(withFailing(['fvg:satisfied'])).success, false, 'contradictory status');
  assert.equal(readScannerRunPairs({ pairs: withFailing(['foo:bar']) }), null, 'a bad entry fails the whole block closed');

  // Pair-level codes stay extensible: provider failure kinds are not enums here.
  const providerCode = v2Block(v2Item({ diagnostics: { stage: 'candles', codes: ['some_future_provider_kind'] } }));
  assert.equal(scannerRunPairsSchema.safeParse(providerCode).success, true);
});

test('condition outcomes use the same closed vocabulary as failing codes', () => {
  const outcome = (conditionType: unknown, status: unknown) =>
    detectionConditionOutcomeSchema.safeParse({ conditionType, status });

  // Every allowed failure status, for a registered condition type.
  for (const status of CONDITION_FAILURE_STATUSES) {
    assert.equal(outcome('liquidity_sweep', status).success, true, `${status} must be accepted`);
  }
  // Every registered condition type is valid evidence.
  for (const conditionType of DETECTION_CONDITION_TYPES) {
    assert.equal(outcome(conditionType, 'unsatisfied').success, true, `${conditionType} must be accepted`);
  }

  // Anything outside the two enums is refused.
  assert.equal(outcome('foo', 'unsatisfied').success, false, 'an unknown condition type is rejected');
  assert.equal(outcome('liquidity_sweep', 'satisfied').success, false, 'a failing entry cannot be satisfied');
  assert.equal(outcome('LIQUIDITY_SWEEP', 'unsatisfied').success, false, 'the enum casing is exact');
  assert.equal(outcome('fvg', 'bogus').success, false, 'an unknown status is rejected');
  assert.equal(outcome('', 'unsatisfied').success, false);
  assert.equal(outcome(42, 'unsatisfied').success, false);
  assert.equal(
    detectionConditionOutcomeSchema.safeParse({ conditionType: 'fvg', status: 'unsatisfied', extra: 1 }).success,
    false,
    'the object stays strict',
  );

  // The detection item agrees with the standalone schema…
  const base = { direction: 'long', qualified: false, setup: null, created: false, failureReasons: [] };
  assert.equal(
    detectionItemDtoSchema.safeParse({ ...base, conditionOutcomes: [{ conditionType: 'liquidity_sweep', status: 'unsatisfied' }] })
      .success,
    true,
  );
  assert.equal(
    detectionItemDtoSchema.safeParse({ ...base, conditionOutcomes: [{ conditionType: 'foo', status: 'unsatisfied' }] }).success,
    false,
  );
  assert.equal(
    detectionItemDtoSchema.safeParse({ ...base, conditionOutcomes: [{ conditionType: 'fvg', status: 'satisfied' }] }).success,
    false,
  );

  // …and the optional/bounded behaviour of `conditionOutcomes` is unchanged.
  assert.equal(detectionItemDtoSchema.safeParse(base).success, true, 'still optional');
  const plain = detectionItemDtoSchema.safeParse(base);
  assert.equal(plain.success && 'conditionOutcomes' in plain.data, false, 'still absent by default');
  assert.equal(
    detectionItemDtoSchema.safeParse({
      ...base,
      conditionOutcomes: Array(DETECTION_CONDITION_OUTCOMES_MAX + 1).fill({ conditionType: 'fvg', status: 'unsatisfied' }),
    }).success,
    false,
    'still bounded',
  );
});

test('scanner failing codes stay enum-bound while pair-level codes stay extensible', () => {
  // Direction evidence: the enums, nothing else.
  assert.equal(conditionFailingCodeSchema.safeParse('fvg:unsatisfied').success, true);
  assert.equal(conditionFailingCodeSchema.safeParse('fvg:insufficient_data').success, true);
  assert.equal(conditionFailingCodeSchema.safeParse('fvg:satisfied').success, false);
  assert.equal(conditionFailingCodeSchema.safeParse('foo:unsatisfied').success, false);

  // Pair-level codes are a bounded string at the contract level, not an enum, so
  // a new provider failure kind needs no contract change. (The core normaliser
  // still refuses non-token shapes when writing; see the scanner observability
  // suite.)
  const providerFailure = v2Block(v2Item({ diagnostics: { stage: 'candles', codes: ['some_future_provider_kind'] } }));
  assert.equal(scannerRunPairsSchema.safeParse(providerFailure).success, true, 'provider codes stay extensible');
  assert.equal(
    scannerRunPairsSchema.safeParse(
      v2Block(v2Item({ diagnostics: { stage: 'candles', codes: ['x'.repeat(SCANNER_RUN_PAIR_CODE_MAX_CHARS + 1)] } })),
    ).success,
    false,
    'but they are still bounded',
  );
});
