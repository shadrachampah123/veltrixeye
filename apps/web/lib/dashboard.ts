/**
 * Dashboard data loading.
 *
 * The dashboard shows full strategy cards for only the first
 * `DASHBOARD_STRATEGY_CARD_LIMIT` strategies, but its headline statistics cover
 * every strategy the user owns. `GET /api/strategies` already returns a summary
 * (including `currentVersionId`) for each one, so the statistics are computed
 * from that single list response and the full detail is fetched only for the
 * strategies that are actually rendered as cards.
 *
 * Request budget for a dashboard load with N strategies:
 *   1 (strategy list) + min(N, 3) (card details) + 1 (setups)
 *   + 2 (scanner health, billing state) = min(N, 3) + 4
 */
import type {
  BillingStateDto,
  ScannerHealthDto,
  SetupDto,
  StrategyDetailDto,
  StrategySummaryDto,
} from '@veltrixeye/contracts';
import { api } from './api';

/** How many strategies the dashboard renders as full cards. */
export const DASHBOARD_STRATEGY_CARD_LIMIT = 3;

/** How many recent setups the dashboard loads. */
export const DASHBOARD_SETUP_LIMIT = 20;

export type DashboardApiClient = Pick<
  typeof api,
  'listStrategies' | 'getStrategy' | 'listSetups' | 'getScannerHealth' | 'getBillingState'
>;

export interface DashboardCriticalData {
  /** Every strategy summary, in API order. Source of dashboard-wide statistics. */
  strategySummaries: StrategySummaryDto[];
  /** Full detail for the first `DASHBOARD_STRATEGY_CARD_LIMIT` summaries, same order. */
  displayedStrategies: StrategyDetailDto[];
  setups: SetupDto[];
}

export interface DashboardOptionalData {
  scannerHealth: ScannerHealthDto;
  billing: BillingStateDto;
}

export interface DashboardStrategyStats {
  total: number;
  /** Strategies with a current (published) version. */
  published: number;
  /** Strategies without a current (published) version. */
  draft: number;
}

/**
 * Strategy statistics from list summaries.
 *
 * A strategy counts as "published" when it has a current published version —
 * `currentVersionId` on the summary is non-null exactly when `currentVersion`
 * on the detail is non-null (both are "the highest-numbered published
 * version"). Everything else counts as "draft". The strategy's own lifecycle
 * `status` (draft / active / paused / archived) deliberately does not enter
 * into it, which is how the dashboard has always counted.
 */
export function summarizeDashboardStrategies(
  summaries: readonly Pick<StrategySummaryDto, 'currentVersionId'>[],
): DashboardStrategyStats {
  const total = summaries.length;
  const published = summaries.filter((s) => Boolean(s.currentVersionId)).length;
  return { total, published, draft: total - published };
}

/**
 * Data the dashboard cannot render without: strategies and recent setups.
 *
 * The strategy list and the setup list are requested in parallel. Once the
 * list arrives, detail for the displayed strategies is requested in parallel;
 * `Promise.all` keeps the results in list order regardless of which response
 * lands first. Any failure rejects the whole load.
 */
export async function loadDashboardCriticalData(client: DashboardApiClient = api): Promise<DashboardCriticalData> {
  const [strategyData, setups] = await Promise.all([
    client.listStrategies().then(async ({ strategies: strategySummaries }) => {
      const displayedStrategies = await Promise.all(
        strategySummaries
          .slice(0, DASHBOARD_STRATEGY_CARD_LIMIT)
          .map((s) => client.getStrategy(s.id).then((r) => r.strategy)),
      );
      return { strategySummaries, displayedStrategies };
    }),
    client.listSetups({ limit: DASHBOARD_SETUP_LIMIT }).then((r) => r.setups),
  ]);
  return { ...strategyData, setups };
}

/** Non-critical data: the dashboard still renders when this rejects. */
export async function loadDashboardOptionalData(client: DashboardApiClient = api): Promise<DashboardOptionalData> {
  const [scannerHealth, billing] = await Promise.all([client.getScannerHealth(), client.getBillingState()]);
  return { scannerHealth, billing };
}
