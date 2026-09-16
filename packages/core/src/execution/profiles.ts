import type pg from 'pg';
import {
  M8_1_ALLOWED_ENVIRONMENTS,
  type ExecutionMode,
  type ExecutionProfileCreateInput,
  type ExecutionProfileDto,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { AuditService, AuditEntry } from '../audit.js';
import type { ExecutionProviderRegistry } from './registry.js';

/**
 * M8.1 — execution profile service (account configuration).
 *
 * Guarantees:
 *  - owner-scoped: every read/write is keyed on the caller's `userId`;
 *    foreign or unknown profiles are masked 404s;
 *  - M8.1 boundary: ONLY `paper` profiles may be created. `demo` is refused
 *    as "not yet available"; `live` is refused outright and is additionally
 *    impossible at the storage layer (migration 0016 CHECK);
 *  - provider validation: `providerSlug` must be a REGISTERED execution
 *    provider — clients cannot name arbitrary providers into existence;
 *  - NO credentials: only a non-secret `accountRef` label is accepted, and
 *    it is length-capped; broker passwords/keys have no home in this schema;
 *  - one profile per (user, mode) — enforced by the DB unique index.
 */
export class ExecutionProfileService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: ExecutionProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async createProfile(
    userId: string,
    input: ExecutionProfileCreateInput,
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>,
  ): Promise<ExecutionProfileDto> {
    // M8.1 hard boundary, enforced server-side regardless of request shape.
    if (!(M8_1_ALLOWED_ENVIRONMENTS as readonly string[]).includes(input.mode)) {
      if (input.mode === 'live') {
        throw Errors.forbidden('Live execution is not available — no live connectivity exists in this platform version');
      }
      throw Errors.forbidden(
        `"${input.mode}" execution profiles are not available yet (paper only in this milestone)`,
      );
    }

    const provider = this.registry.get(input.providerSlug);
    if (!provider) {
      throw Errors.invalidInput(
        `Unknown execution provider "${input.providerSlug}" — providers are registered server-side only`,
      );
    }
    if (!(provider.capabilities.modes as readonly string[]).includes(input.mode)) {
      throw Errors.invalidInput(
        `Execution provider "${provider.id}" does not support "${input.mode}" execution`,
      );
    }

    try {
      const res = await this.pool.query<ExecutionProfileRow>(
        `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug, account_ref)
         VALUES ($1, $2, $2, $3, $4)
         RETURNING *`,
        [userId, input.mode, input.providerSlug, input.accountRef ?? null],
      );
      const row = res.rows[0];
      if (!row) throw Errors.internal('Failed to create execution profile');
      await this.audit.log({
        userId,
        action: 'execution.profile_created',
        entityType: 'execution_profile',
        entityId: row.id,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { mode: row.mode, providerSlug: row.provider_slug },
      });
      return toProfileDto(row);
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw Errors.conflict(`A "${input.mode}" execution profile already exists`);
      }
      throw err;
    }
  }

  async listForUser(userId: string): Promise<{ profiles: ExecutionProfileDto[] }> {
    const res = await this.pool.query<ExecutionProfileRow>(
      `SELECT * FROM execution_profiles WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return { profiles: res.rows.map(toProfileDto) };
  }

  /** Owner-scoped single read; foreign/unknown ids are masked 404s. */
  async getForUser(userId: string, profileId: string): Promise<ExecutionProfileDto> {
    const row = await this.findOwnedRow(userId, profileId);
    if (!row) throw Errors.notFound('Execution profile not found');
    return toProfileDto(row);
  }

  /** Internal: owner-scoped row lookup returning null instead of throwing. */
  async findOwnedRow(userId: string, profileId: string): Promise<ExecutionProfileRow | null> {
    const res = await this.pool.query<ExecutionProfileRow>(
      `SELECT * FROM execution_profiles WHERE id = $1 AND user_id = $2`,
      [profileId, userId],
    );
    return res.rows[0] ?? null;
  }
}

export interface ExecutionProfileRow {
  id: string;
  user_id: string;
  mode: ExecutionMode;
  environment: ExecutionMode;
  provider_slug: string;
  account_ref: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export function toProfileDto(row: ExecutionProfileRow): ExecutionProfileDto {
  return {
    id: row.id,
    mode: row.mode,
    environment: row.environment,
    providerSlug: row.provider_slug,
    accountRef: row.account_ref,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
