import { z } from 'zod';

/**
 * Canonical timeframe vocabulary.
 *
 * The strategy engine MUST operate on these canonical values only.
 * User input (e.g. "1D", "60m", "4H") is normalized into this vocabulary
 * before persistence. Adding a timeframe here is an additive change.
 */
export const TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

/** The role a timeframe plays inside a strategy. Roles are independent:
 *  a user may pick any combination (e.g. htf_bias=4h, setup=1h, entry=5m). */
export const TIMEFRAME_ROLES = ['htf_bias', 'setup', 'entry'] as const;
export type TimeframeRole = (typeof TIMEFRAME_ROLES)[number];

export const TIMEFRAME_ROLE_LABELS: Record<TimeframeRole, string> = {
  htf_bias: 'Higher-timeframe bias',
  setup: 'Setup timeframe',
  entry: 'Entry timeframe',
};

export const timeframeSchema = z.enum(TIMEFRAMES);
export const timeframeRoleSchema = z.enum(TIMEFRAME_ROLES);

/** A complete per-role timeframe assignment for a strategy version. */
export const strategyTimeframesSchema = z
  .object({
    htf_bias: timeframeSchema,
    setup: timeframeSchema,
    entry: timeframeSchema,
  })
  .strict();
export type StrategyTimeframes = z.infer<typeof strategyTimeframesSchema>;

/** Explicit duration (in minutes) of each canonical timeframe. */
const CANONICAL_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
  '1M': 43200, // the canonical MONTH timeframe
};

const MINUTES_BY_CANONICAL = new Map<string, Timeframe>(
  TIMEFRAMES.map((tf) => [`${CANONICAL_MINUTES[tf] ?? 0}min`, tf] as [string, Timeframe]),
);

/**
 * Parse free-form units to a duration in minutes.
 * For free-form input, 'm'/'M' both mean MINUTES (trading convention, e.g.
 * TradingView's "15M"); the month timeframe is only reachable via the
 * canonical value '1M'.
 */
function parseTimeframeMinutes(input: string): number | null {
  const match = /^(\d+)([mhdwM])$/i.exec(input.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const raw = match[2] ?? '';
  const unit = raw === 'm' || raw === 'M' ? 'm' : raw.toLowerCase();
  const unitMinutes = unit === 'm' ? 1 : unit === 'h' ? 60 : unit === 'd' ? 1440 : unit === 'w' ? 10080 : null;
  if (unitMinutes === null) return null;
  return num * unitMinutes;
}

/**
 * Normalize free-form timeframe input ("1D", "60m", "4h", "1m") to a
 * canonical timeframe. Returns `null` when the value is not representable.
 * This is the single place where display formats meet the domain.
 */
export function normalizeTimeframe(input: string): Timeframe | null {
  const minutes = parseTimeframeMinutes(input);
  if (minutes === null) return null;
  return MINUTES_BY_CANONICAL.get(`${minutes}min`) ?? null;
}

export function describeTimeframe(tf: Timeframe): string {
  return tf.toUpperCase();
}
