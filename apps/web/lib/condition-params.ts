/**
 * UI metadata for condition parameters, used by the strategy editor to render
 * typed inputs. Validation itself is authoritative in
 * @veltrixeye/contracts (conditionTypeRegistry paramSchema) — this file only
 * describes how each parameter should be EDITED in the UI.
 */

export type ParamKind = 'select' | 'number' | 'boolean' | 'sessions';

export interface ParamDescriptor {
  key: string;
  label: string;
  kind: ParamKind;
  options?: string[];
  default?: number | string | boolean | string[];
  step?: number;
  min?: number;
  max?: number;
}

export const CONDITION_PARAM_DESCRIPTORS: Record<string, ParamDescriptor[]> = {
  liquidity_sweep: [
    { key: 'side', label: 'Side', kind: 'select', options: ['above', 'below'], default: 'above' },
    { key: 'lookbackCandles', label: 'Lookback (candles)', kind: 'number', default: 100, step: 10, min: 1, max: 1000 },
    { key: 'minWickRatio', label: 'Min wick ratio', kind: 'number', default: 0.3, step: 0.05, min: 0, max: 1 },
  ],
  choch: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
    { key: 'lookbackCandles', label: 'Lookback (candles)', kind: 'number', default: 200, step: 10, min: 1, max: 5000 },
    { key: 'requireDisplacement', label: 'Require displacement', kind: 'boolean', default: false },
  ],
  bos: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
    { key: 'lookbackCandles', label: 'Lookback (candles)', kind: 'number', default: 200, step: 10, min: 1, max: 5000 },
  ],
  break_retest: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
    { key: 'maxRetestCandles', label: 'Max retest candles', kind: 'number', default: 24, step: 1, min: 1, max: 100 },
    { key: 'retestTolerancePct', label: 'Retest tolerance (%)', kind: 'number', default: 0.1, step: 0.05, min: 0, max: 10 },
  ],
  order_block: [
    { key: 'kind', label: 'Kind', kind: 'select', options: ['bullish', 'bearish'], default: 'bullish' },
    { key: 'validation', label: 'Validation', kind: 'select', options: ['mitigation', 'break'], default: 'mitigation' },
    { key: 'maxAgeCandles', label: 'Max age (candles)', kind: 'number', default: 100, step: 10, min: 1, max: 500 },
  ],
  fvg: [
    { key: 'kind', label: 'Kind', kind: 'select', options: ['bullish', 'bearish'], default: 'bullish' },
    { key: 'requireMitigation', label: 'Require mitigation', kind: 'boolean', default: true },
  ],
  support: [
    { key: 'minTouches', label: 'Min touches', kind: 'number', default: 2, step: 1, min: 2, max: 50 },
    { key: 'lookbackCandles', label: 'Lookback (candles)', kind: 'number', default: 500, step: 50, min: 1, max: 5000 },
  ],
  resistance: [
    { key: 'minTouches', label: 'Min touches', kind: 'number', default: 2, step: 1, min: 2, max: 50 },
    { key: 'lookbackCandles', label: 'Lookback (candles)', kind: 'number', default: 500, step: 50, min: 1, max: 5000 },
  ],
  supply: [
    { key: 'source', label: 'Zone source', kind: 'select', options: ['swing_high', 'order_block', 'consolidation'], default: 'swing_high' },
    { key: 'minTouches', label: 'Min touches', kind: 'number', default: 1, step: 1, min: 1, max: 50 },
  ],
  demand: [
    { key: 'source', label: 'Zone source', kind: 'select', options: ['swing_low', 'order_block', 'consolidation'], default: 'swing_low' },
    { key: 'minTouches', label: 'Min touches', kind: 'number', default: 1, step: 1, min: 1, max: 50 },
  ],
  rejection_candle: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish'], default: 'bullish' },
    { key: 'minWickBodyRatio', label: 'Min wick/body ratio', kind: 'number', default: 2, step: 0.5, min: 0, max: 20 },
  ],
  engulfing_candle: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
  ],
  displacement: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
    { key: 'atrPeriod', label: 'ATR period', kind: 'number', default: 14, step: 1, min: 2, max: 100 },
    { key: 'minAtrMultiple', label: 'Min ATR multiple', kind: 'number', default: 1.5, step: 0.1, min: 0, max: 100 },
  ],
  rr_requirement: [{ key: 'minRr', label: 'Min R:R', kind: 'number', default: 2, step: 0.1, min: 0, max: 100 }],
  session_requirement: [
    { key: 'sessions', label: 'Sessions', kind: 'sessions', options: ['asia', 'london', 'new_york', 'sydney'], default: ['asia', 'london', 'new_york', 'sydney'] },
    { key: 'mode', label: 'Mode', kind: 'select', options: ['include', 'exclude'], default: 'include' },
    { key: 'timezone', label: 'Timezone', kind: 'select', options: ['utc', 'exchange'], default: 'exchange' },
  ],
  news_filter: [
    { key: 'maxImportance', label: 'Max importance', kind: 'select', options: ['low', 'medium', 'high'], default: 'high' },
    { key: 'beforeMinutes', label: 'Before news (min)', kind: 'number', default: 30, step: 5, min: 0, max: 720 },
    { key: 'afterMinutes', label: 'After news (min)', kind: 'number', default: 30, step: 5, min: 0, max: 720 },
  ],
  volatility_filter: [
    { key: 'metric', label: 'Metric', kind: 'select', options: ['atr', 'body_range'], default: 'atr' },
    { key: 'period', label: 'Period', kind: 'number', default: 14, step: 1, min: 2, max: 200 },
    { key: 'min', label: 'Min', kind: 'number', default: 0, step: 0.1, min: 0, max: 1e6 },
    { key: 'max', label: 'Max (optional)', kind: 'number', step: 0.1, min: 0, max: 1e6 },
  ],
  spread_filter: [
    { key: 'max', label: 'Max spread', kind: 'number', default: 2, step: 0.1, min: 0, max: 1e6 },
    { key: 'unit', label: 'Unit', kind: 'select', options: ['pips', 'pct'], default: 'pips' },
  ],
  htf_alignment: [
    { key: 'direction', label: 'Direction', kind: 'select', options: ['bullish', 'bearish', 'either'], default: 'either' },
    { key: 'source', label: 'Source', kind: 'select', options: ['trend', 'structure', 'bias'], default: 'structure' },
  ],
};

export function descriptorsFor(type: string): ParamDescriptor[] {
  return CONDITION_PARAM_DESCRIPTORS[type] ?? [];
}

/** Build a params object from defaults for a condition type. */
export function defaultParamsFor(type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of descriptorsFor(type)) {
    if (d.default !== undefined) out[d.key] = d.default;
  }
  return out;
}
