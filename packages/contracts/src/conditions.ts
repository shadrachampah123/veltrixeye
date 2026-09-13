import { z } from 'zod';
import type { TimeframeRole } from './timeframes.js';

/**
 * Condition model — foundation for the deterministic strategy engine.
 *
 * Design rules (see docs/strategy-model.md):
 *  - A condition is a NAMED, TYPED rule with structured parameters (JSONB in
 *    the database, validated against the per-type schema in this registry).
 *  - The registry in THIS FILE is the single source of truth for condition
 *    types. It is deliberately NOT a database enum: adding a new type is an
 *    additive code change, never a schema migration.
 *  - Each persisted condition also carries a classification:
 *      required      — must be satisfied for the setup to pass
 *      optional      — may contribute to the quality score
 *      confirmation  — must be satisfied at the entry timeframe
 *      disqualifying — if satisfied, the setup is rejected
 */

export const CONDITION_CLASSIFICATIONS = [
  'required',
  'optional',
  'confirmation',
  'disqualifying',
] as const;
export type ConditionClassification = (typeof CONDITION_CLASSIFICATIONS)[number];

export const CONDITION_CATEGORIES = [
  'structure',
  'price_action',
  'zone',
  'level',
  'risk',
  'time',
  'market_filter',
] as const;
export type ConditionCategory = (typeof CONDITION_CATEGORIES)[number];

export type ConditionParams = Record<string, unknown>;

export interface ConditionTypeDefinition {
  /** Stable machine identifier (snake_case). Never change once released. */
  type: string;
  label: string;
  description: string;
  categories: ConditionCategory[];
  /** Which timeframe role this condition most naturally applies to. */
  defaultTimeframeRole: TimeframeRole | 'any';
  /**
   * Validation for the condition's `params` object (strict: unknown keys
   * rejected). Typed as ZodTypeAny so each schema can use its own default
   * handling; validation is runtime-authoritative.
   */
  paramSchema: z.ZodTypeAny;
}

const direction = z.enum(['bullish', 'bearish', 'either']);
const positiveInt = (max = 100000) => z.number().int().positive().max(max);

const lookback = positiveInt(5000);

/**
 * The condition-type registry.
 *
 * To add a future condition type: add an entry here with its param schema.
 * No database migration is required; the `strategy_conditions.condition_type`
 * column is text and the API validates against this registry.
 */
export const CONDITION_TYPE_REGISTRY: Readonly<Record<string, ConditionTypeDefinition>> = {
  liquidity_sweep: {
    type: 'liquidity_sweep',
    label: 'Liquidity sweep',
    description:
      'Price wicked through a prior high/low (resting liquidity) and closed back inside the range.',
    categories: ['structure', 'price_action'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        side: z.enum(['above', 'below']).default('above'),
        lookbackCandles: z.number().int().min(1).max(1000).default(100),
        minWickRatio: z.number().min(0).max(1).default(0.3),
      })
      .strict()
      .default({}),
  },
  choch: {
    type: 'choch',
    label: 'Change of character (CHoCH)',
    description: 'Market structure shifted against the prevailing trend via a broken swing.',
    categories: ['structure'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        lookbackCandles: lookback.default(200),
        requireDisplacement: z.boolean().default(false),
      })
      .strict()
      .default({}),
  },
  bos: {
    type: 'bos',
    label: 'Break of structure (BOS)',
    description: 'Market closed beyond the last swing high/low in the direction of the trend.',
    categories: ['structure'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        lookbackCandles: lookback.default(200),
      })
      .strict()
      .default({}),
  },
  break_retest: {
    type: 'break_retest',
    label: 'Break & retest',
    description:
      'A level was broken and then retested (break flips to support/resistance) before the move continues.',
    categories: ['structure', 'level'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        maxRetestCandles: positiveInt(100).default(24),
        retestTolerancePct: z.number().positive().max(10).default(0.1),
      })
      .strict()
      .default({}),
  },
  order_block: {
    type: 'order_block',
    label: 'Order block',
    description:
      'Price reacted from an origin zone (last opposing candle before a displacing move).',
    categories: ['zone'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        kind: z.enum(['bullish', 'bearish']).default('bullish'),
        validation: z.enum(['mitigation', 'break']).default('mitigation'),
        maxAgeCandles: positiveInt(500).default(100),
      })
      .strict()
      .default({}),
  },
  fvg: {
    type: 'fvg',
    label: 'Fair value gap',
    description: 'Unfilled three-candle imbalance zone; price returned to or reacted from it.',
    categories: ['zone'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        kind: z.enum(['bullish', 'bearish']).default('bullish'),
        minGapSizePct: z.number().positive().max(10).optional(),
        requireMitigation: z.boolean().default(true),
      })
      .strict()
      .default({}),
  },
  support: {
    type: 'support',
    label: 'Support level',
    description: 'Price held at a prior low/accumulation zone (tested at least N times).',
    categories: ['level', 'zone'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        minTouches: z.number().int().min(2).max(50).default(2),
        lookbackCandles: lookback.default(500),
      })
      .strict()
      .default({}),
  },
  resistance: {
    type: 'resistance',
    label: 'Resistance level',
    description: 'Price rejected at a prior high/distribution zone (tested at least N times).',
    categories: ['level', 'zone'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        minTouches: z.number().int().min(2).max(50).default(2),
        lookbackCandles: lookback.default(500),
      })
      .strict()
      .default({}),
  },
  supply: {
    type: 'supply',
    label: 'Supply zone',
    description: 'Overhead zone where prior selling caused a sustained decline.',
    categories: ['zone'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        source: z.enum(['swing_high', 'order_block', 'consolidation']).default('swing_high'),
        minTouches: z.number().int().min(1).max(50).default(1),
      })
      .strict()
      .default({}),
  },
  demand: {
    type: 'demand',
    label: 'Demand zone',
    description: 'Underlying zone where prior buying caused a sustained rise.',
    categories: ['zone'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        source: z.enum(['swing_low', 'order_block', 'consolidation']).default('swing_low'),
        minTouches: z.number().int().min(1).max(50).default(1),
      })
      .strict()
      .default({}),
  },
  rejection_candle: {
    type: 'rejection_candle',
    label: 'Rejection candle',
    description: 'A candle with a dominant wick in the rejection direction (pin bar).',
    categories: ['price_action'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        direction: z.enum(['bullish', 'bearish']).default('bullish'),
        minWickBodyRatio: z.number().positive().max(20).default(2),
      })
      .strict()
      .default({}),
  },
  engulfing_candle: {
    type: 'engulfing_candle',
    label: 'Engulfing candle',
    description: 'A candle whose body fully engulfs the previous candle in the reversal direction.',
    categories: ['price_action'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        minBodyRatio: z.number().min(0).max(10).optional(),
      })
      .strict()
      .default({}),
  },
  displacement: {
    type: 'displacement',
    label: 'Displacement',
    description: 'A strong impulsive move (multiple of ATR) indicating institutional intent.',
    categories: ['price_action'],
    defaultTimeframeRole: 'setup',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        atrPeriod: z.number().int().min(2).max(100).default(14),
        minAtrMultiple: z.number().positive().max(100).default(1.5),
      })
      .strict()
      .default({}),
  },
  rr_requirement: {
    type: 'rr_requirement',
    label: 'Risk:reward requirement',
    description: 'Setup must offer at least the configured R:R before it can pass.',
    categories: ['risk'],
    defaultTimeframeRole: 'entry',
    paramSchema: z
      .object({
        minRr: z.number().positive().max(100).default(2),
      })
      .strict()
      .default({}),
  },
  session_requirement: {
    type: 'session_requirement',
    label: 'Session requirement',
    description: 'Setup must form during (or outside) the configured trading sessions.',
    categories: ['time'],
    defaultTimeframeRole: 'any',
    paramSchema: z
      .object({
        sessions: z.array(z.enum(['asia', 'london', 'new_york', 'sydney'])).min(1).default(['asia', 'london', 'new_york', 'sydney']),
        mode: z.enum(['include', 'exclude']).default('include'),
        timezone: z.enum(['utc', 'exchange']).default('exchange'),
      })
      .strict()
      .default({}),
  },
  news_filter: {
    type: 'news_filter',
    label: 'News filter',
    description: 'Reject (or allow) setups near high-impact news within a time window.',
    categories: ['market_filter'],
    defaultTimeframeRole: 'any',
    paramSchema: z
      .object({
        maxImportance: z.enum(['low', 'medium', 'high']).default('high'),
        beforeMinutes: z.number().int().min(0).max(720).default(30),
        afterMinutes: z.number().int().min(0).max(720).default(30),
      })
      .strict()
      .default({}),
  },
  volatility_filter: {
    type: 'volatility_filter',
    label: 'Volatility filter',
    description: 'Setup must fall within a configured ATR/range volatility band.',
    categories: ['market_filter'],
    defaultTimeframeRole: 'any',
    paramSchema: z
      .object({
        metric: z.enum(['atr', 'body_range']).default('atr'),
        period: z.number().int().min(2).max(200).default(14),
        min: z.number().min(0).max(1e6).default(0),
        max: z.number().positive().optional(),
      })
      .strict()
      .default({})
      .superRefine((v, ctx) => {
        if (v.max !== undefined && v.max <= v.min) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: 'max must be greater than min' });
        }
      }),
  },
  spread_filter: {
    type: 'spread_filter',
    label: 'Spread filter',
    description: 'Reject setups when the current spread exceeds a threshold.',
    categories: ['market_filter'],
    defaultTimeframeRole: 'any',
    paramSchema: z
      .object({
        max: z.number().positive(),
        unit: z.enum(['pips', 'pct']).default('pips'),
      })
      .strict(),
  },
  htf_alignment: {
    type: 'htf_alignment',
    label: 'HTF alignment',
    description: 'Higher-timeframe bias/structure must align with the setup direction.',
    categories: ['structure'],
    defaultTimeframeRole: 'htf_bias',
    paramSchema: z
      .object({
        direction: direction.default('either'),
        source: z.enum(['trend', 'structure', 'bias']).default('structure'),
      })
      .strict()
      .default({}),
  },
};

export type ConditionType = keyof typeof CONDITION_TYPE_REGISTRY & string;

export function getConditionType(type: string): ConditionTypeDefinition | undefined {
  return CONDITION_TYPE_REGISTRY[type];
}

export function listConditionTypes(): ConditionTypeDefinition[] {
  return Object.values(CONDITION_TYPE_REGISTRY);
}

/** The `any` role is only meaningful for time-independent filters. */
export const CONDITION_TIMEFRAME_ROLES = ['htf_bias', 'setup', 'entry', 'any'] as const;
export type ConditionTimeframeRole = (typeof CONDITION_TIMEFRAME_ROLES)[number];

export const conditionTimeframeRoleSchema = z.enum(CONDITION_TIMEFRAME_ROLES);
export const conditionClassificationSchema = z.enum(CONDITION_CLASSIFICATIONS);

/** One condition row as stored on a strategy version. */
export const strategyConditionSchema = z
  .object({
    conditionType: z.string().min(1).max(64),
    classification: conditionClassificationSchema,
    timeframeRole: conditionTimeframeRoleSchema,
    params: z.record(z.string(), z.unknown()).default({}),
    description: z.string().trim().max(280).optional(),
    position: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .superRefine((cond, ctx) => {
    const def = getConditionType(cond.conditionType);
    if (!def) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditionType'],
        message: `Unknown condition type "${cond.conditionType}"`,
      });
      return;
    }
    const parsed = def.paramSchema.safeParse(cond.params);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params'],
        message: `Invalid params for condition "${def.type}": ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      });
    }
  });
export type StrategyCondition = z.infer<typeof strategyConditionSchema>;

/** A named rule group. Conditions inside a group are combined with `logic`;
 *  groups of a version are always combined with AND. M1 keeps groups flat
 *  (`parentGroupId` exists for future nesting without a schema migration). */
export const strategyRuleGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    logic: z.enum(['AND', 'OR']),
    position: z.number().int().min(0).max(10000).default(0),
    conditions: z.array(strategyConditionSchema).max(100).default([]),
    parentGroupId: z.string().uuid().optional(),
  })
  .strict();
export type StrategyRuleGroup = z.infer<typeof strategyRuleGroupSchema>;
