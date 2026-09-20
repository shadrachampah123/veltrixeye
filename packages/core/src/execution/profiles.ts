import type pg from 'pg';
import {
  MT5_EXECUTION_PROVIDER_ID,
  type BrokerProfilePatchInput,
  type BrokerSymbolMappingInput,
  type ExecutionMode,
  type ExecutionProfileCreateInput,
  type ExecutionProfileDto,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { AuditService, AuditEntry } from '../audit.js';
import type { ExecutionProviderRegistry } from './registry.js';
import { toSafeProviderHealth } from './provider-health.js';

/** Owner-scoped execution/broker profiles. Credentials are deliberately not modeled. */
export class ExecutionProfileService {
  constructor(private readonly pool: pg.Pool, private readonly registry: ExecutionProviderRegistry, private readonly audit: AuditService) {}

  async createProfile(userId: string, input: ExecutionProfileCreateInput, meta?: Pick<AuditEntry, 'ip' | 'userAgent'>): Promise<ExecutionProfileDto> {
    if (input.mode === 'live') throw Errors.forbidden('Live execution is prohibited in M8.4');
    const provider = this.registry.get(input.providerSlug);
    if (!provider) throw Errors.invalidInput(`Unknown execution provider "${input.providerSlug}" — providers are registered server-side only`);
    if (!provider.capabilities.modes.includes(input.mode)) throw Errors.invalidInput(`Execution provider "${provider.id}" does not support "${input.mode}" execution`);
    if (input.mode === 'paper' && input.providerSlug !== 'paper') throw Errors.invalidInput('Paper profiles must use the internal paper provider');
    if (input.mode === 'demo' && input.providerSlug !== MT5_EXECUTION_PROVIDER_ID) throw Errors.invalidInput('Broker demo profiles must use a registered demo provider');
    if (input.mode === 'demo' && (!input.brokerServer || !input.accountRef)) throw Errors.invalidInput('Broker demo profiles require brokerServer and a non-secret accountRef');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<ExecutionProfileRow>(
        `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug, account_ref, broker_server, enabled, connection_status)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, input.mode, input.providerSlug, input.accountRef ?? null, input.brokerServer ?? null,
          input.mode === 'paper', input.mode === 'paper' ? 'connected' : 'disabled'],
      );
      const row = res.rows[0];
      if (!row) throw Errors.internal('Failed to create execution profile');
      await replaceMappings(client, row.id, input.symbolMappings ?? []);
      await client.query('COMMIT');
      await this.audit.log({ userId, action: 'execution.profile_created', entityType: 'execution_profile', entityId: row.id, ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null, metadata: { mode: row.mode, providerSlug: row.provider_slug, brokerServer: row.broker_server, enabled: row.enabled } });
      return this.getForUser(userId, row.id);
    } catch (err) {
      await client.query('ROLLBACK');
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') throw Errors.conflict(`A "${input.mode}" execution profile or symbol mapping already exists`);
      throw err;
    } finally { client.release(); }
  }

  async updateBrokerProfile(userId: string, profileId: string, input: BrokerProfilePatchInput, meta?: Pick<AuditEntry, 'ip' | 'userAgent'>): Promise<ExecutionProfileDto> {
    const current = await this.findOwnedRow(userId, profileId);
    if (!current) throw Errors.notFound('Execution profile not found');
    if (current.provider_slug !== MT5_EXECUTION_PROVIDER_ID) throw Errors.invalidInput('Only broker profiles can be changed through this endpoint');
    if (input.environment === 'live') throw Errors.forbidden('Live execution is prohibited in M8.4');
    if (input.environment && input.environment !== 'demo') throw Errors.invalidInput('MT5 broker profiles are demo-only in M8.4');
    // Enabling a database row cannot activate an unconfigured provider.
    if (input.enabled && !this.registry.get(MT5_EXECUTION_PROVIDER_ID)?.configured) throw Errors.forbidden('MT5 transport is unconfigured; this profile cannot be enabled');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE execution_profiles SET enabled = COALESCE($3, enabled), broker_server = COALESCE($4, broker_server),
           account_ref = COALESCE($5, account_ref), connection_status = CASE WHEN $3 = false THEN 'disabled' ELSE connection_status END
         WHERE id = $1 AND user_id = $2`,
        [profileId, userId, input.enabled ?? null, input.brokerServer ?? null, input.accountRef ?? null],
      );
      if (input.symbolMappings) await replaceMappings(client, profileId, input.symbolMappings);
      await client.query('COMMIT');
      await this.audit.log({ userId, action: input.enabled === false ? 'execution.provider_disabled' : 'execution.profile_updated', entityType: 'execution_profile', entityId: profileId, ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null, metadata: { fields: [input.enabled !== undefined ? 'enabled' : null, input.brokerServer !== undefined ? 'brokerServer' : null, input.accountRef !== undefined ? 'accountRef' : null, input.symbolMappings !== undefined ? 'symbolMappings' : null, input.environment !== undefined ? 'environment' : null].filter(Boolean) } });
      return this.getForUser(userId, profileId);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async testBrokerProfile(userId: string, profileId: string, meta?: Pick<AuditEntry, 'ip' | 'userAgent'>) {
    const row = await this.findOwnedRow(userId, profileId);
    if (!row) throw Errors.notFound('Execution profile not found');
    if (row.provider_slug !== MT5_EXECUTION_PROVIDER_ID) throw Errors.invalidInput('Connection tests apply only to broker profiles');
    const provider = this.registry.get(row.provider_slug);
    // The adapter's health object is never returned or persisted verbatim: the
    // audit row keeps closed-enum facts only (no `reason`, no `detail`) and the
    // response is the safe projection.
    const health = toSafeProviderHealth(provider ? await provider.health() : null);
    await this.audit.log({ userId, action: 'execution.connection_tested', entityType: 'execution_profile', entityId: profileId, ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null, metadata: { provider: row.provider_slug, healthy: health.healthy, available: health.available, state: health.state, providerRegistered: provider !== undefined } });
    return { profileId, orderPlaced: false, health };
  }

  async listForUser(userId: string): Promise<{ profiles: ExecutionProfileDto[] }> {
    const res = await this.pool.query<ExecutionProfileRow>(`SELECT * FROM execution_profiles WHERE user_id = $1 ORDER BY created_at ASC`, [userId]);
    return { profiles: await Promise.all(res.rows.map((r) => this.toDto(r))) };
  }
  async getForUser(userId: string, profileId: string): Promise<ExecutionProfileDto> {
    const row = await this.findOwnedRow(userId, profileId);
    if (!row) throw Errors.notFound('Execution profile not found');
    return this.toDto(row);
  }
  async findOwnedRow(userId: string, profileId: string): Promise<ExecutionProfileRow | null> {
    const res = await this.pool.query<ExecutionProfileRow>('SELECT * FROM execution_profiles WHERE id = $1 AND user_id = $2', [profileId, userId]);
    return res.rows[0] ?? null;
  }
  private async toDto(row: ExecutionProfileRow): Promise<ExecutionProfileDto> {
    const maps = await this.pool.query<{ asset_class: BrokerSymbolMappingInput['assetClass']; symbol: string; broker_symbol: string }>(
      `SELECT i.asset_class, i.symbol, m.broker_symbol FROM execution_symbol_mappings m JOIN instruments i ON i.id = m.instrument_id WHERE m.execution_profile_id = $1 ORDER BY i.symbol`, [row.id]);
    return toProfileDto(row, maps.rows.map((m) => ({ assetClass: m.asset_class, canonicalSymbol: m.symbol, brokerSymbol: m.broker_symbol })));
  }
}

async function replaceMappings(client: pg.PoolClient, profileId: string, mappings: BrokerSymbolMappingInput[]) {
  await client.query('DELETE FROM execution_symbol_mappings WHERE execution_profile_id = $1', [profileId]);
  for (const m of mappings) {
    const result = await client.query<{ id: string }>('SELECT id FROM instruments WHERE asset_class = $1 AND symbol = $2', [m.assetClass, m.canonicalSymbol]);
    if (!result.rows[0]) throw Errors.invalidInput(`Unknown canonical instrument ${m.assetClass}:${m.canonicalSymbol}`);
    await client.query('INSERT INTO execution_symbol_mappings (execution_profile_id, instrument_id, broker_symbol) VALUES ($1, $2, $3)', [profileId, result.rows[0].id, m.brokerSymbol]);
  }
}

export interface ExecutionProfileRow {
  id: string; user_id: string; mode: ExecutionMode; environment: ExecutionMode; provider_slug: string;
  account_ref: string | null; broker_server: string | null; connection_status: 'unconfigured' | 'disabled' | 'unavailable' | 'connected' | 'degraded';
  enabled: boolean; created_at: Date; updated_at: Date;
}
export function toProfileDto(row: ExecutionProfileRow, symbolMappings: BrokerSymbolMappingInput[] = []): ExecutionProfileDto {
  return { id: row.id, mode: row.mode, environment: row.environment, providerSlug: row.provider_slug, accountRef: row.account_ref,
    brokerServer: row.broker_server, connectionStatus: row.connection_status, symbolMappings, enabled: row.enabled,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
