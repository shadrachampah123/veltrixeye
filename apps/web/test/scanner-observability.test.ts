/**
 * Observability PR 3/3 — Live Scanner UI.
 *
 * The rules these tests pin down:
 *  - outcomes are shown for every run that has readable counters, in the fixed
 *    order evaluated → cursor skipped → stale → failed;
 *  - a pure cursor-skip run is described as an idempotent no-op ("10 of 10 pairs
 *    already evaluated this setup bar."), never as a failure or an empty scan;
 *  - a run with no readable pair block says "unavailable" and shows **no**
 *    counts — a missing measurement is never rendered as zero;
 *  - a run the viewer does not own shows aggregates plus an explicit privacy
 *    notice, and never an observation, even if a full block arrives;
 *  - switching scope resets the list, refetches, and a stale response for a
 *    scope the user has left is discarded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  scannerRunDtoSchema,
  type ScannerPairItem,
  type ScannerPairOutcome,
  type ScannerRunDto,
} from '@veltrixeye/contracts';
import {
  PAIR_DIAGNOSTIC_TEXT_MAX,
  SCANNER_RUN_SCOPE_OPTIONS,
  buildScannerRunsRequest,
  describePairDiagnostics,
  describeScannerOutcomes,
  describeScannerRunsError,
  initialScannerRunsState,
  runAudience,
  readScannerPairSummary,
  scannerRunsEmptyCopy,
  scannerRunsReducer,
  type ScannerPairTotals,
  type ScannerRunsState,
} from '../lib/scanner-observability';
import {
  PAIR_ITEM_PREVIEW_LIMIT,
  PairItemList,
  PairOutcomeBar,
  RunScopeControl,
  ScannerLastRunOutcomes,
  ScannerRunOutcomes,
  ScannerRunRow,
  ScannerRunsCard,
} from '../components/scanner-observability';
import { ApiError } from '../lib/api';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const STRATEGY_ID = '22222222-2222-4222-8222-222222222222';
const STARTED = '2026-11-03T10:00:00.000Z';

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

function totalsOf(overrides: Partial<ScannerPairTotals> = {}): ScannerPairTotals {
  return { pairs: 0, evaluated: 0, cursor_skipped: 0, stale: 0, failed: 0, ...overrides };
}

function itemFor(index: number, outcome: ScannerPairOutcome): ScannerPairItem {
  return {
    strategyId: STRATEGY_ID,
    assetClass: 'forex',
    symbol: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'][index % 4]!,
    timeframe: '1h',
    outcome,
    cursorMs: 1_700_000_000_000 + index * 3_600_000,
    anchorMs: 1_700_003_600_000 + index * 3_600_000,
    reason: outcome === 'cursor_skipped' ? 'cursor_hit' : outcome === 'stale' ? 'setup_stale_candle' : null,
    ...(outcome === 'evaluated'
      ? { conditions: { satisfied: 1, unsatisfied: 0, insufficient_data: 0, unsupported: 0 } }
      : {}),
  };
}

/** A complete block: exactly min(200, totals.pairs) items, as the API stores it. */
function fullBlock(totals: ScannerPairTotals, overrides: Record<string, unknown> = {}) {
  const items: ScannerPairItem[] = [];
  const push = (count: number, outcome: ScannerPairOutcome) => {
    for (let i = 0; i < count; i += 1) items.push(itemFor(items.length, outcome));
  };
  push(totals.evaluated, 'evaluated');
  push(totals.cursor_skipped, 'cursor_skipped');
  push(totals.stale, 'stale');
  push(totals.failed, 'failed');
  return {
    v: 1,
    totals,
    conditions: { satisfied: totals.evaluated, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
    truncated: false,
    items,
    ...overrides,
  };
}

/**
 * A stored sample capped at the API limit (`SCANNER_RUN_PAIR_ITEMS_MAX = 200`)
 * for a run that walked more pairs — the shape that proves the disclosure uses
 * the aggregate total rather than the sample size.
 */
function truncatedBlock(totals: ScannerPairTotals) {
  const stored = Math.min(200, totals.pairs);
  const items = Array.from({ length: stored }, (_, i) => itemFor(i, 'evaluated'));
  return {
    v: 1,
    totals,
    conditions: { satisfied: totals.evaluated, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
    truncated: totals.pairs > stored,
    items,
  };
}

/** The aggregate-only projection the API returns for a run the viewer does not own. */
function aggregateOnly(totals: ScannerPairTotals) {
  const { items: _items, ...rest } = fullBlock(totals);
  return rest;
}

function runFixture(
  metadata: Record<string, unknown>,
  overrides: Partial<ScannerRunDto> = {},
): ScannerRunDto {
  return scannerRunDtoSchema.parse({
    id: RUN_ID,
    status: 'completed',
    providerSlug: 'twelve-data',
    startedAt: STARTED,
    finishedAt: '2026-11-03T10:00:04.000Z',
    strategiesScanned: 1,
    instrumentsScanned: 4,
    candlesFetched: 240,
    setupsDetected: 1,
    setupsCreated: 1,
    alertsCreated: 0,
    staleRejections: 0,
    providerFailures: 0,
    symbolsProcessed: ['EURUSD'],
    timeframesProcessed: ['1h'],
    error: null,
    metadata,
    createdAt: STARTED,
    updatedAt: '2026-11-03T10:00:04.000Z',
    ...overrides,
  });
}

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

/* ------------------------------------------------------------------------- */
/* Outcome copy                                                              */
/* ------------------------------------------------------------------------- */

describe('describeScannerOutcomes', () => {
  test('a pure cursor-skip run is an explicit no-op, not a failure', () => {
    const summary = describeScannerOutcomes(totalsOf({ pairs: 10, cursor_skipped: 10 }));
    assert.equal(summary.headline, '10 of 10 pairs already evaluated this setup bar.');
    assert.equal(summary.noOp, true);
    assert.match(summary.detail, /idempotent no-op/);
    assert.match(summary.detail, /nothing failed/i);
    assert.equal(summary.percent.cursor_skipped, 100);
  });

  test('a fully evaluated run says so', () => {
    const summary = describeScannerOutcomes(totalsOf({ pairs: 4, evaluated: 4 }));
    assert.equal(summary.headline, '4 of 4 pairs evaluated.');
    assert.equal(summary.noOp, false);
    assert.match(summary.detail, /detection engine/);
  });

  test('a mixed run breaks down the remainder without hiding the skips', () => {
    const summary = describeScannerOutcomes(
      totalsOf({ pairs: 10, evaluated: 5, cursor_skipped: 3, stale: 1, failed: 1 }),
    );
    assert.equal(summary.headline, '5 of 10 pairs evaluated.');
    assert.equal(summary.noOp, false);
    assert.match(summary.detail, /3 skipped \(already processed\)/);
    assert.match(summary.detail, /1 stale/);
    assert.match(summary.detail, /1 failed/);
    assert.equal(summary.percent.evaluated, 50);
    assert.equal(summary.percent.cursor_skipped, 30);
  });

  test('a run that walked no pairs is neither a no-op nor a zero-success run', () => {
    const summary = describeScannerOutcomes(totalsOf());
    assert.equal(summary.headline, 'No pairs were walked in this run.');
    assert.equal(summary.noOp, false);
    assert.equal(summary.percent.evaluated, 0);
  });

  test('a run where nothing reached the engine but pairs failed is stated plainly', () => {
    const summary = describeScannerOutcomes(totalsOf({ pairs: 6, stale: 4, failed: 2 }));
    assert.match(summary.headline, /No pairs were evaluated \(6 walked\)/);
    assert.equal(summary.noOp, false);
    assert.match(summary.detail, /4 stale/);
    assert.match(summary.detail, /2 failed/);
  });
});

/* ------------------------------------------------------------------------- */
/* Pair summary: aggregate vs detail vs unavailable                          */
/* ------------------------------------------------------------------------- */

describe('readScannerPairSummary', () => {
  test('an owned run yields detail, with totals from the aggregate reader', () => {
    const totals = totalsOf({ pairs: 4, evaluated: 4 });
    const summary = readScannerPairSummary({ triggeredBy: 'user', pairs: fullBlock(totals) });
    assert.equal(summary.kind, 'detail');
    if (summary.kind !== 'detail') return;
    assert.equal(summary.items.length, 4);
    assert.deepEqual(summary.aggregate.totals, totals, 'totals come from the aggregate reader, not the sample');
    assert.equal(summary.aggregate.conditions.satisfied, 4);
  });

  test('the system projection is aggregate-only and says detail is withheld', () => {
    const totals = totalsOf({ pairs: 10, cursor_skipped: 10 });
    const summary = readScannerPairSummary({ pairs: aggregateOnly(totals) });
    assert.equal(summary.kind, 'aggregate');
    if (summary.kind !== 'aggregate') return;
    assert.deepEqual(summary.aggregate.totals, totals);
    assert.equal(summary.detailWithheld, true);
  });

  test('a run with no pairs key is "missing", never zero counts', () => {
    assert.deepEqual(readScannerPairSummary({}), { kind: 'unavailable', reason: 'missing' });
    assert.deepEqual(readScannerPairSummary({ candles: { store: 1, provider: 0, total: 1 } }), {
      kind: 'unavailable',
      reason: 'missing',
    });
    assert.deepEqual(readScannerPairSummary(null), { kind: 'unavailable', reason: 'missing' });
  });

  test('a malformed pair block is "malformed", never zero counts', () => {
    for (const pairs of [[], 'nope', 7, null, { v: 1, totals: {} }, { items: [{ symbol: 'BTCUSD' }] }]) {
      assert.deepEqual(
        readScannerPairSummary({ pairs }),
        { kind: 'unavailable', reason: 'malformed' },
        `pairs=${JSON.stringify(pairs)}`,
      );
    }
  });

  test('a full block is still withheld when detail is not allowed (client-side defence)', () => {
    const totals = totalsOf({ pairs: 2, evaluated: 2 });
    const summary = readScannerPairSummary({ pairs: fullBlock(totals) }, { allowDetail: false });
    assert.equal(summary.kind, 'aggregate');
    if (summary.kind !== 'aggregate') return;
    assert.equal(summary.detailWithheld, true);
    assert.equal('items' in summary, false, 'no observations are exposed');
  });

  test('an aggregate-only run that walked no pairs withholds nothing', () => {
    const summary = readScannerPairSummary({ pairs: aggregateOnly(totalsOf()) });
    assert.equal(summary.kind, 'aggregate');
    if (summary.kind !== 'aggregate') return;
    assert.equal(summary.aggregate.totals.pairs, 0);
    assert.equal(summary.detailWithheld, false);
  });
});

/* ------------------------------------------------------------------------- */
/* Ownership + scope request                                                 */
/* ------------------------------------------------------------------------- */

describe('scope helpers', () => {
  test('ownership: a present triggeredBy is mine, and an unowned row needs a scope to be "system"', () => {
    const owned = runFixture({ triggeredBy: 'user-id', force: false });
    const unowned = runFixture({ pairs: aggregateOnly(totalsOf({ pairs: 1, stale: 1 })) });

    assert.equal(runAudience(owned), 'owner');
    assert.equal(runAudience(owned, 'all'), 'owner');

    // The automatic-cycle runs returned by these scopes are provably system rows.
    assert.equal(runAudience(unowned, 'system'), 'system');
    assert.equal(runAudience(unowned, 'all'), 'system');

    // Without a scope (the global health lastRun) an unowned row may be another
    // tenant's manual run, redacted exactly like a system one — never claim it
    // came from the automatic cycle.
    assert.equal(runAudience(unowned), 'other');
  });

  test('the scope request always names the scope the control shows', () => {
    assert.deepEqual(buildScannerRunsRequest('mine'), { limit: 20, scope: 'mine' });
    assert.deepEqual(buildScannerRunsRequest('system'), { limit: 20, scope: 'system' });
    assert.deepEqual(buildScannerRunsRequest('all', 50), { limit: 50, scope: 'all' });
  });

  test('every scope has a label, a description and its own empty copy', () => {
    assert.deepEqual(
      SCANNER_RUN_SCOPE_OPTIONS.map((option) => option.value),
      ['mine', 'system', 'all'],
    );
    for (const option of SCANNER_RUN_SCOPE_OPTIONS) {
      assert.ok(option.label.length > 0);
      assert.ok(option.description.length > 0);
      assert.ok(scannerRunsEmptyCopy(option.value).length > 0);
    }
    assert.match(scannerRunsEmptyCopy('system'), /automatic/i);
  });

  test('a 403 is surfaced as the entitlement message; a 5xx stays generic', () => {
    assert.match(
      describeScannerRunsError(new ApiError(403, 'forbidden', 'Scanner access requires a Pro or Premium subscription')),
      /Pro or Premium/,
    );
    assert.match(describeScannerRunsError(new ApiError(500, 'internal', 'boom')), /Could not load scanner runs/);
    assert.match(describeScannerRunsError(new Error('network down')), /Could not load scanner runs/);
  });
});

/* ------------------------------------------------------------------------- */
/* Run-list state machine (scope switching)                                  */
/* ------------------------------------------------------------------------- */

describe('scannerRunsReducer', () => {
  const loaded: ScannerRunsState = {
    scope: 'mine',
    runs: [runFixture({ triggeredBy: 'user', force: false })],
    loading: false,
    error: null,
    requestId: 0,
  };

  test('starts loading the default scope', () => {
    assert.deepEqual(initialScannerRunsState(), {
      scope: 'mine',
      runs: null,
      loading: true,
      error: null,
      requestId: 0,
    });
    assert.equal(initialScannerRunsState('system').scope, 'system');
  });

  test('switching scope clears the previous scope’s rows and starts a new request', () => {
    const next = scannerRunsReducer(loaded, { type: 'scope', scope: 'system' });
    assert.equal(next.scope, 'system');
    assert.equal(next.runs, null, 'another scope’s rows are never shown under this label');
    assert.equal(next.loading, true);
    assert.equal(next.error, null);
    assert.equal(next.requestId, loaded.requestId + 1);
  });

  test('re-selecting the active scope does not refetch', () => {
    assert.equal(scannerRunsReducer(loaded, { type: 'scope', scope: 'mine' }), loaded);
  });

  test('a response for a superseded request is ignored', () => {
    const switched = scannerRunsReducer(loaded, { type: 'scope', scope: 'all' });
    const stale = scannerRunsReducer(switched, {
      type: 'loaded',
      requestId: loaded.requestId,
      runs: [runFixture({ triggeredBy: 'user' })],
    });
    assert.equal(stale, switched, 'the old scope’s response cannot repaint the list');
    assert.equal(stale.runs, null);
  });

  test('a matching response fills the list and clears loading', () => {
    const switched = scannerRunsReducer(loaded, { type: 'scope', scope: 'system' });
    const rows = [runFixture({ pairs: aggregateOnly(totalsOf({ pairs: 1, cursor_skipped: 1 })) })];
    const done = scannerRunsReducer(switched, { type: 'loaded', requestId: switched.requestId, runs: rows });
    assert.deepEqual(done.runs, rows);
    assert.equal(done.loading, false);
    assert.equal(done.error, null);
  });

  test('refresh keeps the rows visible while the request is in flight', () => {
    const refreshing = scannerRunsReducer(loaded, { type: 'refresh' });
    assert.equal(refreshing.loading, true);
    assert.deepEqual(refreshing.runs, loaded.runs);
    assert.equal(refreshing.requestId, loaded.requestId + 1);
  });

  test('a failure is recorded, and a stale failure is discarded', () => {
    const failed = scannerRunsReducer(loaded, { type: 'refresh' });
    const withError = scannerRunsReducer(failed, {
      type: 'failed',
      requestId: failed.requestId,
      error: 'Could not load scanner runs. Please try again.',
    });
    assert.equal(withError.loading, false);
    assert.equal(withError.error, 'Could not load scanner runs. Please try again.');
    assert.deepEqual(withError.runs, loaded.runs, 'the previous rows stay readable');

    const ignored = scannerRunsReducer(withError, {
      type: 'failed',
      requestId: loaded.requestId,
      error: 'stale',
    });
    assert.equal(ignored, withError);
  });
});

/* ------------------------------------------------------------------------- */
/* Render: scope control                                                     */
/* ------------------------------------------------------------------------- */

describe('RunScopeControl', () => {
  test('renders all three scopes and marks exactly the active one', () => {
    const html = render(React.createElement(RunScopeControl, { value: 'system', onChange: () => {} }));
    assert.match(html, /role="group"/);
    assert.match(html, /aria-label="Scanner run scope"/);
    assert.match(html, /data-scope="mine"/);
    assert.match(html, /data-scope="system"/);
    assert.match(html, /data-scope="all"/);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, 'exactly one scope is active');
    assert.match(html, /data-scope="system"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-scope="system"/);
    assert.match(html, /My runs/);
    assert.match(html, /All runs/);
    // The description is announced, not just a tooltip.
    assert.match(html, /class="sr-only"/);
  });

  test('switching scopes is a click away, and the control is a real button group', () => {
    const html = render(React.createElement(RunScopeControl, { value: 'mine', onChange: () => {} }));
    assert.equal((html.match(/type="button"/g) ?? []).length, 3, 'keyboard-operable buttons, not links');
    assert.ok(!html.includes('<a '), 'scope switching never navigates');
  });
});

/* ------------------------------------------------------------------------- */
/* Render: outcomes                                                          */
/* ------------------------------------------------------------------------- */

describe('ScannerRunOutcomes', () => {
  test('a system no-op run shows aggregates, the no-op copy and the privacy notice', () => {
    const metadata = { pairs: aggregateOnly(totalsOf({ pairs: 10, cursor_skipped: 10 })) };
    const audience = runAudience(runFixture(metadata), 'system');
    const summary = readScannerPairSummary(metadata, { allowDetail: audience === 'owner' });
    const html = render(React.createElement(ScannerRunOutcomes, { summary, audience }));

    assert.match(html, /10 of 10 pairs already evaluated this setup bar\./);
    assert.match(html, /No-op/);
    assert.match(html, /Cursor skipped/);
    assert.match(html, /Per-pair details withheld/);
    assert.match(html, /mixes pairs from every account/);
    assert.ok(!html.includes('data-testid="pair-items"'), 'no observations are rendered');
    assert.match(html, /data-testid="pair-outcome-legend"/);
  });

  test('an owned run shows its per-pair observations', () => {
    const metadata = { triggeredBy: 'user-id', pairs: fullBlock(totalsOf({ pairs: 2, evaluated: 2 })) };
    const summary = readScannerPairSummary(metadata);
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));

    assert.match(html, /2 of 2 pairs evaluated\./);
    assert.match(html, /data-testid="pair-items"/);
    assert.match(html, /data-testid="pair-item-list"/);
    assert.match(html, /EURUSD/);
    assert.ok(!html.includes('Per-pair details withheld'), 'nothing is withheld from the owner');
  });

  test('historical runs say "unavailable" and never render fabricated zero counts', () => {
    const summary = readScannerPairSummary({ candles: { store: 240, provider: 0, total: 240 } });
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));

    assert.match(html, /Pair outcomes unavailable/);
    assert.match(html, /predates per-pair observability/);
    assert.ok(!html.includes('data-testid="pair-outcome-legend"'), 'no counts block is drawn');
    assert.ok(!html.includes('data-testid="pair-outcome-bar"'), 'no bar is drawn');
    assert.ok(!html.includes('0 of 0'), 'absence is not rendered as zero');
  });

  test('a malformed pair block is reported as unreadable, not as zero', () => {
    const summary = readScannerPairSummary({ pairs: { v: 1, totals: {} } });
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));

    assert.match(html, /Pair outcomes unavailable/);
    assert.match(html, /could not be read/);
    assert.ok(!html.includes('data-testid="pair-outcome-legend"'));
  });

  test('a full block on a system row never renders observations', () => {
    const totals = totalsOf({ pairs: 2, evaluated: 2 });
    const metadata = { pairs: fullBlock(totals) };
    const summary = readScannerPairSummary(metadata, { allowDetail: false });
    const html = render(React.createElement(ScannerRunOutcomes, { summary, audience: 'system' }));

    assert.ok(!html.includes('EURUSD'), 'no instrument from an observation leaks');
    assert.ok(!html.includes('data-testid="pair-items"'));
    assert.match(html, /Per-pair details withheld/);
    assert.match(html, /2 of 2 pairs evaluated\./, 'aggregates are still shown');
  });

  test('an aggregate-only run that walked no pairs withholds nothing', () => {
    const summary = readScannerPairSummary({ pairs: aggregateOnly(totalsOf()) });
    const html = render(React.createElement(ScannerRunOutcomes, { summary, audience: 'system' }));
    assert.match(html, /No pairs were walked in this run\./);
    assert.ok(!html.includes('Per-pair details withheld'));
  });
});

/* ------------------------------------------------------------------------- */
/* Render: the global health last run                                        */
/* ------------------------------------------------------------------------- */

describe('regression: last-run audience attribution', () => {
  /** What `getHealth().lastRun` looks like for a run the viewer does not own. */
  const redactedLastRun = () =>
    runFixture({ pairs: aggregateOnly(totalsOf({ pairs: 10, cursor_skipped: 10 })) });

  test('an owned run is "owner" and may show its per-pair details', () => {
    const run = runFixture({ triggeredBy: 'user-id', pairs: fullBlock(totalsOf({ pairs: 2, evaluated: 2 })) });
    assert.equal(runAudience(run), 'owner');

    const html = render(React.createElement(ScannerLastRunOutcomes, { run }));
    assert.match(html, /data-testid="pair-items"/, 'the owner can open their observations');
    assert.match(html, /Per-pair observations \(2 shown of 2\)/);
    assert.ok(!html.includes('Per-pair details withheld'));
  });

  test('a redacted last run with no triggeredBy is "other", never assumed to be "system"', () => {
    const run = redactedLastRun();
    assert.equal(run.metadata.triggeredBy, undefined, 'the payload carries no owner');
    assert.equal(runAudience(run), 'other');
    assert.notEqual(runAudience(run), 'system', 'the global lastRun cannot prove system authorship');
  });

  test('an "other" run shows no System badge and makes no automatic-cycle claim', () => {
    const html = render(React.createElement(ScannerLastRunOutcomes, { run: redactedLastRun() }));
    assert.ok(!html.includes('>System</span>'), 'not labelled System');
    assert.ok(!html.includes('automatic scan cycle'), 'no origin is asserted');
  });

  test('an "other" run explains the withholding neutrally', () => {
    const html = render(React.createElement(ScannerLastRunOutcomes, { run: redactedLastRun() }));
    assert.match(html, /Per-pair details withheld/);
    assert.match(html, /was not triggered from your session/);
    assert.match(html, /only aggregate outcome metrics are shown/);
    assert.ok(!html.includes('mixes pairs from every account'), 'the system-specific reason is not reused');
    assert.match(html, /10 of 10 pairs already evaluated this setup bar\./, 'aggregates stay visible');
  });

  test('a genuine system row in a system scope is labelled and explained as system', () => {
    const run = redactedLastRun();
    // `system`/`all` can only contain own runs plus the automatic cycle's, so an
    // unowned row there *is* a system run — this is the one place the UI may say so.
    assert.equal(runAudience(run, 'system'), 'system');
    assert.equal(runAudience(run, 'all'), 'system');

    const html = render(React.createElement(ScannerRunRow, { run, scope: 'system' }));
    assert.match(html, />System</, 'the badge is shown where the scope proves it');
    assert.match(html, /mixes pairs from every account/);
  });

  test('unowned runs never render observations, even when a complete block is supplied', () => {
    // Defence in depth: a redaction regression on the server must not become a
    // client-side leak, in the health card or in either unscoped list.
    const run = runFixture({ pairs: fullBlock(totalsOf({ pairs: 2, evaluated: 2 })) });
    const renderings: [string, string][] = [
      ['health last run', render(React.createElement(ScannerLastRunOutcomes, { run }))],
      ['scope=system', render(React.createElement(ScannerRunRow, { run, scope: 'system' }))],
      ['scope=all', render(React.createElement(ScannerRunRow, { run, scope: 'all' }))],
    ];

    for (const [label, html] of renderings) {
      assert.ok(!html.includes('data-testid="pair-items"'), `${label}: no observations`);
      assert.ok(!html.includes('Per-pair observations'), `${label}: no disclosure control either`);
      assert.ok(!html.includes('EURUSD'), `${label}: no instrument from an observation`);
      assert.match(html, /2 of 2 pairs evaluated\./, `${label}: aggregates are still shown`);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Render: bar, item list, row                                               */
/* ------------------------------------------------------------------------- */

describe('pair outcome primitives', () => {
  test('the bar names every outcome for assistive tech and draws only non-zero segments', () => {
    const html = render(
      React.createElement(PairOutcomeBar, { totals: totalsOf({ pairs: 10, evaluated: 4, cursor_skipped: 6 }) }),
    );
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="Pair outcomes — Evaluated: 4, Cursor skipped: 6, Stale: 0, Failed: 0"/);
    assert.equal((html.match(/data-outcome=/g) ?? []).length, 2, 'zero-width segments are not drawn');
  });

  test('an empty run gets a flat bar with an explicit label, never a misleading split', () => {
    const html = render(React.createElement(PairOutcomeBar, { totals: totalsOf() }));
    assert.match(html, /no pairs walked/);
    assert.equal((html.match(/data-outcome=/g) ?? []).length, 0);
  });

  test('the item list states how many observations of how many pairs are shown', () => {
    const totals = totalsOf({ pairs: 250, evaluated: 250 });
    const items = Array.from({ length: 200 }, (_, i) => itemFor(i, 'evaluated'));
    const html = render(
      React.createElement(PairItemList, { items, totals, truncated: true, limit: 5 }),
    );
    assert.match(html, /Showing 5 of 250 pairs/);
    assert.match(html, /stored sample is capped/);
    assert.equal((html.match(/data-testid="pair-item-list"/g) ?? []).length, 1);
  });

  test('a run row labels system rows and shows their aggregate outcomes', () => {
    const run = runFixture({ pairs: aggregateOnly(totalsOf({ pairs: 6, cursor_skipped: 6 })) });
    const html = render(React.createElement(ScannerRunRow, { run, scope: 'system' }));
    assert.match(html, /System/);
    assert.match(html, /6 of 6 pairs already evaluated this setup bar\./);
    assert.match(html, /Per-pair details withheld/);
  });

  test('a row for a legacy run shows "unavailable" instead of zero counts', () => {
    const run = runFixture({ triggeredBy: 'user-id', force: false });
    const html = render(React.createElement(ScannerRunRow, { run, scope: 'mine' }));
    assert.match(html, /Pair outcomes unavailable/);
    assert.ok(!html.includes('data-testid="pair-outcome-legend"'));
  });
});

/* ------------------------------------------------------------------------- */
/* Regression: honest observation disclosure count                            */
/* ------------------------------------------------------------------------- */

describe('regression: observation disclosure count', () => {
  /** One rendered observation row (the symbol cell is unique to a row). */
  const renderedRows = (html: string) =>
    (html.match(/class="col-span-2 font-mono text-ink-100"/g) ?? []).length;

  const detailSummary = (block: Record<string, unknown>) => {
    const summary = readScannerPairSummary({ triggeredBy: 'user-id', pairs: block });
    assert.equal(summary.kind, 'detail', 'the fixture must be a readable detail block');
    return summary;
  };

  test('more stored observations than the limit reports the rendered count, not the stored count', () => {
    const totals = totalsOf({ pairs: 20, evaluated: 20 });
    const summary = detailSummary(fullBlock(totals));
    assert.equal(summary.kind === 'detail' && summary.items.length, 20, 'all 20 observations are stored');

    const html = render(React.createElement(ScannerRunOutcomes, { summary }));
    assert.match(html, /12 shown of 20/, 'the disclosure matches what is drawn');
    assert.ok(!html.includes('20 shown of 20'), 'the stored sample size is not presented as shown');
    assert.equal(renderedRows(html), PAIR_ITEM_PREVIEW_LIMIT, 'only the shared limit is rendered');
  });

  test('the list renders no more rows than the shared limit, from either component', () => {
    assert.equal(PAIR_ITEM_PREVIEW_LIMIT, 12, 'the single source of truth for the preview cap');

    const items = Array.from({ length: 200 }, (_, i) => itemFor(i, 'evaluated'));
    const totals = totalsOf({ pairs: 250, evaluated: 250 });

    // `PairItemList` uses the constant as its default, with no caller override.
    const listHtml = render(React.createElement(PairItemList, { items, totals, truncated: true }));
    assert.equal(renderedRows(listHtml), PAIR_ITEM_PREVIEW_LIMIT);

    // …and the outcome block that wraps it agrees.
    const summary = detailSummary(truncatedBlock(totals));
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));
    assert.equal(renderedRows(html), PAIR_ITEM_PREVIEW_LIMIT);
    assert.match(html, /12 shown of 250/);
  });

  test('fewer observations than the limit reports the smaller actual number', () => {
    const totals = totalsOf({ pairs: 3, evaluated: 3 });
    const summary = detailSummary(fullBlock(totals));
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));

    assert.match(html, /3 shown of 3/);
    assert.match(html, /Showing 3 of 3 pairs/);
    assert.equal(renderedRows(html), 3);
    assert.ok(!html.includes('12 shown'), 'the cap is never reported as a count');
  });

  test('a truncated sample keeps the aggregate total, and disclosure and footer agree', () => {
    const totals = totalsOf({ pairs: 250, evaluated: 250 });
    const summary = detailSummary(truncatedBlock(totals));
    assert.equal(summary.kind === 'detail' && summary.items.length, 200, '200 observations stored, 250 pairs walked');

    const html = render(React.createElement(ScannerRunOutcomes, { summary }));
    assert.match(html, /12 shown of 250/, 'the denominator is the aggregate total');
    assert.ok(!html.includes('12 shown of 200'), 'never the stored sample size');
    assert.match(html, /Showing 12 of 250 pairs/, 'the footer agrees with the disclosure');
    assert.match(html, /stored sample is capped, totals still cover every pair/);
    assert.equal(renderedRows(html), PAIR_ITEM_PREVIEW_LIMIT);
  });
});

/* ------------------------------------------------------------------------- */
/* Render: list card states                                                  */
/* ------------------------------------------------------------------------- */

describe('ScannerRunsCard', () => {
  const noop = () => {};

  test('loading state announces what is loading', () => {
    const html = render(
      React.createElement(ScannerRunsCard, {
        state: initialScannerRunsState('mine'),
        onScopeChange: noop,
        onRetry: noop,
      }),
    );
    assert.match(html, /role="status"/);
    assert.match(html, /Loading scanner runs/);
    assert.match(html, /data-testid="run-scope-control"/, 'the scope control is usable while loading');
  });

  test('empty state is scope-specific and not an error', () => {
    const html = render(
      React.createElement(ScannerRunsCard, {
        state: { scope: 'system', runs: [], loading: false, error: null, requestId: 1 },
        onScopeChange: noop,
        onRetry: noop,
      }),
    );
    assert.match(html, /data-testid="runs-empty"/);
    assert.match(html, /No automatic runs recorded yet/);
    assert.ok(!html.includes('role="alert"'));
  });

  test('error state is announced with a retry control', () => {
    const html = render(
      React.createElement(ScannerRunsCard, {
        state: {
          scope: 'all',
          runs: null,
          loading: false,
          error: 'Could not load scanner runs. Please try again.',
          requestId: 2,
        },
        onScopeChange: noop,
        onRetry: noop,
      }),
    );
    assert.match(html, /role="alert"/);
    assert.match(html, /Could not load scanner runs/);
    assert.match(html, /Retry/);
  });

  test('a failed refresh keeps the previous rows and offers a retry', () => {
    const runs = [runFixture({ triggeredBy: 'user-id', pairs: fullBlock(totalsOf({ pairs: 1, evaluated: 1 })) })];
    const html = render(
      React.createElement(ScannerRunsCard, {
        state: { scope: 'mine', runs, loading: false, error: 'Refresh failed', requestId: 3 },
        onScopeChange: noop,
        onRetry: noop,
      }),
    );
    assert.match(html, /Refreshing scanner runs failed/);
    assert.match(html, /data-testid="scanner-run-row"/);
  });

  test('the list shows per-run outcomes for both owned and system rows', () => {
    const owned = runFixture({ triggeredBy: 'user-id', pairs: fullBlock(totalsOf({ pairs: 2, evaluated: 2 })) });
    const system = runFixture(
      { pairs: aggregateOnly(totalsOf({ pairs: 8, cursor_skipped: 8 })) },
      { id: '33333333-3333-4333-8333-333333333333' },
    );
    const html = render(
      React.createElement(ScannerRunsCard, {
        state: { scope: 'all', runs: [owned, system], loading: false, error: null, requestId: 1 },
        onScopeChange: noop,
        onRetry: noop,
      }),
    );
    assert.equal((html.match(/data-testid="scanner-run-row"/g) ?? []).length, 2);
    assert.match(html, /2 of 2 pairs evaluated\./);
    assert.match(html, /8 of 8 pairs already evaluated this setup bar\./);
    assert.match(html, /data-testid="pair-items"/, 'the owned row keeps detail');
    assert.match(html, /Per-pair details withheld/, 'the system row says detail is withheld');
    assert.ok(!html.includes('XAUUSD'), 'no system observation is rendered');
  });
});

/* ------------------------------------------------------------------------- */
/* PR A: per-pair evaluation diagnostics                                     */
/* ------------------------------------------------------------------------- */

/** A v2 block whose items each carry the diagnostics the API now writes. */
function diagnosticsBlock(diagnostics: (Record<string, unknown> | undefined)[]) {
  const items = diagnostics.map((entry, index) => {
    const base = itemFor(index, 'evaluated');
    return entry ? { ...base, diagnostics: entry } : base;
  });
  return {
    v: 2,
    totals: totalsOf({ pairs: items.length, evaluated: items.length }),
    conditions: { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
    truncated: false,
    items,
  };
}

const renderedObservations = (html: string) =>
  (html.match(/class="col-span-2 font-mono text-ink-100"/g) ?? []).length;

describe('describePairDiagnostics', () => {
  test('a pair with no diagnostics renders nothing at all', () => {
    assert.equal(describePairDiagnostics({}), null);
    assert.equal(describePairDiagnostics({ diagnostics: undefined }), null);
  });

  test('it reads stage, then codes, then directions, then candle counts', () => {
    const text = describePairDiagnostics({
      diagnostics: {
        stage: 'persistence',
        codes: ['setup_limit_reached', 'setup_not_persisted'],
        directions: {
          long: { state: 'blocked' },
          short: { state: 'not_qualified', failing: ['liquidity_sweep:unsatisfied'] },
        },
        data: {
          htf: { candles: 60, newestMs: null },
          setup: { candles: 120, newestMs: null },
          entry: { candles: 119, newestMs: null },
        },
      },
    });
    assert.equal(
      text,
      'Stage: persistence · codes: setup_limit_reached, setup_not_persisted · long blocked by limit · short not qualified (liquidity_sweep:unsatisfied) · candles 60/120/119',
    );
  });

  test('every direction state has plain words, and only failing conditions are named', () => {
    const cases = [
      ['qualified', 'qualified'],
      ['not_qualified', 'not qualified'],
      ['blocked', 'blocked by limit'],
      ['error', 'error'],
      ['not_run', 'not run'],
    ] as const;
    for (const [state, label] of cases) {
      assert.equal(describePairDiagnostics({ diagnostics: { stage: 'detection', directions: { long: { state } } } }), `Stage: detection · long ${label}`);
    }
    // A qualified direction carries no explanation, so nothing is invented.
    assert.equal(
      describePairDiagnostics({ diagnostics: { stage: 'complete', directions: { long: { state: 'qualified' } } } }),
      'Stage: complete · long qualified',
    );
  });

  test('directions always read long before short, whatever the stored key order', () => {
    const diagnostics = {
      stage: 'complete',
      directions: { short: { state: 'error' }, long: { state: 'qualified' } },
    } as const;
    assert.equal(describePairDiagnostics({ diagnostics }), 'Stage: complete · long qualified · short error');
    assert.equal(
      describePairDiagnostics({ diagnostics }),
      describePairDiagnostics({ diagnostics }),
      'the same observation always renders the same sentence',
    );
  });

  test('the line is capped, so one pair cannot distort the table', () => {
    const failing = Array.from({ length: 4 }, (_, i) => `condition_${'x'.repeat(40)}:${i}`);
    const text = describePairDiagnostics({
      diagnostics: { stage: 'complete', codes: ['cursor_hit'], directions: { long: { state: 'not_qualified', failing } } },
    })!;
    assert.equal(text.length, PAIR_DIAGNOSTIC_TEXT_MAX);
    assert.ok(text.startsWith('Stage: complete · codes: cursor_hit'));
  });

  test('a minimal stage-only diagnostic still explains the pair', () => {
    assert.equal(describePairDiagnostics({ diagnostics: { stage: 'candles' } }), 'Stage: candles');
  });
});

describe('pair diagnostics in the observation list', () => {
  test('only pairs that carry diagnostics get a diagnostic row', () => {
    const summary = readScannerPairSummary(
      {
        triggeredBy: 'user-id',
        pairs: diagnosticsBlock([
          { stage: 'complete', codes: ['cursor_hit'] },
          undefined,
          { stage: 'validation', codes: ['insufficient_history'] },
        ]),
      },
      {},
    );
    assert.equal(summary.kind, 'detail');
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));

    assert.equal((html.match(/data-testid="pair-diagnostic"/g) ?? []).length, 2, 'one row per pair with evidence');
    assert.match(html, /Stage: complete · codes: cursor_hit/);
    assert.match(html, /Stage: validation · codes: insufficient_history/);
    assert.equal(renderedObservations(html), 3, 'the diagnostic row never duplicates an observation');
  });

  test('a run recorded before PR A renders exactly as it did before', () => {
    const legacy = readScannerPairSummary({ triggeredBy: 'user-id', pairs: fullBlock(totalsOf({ pairs: 3, evaluated: 3 })) });
    const html = render(React.createElement(ScannerRunOutcomes, { summary: legacy }));

    assert.ok(!html.includes('data-testid="pair-diagnostic"'), 'nothing is fabricated for a historical run');
    assert.ok(!html.includes('Stage:'), 'no stage is invented');
    assert.equal(renderedObservations(html), 3);
  });

  test('the full sentence is available as the row title, not just the clipped text', () => {
    const text = 'Stage: persistence · codes: setup_limit_reached';
    const summary = readScannerPairSummary({
      triggeredBy: 'user-id',
      pairs: diagnosticsBlock([{ stage: 'persistence', codes: ['setup_limit_reached'] }]),
    });
    const html = render(React.createElement(ScannerRunOutcomes, { summary }));
    assert.ok(html.includes(`title="${text}"`), 'the title carries the untruncated description');
    assert.equal(html.includes('<span data-testid="pair-diagnostic"'), true);
  });

  test('a system run never renders diagnostics, even if a full block arrives', () => {
    const metadata = {
      pairs: diagnosticsBlock([{ stage: 'complete', codes: ['setup_limit_reached'], directions: { long: { state: 'blocked' } } }]),
    };
    const audience = runAudience(runFixture(metadata), 'system');
    const allowDetail = audience === 'owner';
    assert.equal(audience, 'system');
    const summary = readScannerPairSummary(metadata, { allowDetail });
    assert.equal(summary.kind, 'aggregate', 'the client refuses to read detail it is not allowed to show');

    const html = render(React.createElement(ScannerRunOutcomes, { summary, audience }));
    assert.ok(!html.includes('data-testid="pair-diagnostic"'));
    assert.ok(!html.includes('setup_limit_reached'), 'no cause code leaks through the aggregate view');
    assert.ok(!html.includes('blocked by limit'));
    assert.match(html, /Per-pair details withheld/);
  });

  test('another tenant’s row shows no diagnostics and no reason text', () => {
    // The API redacts `triggeredBy` for a run the viewer does not own, so the
    // payload arrives without an owner — and, defensively, still with a full
    // block here: the client must refuse to read it.
    const metadata = { pairs: diagnosticsBlock([{ stage: 'detection', codes: ['detector_unavailable'] }]) };
    const run = runFixture(metadata);
    const audience = runAudience(run, 'mine');
    const allowDetail = audience === 'owner';
    assert.equal(audience, 'other');
    const summary = readScannerPairSummary(metadata, { allowDetail });
    assert.equal(summary.kind, 'aggregate', 'detail is refused for a run the viewer does not own');

    const html = render(React.createElement(ScannerRunRow, { run, scope: 'mine' }));
    assert.ok(!html.includes('data-testid="pair-diagnostic"'));
    assert.ok(!html.includes('detector_unavailable'));
    assert.ok(!html.includes('Stage:'), 'no stage is rendered');
    assert.match(html, /Per-pair details withheld/);
  });
});
