/**
 * Fixed-scale decimal arithmetic for M8.2 risk calculations.
 *
 * Scale is 10 decimal places, stored as bigint. All monetary risk, position
 * size, RR and exposure math goes through this type so IEEE-754 rounding
 * cannot silently move a value across a safety limit.
 *
 * Rounding rules (explicit):
 *  - Position size is always ROUND_DOWN onto `quantityStep` (never increase risk).
 *  - Limit comparisons use the full 10-dp value (no rounding before compare).
 *  - Display money: ROUND_HALF_EVEN to 2 dp.
 *  - Display RR / percentages: ROUND_HALF_EVEN to 4 dp.
 *  - Display quantity / price: ROUND_HALF_EVEN to 8 dp.
 *
 * Overflow: any intermediate whose absolute scaled value exceeds 10^28
 * (18 integer digits + 10 fractional) is rejected as overflow. The engine
 * then fail-closes.
 */

export const DEC_SCALE = 10;
const SCALE = 10n ** BigInt(DEC_SCALE);
const MAX_ABS = 10n ** 28n;

export type RoundingMode = 'down' | 'half_even';

export class DecimalOverflowError extends Error {
  constructor(message = 'numeric overflow in risk calculation') {
    super(message);
    this.name = 'DecimalOverflowError';
  }
}

export class Dec {
  private constructor(readonly units: bigint) {
    if (abs(units) > MAX_ABS) throw new DecimalOverflowError();
  }

  static zero(): Dec {
    return new Dec(0n);
  }

  static fromInt(n: number | bigint): Dec {
    if (typeof n === 'number') {
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new TypeError('fromInt requires a finite integer');
      }
      n = BigInt(n);
    }
    return new Dec(n * SCALE);
  }

  /** Parse a finite number via a decimal string (avoids binary float residue). */
  static fromNumber(x: number): Dec | null {
    if (!Number.isFinite(x)) return null;
    if (Object.is(x, -0)) x = 0;
    // toFixed(DEC_SCALE) yields a plain decimal string without exponent.
    return Dec.fromString(x.toFixed(DEC_SCALE));
  }

  static fromString(raw: string): Dec | null {
    const s = raw.trim();
    if (s.length === 0) return null;
    const m = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(s);
    if (!m) return null;
    const sign = m[1] === '-' ? -1n : 1n;
    const whole = m[2] ?? '0';
    const frac = (m[3] ?? m[4] ?? '').slice(0, DEC_SCALE).padEnd(DEC_SCALE, '0');
    if (whole.length > 18) return null;
    try {
      return new Dec(sign * (BigInt(whole) * SCALE + BigInt(frac || '0')));
    } catch {
      return null;
    }
  }

  /** Postgres `numeric` arrives as a string. */
  static fromUnknown(value: unknown): Dec | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Dec) return value;
    if (typeof value === 'number') return Dec.fromNumber(value);
    if (typeof value === 'string') return Dec.fromString(value);
    if (typeof value === 'bigint') {
      try {
        return new Dec(value);
      } catch {
        return null;
      }
    }
    return null;
  }

  get isZero(): boolean {
    return this.units === 0n;
  }

  get isNegative(): boolean {
    return this.units < 0n;
  }

  get isPositive(): boolean {
    return this.units > 0n;
  }

  abs(): Dec {
    return this.units < 0n ? new Dec(-this.units) : this;
  }

  neg(): Dec {
    return new Dec(-this.units);
  }

  add(other: Dec): Dec {
    return new Dec(this.units + other.units);
  }

  sub(other: Dec): Dec {
    return new Dec(this.units - other.units);
  }

  /**
   * Multiply. Default ROUND_HALF_EVEN at scale.
   * Pass `down` to always truncate toward zero (used when reducing size).
   */
  mul(other: Dec, rounding: RoundingMode = 'half_even'): Dec {
    return new Dec(divRound(this.units * other.units, SCALE, rounding));
  }

  /** Divide. Fail (null) on division by zero. */
  div(other: Dec, rounding: RoundingMode = 'half_even'): Dec | null {
    if (other.units === 0n) return null;
    return new Dec(divRound(this.units * SCALE, other.units, rounding));
  }

  cmp(other: Dec): -1 | 0 | 1 {
    if (this.units < other.units) return -1;
    if (this.units > other.units) return 1;
    return 0;
  }

  eq(other: Dec): boolean {
    return this.units === other.units;
  }

  lt(other: Dec): boolean {
    return this.units < other.units;
  }

  lte(other: Dec): boolean {
    return this.units <= other.units;
  }

  gt(other: Dec): boolean {
    return this.units > other.units;
  }

  gte(other: Dec): boolean {
    return this.units >= other.units;
  }

  min(other: Dec): Dec {
    return this.units <= other.units ? this : other;
  }

  max(other: Dec): Dec {
    return this.units >= other.units ? this : other;
  }

  /**
   * Round DOWN (toward −∞ for negatives, toward 0 for the sizer which only
   * feeds non-negative quantities) onto a positive step.
   * Returns null if step is not positive.
   */
  floorToStep(step: Dec): Dec | null {
    if (!step.isPositive) return null;
    // n = floor(this / step) * step, with floor toward −∞.
    const q = divFloor(this.units, step.units);
    return new Dec(q * step.units);
  }

  /** Convert to number after rounding to `digits` (0–10) HALF_EVEN. */
  toNumber(digits = DEC_SCALE): number {
    const rounded = this.roundTo(digits, 'half_even');
    const neg = rounded.units < 0n;
    const u = abs(rounded.units);
    const whole = u / SCALE;
    const frac = u % SCALE;
    const fracStr = frac.toString().padStart(DEC_SCALE, '0');
    return Number(`${neg ? '-' : ''}${whole.toString()}.${fracStr}`);
  }

  toFixed(digits: number, rounding: RoundingMode = 'half_even'): string {
    const rounded = this.roundTo(digits, rounding);
    const neg = rounded.units < 0n ? '-' : '';
    const u = abs(rounded.units);
    const whole = (u / SCALE).toString();
    if (digits <= 0) return `${neg}${whole}`;
    const frac = (u % SCALE).toString().padStart(DEC_SCALE, '0').slice(0, digits);
    return `${neg}${whole}.${frac}`;
  }

  roundTo(digits: number, rounding: RoundingMode): Dec {
    const d = Math.max(0, Math.min(DEC_SCALE, Math.trunc(digits)));
    const factor = 10n ** BigInt(DEC_SCALE - d);
    const q = divRound(this.units, factor, rounding);
    return new Dec(q * factor);
  }
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Truncating division toward −∞. */
function divFloor(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new DecimalOverflowError('division by zero');
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  // JavaScript bigint division truncates toward 0. Adjust when signs differ.
  if ((n < 0n && d > 0n) || (n > 0n && d < 0n)) return q - 1n;
  return q;
}

function divRound(n: bigint, d: bigint, rounding: RoundingMode): bigint {
  if (d === 0n) throw new DecimalOverflowError('division by zero');
  if (rounding === 'down') {
    // Toward zero (used for non-negative position sizes).
    return n / d;
  }
  const sign = n < 0n !== d < 0n ? -1n : 1n;
  const an = abs(n);
  const ad = abs(d);
  const q = an / ad;
  const r = an % ad;
  if (r === 0n) return sign * q;
  const twice = r * 2n;
  if (twice > ad) return sign * (q + 1n);
  if (twice < ad) return sign * q;
  // Exact half: banker's rounding (to even).
  return sign * (q % 2n === 0n ? q : q + 1n);
}

export const DEC_ZERO = Dec.zero();
export const DEC_ONE = Dec.fromInt(1);
export const DEC_HUNDRED = Dec.fromInt(100);
