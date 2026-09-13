import { ProviderError } from '@veltrixeye/contracts';

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Convert a Twelve Data `datetime` value ("YYYY-MM-DD HH:mm:ss", or date-only
 * for daily bars) in the vendor-reported `exchangeTimezone` to epoch-ms (UTC).
 *
 * The vendor reports wall-clock times in the listing venue's zone
 * (meta.exchange_timezone, e.g. "America/New_York"); FX/crypto report UTC.
 * Conversion runs through Intl (two passes so DST boundaries resolve), so no
 * timezone database ships with this package. Throws ProviderError on
 * unreadable input — never guesses.
 */
export function twelveDateTimeToMs(datetime: string, exchangeTimezone: string | undefined): number {
  const match = DATETIME_RE.exec(datetime.trim());
  if (!match) {
    throw new ProviderError('unavailable', 'Market-data provider returned an unreadable timestamp');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? '0');
  const minute = Number(match[5] ?? '0');
  const second = Number(match[6] ?? '0');
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ProviderError('unavailable', 'Market-data provider returned an unreadable timestamp');
  }
  const zone = exchangeTimezone && exchangeTimezone !== '' ? exchangeTimezone : 'UTC';
  try {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    // Correct the UTC guess by the zone offset at that instant (twice, so a
    // DST transition between guess and truth still converges).
    const once = wallAsUtc - zoneOffsetMs(zone, wallAsUtc);
    const twice = wallAsUtc - zoneOffsetMs(zone, once);
    if (!Number.isFinite(twice)) {
      throw new ProviderError('unavailable', 'Market-data provider returned an unreadable timestamp');
    }
    return twice;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    // Intl throws RangeError on unknown zones — a vendor data problem, not ours.
    throw new ProviderError('unavailable', 'Market-data provider returned an unreadable timestamp', {
      cause: err,
    });
  }
}

/** Zone offset (ms) such that wallClock = utc + offset, at the given instant. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  // hour12:false can render midnight as "24".
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - utcMs;
}

/** Format epoch-ms (UTC) as a Twelve Data start_date/end_date ("YYYY-MM-DD HH:mm:ss"). */
export function formatTwelveDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
