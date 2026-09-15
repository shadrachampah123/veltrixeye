/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  ALERT_TRIGGER_STATES,
  type AlertDetailDto,
  type AlertDto,
  type AlertDeliveryDto,
  type AlertListQuery,
  type AlertTriggerState,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { StrategyService } from '../strategies/strategies.js';

/**
 * AlertService (M6 Phase 2) — application boundary around the alert schema.
 *
 * Guarantees:
 *  - owner-scoped: every method requires userId and checks alerts.user_id
 *    (masked 404 for foreign).
 *  - eligible states only: setup must be in confirmed or triggered.
 *  - M5 score required: setup_scores row at detection anchor must exist.
 *  - minQualityScore gate: score.total >= version's risk.minQualityScore,
 *    otherwise no alert (silence, not error).
 *  - dedup by (setup_id, trigger_state): at most two alerts per setup.
 *  - transactional: alert + stub delivery ledger in one transaction.
 *  - local/no-network: stub delivery only, deterministic payload hash.
 *  - safe repeated acknowledgement.
 */

const ELIGIBLE_STATES = new Set<string>(ALERT_TRIGGER_STATES);
const CONFIG_HASH_RE = /^[0-9a-f]{64}$/;

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
  alert: AlertDto | null;
  delivery: AlertDeliveryDto | null;
  created: boolean;
  skippedReason?: string;
}

export class AlertService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly strategies: StrategyService,
  ) {}

  /**
   * Generate an alert from an owned setup.
   *
   * Steps (pinned order):
   *  1. Setup exists, owned, in eligible state (confirmed/triggered) else 400/404.
   *  2. M5 score exists at detection anchor else 400.
   *  3. Score >= minQualityScore else no alert (silence).
   *  4. Upsert onto (setup_id, trigger_state) idempotently.
   *  5. Record exactly one stub delivery per generated alert (idempotent).
   */
  async generateAlert(args: GenerateAlertArgs): Promise<GenerateAlertResult> {
    // 1. Owned setup
    const setup = await this.readOwnedSetup(args.userId, args.setupId);
    if (!setup) throw Errors.notFound('Setup not found');

    if (!ELIGIBLE_STATES.has(setup.state)) {
      throw Errors.invalidInput(`Setup is in state "${setup.state}" — only confirmed or triggered setups can generate alerts.`);
    }

    // Determine effective trigger state
    let effectiveTrigger: AlertTriggerState;
    if (args.triggerState) {
      if (!ELIGIBLE_STATES.has(args.triggerState)) {
        throw Errors.invalidInput(`Invalid trigger state "${args.triggerState}" — only confirmed or triggered are allowed.`);
      }
      effectiveTrigger = args.triggerState;
      // Enforce logical progression: can't generate triggered alert when setup is only confirmed.
      if (effectiveTrigger === 'triggered' && setup.state !== 'triggered') {
        throw Errors.invalidInput('Cannot generate a triggered alert for a setup that is not in triggered state.');
      }
      // Confirmed alert allowed when setup is confirmed or triggered (triggered implies confirmed was past)
    } else {
      effectiveTrigger = setup.state as AlertTriggerState;
    }

    // 2. M5 score at detection anchor
    const score = await this.readScoreAtAnchor(setup.id, Number(setup.as_of_ms));
    if (!score) {
      throw Errors.invalidInput('Setup has no quality score at its detection anchor — score the setup before generating an alert.');
    }

    // 3. Load version config for minQualityScore
    const version = await this.strategies.getVersion(args.userId, setup.strategy_id, setup.strategy_version_id);
    const minQualityScore = version.config.risk?.minQualityScore ?? 0;
    if (score.total < minQualityScore) {
      // Gate not met: silence, no row, no delivery
      return { alert: null, delivery: null, created: false, skippedReason: 'below_min_quality' };
    }

    // Prepare title and body
    const title = this.buildTitle({
      symbol: setup.symbol,
      direction: setup.direction,
      triggerState: effectiveTrigger,
      qualityScore: score.total,
      grade: score.grade,
    });

    const body = this.buildBody({
      setup,
      score,
      version,
      triggerState: effectiveTrigger,
      minQualityScore,
    });

    // 4 & 5. Transactional insert
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const alertRes = await client.query<AlertRow>(
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

      let alertRow: AlertRow | null = alertRes.rows[0] ?? null;
      let created = true;

      if (!alertRow) {
        // Existing alert: fetch it
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
        created = false;
      }

      // For new alert, the payload hash should be over deterministic payload including alert id.
      // Recompute with real alert id for accuracy, but keep idempotent via (alert_id, channel, payload_hash).
      const finalPayloadHash = this.computePayloadHash({ title, body, alertId: alertRow.id });

      // Insert stub delivery
      const deliveryRes = await client.query<DeliveryRow>(
        `INSERT INTO alert_deliveries (alert_id, channel, status, attempt, payload_hash)
         VALUES ($1, 'stub', 'delivered', 1, $2)
         ON CONFLICT (alert_id, channel, payload_hash) DO NOTHING
         RETURNING *`,
        [alertRow.id, finalPayloadHash],
      );

      let deliveryRow = deliveryRes.rows[0] ?? null;
      if (!deliveryRow) {
        const existingDelivery = await client.query<DeliveryRow>(
          'SELECT * FROM alert_deliveries WHERE alert_id = $1 AND channel = $2 AND payload_hash = $3',
          [alertRow.id, 'stub', finalPayloadHash],
        );
        deliveryRow = existingDelivery.rows[0] ?? null;
      }

      await client.query('COMMIT');

      // Enrich alert row with joins if missing (for newly inserted case)
      if (!alertRow.asset_class) {
        alertRow.asset_class = setup.asset_class;
        alertRow.symbol = setup.symbol;
        alertRow.version_number = setup.version_number;
      }

      const alertDto = toAlertDto(alertRow);
      const deliveryDto = deliveryRow ? toDeliveryDto(deliveryRow) : null;

      return { alert: alertDto, delivery: deliveryDto, created };
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

    const deliveriesRes = await this.pool.query<DeliveryRow>(
      'SELECT * FROM alert_deliveries WHERE alert_id = $1 ORDER BY id ASC LIMIT 64',
      [args.alertId],
    );

    return {
      alert: toAlertDto(alertRow),
      deliveries: deliveriesRes.rows.map(toDeliveryDto),
    };
  }

  async acknowledgeAlert(args: { userId: string; alertId: string }): Promise<AlertDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<AlertRow>(
        `SELECT a.*, i.asset_class, i.symbol, v.version_number
         FROM alerts a
         JOIN instruments i ON i.id = a.instrument_id
         JOIN strategy_versions v ON v.id = a.strategy_version_id
         WHERE a.id = $1 AND a.user_id = $2
         FOR UPDATE`,
        [args.alertId, args.userId],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        throw Errors.notFound('Alert not found');
      }

      // Idempotent ack: keep original acknowledged_at if already set
      const updated = await client.query<AlertRow>(
        `UPDATE alerts
         SET status = 'acknowledged',
             acknowledged_at = COALESCE(acknowledged_at, now())
         WHERE id = $1
         RETURNING *`,
        [args.alertId],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        await client.query('ROLLBACK');
        throw Errors.internal('Failed to acknowledge alert');
      }

      // Re-join for DTO enrichment
      const enriched = await client.query<AlertRow>(
        `SELECT a.*, i.asset_class, i.symbol, v.version_number
         FROM alerts a
         JOIN instruments i ON i.id = a.instrument_id
         JOIN strategy_versions v ON v.id = a.strategy_version_id
         WHERE a.id = $1`,
        [args.alertId],
      );

      const deliveries = await client.query<DeliveryRow>(
        'SELECT * FROM alert_deliveries WHERE alert_id = $1 ORDER BY id ASC LIMIT 64',
        [args.alertId],
      );

      await client.query('COMMIT');

      const finalRow = enriched.rows[0] ?? updatedRow;
      // Ensure joined fields present
      if (!finalRow.asset_class) {
        finalRow.asset_class = row.asset_class;
        finalRow.symbol = row.symbol;
        finalRow.version_number = row.version_number;
      }

      return {
        alert: toAlertDto(finalRow),
        deliveries: deliveries.rows.map(toDeliveryDto),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
       ORDER BY created_at DESC LIMIT 1`,
      [setupId, asOfMs],
    );
    return res.rows[0] ?? null;
  }

  private buildTitle(args: { symbol: string; direction: string; triggerState: string; qualityScore: number; grade: string }): string {
    // Deterministic, ≤280 chars, human-readable
    const base = `${args.symbol} ${args.direction} ${args.triggerState} (score ${args.qualityScore}/${args.grade})`;
    return base.slice(0, 280);
  }

  private buildBody(args: {
    setup: SetupRow;
    score: ScoreRow;
    version: { id: string; strategyId: string; versionNumber: number; config: any };
    triggerState: string;
    minQualityScore: number;
  }): Record<string, unknown> {
    // Structured payload — never raw candles, licensing-safe
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

  private computePayloadHash(args: { title: string; body: Record<string, unknown>; alertId?: string; alertIdPlaceholder?: string }): string {
    // Deterministic payload: sorted keys, JSON stringify, sha256
    const payload = {
      alertId: args.alertId ?? args.alertIdPlaceholder ?? 'unknown',
      title: args.title,
      body: args.body,
    };
    const canonical = canonicalize(payload);
    const json = JSON.stringify(canonical);
    const hash = createHash('sha256').update(json, 'utf8').digest('hex');
    if (!CONFIG_HASH_RE.test(hash)) throw new Error('invalid payload hash format');
    return hash;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonicalize(obj[k]);
    return out;
  }
  return value;
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
    body: (typeof row.body === 'string' ? JSON.parse(row.body as unknown as string) : row.body) as Record<string, unknown>,
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
