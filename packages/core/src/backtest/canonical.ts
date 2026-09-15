/**
 * Canonical config_hash computation for M6 Phase 2 backtests.
 *
 * M6.1 review requirement: BEFORE implementing the writer, explicitly pin
 * and document how config_hash is computed, so that identical logical
 * configurations always collapse onto the same run and irrelevant
 * representation differences (key ordering, missing defaults, whitespace)
 * never create duplicate logical runs.
 *
 * Pinned algorithm (m6-backtest-1):
 *
 *  1. Parse exitPolicy and costPolicy through their Zod schemas
 *     (`backtestExitPolicySchema`, `backtestCostPolicySchema`). This applies
 *     defaults (`stopLoss: 'level'`, `takeProfit: 'tp3'`, `maxHoldCandles: 100`,
 *     `sameCandleRule: 'stop_first'`, `entryTiming: 'signal_close'`,
 *     `feePerSide: 0`, `slippagePerSide: 0`, `spread: 0`) and rejects unknown
 *     keys, so `{}` and `{ stopLoss: 'level', takeProfit: 'tp3', ... }` become
 *     byte-identical after parsing.
 *
 *  2. Build the canonical object:
 *     `{ exitPolicy: <parsed>, costPolicy: <parsed> }`
 *     Only policies are hashed. The remaining idempotency dimensions
 *     (user_id, strategy_version_id, instrument_id, direction, engine_version,
 *     from_ms, to_ms) are enforced separately by the unique index
 *     `backtest_runs_idempotency_uniq`. Hashing only policies keeps the hash
 *     focused on the part where JSON key ordering could otherwise cause
 *     logical duplicates.
 *
 *  3. Canonicalize recursively: sort object keys alphabetically at every
 *     level, preserve array order (arrays are semantically ordered), and
 *     leave primitives unchanged. This eliminates key-ordering differences.
 *
 *  4. Stable stringify: `JSON.stringify(canonicalized)` with no whitespace
 *     or replacer. Because step 3 already sorted keys, the string is
 *     deterministic.
 *
 *  5. SHA-256 hex: `sha256(utf8(json))` → 64-char lowercase hex. This is
 *     `config_hash`. Format is validated before persistence against
 *     `/^[0-9a-f]{64}$/`.
 *
 * Why not hash the whole request?
 *  - Instrument symbol normalization (EURUSD vs eurusd) is handled by
 *    `CandleStore.resolveInstrument` → `instrument_id`, not by the hash.
 *  - Direction normalization (`both` default) is handled by Zod and stored as
 *    `direction` column.
 *  - Range bounds are stored as `from_ms`/`to_ms` integers.
 *  Including them in the hash would be redundant with the unique index and
 *  would not add safety, but hashing only policies makes the intent explicit
 *  and keeps the hash stable if we later add non-policy fields to the request.
 *
 * Determinism guarantees:
 *  - Same logical exit/cost policies → same hash, regardless of key order,
 *    whitespace, or whether defaults were explicitly provided.
 *  - Different logical policies → different hash (collision probability
 *    negligible for SHA-256).
 *  - No network, no clock, no randomness involved.
 */

import { createHash } from 'node:crypto';
import {
  backtestCostPolicySchema,
  backtestExitPolicySchema,
  type BacktestCostPolicy,
  type BacktestExitPolicy,
} from '@veltrixeye/contracts';

export const CONFIG_HASH_RE = /^[0-9a-f]{64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    // Preserve Date? Not expected in policies, but handle defensively.
    if (value instanceof Date) return value.toISOString();
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface ParsedPolicies {
  exitPolicy: BacktestExitPolicy;
  costPolicy: BacktestCostPolicy;
}

export interface ConfigHashResult extends ParsedPolicies {
  /** 64-char lowercase hex sha256 */
  hash: string;
  /** The exact JSON that was hashed (for debugging/audit, not persisted). */
  canonicalJson: string;
}

/**
 * Compute the canonical config_hash for a backtest request.
 * Throws Zod errors if policies are invalid (caller should map to 400).
 */
export function computeConfigHash(exitPolicyInput: unknown, costPolicyInput: unknown): ConfigHashResult {
  const exitPolicy = backtestExitPolicySchema.parse(exitPolicyInput ?? {});
  const costPolicy = backtestCostPolicySchema.parse(costPolicyInput ?? {});
  const canonical = { exitPolicy, costPolicy };
  const canonicalJson = stableStringify(canonical);
  const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (!CONFIG_HASH_RE.test(hash)) {
    // Defensive: sha256 hex must always match, but validate before persistence
    // as required by the M6.1 review.
    throw new Error(`computed config_hash has invalid format: ${hash}`);
  }
  return { hash, exitPolicy, costPolicy, canonicalJson };
}

/**
 * Validate a config_hash string before persistence.
 * Returns true if valid, false otherwise.
 */
export function isValidConfigHash(hash: string): boolean {
  return CONFIG_HASH_RE.test(hash);
}
