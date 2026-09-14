import type pg from 'pg';
import {
  DEFAULT_MIN_RR,
  M5_SCORE_ENGINE_VERSION,
  SETUP_TERMINAL_STATES,
  type SetupScoreDto,
  type SetupScoreHistoryResponseDto,
  type SetupScoreResponseDto,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { EvaluationService } from '../strategies/evaluation/service.js';
import type { StrategyService } from '../strategies/strategies.js';
import { SETUP_SELECT, toSetupDto, type SetupRow } from '../setups/service.js';
import { scoreSetupQuality } from './engine.js';

/**
 * Setup quality-scoring service (M5).
 *
 * Guarantees:
 *  - M3 is consumed, never bypassed: scoring re-runs
 *    `EvaluationService.evaluateVersion` at the scoring anchor, inheriting
 *    its ownership masking, published-only gate, published-config trust,
 *    and store-only reads. M5 contains zero condition logic and zero
 *    provider access.
 *  - no clock: the anchor is caller-supplied, defaulting to the setup's own
 *    detection anchor (`setups.as_of_ms`); the service never calls
 *    `Date.now` on the scoring path.
 *  - idempotent: the 0010 unique key (setup, engine version, asOfMs)
 *    serializes concurrent duplicates — the loser re-selects the winner's
 *    row and writes nothing; a replayed scoring context returns the stored
 *    row without re-evaluating.
 *  - ownership: every read/write joins through
 *    `strategy_versions → strategies.user_id`; foreign setups and scores
 *    are masked 404s, exactly like setups.
 *  - append-only: `setup_scores` rows are only ever inserted, never updated
 *    or deleted (guarded by the 0007 trigger); `setups.quality_score` is
 *    refreshed transactionally with the insert and reflects the latest
 *    score only.
 *  - lifecycle-neutral: scoring never transitions, confirms, triggers,
 *    invalidates or expires a setup — M4 owns lifecycle. Setups in terminal
 *    states are refused, not mutated.
 */
export class ScoringService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly strategies: StrategyService,
    private readonly evaluation: EvaluationService,
  ) {}

  /**
   * Score one owned setup. The anchor defaults to the setup's detection
   * anchor (the exact context the setup was detected from); an explicit
   * `asOf` re-scores at another point in time. Exactly one score row ever
   * exists per (setup, engine version, anchor) — repeats return it.
   */
  async scoreSetup(args: {
    userId: string;
    setupId: string;
    asOf?: number;
  }): Promise<SetupScoreResponseDto> {
    const row = await this.readOwnedSetup(args.userId, args.setupId);
    if (!row) throw Errors.notFound('Setup not found');
    if ((SETUP_TERMINAL_STATES as readonly string[]).includes(row.state)) {
      throw Errors.invalidInput(
        `Setup is in terminal state "${row.state}" — terminal setups are never scored. Scoring never changes lifecycle; only active setups are scored.`,
      );
    }
    const asOfMs = args.asOf ?? Number(row.as_of_ms);

    // Idempotent replay: a score for this exact context already exists.
    // Return it WITHOUT re-evaluating — one score per scoring context.
    const existing = await this.readScore(row.id, asOfMs);
    if (existing) {
      return { setup: toSetupDto(row), score: toScoreDto(existing), created: false };
    }

    // Rebuild the M3 evaluation context through the existing M3 service:
    // store-only candle reads (never a provider), ownership-masked,
    // published-only. minRr comes from the published risk configuration.
    const version = await this.strategies.getVersion(args.userId, row.strategy_id, row.strategy_version_id);
    const minRr = version.config.risk?.minRr ?? DEFAULT_MIN_RR;

    const result = await this.evaluation.evaluateVersion({
      userId: args.userId,
      strategyId: row.strategy_id,
      versionId: row.strategy_version_id,
      asOf: asOfMs,
    });
    const item = result.instruments.find(
      (i) => i.assetClass === row.asset_class && i.symbol === row.symbol,
    );
    if (!item) {
      throw Errors.invalidInput(
        `Instrument "${row.asset_class}/${row.symbol}" is no longer within this version's evaluated market scope — it cannot be scored.`,
      );
    }
    const directionEvaluation = item.directions[row.direction];

    // Pure, deterministic engine — no I/O from here on.
    const score = scoreSetupQuality({ evaluation: directionEvaluation, minRr, asOfMs });

    // Persist under the 0010 idempotency key. `ON CONFLICT DO NOTHING` makes
    // the race abort-free: the winner inserts and refreshes the setup's
    // quality score transactionally; losers commit a no-op and return the
    // winner's row — no 23505, never an aborted transaction.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<ScoreRow>(
        `INSERT INTO setup_scores (setup_id, engine_version, total, grade, components, created_at, as_of_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (setup_id, engine_version, as_of_ms) DO NOTHING
         RETURNING *`,
        [
          row.id,
          score.engineVersion,
          score.total,
          score.grade,
          JSON.stringify(score.components),
          new Date(asOfMs),
          asOfMs,
        ],
      );
      const scoreRow = inserted.rows[0];
      if (scoreRow) {
        // Winner: latest-score reflection on the setup row, transactional
        // with the insert — either both commit or neither does.
        await client.query('UPDATE setups SET quality_score = $2 WHERE id = $1', [row.id, score.total]);
        await client.query('COMMIT');
        const fresh = await this.readOwnedSetup(args.userId, args.setupId);
        if (!fresh) throw Errors.internal('Failed to read setup after scoring');
        return { setup: toSetupDto(fresh), score: toScoreDto(scoreRow), created: true };
      }
      // Lost the race: commit the no-op and return the winner's row.
      await client.query('COMMIT');
      const winner = await this.readScore(row.id, asOfMs);
      if (!winner) throw Errors.internal('Score conflict could not be resolved');
      return { setup: toSetupDto(row), score: toScoreDto(winner), created: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** One owned setup's append-only score history, newest anchor first. */
  async listScores(args: {
    userId: string;
    setupId: string;
    limit: number;
  }): Promise<SetupScoreHistoryResponseDto> {
    const row = await this.readOwnedSetup(args.userId, args.setupId);
    if (!row) throw Errors.notFound('Setup not found');
    const res = await this.pool.query<ScoreRow>(
      'SELECT * FROM setup_scores WHERE setup_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [args.setupId, args.limit],
    );
    return { setupId: row.id, scores: res.rows.map(toScoreDto) };
  }

  /** Owned setup row (full DTO identity) by id — same join as M4. */
  private async readOwnedSetup(userId: string, setupId: string): Promise<SetupRow | null> {
    const res = await this.pool.query<SetupRow>(
      `${SETUP_SELECT} WHERE s.id = $1 AND st.user_id = $2`,
      [setupId, userId],
    );
    return res.rows[0] ?? null;
  }

  /** Score row for one exact scoring context, if present. */
  private async readScore(setupId: string, asOfMs: number): Promise<ScoreRow | null> {
    const res = await this.pool.query<ScoreRow>(
      'SELECT * FROM setup_scores WHERE setup_id = $1 AND engine_version = $2 AND as_of_ms = $3',
      [setupId, M5_SCORE_ENGINE_VERSION, asOfMs],
    );
    return res.rows[0] ?? null;
  }
}

interface ScoreRow {
  id: string; // identity bigint arrives as text via node-postgres
  setup_id: string;
  engine_version: string;
  total: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'ignore';
  components: unknown;
  created_at: Date;
  as_of_ms: string; // int8 arrives as text via node-postgres
}

function toScoreDto(row: ScoreRow): SetupScoreDto {
  return {
    id: Number(row.id),
    setupId: row.setup_id,
    engineVersion: row.engine_version,
    asOfMs: Number(row.as_of_ms),
    total: row.total,
    grade: row.grade,
    // Persisted exactly as the engine produced it (array of components).
    components: row.components as SetupScoreDto['components'],
    createdAt: row.created_at.toISOString(),
  };
}
