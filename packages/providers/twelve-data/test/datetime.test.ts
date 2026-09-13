import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isProviderError } from '@veltrixeye/contracts';
import { twelveDateTimeToMs, formatTwelveDate } from '../src/datetime.js';

test('datetime: UTC datetimes convert exactly', () => {
  assert.equal(twelveDateTimeToMs('2026-09-13 00:00:00', 'UTC'), Date.UTC(2026, 8, 13, 0, 0, 0));
  assert.equal(twelveDateTimeToMs('2020-02-10 09:30:00', undefined), Date.UTC(2020, 1, 10, 9, 30, 0));
  assert.equal(twelveDateTimeToMs('2026-09-13 00:00:00', ''), Date.UTC(2026, 8, 13, 0, 0, 0));
});

test('datetime: America/New_York offsets honor DST (EDT vs EST)', () => {
  // September: EDT (UTC-4)
  assert.equal(twelveDateTimeToMs('2026-09-13 09:30:00', 'America/New_York'), Date.UTC(2026, 8, 13, 13, 30, 0));
  // January: EST (UTC-5)
  assert.equal(twelveDateTimeToMs('2026-01-13 09:30:00', 'America/New_York'), Date.UTC(2026, 0, 13, 14, 30, 0));
});

test('datetime: non-hour offsets and date-only values', () => {
  // Asia/Kathmandu is UTC+5:45
  assert.equal(twelveDateTimeToMs('2026-09-13 12:00:00', 'Asia/Kathmandu'), Date.UTC(2026, 8, 13, 6, 15, 0));
  // daily bars may arrive date-only
  assert.equal(twelveDateTimeToMs('2026-09-13', 'America/New_York'), Date.UTC(2026, 8, 13, 4, 0, 0));
});

test('datetime: invalid input throws ProviderError (never guesses)', () => {
  for (const bad of ['not a date', '2026-13-45 99:99:99', '', '2026-09-13 24:00:00']) {
    assert.throws(() => twelveDateTimeToMs(bad, 'UTC'), (e: unknown) => isProviderError(e) && e.kind === 'unavailable', bad);
  }
  assert.throws(
    () => twelveDateTimeToMs('2026-09-13 00:00:00', 'Mars/Olympus'),
    (e: unknown) => isProviderError(e) && e.kind === 'unavailable',
  );
});

test('datetime: request dates format as vendor YYYY-MM-DD HH:mm:ss (UTC)', () => {
  assert.equal(formatTwelveDate(Date.UTC(2026, 8, 13, 5, 6, 7)), '2026-09-13 05:06:07');
  assert.equal(formatTwelveDate(0), '1970-01-01 00:00:00');
});
