import type { StrategyVersionConfig } from '@veltrixeye/contracts';

export interface PublishValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Publish gate: a draft becomes immutable (published) only when its
 * configuration is complete. This is the single source of truth for what a
 * "publishable" strategy version contains.
 *
 * Rules:
 *  1. All three timeframe roles must be set (htf_bias, setup, entry).
 *  2. Market scope must be set (all, or an explicit instrument list).
 *  3. Risk configuration must be set.
 *  4. At least one rule group with at least one condition.
 *  5. At least one condition classified 'required' or 'confirmation'
 *     (a strategy must be able to actually PASS — optional/disqualifying
 *     alone can never produce a setup).
 */
export function validatePublishable(config: StrategyVersionConfig): PublishValidationResult {
  const errors: string[] = [];

  if (!config.timeframes) {
    errors.push('Timeframes are required: set the higher-timeframe bias, setup and entry timeframes.');
  }
  if (!config.marketScope) {
    errors.push('Market scope is required: choose "all markets" or specific instruments.');
  }
  if (!config.risk) {
    errors.push('Risk configuration is required (minimum R:R, stop-loss, take-profit, quality score).');
  }

  const conditions = config.ruleGroups.flatMap((g) => g.conditions);
  if (config.ruleGroups.length === 0) {
    errors.push('At least one rule group (stage) is required.');
  } else if (conditions.length === 0) {
    errors.push('At least one condition is required across all rule groups.');
  } else {
    const hasPassable = conditions.some(
      (c) => c.classification === 'required' || c.classification === 'confirmation',
    );
    if (!hasPassable) {
      errors.push('At least one condition must be classified as "required" or "confirmation".');
    }
  }

  return { ok: errors.length === 0, errors };
}
