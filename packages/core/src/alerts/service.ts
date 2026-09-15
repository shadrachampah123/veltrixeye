/* eslint-disable @typescript-eslint/no-explicit-any */
import type pg from 'pg';
import {
  ALERT_TRIGGER_STATES,
  MAX_ALERT_DELIVERIES,
  type AlertDetailDto,
  type AlertDto,
  type AlertDeliveryDto,
  type AlertChannel,
  type AlertListQuery,
  type AlertSkippedReason,
  type AlertTriggerState,
  type SetupState,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { isTerminalState } from '../setups/machine.js';
import type { StrategyService } from '../strategies/strategies.js';
import { NonStubSenderError, StubAlertSender, type AlertSender } from './sender.js';

/**
 * AlertService (M6 Phases 2–3) — the application boundary around the alert
 * schema. It is the ONLY writer of `alerts` / `alert_deliveries`.
 *
 * Guarantees (pinned order, enforced by tests):
 *  - owner-scoped: every method takes `userId` and checks the ownership chain
 *    alerts.user_id → setups.strategy_version_id → strategies.user_id.
 *    Foreign or unknown resources are masked as 404.
 *  - eligible states only: the setup must be in `confirmed` or `triggered`,
 *    i.e. `ALERT_TRIGGER_STATES`. Terminal setups (completed / invalidated /
 *    expired) and pre-confirmation states are refused with 400.
 *  - M5 score required: a `setup_scores` row at the setup's detection anchor
 *    (`setup.as_of_ms`) must exist; otherwise 400.
 *  - minQualityScore gate: `score.total >= version.config.risk.minQualityScore`
 *    (default 0). Below the gate the call is silent — HTTP 200, no alert row,
 *    no ledger row, `skippedReason: 'below_min_quality'`.
 *  - dedup by `(setup_id, trigger_state)`: at most two alerts per setup
 *    (`confirmed` + `triggered`). Replays return the existing alert and never
 *    insert a second delivery ledger row.
 *  - transactional: alert + stub delivery ledger row commit together.
 *  - local/no-network: the only sender M6 accepts is the local stub
 *    (`NonStubSenderError` otherwise) — zero external I/O.
 *  - idempotent acknowledgement that preserves the first acknowledgedAt.
 */

/** Setup states that may generate an alert (the dedup key's second half). */
const ELIGIBLE_STATES = new Set<string>(ALERT_TRIGGER_STATES);

interface SetupRow {
  id: string;
  strategy_version_id: string;
  strategy_id: string;
  version_number: number;
  asset_class: string;
  symbol: string;
  instrument_id: string;
  state: string;
  direction: string;
  detected_at: Date;
  as_of_ms: string;
  entry_price: string | null;
  stop_loss_price: string | null;
  tp1_price: string | null;
  tp2_price: string | null;
  tp3_price: string | null;
  quality_score: number | null;
  metadata: Record<string, unknown>;
}

interface ScoreRow {
  id: string;
  setup_id: string;
  engine_version: string;
  total: number;
  grade: string;
  components: unknown;
  created_at: Date;
  as_of_ms: string;
}

interface AlertRow {
  id: string;
  user_id: string;
  setup_id: string;
  strategy_id: string;
  strategy_version_id: string;
  instrument_id: string;
  direction: string;
  trigger_state: string;
  quality_score: number;
  min_quality_score: number;
  title: string;
  body: unknown;
  status: string;
  acknowledged_at: Date | null;
  created_at: Date;
  // joined
  asset_class?: string;
  symbol?: string;
  version_number?: number;
}

interface DeliveryRow {
  id: string;
  alert_id: string;
  channel: string;
  status: string;
  attempt: number;
  error: string | null;
  payload_hash: string;
  created_at: Date;
}

export interface GenerateAlertArgs {
  userId: string;
  setupId: string;
  triggerState?: AlertTriggerState;
}

export interface GenerateAlertResult {
  /** The alert (newly created or the existing dedup winner); null on a gate skip. */
  alert: AlertDto | null;
  /** The alert's stub ledger entry; null on a gate skip. */
  delivery: AlertDeliveryDto | null;
  /** True only when THIS call inserted the alert row. */
  created: boolean;
  /**
   * True only when THIS call inserted the delivery ledger row. Replays are
   * `false`, so callers can record `alert.delivery_recorded` exactly once per
   * ledger row instead of on every retry.
   */
  deliveryCreated: boolean;
  /** Present when the minQualityScore gate refused generation (silence). */
  skippedReason?: AlertSkippedReason;
  /** Gate context for audit metadata (present when skippedReason is set). */
  gate?: { qualityScore: number; qualityGrade: string; minQualityScore: number };
}

export class AlertService {
  private readonly sender: AlertSender;

  constructor(
    private readonly pool: pg.Pool,
    private readonly strategies: StrategyService,
    sender: AlertSender = new StubAlertSender(),
  ) {
    // M6 hard rule: the only delivery this milestone performs is the local
    // stub ledger entry. A real channel would need an outbox/worker, provider
    // credentials and a security review — refuse to boot with one wired.
    if (sender.channel !== 'stub') throw new NonStubSenderError(String(sender.channel));
    this.sender = sender;
  }

  /** The delivery channel in use — `stub` for every M6 deployment. */
  get deliveryChannel(): AlertChannel {
    return this.sender.channel;
  }

  /**
   * Generate an alert from an owned setup.
   *
   * Steps (pinned order):
   *  1. Setup exists, owned, in an eligible state (confirmed/triggered) else
   *     404 (foreign/unknown) or 400 (terminal/ineligible).
   *  2. M5 score exists at the detection anchor else 400.
   *  3. `score.total >= risk.minQualityScore` else silence (200 + skippedReason).
   *  4. Insert onto `(setup_id, trigger_state)` idempotently; the loser of a
   *     race reads the winner's row.
   *  5. If the alert has no ledger row yet, ask the (stub) sender to render it
   *     and insert exactly one row; replays insert nothing.
   */
  async generateAlert(args: GenerateAlertArgs): Promise<GenerateAlertResult> {
    // 1. Owned setup + eligible state
    const setup = await this.readOwnedSetup(args.userId, args.setupId);
    if (!setup) throw Errors.notFound('Setup not found');
    assertEligibleState(setup.state);

    // Effective trigger state (validated logical progression)
    const effectiveTrigger = resolveTriggerState(setup.state, args.triggerState);

    // 2. M5 score at the detection anchor
    const score = await this.readScoreAtAnchor(setup.id, Number(setup.as_of_ms));
    if (!score) {
      throw Errors.invalidInput(
        'Setup has no quality score at its detection anchor — score the setup before generating an alert.',
      );
    }

    // 3. Quality gate (owner-scoped version read; published or deprecated are
    //    both readable by their owner — M4 detection semantics).
    const version = await this.strategies.getVersion(
      args.userId,
      setup.strategy_id,
      setup.strategy_version_id,
    );
    const minQualityScore = version.config.risk?.minQualityScore ?? 0;
    if (score.total < minQualityScore) {
      // Gate not met: silence, no row, no ledger entry, HTTP 200.
      return {
        alert: null,
        delivery: null,
        created: false,
        deliveryCreated: false,
        skippedReason: 'below_min_quality',
        gate: {
          qualityScore: score.total,
          qualityGrade: score.grade,
          minQualityScore,
        },
      };
    }

    const title = buildTitle({
      symbol: setup.symbol,
      direction: setup.direction,
      triggerState: effectiveTrigger,
      qualityScore: score.total,
      grade: score.grade,
    });
    const body = buildBody({ setup, score, triggerState: effectiveTrigger, minQualityScore });

    // 4 + 5. Transactional alert + stub delivery ledger
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<AlertRow>(
        `INSERT INTO alerts
           (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction,
            trigger_state, quality_score, min_quality_score, title, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (setup_id, trigger_state) DO NOTHING
         RETURNING *`,
        [
          args.userId,
          setup.id,
          setup.strategy_id,
          setup.strategy_version_id,
          setup.instrument_id,
          setup.direction,
          effectiveTrigger,
          score.total,
          minQualityScore,
          title,
          JSON.stringify(body),
        ],
      );

      let alertRow: AlertRow | null = inserted.rows[0] ?? null;
      const created = alertRow !== null;

      if (!alertRow) {
        // Dedup replay (or the loser of a concurrent race): read the winner.
        const existing = await client.query<AlertRow>(
          `SELECT a.*, i.asset_class, i.symbol, v.version_number
           FROM alerts a
           JOIN instruments i ON i.id = a.instrument_id
           JOIN strategy_versions v ON v.id = a.strategy_version_id
           WHERE a.setup_id = $1 AND a.trigger_state = $2`,
          [setup.id, effectiveTrigger],
        );
        alertRow = existing.rows[0] ?? null;
        if (!alertRow) {
          await client.query('ROLLBACK');
          throw Errors.internal('Alert conflict could not be resolved');
        }
      } else if (!alertRow.asset_class) {
        // Freshly inserted row: RETURNING cannot carry the joins.
        alertRow.asset_class = setup.asset_class;
        alertRow.symbol = setup.symbol;
        alertRow.version_number = setup.version_number;
      }

      // The ledger payload is rendered from the PERSISTED alert, so a replay
      // (or any later change upstream) hashes to the original value and can
      // never add a second ledger row for the same alert.
      const persistedBody: Record<string, unknown> =
        typeof alertRow.body === 'string'
          ? (JSON.parse(alertRow.body) as Record<string, unknown>)
          : (alertRow.body as Record<string, unknown>);

      let deliveryRow = await this.readDeliveryRow(client, alertRow.id);
      let deliveryCreated = false;

      if (!deliveryRow) {
        // No ledger row for this alert: render exactly one (also self-heals an
        // alert whose ledger row is missing, which the transactional write
        // path cannot normally produce).
        const sent = await this.sender.send({
          alertId: alertRow.id,
          userId: args.userId,
          setupId: setup.id,
          triggerState: alertRow.trigger_state,
          title: alertRow.title,
          body: persistedBody,
        });

        const deliveryInsert = await client.query<DeliveryRow>(
          `INSERT INTO alert_deliveries (alert_id, channel, status, attempt, error, payload_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (alert_id, channel, payload_hash) DO NOTHING
           RETURNING *`,
          [
            alertRow.id,
            this.sender.channel,
            sent.status,
            sent.attempt,
            sent.error ?? null,
            sent.payloadHash,
          ],
        );
        deliveryRow = deliveryInsert.rows[0] ?? null;
        deliveryCreated = deliveryRow !== null;
        if (!deliveryRow) {
          // Concurrent twin inserted it first: read theirs.
          deliveryRow = await this.readDeliveryRow(client, alertRow.id, sent.payloadHash);
        }
      }

      await client.query('COMMIT');

      return {
        alert: toAlertDto(alertRow),
        delivery: deliveryRow ? toDeliveryDto(deliveryRow) : null,
        created,
        deliveryCreated,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listAlerts(args: { userId: string } & AlertListQuery): Promise<{ alerts: AlertDto[] }> {
    const values: unknown[] = [args.userId];
    const where = ['a.user_id = $1'];
    if (args.strategyId) {
      values.push(args.strategyId);
      where.push(`a.strategy_id = $${values.length}`);
    }
    if (args.status) {
      values.push(args.status);
      where.push(`a.status = $${values.length}`);
    }
    values.push(args.limit);
    const res = await this.pool.query<AlertRow>(
      `SELECT a.*, i.asset_class, i.symbol, v.version_number
       FROM alerts a
       JOIN instruments i ON i.id = a.instrument_id
       JOIN strategy_versions v ON v.id = a.strategy_version_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return { alerts: res.rows.map(toAlertDto) };
  }

  async getAlert(args: { userId: string; alertId: string }): Promise<AlertDetailDto> {
    const alertRes = await this.pool.query<AlertRow>(
      `SELECT a.*, i.asset_class, i.symbol, v.version_number
       FROM alerts a
       JOIN instruments i ON i.id = a.instrument_id
       JOIN strategy_versions v ON v.id = a.strategy_version_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [args.alertId, args.userId],
    );
    const alertRow = alertRes.rows[0];
    if (!alertRow) throw Errors.notFound('Alert not found');

    const deliveries = await this.pool.query<DeliveryRow>(
      'SELECT * FROM alert_deliveries WHERE alert_id = $1 ORDER BY id ASC LIMIT $2',
      [args.alertId, MAX_ALERT_DELIVERIES],
    );

    return {
      alert: toAlertDto(alertRow),
      deliveries: deliveries.rows.map(toDeliveryDto),
    };
  }

  /**
   * Acknowledge an owned alert. Idempotent: the first call moves
   * `pending → acknowledged` and stamps `acknowledged_at`; repeats are
   * accepted no-ops that return the SAME timestamp (the row is not written
   * again). Foreign/unknown ids are masked as 404.
   */
  async acknowledgeAlert(args: { userId: string; alertId: string }): Promise<AlertDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<AlertRow>(
        `SELECT a.*, i.asset_class, i.symbol, v.version_number
         FROM alerts a
         JOIN instruments i ON i.id = a.instrument_id
         JOIN strategy_versions v ON v.id = a.strategy_version_id
         WHERE a.id = $1 AND a.user_id = $2
         FOR UPDATE`,
        [args.alertId, args.userId],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        throw Errors.notFound('Alert not found');
      }

      const alreadyAcknowledged = row.status === 'acknowledged' && row.acknowledged_at !== null;

      let acknowledgedRow = row;
      if (!alreadyAcknowledged) {
        // Single state change; `COALESCE` keeps an existing (never overwritten)
        // timestamp even if the column was set by an earlier partial write.
        const updated = await client.query<AlertRow>(
          `UPDATE alerts
           SET status = 'acknowledged',
               acknowledged_at = COALESCE(acknowledged_at, now())
           WHERE id = $1 AND user_id = $2
           RETURNING *`,
          [args.alertId, args.userId],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) {
          await client.query('ROLLBACK');
          throw Errors.internal('Failed to acknowledge alert');
        }
        acknowledgedRow = {
          ...row,
          ...updatedRow,
          asset_class: row.asset_class,
          symbol: row.symbol,
          version_number: row.version_number,
        };
      }

      const deliveries = await client.query<DeliveryRow>(
        'SELECT * FROM alert_deliveries WHERE alert_id = $1 ORDER BY id ASC LIMIT $2',
        [args.alertId, MAX_ALERT_DELIVERIES],
      );

      await client.query('COMMIT');

      return {
        alert: toAlertDto(acknowledgedRow),
        deliveries: deliveries.rows.map(toDeliveryDto),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async readDeliveryRow(
    client: pg.PoolClient,
    alertId: string,
    payloadHash?: string,
  ): Promise<DeliveryRow | null> {
    const res = payloadHash
      ? await client.query<DeliveryRow>(
          'SELECT * FROM alert_deliveries WHERE alert_id = $1 AND channel = $2 AND payload_hash = $3',
          [alertId, this.sender.channel, payloadHash],
        )
      : await client.query<DeliveryRow>(
          'SELECT * FROM alert_deliveries WHERE alert_id = $1 AND channel = $2 ORDER BY id ASC LIMIT 1',
          [alertId, this.sender.channel],
        );
    return res.rows[0] ?? null;
  }

  private async readOwnedSetup(userId: string, setupId: string): Promise<SetupRow | null> {
    const res = await this.pool.query<SetupRow>(
      `SELECT s.*, v.strategy_id, v.version_number, i.asset_class, i.symbol
       FROM setups s
       JOIN strategy_versions v ON v.id = s.strategy_version_id
       JOIN strategies st ON st.id = v.strategy_id
       JOIN instruments i ON i.id = s.instrument_id
       WHERE s.id = $1 AND st.user_id = $2`,
      [setupId, userId],
    );
    return res.rows[0] ?? null;
  }

  private async readScoreAtAnchor(setupId: string, asOfMs: number): Promise<ScoreRow | null> {
    const res = await this.pool.query<ScoreRow>(
      `SELECT * FROM setup_scores
       WHERE setup_id = $1 AND as_of_ms = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [setupId, asOfMs],
    );
    return res.rows[0] ?? null;
  }
}

/**
 * Refuse every state that is not `confirmed` / `triggered`. Terminal states
 * (completed / invalidated / expired) get a dedicated message so callers can
 * tell "this setup is over" apart from "this setup is not ready yet".
 */
function assertEligibleState(state: string): void {
  if (ELIGIBLE_STATES.has(state)) return;
  if (isTerminalState(state as SetupState)) {
    throw Errors.invalidInput(
      `Setup is in terminal state "${state}" — no alert can be generated for an invalidated, expired or completed setup.`,
    );
  }
  throw Errors.invalidInput(
    `Setup is in state "${state}" — only confirmed or triggered setups can generate alerts.`,
  );
}

/**
 * Resolve the alert's triggering state. Omitted → the setup's current state
 * (guaranteed eligible). `triggered` requires the setup to actually be
 * triggered (no forward-looking alerts); `confirmed` stays allowed once the
 * setup has progressed to `triggered`, because triggered implies confirmed.
 */
function resolveTriggerState(
  setupState: string,
  requested: AlertTriggerState | undefined,
): AlertTriggerState {
  if (!requested) return setupState as AlertTriggerState;
  if (!ELIGIBLE_STATES.has(requested)) {
    throw Errors.invalidInput(
      `Invalid trigger state "${requested}" — only confirmed or triggered are allowed.`,
    );
  }
  if (requested === 'triggered' && setupState !== 'triggered') {
    throw Errors.invalidInput(
      'Cannot generate a triggered alert for a setup that is not in triggered state.',
    );
  }
  return requested;
}

/** Deterministic, licensing-safe, ≤ 280 chars (the 0012 CHECK). */
function buildTitle(args: {
  symbol: string;
  direction: string;
  triggerState: string;
  qualityScore: number;
  grade: string;
}): string {
  const base = `${args.symbol} ${args.direction} ${args.triggerState} (score ${args.qualityScore}/${args.grade})`;
  return base.slice(0, 280);
}

/** Structured payload (levels, score reference, links) — never raw candles. */
function buildBody(args: {
  setup: SetupRow;
  score: ScoreRow;
  triggerState: string;
  minQualityScore: number;
}): Record<string, unknown> {
  return {
    setupId: args.setup.id,
    strategyId: args.setup.strategy_id,
    strategyVersionId: args.setup.strategy_version_id,
    versionNumber: args.setup.version_number,
    instrument: { assetClass: args.setup.asset_class, symbol: args.setup.symbol },
    direction: args.setup.direction,
    triggerState: args.triggerState,
    qualityScore: args.score.total,
    qualityGrade: args.score.grade,
    minQualityScore: args.minQualityScore,
    entryPrice: args.setup.entry_price ? Number(args.setup.entry_price) : null,
    stopLossPrice: args.setup.stop_loss_price ? Number(args.setup.stop_loss_price) : null,
    tp1Price: args.setup.tp1_price ? Number(args.setup.tp1_price) : null,
    tp2Price: args.setup.tp2_price ? Number(args.setup.tp2_price) : null,
    tp3Price: args.setup.tp3_price ? Number(args.setup.tp3_price) : null,
    scoreId: Number(args.score.id),
    scoreEngineVersion: args.score.engine_version,
    detectedAt: args.setup.detected_at.toISOString(),
    asOfMs: Number(args.setup.as_of_ms),
  };
}

function toAlertDto(row: AlertRow): AlertDto {
  return {
    id: row.id,
    setupId: row.setup_id,
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    versionNumber: row.version_number ?? 0,
    instrument: {
      assetClass: (row.asset_class ?? 'forex') as any,
      symbol: row.symbol ?? 'UNKNOWN',
    },
    direction: row.direction as any,
    triggerState: row.trigger_state as any,
    qualityScore: row.quality_score,
    minQualityScore: row.min_quality_score,
    title: row.title,
    body: (typeof row.body === 'string'
      ? JSON.parse(row.body as unknown as string)
      : row.body) as Record<string, unknown>,
    status: row.status as any,
    acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function toDeliveryDto(row: DeliveryRow): AlertDeliveryDto {
  return {
    id: Number(row.id),
    alertId: row.alert_id,
    channel: row.channel as any,
    status: row.status as any,
    attempt: row.attempt,
    error: row.error,
    payloadHash: row.payload_hash,
    createdAt: row.created_at.toISOString(),
  };
}
