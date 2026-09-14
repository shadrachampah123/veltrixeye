import type { CandidateLevels, SetupDirection } from '@veltrixeye/contracts';

/**
 * M4 persisted trade levels (pure — no I/O, no clock).
 *
 * M3's `candidate` is LONG-convention (stop below entry, targets above —
 * "per-direction levels deferred to M4"). For a long setup the candidate is
 * stored as-is; for a short setup each leg is mirrored around the entry so
 * the stop sits above and the targets below, preserving the exact risk
 * distance. Mirroring is the only deterministic reading of "the same risk
 * profile, opposite side" and keeps `riskDistance` identical for both
 * directions.
 *
 * A null candidate (M3 found no valid candidate) persists as all-null
 * levels. A mirrored leg that would land on the wrong side or at a
 * non-positive price is dropped to null rather than stored inverted — the
 * setup stays traceable (entry is always kept) without fabricating levels.
 */
export interface DetectionLevels {
  entryPrice: number;
  stopLossPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
}

export function mirrorPrice(entryPrice: number, price: number): number {
  return 2 * entryPrice - price;
}

export function detectionLevels(
  candidate: CandidateLevels | null,
  direction: SetupDirection,
): DetectionLevels | null {
  if (!candidate) return null;
  const entry = candidate.entryPrice;
  if (!(entry > 0)) return null;

  if (direction === 'long') {
    return {
      entryPrice: entry,
      stopLossPrice: candidate.stopLossPrice > 0 ? candidate.stopLossPrice : null,
      tp1Price: candidate.tp1Price !== null && candidate.tp1Price > 0 ? candidate.tp1Price : null,
      tp2Price: candidate.tp2Price !== null && candidate.tp2Price > 0 ? candidate.tp2Price : null,
      tp3Price: candidate.tp3Price !== null && candidate.tp3Price > 0 ? candidate.tp3Price : null,
    };
  }

  const stop = mirrorPrice(entry, candidate.stopLossPrice);
  const mirrorTarget = (tp: number | null): number | null => {
    if (tp === null) return null;
    const m = mirrorPrice(entry, tp);
    return m > 0 && m < entry ? m : null;
  };
  return {
    entryPrice: entry,
    // A short stop must sit above the entry; anything else is degenerate.
    stopLossPrice: stop > entry ? stop : null,
    tp1Price: mirrorTarget(candidate.tp1Price),
    tp2Price: mirrorTarget(candidate.tp2Price),
    tp3Price: mirrorTarget(candidate.tp3Price),
  };
}
