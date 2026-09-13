import { z } from 'zod';
import { strategyTimeframesSchema } from './timeframes.js';
import { marketScopeSchema } from './assets.js';
import { strategyRuleGroupSchema } from './conditions.js';
import { riskConfigurationSchema } from './risk.js';

/**
 * Strategy API payload contracts.
 *
 * A Strategy (parent) owns many StrategyVersions. A version is the complete,
 * self-contained definition of "what the strategy is at that version":
 * timeframes + market scope + session filters + risk config + filters +
 * rule groups/conditions. Publishing a version freezes it (enforced by the
 * service layer AND by database triggers — see docs/strategy-model.md).
 */

export const STRATEGY_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const VERSION_STATUSES = ['draft', 'published', 'deprecated'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const SESSION_NAMES = ['asia', 'london', 'new_york', 'sydney'] as const;
export type SessionName = (typeof SESSION_NAMES)[number];

export const sessionFilterSchema = z
  .object({
    session: z.enum(SESSION_NAMES),
    mode: z.enum(['include', 'exclude']).default('include'),
    timezone: z.enum(['utc', 'exchange']).default('exchange'),
  })
  .strict();
export type SessionFilter = z.infer<typeof sessionFilterSchema>;

export const STRATEGY_FILTER_TYPES = ['news', 'volatility', 'spread'] as const;
export type StrategyFilterType = (typeof STRATEGY_FILTER_TYPES)[number];

export const strategyFilterSchema = z
  .object({
    type: z.enum(STRATEGY_FILTER_TYPES),
    enabled: z.boolean().default(true),
    /** Type-specific parameters, validated by the strategy service. */
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type StrategyFilter = z.infer<typeof strategyFilterSchema>;

/**
 * Full configuration of a strategy version.
 * Every field is optional in a DRAFT (an empty draft is legal) but a version
 * cannot be PUBLISHED until required fields are present and valid —
 * publish validation is enforced by the core service (see
 * `validatePublishable` in packages/core).
 */
export const strategyVersionConfigSchema = z
  .object({
    timeframes: strategyTimeframesSchema.optional(),
    marketScope: marketScopeSchema.optional(),
    sessionFilters: z.array(sessionFilterSchema).max(16).default([]),
    risk: riskConfigurationSchema.optional(),
    filters: z.array(strategyFilterSchema).max(16).default([]),
    ruleGroups: z.array(strategyRuleGroupSchema).max(50).default([]),
  })
  .strict();
export type StrategyVersionConfig = z.infer<typeof strategyVersionConfigSchema>;
/** What a client may POST: fields with defaults may be omitted. */
export type StrategyVersionConfigInput = z.input<typeof strategyVersionConfigSchema>;

export const strategyCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).optional(),
    /** Initial draft version configuration (optional — may be an empty draft). */
    version: strategyVersionConfigSchema.optional(),
  })
  .strict();
export type StrategyCreateInput = z.input<typeof strategyCreateSchema>;

export const strategyUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    status: z.enum(STRATEGY_STATUSES).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, {
    message: 'Provide at least one field to update',
  });
export type StrategyUpdateInput = z.infer<typeof strategyUpdateSchema>;

/** Update the configuration of a DRAFT version (full-replace semantics). */
export const strategyVersionUpdateSchema = z
  .object({
    config: strategyVersionConfigSchema,
  })
  .strict();
export type StrategyVersionUpdateInput = z.input<typeof strategyVersionUpdateSchema>;

/** Create a new draft version, optionally cloned from an existing one. */
export const strategyVersionCreateSchema = z
  .object({
    fromVersionId: z.string().uuid().optional(),
    changelog: z.string().trim().max(500).optional(),
  })
  .strict();
export type StrategyVersionCreateInput = z.infer<typeof strategyVersionCreateSchema>;

/** Response DTOs. */
export interface StrategySummaryDto {
  id: string;
  name: string;
  description: string | null;
  status: StrategyStatus;
  currentVersionId: string | null;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyVersionSummaryDto {
  id: string;
  strategyId: string;
  versionNumber: number;
  status: VersionStatus;
  changelog: string | null;
  isCurrent: boolean;
  createdAt: string;
  publishedAt: string | null;
}

export interface StrategyDetailDto extends StrategySummaryDto {
  versions: StrategyVersionSummaryDto[];
  currentVersion: StrategyVersionDetailDto | null;
}

export interface StrategyVersionDetailDto {
  id: string;
  strategyId: string;
  versionNumber: number;
  status: VersionStatus;
  changelog: string | null;
  isCurrent: boolean;
  createdAt: string;
  publishedAt: string | null;
  /**
   * Full version configuration. For drafts, `timeframes`, `marketScope` and
   * `risk` may be absent until they are filled in; a version cannot be
   * published until they are present and valid (see validatePublishable).
   */
  config: StrategyVersionConfig;
}
