import type { Candle } from '@veltrixeye/contracts';

/**
 * Deterministically aggregate fine-grained candles into coarser buckets
 * (e.g. 1m → 3m). Buckets align to epoch boundaries
 * (bucket = floor(time / targetMs) * targetMs), so the same input always
 * produces the same output regardless of venue timezone or DST.
 *
 *  - open = first candle's open, close = last candle's close (time order)
 *  - high/low = extremes across the bucket
 *  - volume = sum when every member reports one, else null (never a
 *    partial sum masquerading as a total)
 *  - state = 'forming' if any member is forming, else 'closed'
 *
 * Input order does not matter (it is sorted); callers should still pass
 * ascending vendor output. Pure function — no I/O.
 */
export function resampleCandles(candles: readonly Candle[], sourceMs: number, factor: number): Candle[] {
  if (!Number.isInteger(sourceMs) || sourceMs <= 0) {
    throw new Error(`resampleCandles: sourceMs must be a positive integer (got ${sourceMs})`);
  }
  if (!Number.isInteger(factor) || factor <= 1) {
    throw new Error(`resampleCandles: factor must be an integer > 1 (got ${factor})`);
  }
  if (candles.length === 0) return [];
  const targetMs = sourceMs * factor;
  const sorted = [...candles].sort((a, b) => a.time - b.time);

  const out: Candle[] = [];
  let bucketStart = -1;
  let open = 0;
  let high = -Infinity;
  let low = Infinity;
  let close = 0;
  let volumeSum = 0;
  let volumeMissing = false;
  let forming = false;

  const flush = (): void => {
    if (bucketStart < 0) return;
    out.push({
      time: bucketStart,
      open,
      high,
      low,
      close,
      volume: volumeMissing ? null : volumeSum,
      state: forming ? 'forming' : 'closed',
    });
  };

  for (const c of sorted) {
    const bucket = Math.floor(c.time / targetMs) * targetMs;
    if (bucket !== bucketStart) {
      flush();
      bucketStart = bucket;
      open = c.open;
      high = c.high;
      low = c.low;
      close = c.close;
      volumeSum = 0;
      volumeMissing = false;
      forming = false;
    } else {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      close = c.close;
    }
    if (c.volume === null) {
      volumeMissing = true;
    } else {
      volumeSum += c.volume;
    }
    if (c.state === 'forming') forming = true;
  }
  flush();
  return out;
}
