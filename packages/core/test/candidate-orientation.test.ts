/**
 * Candidate-level direction orientation — regression tests
 * (`m3-deterministic-eval-3` follow-up to the per-direction structure stops).
 *
 * THE REPORTED PRODUCTION SYMPTOM. A published Gold (XAUUSD) version — 4H →
 * 1H → 15M, structure stop, `rr` targets with `tp1Rr: 1`, `tp3Rr: 3` — showed
 * its SHORT candidate as "TP1 equal to SL while achievable R:R reported 3" in
 * the evaluation workbench. It was not a coincidence and not a rendering bug:
 * `deriveCandidate` oriented only structure STOPS per direction (PR #92) and
 * left fixed/atr stops and every `rr` target in LONG convention, so a short
 * candidate's `tp1Price` was `entry + riskDistance × 1` — numerically exactly
 * the structure stop that sits ABOVE the entry (`entry + riskDistance`).
 * Fixed/atr short candidates were equally inconsistent: the stop sat below
 * the entry and the targets above it, i.e. the short panel showed a long-
 * shaped trade.
 *
 * THE FIX. Every leg of `deriveCandidate` is now oriented for the direction
 * it is derived for: long stops below the entry with targets above, short
 * stops above the entry with targets below.
 *
 * WHY THIS IS SAFE (and why it changes no setup, score, alert or replay):
 * `riskDistance` and `achievableRr` are direction-neutral and unchanged, the
 * `rr_requirement` handler compares the version's own `tpNRr` values, M5's
 * completeness check only reads whether the target legs are non-null, and
 * M4's `detectionLevels` orientation is IDEMPOTENT by design — a leg already
 * on its direction's side is kept, so the persisted setup levels are the
 * exact same numbers as before for both directions. The tests below pin each
 * of those claims.
 *
 * No database, no provider, no wall clock: everything is a pure function of
 * hand-built candles and a fixed anchor.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  riskConfigurationSchema,
  strategyVersionConfigSchema,
  type CandleDto,
  type CandidateLevels,
  type StrategyRuleGroup,
  type StrategyVersionConfig,
} from '@veltrixeye/contracts';
import { createEvaluationEngine, deriveCandidate, detectionLevels, atrWilder } from '../src/index.js';

const HOUR = 3_600_000;
/** Fixed anchor (2027-01-15T08:00:00Z). Every fixture candle closes at or before it. */
const AS_OF = 1_800_000_000_000;

function candle(time: number, open: number, high: number, low: number, close: number): CandleDto {
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close), 'fixture violates OHLC invariant');
  return { time, open, high, low, close, volume: null };
}

/** Series shapes (oldest first); the LAST candle closes exactly at AS_OF. */
function series(shapes: Array<[number, number, number, number]>): CandleDto[] {
  const n = shapes.length;
  return shapes.map(([o, h, l, c], i) => candle(AS_OF - (n - i) * HOUR, o, h, l, c));
}

/**
 * 1h structure fixture: pivots lows at 99.0 / 99.6 / 96.5 and a pivot high at
 * 102.0; the anchor (last) candle closes at 100.0. So the LONG structure stop
 * is 96.5 − buffer and the SHORT structure stop is 102.0 + buffer.
 */
const STRUCTURE_SHAPES: Array<[number, number, number, number]> = [
  [100.0, 100.5, 99.5, 100.0],
  [100.0, 100.5, 99.5, 100.0],
  [100.0, 100.5, 99.0, 99.2], // pivot low 99.0
  [99.2, 101.0, 99.1, 100.5],
  [100.5, 102.0, 100.4, 101.5], // pivot high 102.0
  [101.5, 101.8, 100.8, 101.0],
  [101.0, 101.2, 99.6, 99.8], // pivot low 99.6
  [99.8, 100.6, 99.7, 100.4],
  [100.4, 100.6, 96.5, 97.2], // pivot low 96.5
  [97.2, 100.4, 97.1, 100.2],
  [100.2, 100.4, 99.9, 100.1],
  [100.1, 100.3, 99.9, 100.0], // anchor close 100.0
];

/** 20 flat candles (high 101 / low 99, open=close=100): constant true range 2 ⇒ ATR(14) === 2. */
const FLAT_SHAPES: Array<[number, number, number, number]> = Array.from(
  { length: 20 },
  () => [100, 101, 99, 100] as [number, number, number, number],
);

const STRUCTURE = series(STRUCTURE_SHAPES);
const FLAT = series(FLAT_SHAPES);

/** Structure stop, `rr` targets — the reported production shape (tp1Rr 1, tp3Rr 3). */
const STRUCTURE_RR_RISK = riskConfigurationSchema.parse({
  minRr: 2,
  stopLossMethod: 'structure',
  stopLossBuffer: 0.5,
  stopLossBufferUnit: 'pct',
  takeProfitMethod: 'rr',
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
  minQualityScore: 65,
});

const FIXED_RR_RISK = riskConfigurationSchema.parse({
  stopLossMethod: 'fixed',
  stopLossBuffer: 1,
  stopLossBufferUnit: 'pct',
  takeProfitMethod: 'rr',
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
});

const ATR_RR_RISK = riskConfigurationSchema.parse({
  stopLossMethod: 'atr',
  stopLossBuffer: 1,
  stopLossBufferUnit: 'pct',
  takeProfitMethod: 'rr',
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
});

function cond(
  conditionType: string,
  classification: 'required' | 'optional' | 'confirmation' | 'disqualifying',
  timeframeRole: 'htf_bias' | 'setup' | 'entry' | 'any',
  params: Record<string, unknown> = {},
): StrategyRuleGroup['conditions'][number] {
  return { conditionType, classification, timeframeRole, params, position: 0 };
}

function group(name: string, logic: 'AND' | 'OR', conditions: StrategyRuleGroup['conditions']): StrategyRuleGroup {
  return { name, logic, position: 0, conditions };
}

function mkConfig(risk: StrategyVersionConfig['risk'], groups: StrategyRuleGroup[]): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'commodity', symbol: 'XAUUSD' }] },
    risk,
    ruleGroups: groups,
  });
}

const engine = createEvaluationEngine();

function evaluate(config: StrategyVersionConfig, candles: CandleDto[]) {
  return engine.evaluate({
    config,
    instrument: { assetClass: 'commodity', symbol: 'XAUUSD' },
    pipSize: 0.01,
    candles: { htf_bias: candles, setup: candles, entry: candles },
    asOfMs: AS_OF,
  });
}

// ---------------------------------------------------------------------------
// The reported symptom
// ---------------------------------------------------------------------------

describe('candidate direction orientation — the reported symptom', () => {
  test('a short candidate with tp1Rr 1 and a structure stop no longer reports TP1 === SL', () => {
    const short = deriveCandidate(STRUCTURE_RR_RISK, STRUCTURE, 0.01, 'short');
    assert.ok(short);
    // Structure stop: the pivot high 102.0 + 0.5% of the 100.0 entry = 102.5.
    assert.equal(short.entryPrice, 100);
    assert.equal(short.stopLossPrice, 102.5);
    assert.equal(short.riskDistance, 2.5);
    // Targets are on the SHORT side of the entry, at 1R/2R/3R — and TP1 can
    // never be the stop (`entry + 1 × riskDistance` was exactly the stop).
    assert.equal(short.tp1Price, 97.5);
    assert.equal(short.tp2Price, 95);
    assert.equal(short.tp3Price, 92.5);
    assert.notEqual(short.tp1Price, short.stopLossPrice);
    assert.ok(short.tp1Price! < short.entryPrice, 'TP1 must sit below a short entry');
    assert.ok(short.stopLossPrice > short.entryPrice, 'a short stop must sit above its entry');
    // achievableRr stays the version's pinned tp3Rr — direction-neutral, so the
    // "achievable R:R reported 3" reading was (and stays) correct.
    assert.equal(short.achievableRr, 3);
  });

  test('long candidates are untouched by the orientation fix', () => {
    const long = deriveCandidate(STRUCTURE_RR_RISK, STRUCTURE, 0.01, 'long');
    assert.ok(long);
    assert.equal(long.entryPrice, 100);
    assert.equal(long.stopLossPrice, 96); // pivot low 96.5 − 0.5% buffer
    assert.equal(long.riskDistance, 4);
    assert.equal(long.tp1Price, 104);
    assert.equal(long.tp2Price, 108);
    assert.equal(long.tp3Price, 112);
    assert.equal(long.achievableRr, 3);
    assert.equal(long.basis, 'structure stop at 96.5 (recent swing) minus buffer');
    // Omitting `direction` still means the long convention (backwards compatible).
    assert.deepEqual(deriveCandidate(STRUCTURE_RR_RISK, STRUCTURE, 0.01), long);
  });

  test('short fixed and atr stops sit above the entry, with targets below', () => {
    const fixedShort = deriveCandidate(FIXED_RR_RISK, FLAT, 0.01, 'short');
    assert.ok(fixedShort);
    assert.equal(fixedShort.entryPrice, 100);
    assert.equal(fixedShort.stopLossPrice, 101); // 1% of 100 above the entry
    assert.equal(fixedShort.riskDistance, 1);
    assert.equal(fixedShort.tp1Price, 99);
    assert.equal(fixedShort.tp2Price, 98);
    assert.equal(fixedShort.tp3Price, 97);
    assert.equal(fixedShort.basis, 'fixed stop 1pct above entry');

    // Constant true range 2 ⇒ ATR(14) = 2; +1% buffer ⇒ stop 100 + 2 + 1 = 103.
    assert.equal(atrWilder(FLAT, 14), 2);
    const atrShort = deriveCandidate(ATR_RR_RISK, FLAT, 0.01, 'short');
    assert.ok(atrShort);
    assert.equal(atrShort.stopLossPrice, 103);
    assert.equal(atrShort.riskDistance, 3);
    assert.equal(atrShort.tp1Price, 97);
    assert.equal(atrShort.tp2Price, 94);
    assert.equal(atrShort.tp3Price, 91);

    // The mirrored long legs are unchanged.
    const fixedLong = deriveCandidate(FIXED_RR_RISK, FLAT, 0.01, 'long');
    assert.ok(fixedLong);
    assert.equal(fixedLong.stopLossPrice, 99);
    assert.equal(fixedLong.tp1Price, 101);
    const atrLong = deriveCandidate(ATR_RR_RISK, FLAT, 0.01, 'long');
    assert.ok(atrLong);
    assert.equal(atrLong.stopLossPrice, 97);
    assert.equal(atrLong.tp1Price, 103);
  });

  test('the evaluation DTO carries the oriented short candidate too', () => {
    const config = mkConfig(STRUCTURE_RR_RISK, [
      // Bearish rejection on the anchor: open 100.1 → close 100.0 with a
      // 0.2 upper wick against a 0.1 body (ratio 2).
      group('short trigger', 'AND', [
        cond('rejection_candle', 'required', 'entry', { direction: 'bearish', minWickBodyRatio: 2 }),
        cond('rr_requirement', 'required', 'setup', { minRr: 2 }),
      ]),
    ]);
    const candles = series([
      ...STRUCTURE_SHAPES.slice(0, -1),
      [100.1, 100.3, 99.95, 100.0], // anchor: bearish rejection, close 100.0
    ]);
    const result = evaluate(config, candles);
    assert.equal(result.short.passed, true);
    const candidate = result.short.candidate;
    assert.ok(candidate);
    assert.equal(candidate.entryPrice, 100);
    assert.ok(candidate.stopLossPrice > candidate.entryPrice);
    assert.ok(candidate.tp1Price !== null && candidate.tp1Price < candidate.entryPrice);
    assert.notEqual(candidate.tp1Price, candidate.stopLossPrice);
    assert.equal(candidate.achievableRr, 3);

    // rr_requirement compares the version's own tp3Rr — orientation-independent:
    // raising minRr above tp3Rr fails the direction, lowering it passes again.
    const stricter = evaluate(mkConfig({ ...STRUCTURE_RR_RISK, minRr: 4 }, [
      group('short trigger', 'AND', [
        cond('rejection_candle', 'required', 'entry', { direction: 'bearish', minWickBodyRatio: 2 }),
        cond('rr_requirement', 'required', 'setup', { minRr: 4 }),
      ]),
    ]), candles);
    assert.equal(stricter.short.passed, false);
    assert.ok(stricter.short.failureReasons.some((r) => r.includes('short trigger')));
    const rrOutcome = stricter.short.groups
      .flatMap((g) => g.conditions)
      .find((c) => c.conditionType === 'rr_requirement');
    assert.equal(rrOutcome?.status, 'unsatisfied');
    // A stricter minRr cannot move the candidate legs: the levels are a
    // property of the risk config's stop/target methods, not of the gate.
    assert.deepEqual(stricter.short.candidate, candidate);
  });
});

// ---------------------------------------------------------------------------
// No downstream change: M4 orientation is idempotent
// ---------------------------------------------------------------------------

describe('candidate direction orientation — M4 keeps identical persisted levels', () => {
  test('legacy long-convention short legs and oriented short legs persist the same numbers', () => {
    // The shape the engine produced BEFORE the fix: stop below the entry,
    // targets above it (long convention) — mirrored by M4 at persistence.
    const legacyShort: CandidateLevels = {
      entryPrice: 100,
      stopLossPrice: 99,
      riskDistance: 1,
      tp1Price: 101,
      tp2Price: 102,
      tp3Price: 103,
      achievableRr: 3,
      basis: 'fixed stop 1pct from entry',
    };
    // The shape the engine produces AFTER the fix.
    const oriented = deriveCandidate(FIXED_RR_RISK, FLAT, 0.01, 'short');
    assert.ok(oriented);
    assert.equal(oriented.stopLossPrice, 101);

    const legacyLevels = detectionLevels(legacyShort, 'short');
    const orientedLevels = detectionLevels(oriented, 'short');
    assert.ok(legacyLevels && orientedLevels);
    assert.deepEqual(orientedLevels, legacyLevels);
    assert.deepEqual(orientedLevels, { entryPrice: 100, stopLossPrice: 101, tp1Price: 99, tp2Price: 98, tp3Price: 97 });
  });

  test('the reported structure shape persisted the same levels before and after', () => {
    // The pre-fix structure short candidate: stop 102.5 (already per-direction)
    // with TP1 = entry + 1 × riskDistance = the stop itself, TP2/TP3 above.
    const preFixShort: CandidateLevels = {
      entryPrice: 100,
      stopLossPrice: 102.5,
      riskDistance: 2.5,
      tp1Price: 102.5, // ← the reported "TP1 equal to SL"
      tp2Price: 105,
      tp3Price: 107.5,
      achievableRr: 3,
      basis: 'structure stop at 102 (recent swing) plus buffer',
    };
    const oriented = deriveCandidate(STRUCTURE_RR_RISK, STRUCTURE, 0.01, 'short');
    assert.ok(oriented);
    assert.deepEqual(detectionLevels(oriented, 'short'), detectionLevels(preFixShort, 'short'));
    assert.deepEqual(detectionLevels(oriented, 'short'), {
      entryPrice: 100,
      stopLossPrice: 102.5,
      tp1Price: 97.5,
      tp2Price: 95,
      tp3Price: 92.5,
    });
  });
});
