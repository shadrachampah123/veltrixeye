import type pg from 'pg';
import {
  MAX_EVALUATION_INSTRUMENTS,
  timeframeMinutes,
  type EvaluationEngine,
  type EvaluationResultDto,
  type InstrumentEvaluation,
  type NormalizedInstrument,
  type StrategyVersionConfig,
  type Timeframe,
} from '@veltrixeye/contracts';
import { Errors } from '../../errors.js';
import type { StrategyService } from '../strategies.js';
import type { CandleStore } from '../../market-data/candles.js';
import { createEvaluationEngine } from './engine.js';

/**
 * Evaluation service (M3) — the ONLY boundary between the HTTP layer and the
 * deterministic engine.
 *
 * Guarantees:
 *  - ownership: version loading goes through `StrategyService.getVersion`,
 *    so foreign or nonexistent strategies/versions are masked 404s;
 *  - published only: draft versions are rejected (published and deprecated
 *    versions are immutable and may both be evaluated);
 *  - STORE-ONLY data access: candles are read from the shared `CandleStore`
 *    directly. `IngestionService` (fetch-through) is NEVER touched, so an
 *    evaluation can never trigger a provider call — evaluation works with
 *    `TWELVE_DATA_API_KEY` unset and its output depends only on stored data;
 *  - bounded: instrument count is capped (`MAX_EVALUATION_INSTRUMENTS`, scope
 *    "all" is deterministically truncated), and each role's candle window is
 *    capped by the same 5000-candle ceiling the store enforces;
 *  - deterministic anchor: `asOfMs` is taken from the caller; the service
 *    never advances the clock mid-evaluation. The ONLY wall-clock read is
 *    the default `asOfMs = Date.now()` at the API edge when the caller omits
 *    `asOf` (injectable via `nowMs` for tests).
 */
export class EvaluationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly strategies: StrategyService,
    private readonly store: CandleStore,
    private readonly engine: EvaluationEngine = createEvaluationEngine(),
  ) {}

  async evaluateVersion(args: {
    userId: string;
    strategyId: string;
    versionId: string;
    /** Explicit anchor (epoch-ms). Preferred: keeps evaluation reproducible. */
    asOf?: number;
    /** Test seam: wall clock used ONLY when `asOf` is omitted. */
    nowMs?: number;
  }): Promise<EvaluationResultDto> {
    const asOfMs = args.asOf ?? args.nowMs ?? Date.now();
    const version = await this.strategies.getVersion(args.userId, args.strategyId, args.versionId);

    if (version.status === 'draft') {
      throw Errors.invalidInput(
        'Only published versions can be evaluated — a draft is still mutable. Publish the version first.',
      );
    }
    const config = version.config;
    if (!config.timeframes) {
      throw Errors.invalidInput('Published version is missing its timeframe configuration.');
    }
    if (!config.risk) {
      throw Errors.invalidInput('Published version is missing its risk configuration.');
    }

    const { instruments, truncated } = await this.resolveInstruments(config);

    // Per-role candle windows: the largest lookback any condition assigned to
    // that role can ask for, plus margin, clamped to the store's 5000 cap.
    const windows = requiredWindows(config);

    const instrumentsOut: InstrumentEvaluation[] = [];
    const notes = new Set<string>();
    for (const instrument of instruments) {
      const resolved = await this.store.resolveInstrument(instrument.assetClass, instrument.symbol);
      if (!resolved) {
        throw Errors.notFound(`Unknown instrument "${instrument.assetClass}/${instrument.symbol}"`);
      }
      const candleSet = {
        htf_bias: await this.readRole(resolved.id, config.timeframes.htf_bias, windows.htf_bias, asOfMs),
        setup: await this.readRole(resolved.id, config.timeframes.setup, windows.setup, asOfMs),
        entry: await this.readRole(resolved.id, config.timeframes.entry, windows.entry, asOfMs),
      };
      const result = this.engine.evaluate({
        config,
        instrument: { assetClass: resolved.assetClass, symbol: resolved.symbol },
        candles: candleSet,
        asOfMs,
      });
      for (const note of result.notes) notes.add(note);
      instrumentsOut.push({
        assetClass: resolved.assetClass,
        symbol: resolved.symbol,
        directions: { long: result.long, short: result.short },
        anyPassed: result.long.passed || result.short.passed,
      });
    }

    if (truncated) {
      notes.add(
        `Market scope "all" exceeds the ${MAX_EVALUATION_INSTRUMENTS}-instrument evaluation cap — evaluated the first ${MAX_EVALUATION_INSTRUMENTS} instruments in (assetClass, symbol) order.`,
      );
    }

    return {
      strategyId: args.strategyId,
      versionId: args.versionId,
      versionNumber: version.versionNumber,
      engineVersion: this.engine.engineVersion,
      asOfMs,
      evaluatedAt: new Date(asOfMs).toISOString(),
      instruments: instrumentsOut,
      truncated,
      notes: [...notes],
    };
  }

  /** STORE read only — deliberately not IngestionService, so no fetch-through. */
  private async readRole(instrumentId: string, timeframe: Timeframe, windowCandles: number, asOfMs: number) {
    const periodMs = timeframeMinutes(timeframe) * 60_000;
    return this.store.queryCandles({
      instrumentId,
      timeframe,
      from: asOfMs - windowCandles * periodMs,
      to: asOfMs,
      limit: windowCandles,
    });
  }

  private async resolveInstruments(config: StrategyVersionConfig): Promise<{
    instruments: NormalizedInstrument[];
    truncated: boolean;
  }> {
    const scope = config.marketScope;
    if (!scope) throw Errors.invalidInput('Published version is missing its market scope.');
    if (scope.mode === 'instruments') {
      const instruments = scope.instruments ?? [];
      if (instruments.length === 0) throw Errors.invalidInput('Market scope lists no instruments.');
      if (instruments.length > MAX_EVALUATION_INSTRUMENTS) {
        throw Errors.invalidInput(
          `Market scope lists ${instruments.length} instruments — the evaluation cap is ${MAX_EVALUATION_INSTRUMENTS}.`,
        );
      }
      return { instruments, truncated: false };
    }
    // scope "all": every instrument the platform knows, deterministic order,
    // deterministically truncated at the cap.
    const res = await this.pool.query<{ asset_class: string; symbol: string }>(
      'SELECT asset_class, symbol FROM instruments ORDER BY asset_class, symbol LIMIT $1',
      [MAX_EVALUATION_INSTRUMENTS + 1],
    );
    const rows = res.rows.slice(0, MAX_EVALUATION_INSTRUMENTS).map((r) => ({
      assetClass: r.asset_class as NormalizedInstrument['assetClass'],
      symbol: r.symbol,
    }));
    return { instruments: rows, truncated: res.rows.length > MAX_EVALUATION_INSTRUMENTS };
  }
}

/** Hard per-role candle ceiling (matches the store's MAX_CANDLES_PER_REQUEST). */
const MAX_WINDOW_CANDLES = 5000;
/** Margin added on top of the largest declared lookback. */
const WINDOW_MARGIN = 60;
/** Minimum window so pivots (k=2) and ATR(14) always have a chance. */
const MIN_WINDOW_CANDLES = 120;
/** Pinned windows for types whose needs are not expressible as a param. */
const TYPE_WINDOW_FLOOR: Record<string, number> = {
  fvg: 200, // ZONE_WINDOW in handlers.ts
  supply: 300, // SD_WINDOW
  demand: 300, // SD_WINDOW
  htf_alignment: 100, // bias window
};

/**
 * Largest candle count any condition assigned to a role may consume.
 * `timeframeRole: 'any'` counts toward the SETUP role (its evaluation
 * convention), except htf_alignment which counts toward htf_bias.
 */
export function requiredWindows(config: StrategyVersionConfig): Record<'htf_bias' | 'setup' | 'entry', number> {
  const windows: Record<'htf_bias' | 'setup' | 'entry', number> = {
    htf_bias: MIN_WINDOW_CANDLES,
    setup: MIN_WINDOW_CANDLES,
    entry: MIN_WINDOW_CANDLES,
  };
  for (const group of config.ruleGroups) {
    for (const condition of group.conditions) {
      const roleForWindow: 'htf_bias' | 'setup' | 'entry' =
        condition.timeframeRole === 'any'
          ? condition.conditionType === 'htf_alignment'
            ? 'htf_bias'
            : 'setup'
          : condition.timeframeRole === 'htf_bias'
            ? 'htf_bias'
            : condition.timeframeRole === 'entry'
              ? 'entry'
              : 'setup';
      let need = TYPE_WINDOW_FLOOR[condition.conditionType] ?? 0;
      const params = condition.params as Record<string, unknown>;
      for (const key of ['lookbackCandles', 'maxAgeCandles', 'maxRetestCandles', 'period', 'atrPeriod']) {
        const v = params[key];
        if (typeof v === 'number' && Number.isFinite(v) && v > need) need = v;
      }
      // displacement checks add ATR(14) context; break_retest scans its window.
      const total = Math.min(MAX_WINDOW_CANDLES, Math.ceil(need) + WINDOW_MARGIN);
      if (total > windows[roleForWindow]) windows[roleForWindow] = total;
    }
  }
  return windows;
}
