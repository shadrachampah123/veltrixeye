import type pg from 'pg';
import {
  getConditionType,
  strategyVersionConfigSchema,
  type AssetClass,
  type StrategyVersionConfigInput,
  type Timeframe,
  type StrategyCreateInput,
  type StrategyDetailDto,
  type StrategySummaryDto,
  type StrategyUpdateInput,
  type StrategyVersionConfig,
  type StrategyVersionDetailDto,
  type StrategyVersionSummaryDto,
  type StrategyVersionUpdateInput,
  type StrategyVersionCreateInput,
  type StrategyFilter,
  type SessionFilter,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { AuditService } from '../audit.js';
import { validatePublishable } from './validation.js';
import { getEntitlements } from '../billing/entitlements.js';

interface StrategyRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  strategy_id: string;
  version_number: number;
  status: 'draft' | 'published' | 'deprecated';
  changelog: string | null;
  created_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

interface TimeframeRow {
  role: string;
  timeframe: string;
}

interface ScopeRow {
  mode: 'all' | 'instruments';
}

interface ScopeInstrumentRow {
  asset_class: string;
  symbol: string;
  display_name: string | null;
}

interface SessionFilterRow {
  session: string;
  mode: string;
  timezone: string;
}

interface RiskRow {
  min_rr: string;
  stop_loss_method: string;
  stop_loss_buffer: string;
  stop_loss_buffer_unit: string;
  take_profit_method: string;
  tp1_rr: string;
  tp2_rr: string;
  tp3_rr: string;
  min_quality_score: number;
}

interface FilterRow {
  filter_type: string;
  enabled: boolean;
  params: Record<string, unknown>;
  position: number;
}

interface GroupRow {
  id: string;
  name: string;
  logic: 'AND' | 'OR';
  position: number;
}

interface ConditionRow {
  group_id: string;
  condition_type: string;
  classification: string;
  timeframe_role: string;
  params: Record<string, unknown>;
  description: string | null;
  position: number;
}

/**
 * Request context for audit events written by the service layer.
 *
 * HTTP routes pass the acting request's client IP and user agent (derived
 * from the pinned trust-proxy resolution, never client-chosen) so that
 * strategy lifecycle events are attributable like every other audit event.
 * Non-HTTP entrypoints (tests, future workers) may omit it.
 */
export interface StrategyAuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Strategy + StrategyVersion domain service.
 *
 * Guarantees (enforced here AND by database triggers):
 *  - ownership: every call is scoped to the acting user; foreign resources
 *    404 (no existence leakage)
 *  - versioning: version_number is unique and increasing per strategy;
 *    at most one draft per strategy
 *  - immutability: published versions and their configuration cannot be
 *    modified or deleted (see migration 0007); the only allowed transition
 *    after publishing is deprecation
 *  - publish gate: validatePublishable must pass before a version is
 *    published
 *  - reference-data protection: version configs may only reference
 *    instruments that already exist in the shared platform universe —
 *    user input never creates `instruments` rows or rewrites shared
 *    display names (see writeVersionConfig)
 */
export class StrategyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------
  // Strategies (parent)
  // ------------------------------------------------------------------

  async listStrategies(actorUserId: string): Promise<StrategySummaryDto[]> {
    const res = await this.pool.query<StrategyRow & { version_count: string; current_version_id: string | null }>(
      `SELECT s.*,
              (SELECT count(*)::text FROM strategy_versions v WHERE v.strategy_id = s.id) AS version_count,
              (SELECT v.id FROM strategy_versions v
                WHERE v.strategy_id = s.id AND v.status = 'published'
                ORDER BY v.version_number DESC LIMIT 1) AS current_version_id
       FROM strategies s
       WHERE s.user_id = $1
       ORDER BY s.updated_at DESC`,
      [actorUserId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      currentVersionId: row.current_version_id,
      versionCount: Number(row.version_count),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async getStrategy(actorUserId: string, strategyId: string): Promise<StrategyDetailDto> {
    const client = await this.pool.connect();
    try {
      const strategy = await this.getOwnedStrategy(client, actorUserId, strategyId);
      const versionRows = await client.query<VersionRow>(
        'SELECT * FROM strategy_versions WHERE strategy_id = $1 ORDER BY version_number DESC',
        [strategyId],
      );
      const current =
        versionRows.rows.find((v) => v.status === 'published') ?? null;
      const versions: StrategyVersionSummaryDto[] = versionRows.rows.map((v) =>
        toVersionSummary(v, v.id === current?.id),
      );
      const currentVersion = current ? await this.readVersionDetail(client, current, true) : null;
      const summary = await this.summarize(client, strategy, versionRows.rows.length);
      return { ...summary, versions, currentVersion };
    } finally {
      client.release();
    }
  }

  async createStrategy(
    actorUserId: string,
    input: StrategyCreateInput,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // M7.4 Atomic entitlement enforcement
      const entitlementRes = await client.query(`
        SELECT plan, status FROM subscriptions WHERE user_id = $1 FOR UPDATE
      `, [actorUserId]);
      
      const subRow = entitlementRes.rows[0] || { plan: 'free', status: 'active' };
      const entitlements = getEntitlements(subRow.plan as UserPlan, subRow.status);
      const maxStrategies = entitlements.maxStrategies;
      
      const countRes = await client.query('SELECT count(*)::int AS c FROM strategies WHERE user_id = $1', [actorUserId]);
      const currentCount = countRes.rows[0].c;
      
      if (currentCount >= maxStrategies) {
        throw Errors.forbidden(`Strategy limit reached. Your plan allows up to ${maxStrategies} strategies.`);
      }

      const res = await client.query<StrategyRow>(
        `INSERT INTO strategies (user_id, name, description)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [actorUserId, input.name, input.description ?? null],
      );
      const strategy = res.rows[0];
      if (!strategy) throw Errors.internal('Failed to create strategy');

      const versionRes = await client.query<VersionRow>(
        `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
         VALUES ($1, 1, 'draft', $2)
         RETURNING *`,
        [strategy.id, actorUserId],
      );
      const version = versionRes.rows[0];
      if (!version) throw Errors.internal('Failed to create initial version');

      if (input.version) {
        await writeVersionConfig(client, version.id, normalizeConfig(input.version));
      }

      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.created',
        entityType: 'strategy',
        entityId: strategy.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { name: strategy.name },
      });

      return this.getStrategy(actorUserId, strategy.id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(err, 'strategies_user_name_unique')) {
        throw Errors.conflict('A strategy with this name already exists');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async updateStrategy(
    actorUserId: string,
    strategyId: string,
    input: StrategyUpdateInput,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const strategy = await this.getOwnedStrategy(client, actorUserId, strategyId);
      const sets: string[] = [];
      const values: unknown[] = [];
      if (input.name !== undefined) {
        values.push(input.name);
        sets.push(`name = $${values.length}`);
      }
      if (input.description !== undefined) {
        values.push(input.description);
        sets.push(`description = $${values.length}`);
      }
      if (input.status !== undefined) {
        values.push(input.status);
        sets.push(`status = $${values.length}`);
      }
      values.push(strategy.id);
      const res = await client.query<StrategyRow>(
        `UPDATE strategies SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values,
      );
      const updated = res.rows[0];
      if (!updated) throw Errors.notFound('Strategy not found');
      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.updated',
        entityType: 'strategy',
        entityId: strategy.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: {
          name: input.name !== undefined,
          description: input.description !== undefined,
          status: input.status ?? null,
        },
      });
      return this.getStrategy(actorUserId, strategyId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(err, 'strategies_user_name_unique')) {
        throw Errors.conflict('A strategy with this name already exists');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a strategy. Blocked when the strategy has published/deprecated
   * versions — its history must remain traceable (archive it instead).
   */
  async deleteStrategy(actorUserId: string, strategyId: string, meta?: StrategyAuditMeta): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const strategy = await this.getOwnedStrategy(client, actorUserId, strategyId);
      const hist = await client.query<{ id: string }>(
        "SELECT id FROM strategy_versions WHERE strategy_id = $1 AND status <> 'draft'",
        [strategyId],
      );
      if (hist.rowCount !== 0) {
        throw Errors.conflict(
          'A strategy with published versions cannot be deleted because its history must remain traceable. Archive the strategy instead.',
        );
      }
      await client.query('DELETE FROM strategies WHERE id = $1', [strategy.id]);
      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.deleted',
        entityType: 'strategy',
        entityId: strategyId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // Versions
  // ------------------------------------------------------------------

  async createVersion(
    actorUserId: string,
    strategyId: string,
    input: StrategyVersionCreateInput,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyVersionDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.getOwnedStrategyForUpdate(client, actorUserId, strategyId);

      const existingDraft = await client.query<VersionRow>(
        "SELECT * FROM strategy_versions WHERE strategy_id = $1 AND status = 'draft'",
        [strategyId],
      );
      if (existingDraft.rowCount !== 0) {
        throw Errors.conflict(
          'A draft version already exists for this strategy. Publish or delete it before creating another version.',
        );
      }

      let sourceConfig: StrategyVersionConfig | undefined;
      if (input.fromVersionId) {
        const sourceRes = await client.query<VersionRow>(
          'SELECT * FROM strategy_versions WHERE id = $1 AND strategy_id = $2',
          [input.fromVersionId, strategyId],
        );
        const sourceRow = sourceRes.rows[0];
        if (!sourceRow) {
          throw Errors.notFound('Source version not found for this strategy');
        }
        sourceConfig = await readVersionConfig(client, sourceRow.id);
      }

      const maxRes = await client.query<{ max: string }>(
        'SELECT COALESCE(MAX(version_number), 0)::text AS max FROM strategy_versions WHERE strategy_id = $1',
        [strategyId],
      );
      const nextNumber = Number(maxRes.rows[0]?.max ?? 0) + 1;

      const res = await client.query<VersionRow>(
        `INSERT INTO strategy_versions (strategy_id, version_number, status, changelog, created_by)
         VALUES ($1, $2, 'draft', $3, $4)
         RETURNING *`,
        [strategyId, nextNumber, input.changelog ?? null, actorUserId],
      );
      const version = res.rows[0];
      if (!version) throw Errors.internal('Failed to create version');

      if (sourceConfig) {
        await writeVersionConfig(client, version.id, sourceConfig);
      }

      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.version_created',
        entityType: 'strategy_version',
        entityId: version.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { strategyId, versionNumber: version.version_number, fromVersionId: input.fromVersionId ?? null },
      });

      return this.readVersionDetail(client, version, false);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getVersion(
    actorUserId: string,
    strategyId: string,
    versionId: string,
  ): Promise<StrategyVersionDetailDto> {
    const client = await this.pool.connect();
    try {
      const strategy = await this.getOwnedStrategy(client, actorUserId, strategyId);
      const version = await this.getOwnedVersion(client, strategy.id, versionId);
      const current = await this.findCurrentVersion(client, strategy.id);
      return this.readVersionDetail(client, version, version.id === current?.id);
    } finally {
      client.release();
    }
  }

  async updateVersionConfig(
    actorUserId: string,
    strategyId: string,
    versionId: string,
    input: StrategyVersionUpdateInput,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyVersionDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const strategy = await this.getOwnedStrategyForUpdate(client, actorUserId, strategyId);
      const version = await this.getOwnedVersionForUpdate(client, strategy.id, versionId);
      if (version.status !== 'draft') {
        throw Errors.immutable(
          `Version ${version.version_number} is ${version.status} and can no longer be modified. Create a new version to change the strategy.`,
        );
      }
      await writeVersionConfig(client, version.id, normalizeConfig(input.config));
      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.version_updated',
        entityType: 'strategy_version',
        entityId: version.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { strategyId, versionNumber: version.version_number },
      });
      return this.readVersionDetail(client, version, false);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async publishVersion(
    actorUserId: string,
    strategyId: string,
    versionId: string,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyVersionDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const strategy = await this.getOwnedStrategyForUpdate(client, actorUserId, strategyId);
      const version = await this.getOwnedVersionForUpdate(client, strategy.id, versionId);
      if (version.status === 'published') {
        throw Errors.conflict(`Version ${version.version_number} is already published.`);
      }
      if (version.status === 'deprecated') {
        throw Errors.conflict(`Version ${version.version_number} is deprecated and cannot be published.`);
      }

      const config = await readVersionConfig(client, version.id);
      const result = validatePublishable(config);
      if (!result.ok) {
        throw Errors.invalidInput(`Version cannot be published yet: ${result.errors.join(' ')}`);
      }

      const res = await client.query<VersionRow>(
        `UPDATE strategy_versions
         SET status = 'published', published_at = now()
         WHERE id = $1 AND status = 'draft'
         RETURNING *`,
        [version.id],
      );
      const published = res.rows[0];
      if (!published) throw Errors.internal('Failed to publish version');

      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.version_published',
        entityType: 'strategy_version',
        entityId: version.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { strategyId, versionNumber: version.version_number },
      });
      return this.readVersionDetail(client, published, true);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async deprecateVersion(
    actorUserId: string,
    strategyId: string,
    versionId: string,
    meta?: StrategyAuditMeta,
  ): Promise<StrategyVersionDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const strategy = await this.getOwnedStrategyForUpdate(client, actorUserId, strategyId);
      const version = await this.getOwnedVersionForUpdate(client, strategy.id, versionId);
      if (version.status !== 'published') {
        throw Errors.conflict('Only published versions can be deprecated.');
      }
      const res = await client.query<VersionRow>(
        `UPDATE strategy_versions SET status = 'deprecated'
         WHERE id = $1 AND status = 'published'
         RETURNING *`,
        [version.id],
      );
      const deprecated = res.rows[0];
      if (!deprecated) throw Errors.internal('Failed to deprecate version');
      await client.query('COMMIT');
      await this.audit.log({
        userId: actorUserId,
        action: 'strategy.version_deprecated',
        entityType: 'strategy_version',
        entityId: version.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { strategyId, versionNumber: version.version_number },
      });
      const current = await this.findCurrentVersion(client, strategy.id);
      return this.readVersionDetail(client, deprecated, deprecated.id === current?.id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async getOwnedStrategy(
    client: pg.PoolClient,
    actorUserId: string,
    strategyId: string,
  ): Promise<StrategyRow> {
    const res = await client.query<StrategyRow>(
      'SELECT * FROM strategies WHERE id = $1 AND user_id = $2',
      [strategyId, actorUserId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Strategy not found');
    return row;
  }

  private async getOwnedStrategyForUpdate(
    client: pg.PoolClient,
    actorUserId: string,
    strategyId: string,
  ): Promise<StrategyRow> {
    const res = await client.query<StrategyRow>(
      'SELECT * FROM strategies WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [strategyId, actorUserId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Strategy not found');
    return row;
  }

  private async getOwnedVersion(
    client: pg.PoolClient,
    strategyId: string,
    versionId: string,
  ): Promise<VersionRow> {
    const res = await client.query<VersionRow>(
      'SELECT * FROM strategy_versions WHERE id = $1 AND strategy_id = $2',
      [versionId, strategyId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Version not found for this strategy');
    return row;
  }

  private async getOwnedVersionForUpdate(
    client: pg.PoolClient,
    strategyId: string,
    versionId: string,
  ): Promise<VersionRow> {
    const res = await client.query<VersionRow>(
      'SELECT * FROM strategy_versions WHERE id = $1 AND strategy_id = $2 FOR UPDATE',
      [versionId, strategyId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Version not found for this strategy');
    return row;
  }

  private async findCurrentVersion(
    client: pg.PoolClient,
    strategyId: string,
  ): Promise<VersionRow | null> {
    const res = await client.query<VersionRow>(
      "SELECT * FROM strategy_versions WHERE strategy_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1",
      [strategyId],
    );
    return res.rows[0] ?? null;
  }

  private async summarize(client: pg.PoolClient, strategy: StrategyRow, versionCount: number): Promise<StrategySummaryDto> {
    const current = await this.findCurrentVersion(client, strategy.id);
    return {
      id: strategy.id,
      name: strategy.name,
      description: strategy.description,
      status: strategy.status,
      currentVersionId: current?.id ?? null,
      versionCount,
      createdAt: strategy.created_at.toISOString(),
      updatedAt: strategy.updated_at.toISOString(),
    };
  }

  private async readVersionDetail(
    client: pg.PoolClient,
    version: VersionRow,
    isCurrent: boolean,
  ): Promise<StrategyVersionDetailDto> {
    const config = await readVersionConfig(client, version.id);
    return {
      id: version.id,
      strategyId: version.strategy_id,
      versionNumber: version.version_number,
      status: version.status,
      changelog: version.changelog,
      isCurrent,
      createdAt: version.created_at.toISOString(),
      publishedAt: version.published_at ? version.published_at.toISOString() : null,
      config,
    };
  }
}

// ----------------------------------------------------------------------
// Config normalization
// ----------------------------------------------------------------------

/**
 * Defensive validation + normalization of a version config before it is
 * written. The API already validates with the same schema, but the service
 * is the last line of defense (it is also called by tests and future
 * non-HTTP entrypoints). Fills schema defaults and rejects unknown keys.
 */
function normalizeConfig(raw: StrategyVersionConfigInput): StrategyVersionConfig {
  const parsed = strategyVersionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw Errors.invalidInput(`Invalid version config — ${msg}`);
  }
  return parsed.data;
}

// ----------------------------------------------------------------------
// Config (de)serialization
// ----------------------------------------------------------------------

async function readVersionConfig(client: pg.PoolClient, versionId: string): Promise<StrategyVersionConfig> {
  // Sequential, one query at a time: these all run over a SINGLE pooled
  // connection, so the Postgres protocol serializes them anyway — `Promise.all`
  // bought no parallelism and only triggered pg's "client is already executing
  // a query" deprecation (removed in pg@9). Real parallelism would require one
  // connection per query, which is not worth 8 pool slots for this read.
  const tfRes = await client.query<TimeframeRow>(
    'SELECT role, timeframe FROM strategy_timeframes WHERE version_id = $1',
    [versionId],
  );
  const scopeRes = await client.query<ScopeRow>(
    'SELECT mode FROM strategy_market_scopes WHERE version_id = $1',
    [versionId],
  );
  const scopeInstRes = await client.query<ScopeInstrumentRow>(
    `SELECT i.asset_class, i.symbol, i.display_name
       FROM strategy_market_scope_instruments si
       JOIN instruments i ON i.id = si.instrument_id
       WHERE si.version_id = $1`,
    [versionId],
  );
  const sfRes = await client.query<SessionFilterRow>(
    'SELECT session, mode, timezone FROM strategy_session_filters WHERE version_id = $1 ORDER BY id',
    [versionId],
  );
  const riskRes = await client.query<RiskRow>(
    'SELECT * FROM strategy_risk_config WHERE version_id = $1',
    [versionId],
  );
  const filterRes = await client.query<FilterRow>(
    'SELECT filter_type, enabled, params, position FROM strategy_filters WHERE version_id = $1 ORDER BY position',
    [versionId],
  );
  const groupRes = await client.query<GroupRow>(
    'SELECT id, name, logic, position FROM strategy_rule_groups WHERE version_id = $1 ORDER BY position',
    [versionId],
  );
  const condRes = await client.query<ConditionRow>(
    `SELECT c.group_id, c.condition_type, c.classification, c.timeframe_role, c.params, c.description, c.position
       FROM strategy_conditions c
       JOIN strategy_rule_groups g ON g.id = c.group_id
       WHERE g.version_id = $1
       ORDER BY g.position, c.position`,
    [versionId],
  );

  const tfRow = tfRes.rows[0];
  const timeframes =
    tfRow && tfRes.rows.length === 3
      ? {
          htf_bias: tfRes.rows.find((r) => r.role === 'htf_bias')?.timeframe,
          setup: tfRes.rows.find((r) => r.role === 'setup')?.timeframe,
          entry: tfRes.rows.find((r) => r.role === 'entry')?.timeframe,
        }
      : undefined;

  const scopeRow = scopeRes.rows[0];
  let marketScope: StrategyVersionConfig['marketScope'];
  if (scopeRow) {
    marketScope =
      scopeRow.mode === 'all'
        ? { mode: 'all' }
        : {
            mode: 'instruments',
            instruments: scopeInstRes.rows.map((r) => ({
              assetClass: r.asset_class as AssetClass,
              symbol: r.symbol,
              displayName: r.display_name ?? undefined,
            })),
          } as StrategyVersionConfig['marketScope'];
  }

  const riskRow = riskRes.rows[0];
  const risk = riskRow
    ? {
        minRr: Number(riskRow.min_rr),
        stopLossMethod: riskRow.stop_loss_method as 'structure' | 'fixed' | 'atr',
        stopLossBuffer: Number(riskRow.stop_loss_buffer),
        stopLossBufferUnit: riskRow.stop_loss_buffer_unit as 'pips' | 'pct',
        takeProfitMethod: riskRow.take_profit_method as 'rr' | 'structure' | 'manual',
        tp1Rr: Number(riskRow.tp1_rr),
        tp2Rr: Number(riskRow.tp2_rr),
        tp3Rr: Number(riskRow.tp3_rr),
        minQualityScore: riskRow.min_quality_score,
      }
    : undefined;

  const sessionFilters: SessionFilter[] = sfRes.rows.map((r) => ({
    session: r.session as SessionFilter['session'],
    mode: r.mode as SessionFilter['mode'],
    timezone: r.timezone as SessionFilter['timezone'],
  }));

  const filters: StrategyFilter[] = filterRes.rows.map((r) => ({
    type: r.filter_type as StrategyFilter['type'],
    enabled: r.enabled,
    params: r.params,
  }));

  const groups = groupRes.rows.map((g) => {
    const conditions = condRes.rows
      .filter((c) => c.group_id === g.id)
      .map((c) => ({
        conditionType: c.condition_type,
        classification: c.classification as 'required' | 'optional' | 'confirmation' | 'disqualifying',
        timeframeRole: c.timeframe_role as 'htf_bias' | 'setup' | 'entry' | 'any',
        params: c.params,
        description: c.description ?? undefined,
        position: c.position,
      }));
    return {
      name: g.name,
      logic: g.logic,
      position: g.position,
      conditions,
    };
  });

  return {
    ...(timeframes &&
      timeframes.htf_bias &&
      timeframes.setup &&
      timeframes.entry && {
        timeframes: {
          htf_bias: timeframes.htf_bias as Timeframe,
          setup: timeframes.setup as Timeframe,
          entry: timeframes.entry as Timeframe,
        },
      }),
    ...(marketScope && { marketScope }),
    sessionFilters,
    ...(risk && { risk }),
    filters,
    ruleGroups: groups,
  };
}

async function writeVersionConfig(
  client: pg.PoolClient,
  versionId: string,
  config: StrategyVersionConfig,
): Promise<void> {
  // Full-replace semantics: remove existing child rows, then insert the new
  // configuration. (Only legal while the version is a draft — enforced by
  // the caller and by the 0007 triggers.)
  await client.query(
    `DELETE FROM strategy_conditions WHERE group_id IN (SELECT id FROM strategy_rule_groups WHERE version_id = $1)`,
    [versionId],
  );
  await client.query('DELETE FROM strategy_rule_groups WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_timeframes WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_market_scope_instruments WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_market_scopes WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_session_filters WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_risk_config WHERE version_id = $1', [versionId]);
  await client.query('DELETE FROM strategy_filters WHERE version_id = $1', [versionId]);

  if (config.timeframes) {
    for (const [role, timeframe] of Object.entries(config.timeframes)) {
      await client.query('INSERT INTO strategy_timeframes (version_id, role, timeframe) VALUES ($1, $2, $3)', [
        versionId,
        role,
        timeframe,
      ]);
    }
  }

  if (config.marketScope) {
    await client.query('INSERT INTO strategy_market_scopes (version_id, mode) VALUES ($1, $2)', [
      versionId,
      config.marketScope.mode,
    ]);
    if (config.marketScope.mode === 'instruments' && config.marketScope.instruments) {
      for (const inst of config.marketScope.instruments) {
        // M7.2 hardening: `instruments` is PLATFORM-MANAGED reference data
        // shared by every user (see migration 0002 — it grows only via
        // migrations or an admin flow). A user's version config may only
        // REFERENCE existing instruments, never create rows or rewrite
        // shared display names. The previous upsert let any user mint new
        // symbols (which then appeared in everyone's scope-"all"
        // evaluations and market lists) and overwrite the display name of
        // a platform instrument. Unknown instruments are rejected here.
        // `displayName` in the input remains part of the version snapshot
        // contract but no longer mutates the shared table.
        const res = await client.query<{ id: string }>(
          'SELECT id FROM instruments WHERE asset_class = $1 AND symbol = $2',
          [inst.assetClass, inst.symbol.toUpperCase()],
        );
        const instId = res.rows[0]?.id;
        if (!instId) {
          throw Errors.invalidInput(
            `Unknown instrument "${inst.assetClass}/${inst.symbol.toUpperCase()}" — it is not part of the platform instrument universe. ` +
              'Choose an instrument from GET /api/markets/instruments.',
          );
        }
        await client.query('INSERT INTO strategy_market_scope_instruments (version_id, instrument_id) VALUES ($1, $2)', [
          versionId,
          instId,
        ]);
      }
    }
  }

  for (const sf of config.sessionFilters ?? []) {
    await client.query(
      'INSERT INTO strategy_session_filters (version_id, session, mode, timezone) VALUES ($1, $2, $3, $4)',
      [versionId, sf.session, sf.mode, sf.timezone],
    );
  }

  if (config.risk) {
    const r = config.risk;
    await client.query(
      `INSERT INTO strategy_risk_config
       (version_id, min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
        take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        versionId,
        r.minRr,
        r.stopLossMethod,
        r.stopLossBuffer,
        r.stopLossBufferUnit,
        r.takeProfitMethod,
        r.tp1Rr,
        r.tp2Rr,
        r.tp3Rr,
        r.minQualityScore,
      ],
    );
  }

  for (const [index, f] of (config.filters ?? []).entries()) {
    await client.query(
      'INSERT INTO strategy_filters (version_id, filter_type, enabled, params, position) VALUES ($1, $2, $3, $4, $5)',
      [versionId, f.type, f.enabled, JSON.stringify(f.params), index],
    );
  }

  // Order is defined by array position: the position columns are set from
  // the index, never from caller input (avoids duplicate-position conflicts
  // and keeps authoring order authoritative).
  for (const [gIndex, group] of (config.ruleGroups ?? []).entries()) {
    const groupRes = await client.query<{ id: string }>(
      'INSERT INTO strategy_rule_groups (version_id, name, logic, position) VALUES ($1, $2, $3, $4) RETURNING id',
      [versionId, group.name, group.logic, gIndex],
    );
    const groupId = groupRes.rows[0]?.id;
    if (!groupId) continue;
    for (const [cIndex, cond] of group.conditions.entries()) {
      // Normalize params with the type's schema so the stored version is a
      // COMPLETE snapshot (defaults baked in). This keeps historical versions
      // deterministic even if registry defaults change later.
      const def = getConditionType(cond.conditionType);
      const params = def ? def.paramSchema.parse(cond.params) : cond.params;
      await client.query(
        `INSERT INTO strategy_conditions
         (group_id, condition_type, classification, timeframe_role, params, description, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          groupId,
          cond.conditionType,
          cond.classification,
          cond.timeframeRole,
          JSON.stringify(params),
          cond.description ?? null,
          cIndex,
        ],
      );
    }
  }
}

function toVersionSummary(row: VersionRow, isCurrent: boolean): StrategyVersionSummaryDto {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    versionNumber: row.version_number,
    status: row.status,
    changelog: row.changelog,
    isCurrent,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  };
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return false;
  return constraint ? e.constraint === constraint : true;
}
