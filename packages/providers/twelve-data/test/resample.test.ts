import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Candle } from '@veltrixeye/contracts';
import { resampleCandles } from '../src/resample.js';

function bar(time: number, open: number, high: number, low: number, close: number, volume: number | null): Candle {
  return { time, open, high, low, close, volume, state: 'closed' };
}

test('resample: 1m → 3m aggregates open/high/low/close/volume exactly', () => {
  const t0 = Date.UTC(2026, 8, 13, 0, 0, 0);
  const bars = [
    bar(t0, 100, 101, 99, 100.5, 10),
    bar(t0 + 60_000, 100.5, 102, 100, 101, 20),
    bar(t0 + 120_000, 101, 101.5, 98, 99, 30),
  ];
  const out = resampleCandles(bars, 60_000, 3);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { time: t0, open: 100, high: 102, low: 98, close: 99, volume: 60, state: 'closed' });
});

test('resample: buckets align to epoch boundaries regardless of first bar', () => {
  const t0 = Date.UTC(2026, 8, 13, 0, 1, 0); // starts mid-bucket
  const bars = [
    bar(t0, 1, 1, 1, 1, 1),
    bar(t0 + 60_000, 2, 2, 2, 2, 1),
    bar(t0 + 120_000, 3, 3, 3, 3, 1),
  ];
  const out = resampleCandles(bars, 60_000, 3);
  assert.equal(out.length, 2);
  // first two bars fall in the 00:00 bucket, third starts the 00:03 bucket
  assert.equal(out[0]!.time, Date.UTC(2026, 8, 13, 0, 0, 0));
  assert.equal(out[0]!.close, 2);
  assert.equal(out[1]!.time, Date.UTC(2026, 8, 13, 0, 3, 0));
  assert.equal(out[1]!.open, 3);
});

test('resample: null volume in ANY member yields null (never a partial sum)', () => {
  const t0 = Date.UTC(2026, 8, 13, 0, 0, 0);
  const out = resampleCandles(
    [bar(t0, 1, 1, 1, 1, 10), bar(t0 + 60_000, 1, 1, 1, 1, null), bar(t0 + 120_000, 1, 1, 1, 1, 30)],
    60_000,
    3,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.volume, null);
});

test('resample: input order does not matter; forming state propagates', () => {
  const t0 = Date.UTC(2026, 8, 13, 0, 0, 0);
  const shuffled = [
    bar(t0 + 120_000, 3, 3, 3, 3, 1),
    { ...bar(t0, 1, 1, 1, 1, 1), state: 'forming' as const },
    bar(t0 + 60_000, 2, 2, 2, 2, 1),
  ];
  const out = resampleCandles(shuffled, 60_000, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.open, 1);
  assert.equal(out[0]!.close, 3);
  assert.equal(out[0]!.state, 'forming');
});

test('resample: 1h → 12h and 1d → 3d factors', () => {
  const h0 = Date.UTC(2026, 8, 13, 0, 0, 0);
  const hours = Array.from({ length: 12 }, (_, i) => bar(h0 + i * 3_600_000, 1, 2, 0.5, 1.5, 5));
  const h = resampleCandles(hours, 3_600_000, 12);
  assert.equal(h.length, 1);
  assert.equal(h[0]!.time, h0);
  assert.equal(h[0]!.volume, 60);

  // align to an epoch 3-day boundary so the three days form one bucket
  const d0 = Math.floor(Date.UTC(2026, 8, 12, 0, 0, 0) / (3 * 86_400_000)) * (3 * 86_400_000);
  const days = [0, 1, 2].map((d) => bar(d0 + d * 86_400_000, 1, 1, 1, 1, null));
  const d = resampleCandles(days, 86_400_000, 3);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.volume, null);
});

test('resample: empty input yields empty output; bad args throw', () => {
  assert.deepEqual(resampleCandles([], 60_000, 3), []);
  assert.throws(() => resampleCandles([], 0, 3), /sourceMs/);
  assert.throws(() => resampleCandles([], 60_000, 1), /factor/);
});
