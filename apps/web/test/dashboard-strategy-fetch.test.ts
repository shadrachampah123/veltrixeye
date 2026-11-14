/**
 * Dashboard strategy-fetch optimisation.
 *
 * The dashboard used to fetch full detail for EVERY strategy (N + 4 requests)
 * although it renders only three strategy cards. These tests pin the optimised
 * behaviour:
 *  - request budget: min(N, 3) + 4 — one strategy list, detail for the first
 *    three strategies only, one setup list (limit 20), scanner health, billing;
 *  - the detail requests are issued in parallel and their results keep list
 *    order whichever response lands first;
 *  - dashboard-wide statistics come from ALL list summaries (`currentVersionId`)
 *    and match what the old per-detail (`currentVersion`) computation produced;
 *  - the strategy lifecycle status (draft / active / paused / archived) does
 *    not change how a strategy is counted — only a current published version does;
 *  - a failed list, detail or setup request still rejects the critical load,
 *    while scanner/billing stay optional;
 *  - the page is wired to the loader and to the summary-based statistics.
 *
 * Request counting goes through the real API client over a fetch double (the
 * repository's convention for client tests — no HTTP server).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  BillingStateDto,
  ScannerHealthDto,
  SetupDto,
  StrategyDetailDto,
  StrategyStatus,
  StrategySummaryDto,
} from '@veltrixeye/contracts';
import { ApiError } from '../lib/api';
import {
  DASHBOARD_SETUP_LIMIT,
  DASHBOARD_STRATEGY_CARD_LIMIT,
  loadDashboardCriticalData,
  loadDashboardOptionalData,
  summarizeDashboardStrategies,
  type DashboardApiClient,
} from '../lib/dashboard';
import { DashboardStats } from '../components/dashboard-widgets';
import { StrategyCardGrid } from '../components/strategy-card';

const ISO = '2024-05-20T12:00:00.000Z';

function summary(index: number, overrides: Partial<StrategySummaryDto> = {}): StrategySummaryDto {
  return {
    id: `strategy-${index}`,
    name: `Strategy ${index}`,
    description: null,
    status: 'active',
    currentVersionId: `version-${index}`,
    versionCount: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/** The detail the API would return for a summary: same "current published version" rule. */
function detailOf(s: StrategySummaryDto): StrategyDetailDto {
  const version = {
    id: s.currentVersionId ?? `${s.id}-draft`,
    strategyId: s.id,
    versionNumber: 1,
    status: s.currentVersionId ? ('published' as const) : ('draft' as const),
    changelog: null,
    isCurrent: s.currentVersionId !== null,
    createdAt: ISO,
    publishedAt: s.currentVersionId ? ISO : null,
  };
  return {
    ...s,
    versions: [version],
    currentVersion: s.currentVersionId
      ? ({ ...version, config: { ruleGroups: [] } } as unknown as StrategyDetailDto['currentVersion'])
      : null,
  };
}

function summaries(count: number): StrategySummaryDto[] {
  return Array.from({ length: count }, (_, i) => summary(i + 1));
}

const SETUPS = [{ id: 'setup-1', state: 'detected', qualityScore: 80 }] as unknown as SetupDto[];
const HEALTH = { status: 'running', activeRuns: 1, recentFailures: 0 } as unknown as ScannerHealthDto;
const BILLING = { plan: 'free' } as unknown as BillingStateDto;

// ---------------------------------------------------------------------------
// Fetch double
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let calls: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Serves a dashboard backend for `list`; `failures` maps a path to an error status. */
function serveDashboard(list: StrategySummaryDto[], failures: Record<string, number> = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.method ?? 'GET', 'GET', `dashboard load must only read: ${url}`);
    calls.push(url);
    const failure = failures[url];
    if (failure !== undefined) {
      return json(failure, { error: { code: 'internal', message: `failed ${url}` } });
    }
    if (url === '/api/strategies') return json(200, { strategies: list });
    if (url.startsWith('/api/strategies/')) {
      const found = list.find((s) => s.id === url.slice('/api/strategies/'.length));
      return found ? json(200, { strategy: detailOf(found) }) : json(404, { error: { code: 'not_found', message: 'Strategy not found' } });
    }
    if (url.startsWith('/api/setups')) return json(200, { setups: SETUPS });
    if (url === '/api/scanner/health') return json(200, HEALTH);
    if (url === '/api/billing/me') return json(200, BILLING);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof globalThis.fetch;
}

/** The page's load sequence: critical data first, then the optional pair. */
async function loadLikeThePage() {
  const critical = await loadDashboardCriticalData();
  const optional = await loadDashboardOptionalData();
  return { critical, optional };
}

// ---------------------------------------------------------------------------
// Request counts
// ---------------------------------------------------------------------------

test('the card limit and the setup limit are the dashboard’s existing 3 and 20', () => {
  assert.equal(DASHBOARD_STRATEGY_CARD_LIMIT, 3);
  assert.equal(DASHBOARD_SETUP_LIMIT, 20);
});

for (const count of [0, 1, 2, 3, 4, 10, 50]) {
  test(`a dashboard load with ${count} strategies issues min(N, 3) + 4 requests`, async () => {
    const list = summaries(count);
    serveDashboard(list);

    const { critical, optional } = await loadLikeThePage();

    const expectedDetails = list.slice(0, 3).map((s) => `/api/strategies/${s.id}`);
    assert.equal(calls.length, Math.min(count, 3) + 4);
    assert.deepEqual([...calls].sort(), ['/api/strategies', ...expectedDetails, '/api/setups?limit=20', '/api/scanner/health', '/api/billing/me'].sort());
    assert.equal(new Set(calls).size, calls.length, 'no request is issued twice');

    assert.deepEqual(critical.strategySummaries, list, 'every summary is kept for statistics');
    assert.deepEqual(critical.displayedStrategies, list.slice(0, 3).map(detailOf));
    assert.deepEqual(critical.setups, SETUPS);
    assert.deepEqual(optional, { scannerHealth: HEALTH, billing: BILLING });
  });
}

test('the strategy list is fetched exactly once and strategies beyond the third are never fetched', async () => {
  const list = summaries(8);
  serveDashboard(list);
  await loadLikeThePage();
  assert.equal(calls.filter((u) => u === '/api/strategies').length, 1);
  for (const s of list.slice(3)) {
    assert.ok(!calls.includes(`/api/strategies/${s.id}`), `${s.id} is not displayed and must not be fetched`);
  }
});

// ---------------------------------------------------------------------------
// Parallel execution and ordering
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function controlledClient(list: StrategySummaryDto[]) {
  const log: string[] = [];
  const listGate = deferred<{ strategies: StrategySummaryDto[] }>();
  const setupGate = deferred<{ setups: SetupDto[] }>();
  const detailGates = new Map<string, Deferred<{ strategy: StrategyDetailDto }>>();
  const client: DashboardApiClient = {
    listStrategies: () => {
      log.push('listStrategies');
      return listGate.promise;
    },
    getStrategy: (id: string) => {
      log.push(`getStrategy:${id}`);
      const gate = deferred<{ strategy: StrategyDetailDto }>();
      detailGates.set(id, gate);
      return gate.promise;
    },
    listSetups: ((params: { limit?: number } = {}) => {
      log.push(`listSetups:${params.limit}`);
      return setupGate.promise;
    }) as DashboardApiClient['listSetups'],
    getScannerHealth: () => {
      log.push('getScannerHealth');
      return Promise.resolve(HEALTH);
    },
    getBillingState: () => {
      log.push('getBillingState');
      return Promise.resolve(BILLING);
    },
  };
  return { client, log, listGate, setupGate, detailGates, list };
}

test('the strategy list and the setup list are requested in parallel', async () => {
  const c = controlledClient(summaries(5));
  const load = loadDashboardCriticalData(c.client);
  await tick();
  assert.deepEqual(c.log, ['listStrategies', 'listSetups:20'], 'both start before either resolves');
  c.listGate.resolve({ strategies: c.list });
  c.setupGate.resolve({ setups: SETUPS });
  await tick();
  for (const gate of c.detailGates.values()) gate.reject(new Error('stop'));
  await assert.rejects(load);
});

test('the three detail requests are in flight together before any of them resolves', async () => {
  const c = controlledClient(summaries(5));
  const load = loadDashboardCriticalData(c.client);
  c.listGate.resolve({ strategies: c.list });
  c.setupGate.resolve({ setups: SETUPS });
  await tick();

  assert.deepEqual(
    c.log.filter((l) => l.startsWith('getStrategy:')),
    ['getStrategy:strategy-1', 'getStrategy:strategy-2', 'getStrategy:strategy-3'],
    'all three detail requests start without waiting on one another',
  );
  assert.equal(c.detailGates.size, 3);

  let settled = false;
  void load.then(() => (settled = true));
  c.detailGates.get('strategy-1')!.resolve({ strategy: detailOf(c.list[0]!) });
  c.detailGates.get('strategy-3')!.resolve({ strategy: detailOf(c.list[2]!) });
  await tick();
  assert.equal(settled, false, 'the load waits for every displayed strategy');
  c.detailGates.get('strategy-2')!.resolve({ strategy: detailOf(c.list[1]!) });
  const data = await load;
  assert.equal(data.displayedStrategies.length, 3);
});

test('displayed strategies keep list order when responses arrive out of order', async () => {
  const c = controlledClient(summaries(4));
  const load = loadDashboardCriticalData(c.client);
  c.listGate.resolve({ strategies: c.list });
  c.setupGate.resolve({ setups: SETUPS });
  await tick();

  // Resolve last-to-first, with a turn of the event loop between each.
  for (const index of [2, 1, 0]) {
    c.detailGates.get(c.list[index]!.id)!.resolve({ strategy: detailOf(c.list[index]!) });
    await tick();
  }
  const data = await load;
  assert.deepEqual(data.displayedStrategies.map((s) => s.id), ['strategy-1', 'strategy-2', 'strategy-3']);
  assert.deepEqual(data.strategySummaries.map((s) => s.id), ['strategy-1', 'strategy-2', 'strategy-3', 'strategy-4']);
});

test('scanner health and billing are requested together', async () => {
  const c = controlledClient([]);
  const optional = await loadDashboardOptionalData(c.client);
  assert.deepEqual(c.log, ['getScannerHealth', 'getBillingState']);
  assert.deepEqual(optional, { scannerHealth: HEALTH, billing: BILLING });
});

// ---------------------------------------------------------------------------
// Statistics and statuses
// ---------------------------------------------------------------------------

/** The statistic exactly as the dashboard computed it before, from full details. */
function legacyStats(details: StrategyDetailDto[]) {
  const published = details.filter((s) => s.currentVersion);
  return { total: details.length, published: published.length, draft: details.length - published.length };
}

const MIXED: StrategySummaryDto[] = [
  summary(1, { status: 'active' }),
  summary(2, { status: 'draft', currentVersionId: null }),
  summary(3, { status: 'paused' }),
  summary(4, { status: 'archived' }),
  summary(5, { status: 'archived', currentVersionId: null }),
  summary(6, { status: 'paused', currentVersionId: null }),
  summary(7, { status: 'draft' }),
  summary(8, { status: 'active', currentVersionId: null }),
];

test('statistics cover every strategy, not only the three displayed', () => {
  const list = [...summaries(3).map((s) => ({ ...s, currentVersionId: null })), ...summaries(7).map((s, i) => summary(i + 4))];
  assert.deepEqual(summarizeDashboardStrategies(list), { total: 10, published: 7, draft: 3 });
  // Counting only the displayed three would have reported 0 published.
  assert.deepEqual(summarizeDashboardStrategies(list.slice(0, 3)), { total: 3, published: 0, draft: 3 });
});

test('summary-based statistics equal the previous detail-based statistics', () => {
  for (const list of [[], summaries(1), summaries(4), MIXED]) {
    assert.deepEqual(summarizeDashboardStrategies(list), legacyStats(list.map(detailOf)));
  }
  assert.deepEqual(summarizeDashboardStrategies(MIXED), { total: 8, published: 4, draft: 4 });
});

test('a strategy is published when it has a current version, whatever its lifecycle status', () => {
  const statuses: StrategyStatus[] = ['draft', 'active', 'paused', 'archived'];
  for (const status of statuses) {
    assert.deepEqual(
      summarizeDashboardStrategies([summary(1, { status })]),
      { total: 1, published: 1, draft: 0 },
      `${status} with a published version counts as published`,
    );
    assert.deepEqual(
      summarizeDashboardStrategies([summary(1, { status, currentVersionId: null })]),
      { total: 1, published: 0, draft: 1 },
      `${status} without a published version counts as draft`,
    );
  }
});

test('paused and archived strategies stay in the total and are never dropped', () => {
  const list = [summary(1, { status: 'paused' }), summary(2, { status: 'archived' }), summary(3, { status: 'archived', currentVersionId: null })];
  const stats = summarizeDashboardStrategies(list);
  assert.equal(stats.total, 3);
  assert.equal(stats.published + stats.draft, stats.total);
});

test('DashboardStats renders strategy counts from summaries and keeps the setup statistics', () => {
  const setups = [
    { id: 'a', state: 'detected', qualityScore: 80 },
    { id: 'b', state: 'expired', qualityScore: 60 },
    { id: 'c', state: 'completed', qualityScore: null },
    { id: 'd', state: 'confirmed', qualityScore: null },
  ] as unknown as SetupDto[];
  const html = renderToStaticMarkup(React.createElement(DashboardStats, { strategies: MIXED, setups, scannerHealth: HEALTH }));
  assert.match(html, />8<\/span>/, 'total strategies');
  assert.ok(html.includes('4 published · 4 draft'), html);
  assert.match(html, />2<\/span>/, 'active setups exclude expired / invalidated / completed');
  assert.ok(html.includes('4 total · avg Q 70'), 'lifecycle and quality statistics are unchanged');
  assert.ok(html.includes('Running'));
  assert.ok(html.includes('1 active · 0 failures (1h)'));

  const empty = renderToStaticMarkup(React.createElement(DashboardStats, { strategies: [], setups: [], scannerHealth: null }));
  assert.ok(empty.includes('0 published · 0 draft'));
  assert.ok(empty.includes('0 total · not scored yet'));
  assert.ok(empty.includes('Loading…'));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('a failed strategy list rejects the critical load and requests no detail', async () => {
  serveDashboard(summaries(5), { '/api/strategies': 500 });
  await assert.rejects(loadDashboardCriticalData(), (e: unknown) => e instanceof ApiError && e.status === 500 && e.message === 'failed /api/strategies');
  assert.ok(!calls.some((u) => u.startsWith('/api/strategies/')));
});

test('a failed detail request for a displayed strategy rejects the critical load', async () => {
  serveDashboard(summaries(5), { '/api/strategies/strategy-2': 503 });
  await assert.rejects(loadDashboardCriticalData(), (e: unknown) => e instanceof ApiError && e.status === 503 && e.message === 'failed /api/strategies/strategy-2');
});

test('a failed setup list rejects the critical load', async () => {
  serveDashboard(summaries(2), { '/api/setups?limit=20': 500 });
  await assert.rejects(loadDashboardCriticalData(), (e: unknown) => e instanceof ApiError && e.message === 'failed /api/setups?limit=20');
});

test('a strategy that is not displayed cannot fail the dashboard', async () => {
  // Before the optimisation a broken fourth strategy took the whole dashboard down.
  serveDashboard(summaries(5), { '/api/strategies/strategy-4': 500, '/api/strategies/strategy-5': 500 });
  const data = await loadDashboardCriticalData();
  assert.equal(data.displayedStrategies.length, 3);
  assert.equal(data.strategySummaries.length, 5);
});

test('scanner or billing failures reject only the optional load', async () => {
  for (const path of ['/api/scanner/health', '/api/billing/me']) {
    calls = [];
    serveDashboard(summaries(2), { [path]: 500 });
    const critical = await loadDashboardCriticalData();
    assert.equal(critical.displayedStrategies.length, 2);
    await assert.rejects(loadDashboardOptionalData(), (e: unknown) => e instanceof ApiError);
    assert.equal(calls.length, 2 + 4, 'the request budget does not change when an optional call fails');
  }
});

// ---------------------------------------------------------------------------
// Page integration
// ---------------------------------------------------------------------------

const PAGE = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');

test('the dashboard page loads through the loaders and issues no strategy request of its own', () => {
  assert.equal(PAGE.match(/loadDashboardCriticalData\(\)/g)?.length, 1);
  assert.equal(PAGE.match(/loadDashboardOptionalData\(\)/g)?.length, 1);
  assert.ok(!/\bapi\./.test(PAGE), 'the page must not call the API client directly');
  assert.ok(!PAGE.includes('getStrategy'), 'no per-strategy detail fetch in the page');
  assert.ok(PAGE.indexOf('loadDashboardCriticalData()') < PAGE.indexOf('loadDashboardOptionalData()'), 'critical data loads first');
});

test('the dashboard page feeds summaries to the statistics and details to the cards', () => {
  assert.ok(PAGE.includes('<DashboardStats strategies={strategySummaries!}'));
  assert.ok(PAGE.includes('<StrategyCardGrid strategies={strategies ?? []} />'));
  assert.ok(PAGE.includes('setStrategySummaries(critical.strategySummaries)'));
  assert.ok(PAGE.includes('setStrategies(critical.displayedStrategies)'));
  assert.ok(PAGE.includes('(strategySummaries?.length ?? 0) === 0'), 'the empty state follows the full list');
});

test('the dashboard page keeps its error handling and optional scanner/billing fallback', () => {
  assert.ok(PAGE.includes("setError(e?.message ?? 'Failed to load dashboard data')"));
  const failure = PAGE.slice(PAGE.indexOf('} catch (e: any) {'), PAGE.indexOf('const optional ='));
  for (const reset of ['setStrategySummaries([])', 'setStrategies([])', 'setSetups([])']) {
    assert.ok(failure.includes(reset), `a failed critical load must run ${reset} so the spinner clears`);
  }
  const fallback = PAGE.slice(PAGE.indexOf('const optional ='));
  assert.ok(fallback.includes('setScannerHealth(null)') && fallback.includes('setBilling(null)'));
});

test('a loaded dashboard renders three cards in list order and statistics for every strategy', async () => {
  const list = MIXED;
  serveDashboard(list);
  const { critical } = await loadLikeThePage();
  assert.equal(calls.length, 3 + 4);

  const cards = renderToStaticMarkup(React.createElement(StrategyCardGrid, { strategies: critical.displayedStrategies }));
  const positions = list.map((s) => cards.indexOf(`>${s.name}<`));
  assert.ok(positions[0]! >= 0 && positions[0]! < positions[1]! && positions[1]! < positions[2]!, 'the first three, in order');
  for (const position of positions.slice(3)) assert.equal(position, -1, 'no card beyond the third');
  assert.ok(cards.includes('v1 live'), 'a published strategy shows its live version');
  assert.ok(cards.includes('v1 draft'), 'a draft-only strategy shows its draft');

  const stats = renderToStaticMarkup(
    React.createElement(DashboardStats, { strategies: critical.strategySummaries, setups: critical.setups, scannerHealth: null }),
  );
  assert.ok(stats.includes('4 published · 4 draft'), 'statistics span all eight strategies');
});
