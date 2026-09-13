import { z } from 'zod';

/**
 * Per-strategy risk configuration (foundation — no execution logic yet).
 * All values are configurable per strategy version. The platform default
 * minimum risk:reward is 1:2, matching the product requirement.
 */

export const STOP_LOSS_METHODS = ['structure', 'fixed', 'atr'] as const;
export type StopLossMethod = (typeof STOP_LOSS_METHODS)[number];

export const STOP_LOSS_METHOD_LABELS: Record<StopLossMethod, string> = {
  structure: 'Beyond swing structure',
  fixed: 'Fixed distance (pips/%)',
  atr: 'ATR multiple',
};

export const TAKE_PROFIT_METHODS = ['rr', 'structure', 'manual'] as const;
export type TakeProfitMethod = (typeof TAKE_PROFIT_METHODS)[number];

export const TAKE_PROFIT_METHOD_LABELS: Record<TakeProfitMethod, string> = {
  rr: 'Risk:reward targets',
  structure: 'Structural targets',
  manual: 'Manual price levels',
};

export const BUFFER_UNITS = ['pips', 'pct'] as const;
export type BufferUnit = (typeof BUFFER_UNITS)[number];

export const DEFAULT_MIN_RR = 2;
export const DEFAULT_MIN_QUALITY_SCORE = 65;

export const riskConfigurationSchema = z
  .object({
    /** Minimum acceptable risk:reward (e.g. 2 means 1:2). Default 1:2. */
    minRr: z.number().positive().max(100).default(DEFAULT_MIN_RR),
    stopLossMethod: z.enum(STOP_LOSS_METHODS).default('structure'),
    /** Extra safety buffer added beyond the raw stop location. */
    stopLossBuffer: z.number().min(0).max(10000).default(1),
    stopLossBufferUnit: z.enum(BUFFER_UNITS).default('pips'),
    takeProfitMethod: z.enum(TAKE_PROFIT_METHODS).default('rr'),
    /** Partial take-profit targets expressed as R:R multiples (for 'rr'). */
    tp1Rr: z.number().positive().max(100).default(1),
    tp2Rr: z.number().positive().max(100).default(2),
    tp3Rr: z.number().positive().max(100).default(3),
    /** Minimum 0–100 setup-quality score for a setup to be alerted (0–100). */
    minQualityScore: z.number().int().min(0).max(100).default(DEFAULT_MIN_QUALITY_SCORE),
  })
  .strict()
  .superRefine((risk, ctx) => {
    if (risk.takeProfitMethod === 'rr') {
      if (!(risk.tp1Rr < risk.tp2Rr && risk.tp2Rr < risk.tp3Rr)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tp1Rr'],
          message: 'take-profit targets must increase: tp1Rr < tp2Rr < tp3Rr',
        });
      }
    }
  });
export type RiskConfiguration = z.infer<typeof riskConfigurationSchema>;

export type RiskConfigurationInput = z.input<typeof riskConfigurationSchema>;
