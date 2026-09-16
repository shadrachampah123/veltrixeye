import {
  normalizeTimeframe as normalizeTimeframeContract,
  TIMEFRAMES,
  TIMEFRAME_ALIASES,
  type Timeframe,
  type AssetClass,
  ASSET_CLASSES,
} from '@veltrixeye/contracts';

/**
 * Symbol & timeframe normalization (M7.5).
 *
 * Preserves the existing market-universe architecture: instruments are
 * identified by (assetClass, symbol) where symbol is UPPERCASE and matches
 * the platform's canonical rules. Provider-specific tickers (e.g.
 * TwelveData's "EUR/USD" vs platform "EURUSD") are normalized through the
 * existing symbol mapping layer — this file handles the platform side.
 */

export interface NormalizedSymbol {
  assetClass: AssetClass;
  symbol: string;
}

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._:-]*$/;
const MAX_SYMBOL_LEN = 32;

export function normalizeSymbol(input: { assetClass: string; symbol: string }): NormalizedSymbol | null {
  const assetClass = input.assetClass.toLowerCase() as AssetClass;
  if (!(ASSET_CLASSES as readonly string[]).includes(assetClass)) return null;
  const symbol = input.symbol.trim().toUpperCase();
  if (symbol.length === 0 || symbol.length > MAX_SYMBOL_LEN) return null;
  if (!SYMBOL_RE.test(symbol)) return null;
  return { assetClass, symbol };
}

export function normalizeTimeframe(input: string): Timeframe | null {
  const trimmed = input.trim();
  // First try contract's canonical parser (handles "1m", "60m", "4h", etc.)
  const fromContract = normalizeTimeframeContract(trimmed);
  if (fromContract) return fromContract;
  // Then try alias map for display variants like "4H", "1D"
  const aliased = TIMEFRAME_ALIASES[trimmed] ?? TIMEFRAME_ALIASES[trimmed.toUpperCase()] ?? null;
  if (aliased && (TIMEFRAMES as readonly string[]).includes(aliased)) {
    return aliased as Timeframe;
  }
  // Final fallback: upper/lower variations
  const lower = trimmed.toLowerCase();
  if ((TIMEFRAMES as readonly string[]).includes(lower)) return lower as Timeframe;
  const upper = trimmed.toUpperCase();
  // Special case: "1M" month vs "1m" minute — preserve case for month
  if (upper === '1M') {
    // Check if input was month-intended: original had uppercase M and no other hint
    // The contract already handles this, but we keep it explicit
    if (trimmed === '1M') return '1M' as Timeframe;
  }
  return null;
}

export function normalizeTimestamp(input: number): number | null {
  if (!Number.isInteger(input)) return null;
  if (input <= 0) return null;
  if (input > 9_999_999_999_999) return null; // beyond year 2286
  return input;
}

export interface NormalizedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export function normalizeCandle(input: {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}): NormalizedCandle | null {
  const time = normalizeTimestamp(input.time);
  if (time === null) return null;

  const open = normalizePrice(input.open);
  const high = normalizePrice(input.high);
  const low = normalizePrice(input.low);
  const close = normalizePrice(input.close);
  if (open === null || high === null || low === null || close === null) return null;

  // OHLC invariant: low ≤ open/close ≤ high
  if (!(low <= Math.min(open, close) && high >= Math.max(open, close))) return null;

  let volume: number | null = null;
  if (input.volume !== null && input.volume !== undefined) {
    if (typeof input.volume !== 'number' || !Number.isFinite(input.volume) || input.volume < 0) return null;
    volume = input.volume;
  }

  return { time, open, high, low, close, volume };
}

function normalizePrice(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  // Reject impossible prices (e.g., > 1e9 for most instruments, but allow high for BTC etc.)
  // We use a very permissive upper bound to avoid rejecting valid crypto prices.
  if (value > 1e9) return null;
  return value;
}

/**
 * Normalize a batch of candles: sort by time ascending, dedupe by time (last wins),
 * and validate each.
 * Returns null if any candle is invalid or if duplicate/out-of-order detected
 * beyond simple sorting (caller should decide).
 */
export function normalizeCandleBatch(
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number | null }[],
): { normalized: NormalizedCandle[]; hadDuplicates: boolean; hadOutOfOrder: boolean } | null {
  if (candles.length === 0) return { normalized: [], hadDuplicates: false, hadOutOfOrder: false };

  // Check if already sorted
  let hadOutOfOrder = false;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.time < candles[i - 1]!.time) {
      hadOutOfOrder = true;
      break;
    }
  }

  // Normalize each
  const normalized: NormalizedCandle[] = [];
  for (const c of candles) {
    const n = normalizeCandle(c);
    if (!n) return null;
    normalized.push(n);
  }

  // Sort ascending
  normalized.sort((a, b) => a.time - b.time);

  // Dedupe detection
  let hadDuplicates = false;
  const byTime = new Map<number, NormalizedCandle>();
  for (const c of normalized) {
    if (byTime.has(c.time)) hadDuplicates = true;
    byTime.set(c.time, c);
  }

  const deduped = [...byTime.values()].sort((a, b) => a.time - b.time);

  return { normalized: deduped, hadDuplicates, hadOutOfOrder };
}
