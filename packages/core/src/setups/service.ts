import type pg from 'pg';
import {
  DETECTOR_VERSION,
  SETUP_INITIAL_STATE,
  type CandidateLevels,
  type DetectionItemDto,
  type DetectionResponseDto,
  type SetupDetailDto,
  type SetupDirection,
  type SetupDto,
  type SetupListQuery,
  type SetupState,
  type SetupStateEventDto,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { EvaluationService } from '../strategies/evaluation/service.js';
import type { CandleStore } from '../market-data/candles.js';
import { assertTransition } from './machine.js';
import { detectionLevels } from './levels.js';
import { resolveEntitlements } from '../billing/entitlement-resolution.js';
import type { UserPlan } from '@veltrixeye/contracts';

/**
 * Setup detection + lifecycle service (M4).
 *
 * Guarantees:
 *  - M3 is consumed, never bypassed: every detection runs
 *    `EvaluationService.evaluateVersion`, inheriting its ownership masking,
 *    published-only gate, published-config trust, and store-only reads. M4
 *    contains zero condition logic and zero provider access.
 *  - no clock: `asOfMs` is always caller-supplied; the service never calls
 *    `Date.now` (the M3 edge default only fires when `asOf` is omitted, and
 *    M4 always passes it).
 *  - idempotent: the 0009 unique key
 *    (version, instrument, direction, asOfMs) serializes concurrent
 *    duplicates — `ON CONFLICT DO NOTHING` lets exactly one insert win and
 *    the loser re-selects the winner's row and writes nothing (conflict
 *    handling never aborts the transaction).
 *  - ownership: every setup read/write joins through
 *    `strategy_versions → strategies.user_id`; foreign setups are masked
 *    404s, exactly like strategies.
 *  - lifecycle integrity: transitions run in a transaction under
 *    `SELECT … FOR UPDATE`; invalid transitions roll back with no partial
 *    writes, and every committed transition records exactly one event.
 *  - no scoring: `setup_scores` is never written and `quality_score` stays
 *    NULL — M5 owns scoring.
 */
export class SetupService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly evaluation: EvaluationService,
    private readonly store: CandleStore,
  ) {}

  /**
   * Run detection for one instrument (one or both directions) at an
   * explicit anchor. Qualifying M3 directions (`passed`) produce exactly
   * one setup each; repeats return the existing setup with `created: false`
   * and no new event. Never transitions existing setups.
   */
  async detect(args: {
    userId: string;
    strategyId: string;
    versionId: string;
    assetClass: string;
    symbol: string;
    direction?: SetupDirection;
    asOf: number;
  }): Promise<DetectionResponseDto> {
    const symbol = args.symbol.toUpperCase();
    const instrument = await this.store.resolveInstrument(args.assetClass, symbol);
    if (!instrument) {
      throw Errors.notFound(`Unknown instrument "${args.assetClass}/${symbol}"`);
    }

    // Ownership (masked 404), published-only (400), and store-only candle
    // reads are all enforced inside the M3 service.
    const result = await this.evaluation.evaluateVersion({
      userId: args.userId,
      strategyId: args.strategyId,
      versionId: args.versionId,
      asOf: args.asOf,
    });

    const item = result.instruments.find((i) => i.assetClass === instrument.assetClass && i.symbol === instrument.symbol);
    if (!item) {
      throw Errors.invalidInput(
        `Instrument "${instrument.assetClass}/${instrument.symbol}" was not evaluated for this version — it is outside the version's market scope.`,
      );
    }

    const directions: SetupDirection[] = args.direction ? [args.direction] : ['long', 'short'];
    const detections: DetectionItemDto[] = [];
    for (const direction of directions) {
      const dirEval = item.directions[direction];
      if (!dirEval.passed) {
        detections.push({
          direction,
          qualified: false,
          setup: null,
          created: false,
          failureReasons: dirEval.failureReasons,
        });
        continue;
      }
      const { setup, created } = await this.insertOrGetSetup({
        userId: args.userId,
        versionId: args.versionId,
        instrumentId: instrument.id,
        direction,
        asOfMs: result.asOfMs,
        engineVersion: result.engineVersion,
        candidate: dirEval.candidate,
      });
      detections.push({ direction, qualified: true, setup, created, failureReasons: [] });
    }

    return {
      strategyId: args.strategyId,
      versionId: args.versionId,
      versionNumber: result.versionNumber,
      instrument: { assetClass: instrument.assetClass, symbol: instrument.symbol },
      asOfMs: result.asOfMs,
      detectorVersion: DETECTOR_VERSION,
      engineVersion: result.engineVersion,
      detections,
    };
  }

  /** List the acting user's setups (newest first), with optional filters. */
  async countSetups(userId: string): Promise<number> {
    const res = await this.pool.query(
      'SELECT count(*)::int AS c FROM strategy_setups WHERE user_id = $1',
      [userId]
    );
    return res.rows[0].c;
  }

  async listSetups(args: { userId: string } & SetupListQuery): Promise<{ setups: SetupDto[] }> {
    const values: unknown[] = [args.userId];
    const where = ['st.user_id = $1'];
    if (args.strategyId) {
      values.push(args.strategyId);
      where.push(`v.strategy_id = $${values.length}`);
    }
    if (args.versionId) {
      values.push(args.versionId);
      where.push(`s.strategy_version_id = $${values.length}`);
    }
    if (args.state) {
      values.push(args.state);
      where.push(`s.state = $${values.length}`);
    }
    if (args.direction) {
      values.push(args.direction);
      where.push(`s.direction = $${values.length}`);
    }
    values.push(args.limit);
    const res = await this.pool.query<SetupRow>(
      `${SETUP_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.detected_at DESC, s.id DESC LIMIT $${values.length}`,
      values,
    );
    return { setups: res.rows.map(toSetupDto) };
  }

  /** One owned setup plus its lifecycle history (oldest event first). */
  async getSetup(args: { userId: string; setupId: string }): Promise<SetupDetailDto> {
    const setup = await this.readOwnedSetup(args.userId, args.setupId, null);
    if (!setup) throw Errors.notFound('Setup not found');
    const events = await this.pool.query<EventRow>(
      'SELECT * FROM setup_state_events WHERE setup_id = $1 ORDER BY id ASC LIMIT 64',
      [args.setupId],
    );
    return { setup: toSetupDto(setup), events: events.rows.map(toEventDto) };
  }

  /**
   * Transition an owned setup. Same-state repeats are idempotent successes
   * (no write, no event); anything the machine forbids fails with no
   * partial writes. The event timestamp is the supplied anchor.
   */
  async transitionSetup(args: {
    userId: string;
    setupId: string;
    toState: SetupState;
    reason?: string;
    asOf: number;
  }): Promise<{ setup: SetupDto; transitioned: boolean; event: SetupStateEventDto | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await this.readOwnedSetup(args.userId, args.setupId, client);
      if (!current) {
        await client.query('ROLLBACK');
        throw Errors.notFound('Setup not found');
      }
      if (current.state === args.toState) {
        await client.query('COMMIT');
        return { setup: toSetupDto(current), transitioned: false, event: null };
      }
      try {
        assertTransition(current.state, args.toState);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      const updated = await client.query<SetupRow>('UPDATE setups SET state = $2 WHERE id = $1 RETURNING *', [
        args.setupId,
        args.toState,
      ]);
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        await client.query('ROLLBACK');
        throw Errors.internal('Failed to transition setup');
      }
      const event = await client.query<EventRow>(
        `INSERT INTO setup_state_events (setup_id, from_state, to_state, reason, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          args.setupId,
          current.state,
          args.toState,
          args.reason ?? null,
          JSON.stringify({ asOfMs: args.asOf, actor: 'transition' }),
          new Date(args.asOf),
        ],
      );
      const eventRow = event.rows[0];
      if (!eventRow) {
        await client.query('ROLLBACK');
        throw Errors.internal('Failed to record setup transition');
      }
      await client.query('COMMIT');
      // Re-read through the owned join so the DTO carries full identity.
      const fresh = await this.readOwnedSetup(args.userId, args.setupId, null);
      if (!fresh) throw Errors.internal('Failed to read setup after transition');
      return { setup: toSetupDto(fresh), transitioned: true, event: toEventDto(eventRow) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Insert the setup + initial event, or return the existing row when this
   * detection key was already detected. Concurrent duplicates serialize on
   * the 0009 unique constraint via `ON CONFLICT DO NOTHING`: exactly one
   * insert wins and the loser commits a no-op and re-selects the winner's
   * row. The conflict path never raises 23505, so the transaction never
   * aborts mid-race.
   */
  private async insertOrGetSetup(args: {
    userId: string;
    versionId: string;
    instrumentId: string;
    direction: SetupDirection;
    asOfMs: number;
    engineVersion: string;
    candidate: CandidateLevels | null;
  }): Promise<{ setup: SetupDto; created: boolean }> {
    const existing = await this.readOwnedSetupByKey(args.userId, args.versionId, args.instrumentId, args.direction, args.asOfMs);
    if (existing) return { setup: toSetupDto(existing), created: false };

    const levels = detectionLevels(args.candidate, args.direction);
    const metadata = {
      detectorVersion: DETECTOR_VERSION,
      asOfMs: args.asOfMs,
      engineVersion: args.engineVersion,
    };
    const anchor = new Date(args.asOfMs);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // M7.4 Atomic entitlement enforcement
      // `provider` is read for the fail-closed entitlement gate: a
      // provider-backed row is an unconfirmed checkout, never a purchase.
      const entitlementRes = await client.query<{ plan: string; status: string; provider: string | null }>(`
        SELECT plan, status, provider FROM subscriptions WHERE user_id = $1 FOR UPDATE
      `, [args.userId]);
      const subRow = entitlementRes.rows[0] || { plan: 'free', status: 'active', provider: null };
      const entitlements = resolveEntitlements(subRow.plan as UserPlan, subRow.status, subRow.provider);
      const maxSetups = entitlements.maxSavedSetups;
      
      const countRes = await client.query(`
        SELECT count(*)::int AS c FROM setups st
        JOIN strategy_versions v ON st.strategy_version_id = v.id
        JOIN strategies s ON v.strategy_id = s.id
        WHERE s.user_id = $1
      `, [args.userId]);
      if (countRes.rows[0].c >= maxSetups) {
        throw Errors.forbidden(`Saved setups limit reached. Your plan allows up to ${maxSetups} saved setups.`);
      }

      const inserted = await client.query<SetupRow>(
        `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms,
                             entry_price, stop_loss_price, tp1_price, tp2_price, tp3_price, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (strategy_version_id, instrument_id, direction, as_of_ms) DO NOTHING
         RETURNING *`,
        [
          args.versionId,
          args.instrumentId,
          SETUP_INITIAL_STATE,
          args.direction,
          anchor,
          args.asOfMs,
          levels?.entryPrice ?? null,
          levels?.stopLossPrice ?? null,
          levels?.tp1Price ?? null,
          levels?.tp2Price ?? null,
          levels?.tp3Price ?? null,
          JSON.stringify(metadata),
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // Lost the race: commit the no-op and return the winner's row.
        await client.query('COMMIT');
        const winner = await this.readOwnedSetupByKey(
          args.userId,
          args.versionId,
          args.instrumentId,
          args.direction,
          args.asOfMs,
        );
        if (!winner) throw Errors.internal('Setup detection conflict could not be resolved');
        return { setup: toSetupDto(winner), created: false };
      }
      await client.query(
        `INSERT INTO setup_state_events (setup_id, from_state, to_state, reason, payload, created_at)
         VALUES ($1, NULL, $2, 'detected', $3, $4)`,
        [row.id, SETUP_INITIAL_STATE, JSON.stringify({ detectorVersion: DETECTOR_VERSION, asOfMs: args.asOfMs }), anchor],
      );
      await client.query('COMMIT');
      const fresh = await this.readOwnedSetupByKey(args.userId, args.versionId, args.instrumentId, args.direction, args.asOfMs);
      if (!fresh) throw Errors.internal('Failed to read setup after detection');
      return { setup: toSetupDto(fresh), created: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Owned setup row (full DTO identity) by id, optionally locking it. */
  private async readOwnedSetup(
    userId: string,
    setupId: string,
    client: pg.PoolClient | null,
  ): Promise<SetupRow | null> {
    const q = client ?? this.pool;
    // NOTE: the write path passes a transaction client, so this SELECT …
    // FOR UPDATE locks the setup row until COMMIT/ROLLBACK.
    const lock = client ? ' FOR UPDATE OF s' : '';
    const res = await q.query<SetupRow>(
      `${SETUP_SELECT} WHERE s.id = $1 AND st.user_id = $2${lock}`,
      [setupId, userId],
    );
    return res.rows[0] ?? null;
  }

  /** Owned setup row (full DTO identity) by detection key. */
  private async readOwnedSetupByKey(
    userId: string,
    versionId: string,
    instrumentId: string,
    direction: SetupDirection,
    asOfMs: number,
  ): Promise<SetupRow | null> {
    const res = await this.pool.query<SetupRow>(
      `${SETUP_SELECT} WHERE s.strategy_version_id = $1 AND s.instrument_id = $2 AND s.direction = $3 AND s.as_of_ms = $4 AND st.user_id = $5`,
      [versionId, instrumentId, direction, asOfMs, userId],
    );
    return res.rows[0] ?? null;
  }
}

/**
 * Owned-setup SELECT (exported for the M5 scoring service, which enforces
 * the same ownership join — setup → strategy_versions → strategies.user_id).
 */
export const SETUP_SELECT = `SELECT s.*, v.strategy_id, v.version_number, i.asset_class, i.symbol
  FROM setups s
  JOIN strategy_versions v ON v.id = s.strategy_version_id
  JOIN strategies st ON st.id = v.strategy_id
  JOIN instruments i ON i.id = s.instrument_id`;

export interface SetupRow {
  id: string;
  strategy_version_id: string;
  strategy_id: string;
  version_number: number;
  asset_class: string;
  symbol: string;
  instrument_id: string;
  state: SetupState;
  direction: SetupDirection;
  detected_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  as_of_ms: string; // int8 arrives as text via node-postgres
  entry_price: string | null;
  stop_loss_price: string | null;
  tp1_price: string | null;
  tp2_price: string | null;
  tp3_price: string | null;
  quality_score: number | null;
  metadata: Record<string, unknown>;
}

interface EventRow {
  id: string; // identity bigint arrives as text
  setup_id: string;
  from_state: SetupState | null;
  to_state: SetupState;
  reason: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Exported for the M5 scoring service (same DTO mapping, no semantic change). */
export function toSetupDto(row: SetupRow): SetupDto {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    versionNumber: Number(row.version_number),
    instrument: { assetClass: row.asset_class as SetupDto['instrument']['assetClass'], symbol: row.symbol },
    state: row.state,
    direction: row.direction,
    asOfMs: Number(row.as_of_ms),
    detectedAt: row.detected_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    entryPrice: toNumberOrNull(row.entry_price),
    stopLossPrice: toNumberOrNull(row.stop_loss_price),
    tp1Price: toNumberOrNull(row.tp1_price),
    tp2Price: toNumberOrNull(row.tp2_price),
    tp3Price: toNumberOrNull(row.tp3_price),
    qualityScore: row.quality_score,
    metadata: row.metadata ?? {},
  };
}

function toEventDto(row: EventRow): SetupStateEventDto {
  return {
    id: Number(row.id),
    setupId: row.setup_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    payload: row.payload ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

function toNumberOrNull(value: string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
