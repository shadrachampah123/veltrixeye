import { z } from 'zod';
import { ASSET_CLASSES, assetClassSchema, type AssetClass } from './assets.js';
import {
  EXECUTION_MODES,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
  type OrderStatus,
  type OrderType,
} from './execution.js';

/**
 * M10 Gate 9 — the `veltrixeye.mt5-bridge` protocol contract (v1.0.0).
 *
 * This module is the *offline protocol contract* only: identity/version rules,
 * strict wire schemas, closed vocabularies and pure validation rules. It
 * deliberately contains:
 *
 *  - no network, socket, HTTP, terminal or process access;
 *  - no MT5/broker/bridge/demo connectivity and no vendor implementation;
 *  - no credential values, no secret-manager integration and no credential
 *    resolution (only non-secret binding *references* are described, §31);
 *  - no database schema and no migration (uncertainty is expressed with the
 *    existing reconciliation vocabulary, §21);
 *  - no execution authority: nothing here authorizes a trade (§38).
 *
 * Unknown provider data is never coerced into a known protocol state: every
 * closed vocabulary in this file maps an unrecognized value to an explicitly
 * uncertain outcome instead (`statusUncertain` / `outcome: 'uncertain'`).
 */

/* -------------------------------------------------------------------------- */
/* §2 Protocol identity and version                                            */
/* -------------------------------------------------------------------------- */

export const MT5_BRIDGE_PROTOCOL_ID = 'veltrixeye.mt5-bridge';
export const MT5_BRIDGE_PROTOCOL_VERSION = '1.0.0';

/** Strict semantic version (no leading zeros, no pre-release/build metadata). */
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_SEMVER_COMPONENT = 1_000_000;

export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a version token; anything that is not exact `MAJOR.MINOR.PATCH` is null. */
export function parseProtocolVersion(raw: unknown): ProtocolVersion | null {
  if (typeof raw !== 'string') return null;
  const match = SEMVER_PATTERN.exec(raw);
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (
    !Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)
    || major > MAX_SEMVER_COMPONENT || minor > MAX_SEMVER_COMPONENT || patch > MAX_SEMVER_COMPONENT
  ) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Closed compatibility decision vocabulary (§2, §34).
 *
 * Gate 9 pins exactly one released contract (`1.0.0`), so the handshake
 * accepts the same MAJOR **and** MINOR and treats PATCH as free
 * ("bug-compatible corrections may use PATCH where contract semantics are
 * unchanged"). A higher MAJOR is never reinterpreted, a lower MAJOR is never
 * assumed to be a subset, and an unrecognised MINOR is refused rather than
 * guessed — the strict schemas would otherwise silently drop the newer fields.
 */
export const PROTOCOL_COMPATIBILITY_DECISIONS = [
  'compatible',
  'rejected_higher_major',
  'rejected_lower_major',
  'rejected_minor_ahead',
  'rejected_minor_behind',
  'rejected_invalid_version',
] as const;
export type ProtocolCompatibilityDecision = (typeof PROTOCOL_COMPATIBILITY_DECISIONS)[number];

export interface ProtocolCompatibility {
  decision: ProtocolCompatibilityDecision;
  /** True only for `compatible`: the only state that may precede a mutation. */
  accepted: boolean;
  /** True when the peer claims a contract newer than this implementation. */
  higherMajor: boolean;
  proposed: ProtocolVersion | null;
  supported: ProtocolVersion;
}

export function evaluateProtocolCompatibility(
  proposed: unknown,
  supportedVersion: string = MT5_BRIDGE_PROTOCOL_VERSION,
): ProtocolCompatibility {
  const supported = parseProtocolVersion(supportedVersion) ?? { major: 1, minor: 0, patch: 0 };
  const version = parseProtocolVersion(proposed);
  const base = { proposed: version, supported, higherMajor: false } as const;
  if (!version) {
    return { ...base, decision: 'rejected_invalid_version', accepted: false, higherMajor: false };
  }
  if (version.major > supported.major) {
    return { ...base, decision: 'rejected_higher_major', accepted: false, higherMajor: true };
  }
  if (version.major < supported.major) {
    return { ...base, decision: 'rejected_lower_major', accepted: false, higherMajor: false };
  }
  if (version.minor > supported.minor) {
    return { ...base, decision: 'rejected_minor_ahead', accepted: false, higherMajor: false };
  }
  if (version.minor < supported.minor) {
    return { ...base, decision: 'rejected_minor_behind', accepted: false, higherMajor: false };
  }
  return { ...base, decision: 'compatible', accepted: true, higherMajor: false };
}

/** Convenience predicate used by every entry point that must not guess. */
export function isProtocolVersionAccepted(proposed: unknown): boolean {
  return evaluateProtocolCompatibility(proposed).accepted;
}

const protocolVersionSchema = z
  .string()
  .max(32)
  .refine((value) => parseProtocolVersion(value) !== null, 'protocolVersion must be exact MAJOR.MINOR.PATCH');

/* -------------------------------------------------------------------------- */
/* §3 Bounded primitives — every protocol string/number is bounded            */
/* -------------------------------------------------------------------------- */

export const MAX_EPOCH_MS = 9_999_999_999_999;
export const MAX_PROTOCOL_PRICE = 1_000_000_000_000;
export const MAX_PROTOCOL_VOLUME = 1_000_000;
export const MAX_PROTOCOL_PRICE_DIGITS = 12;

/** Bounded machine token (ids, refs, reason codes). No free text, no newlines. */
const tokenSchema = (min: number, max: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{${Math.max(0, min - 1)},${max - 1}}$`));

/** Bounded ISO-8601 timestamp (validated, never coerced). */
const isoTimestampSchema = z.string().datetime({ offset: true }).max(64);

const epochMillisSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_EPOCH_MS);

const priceSchema = z.number().finite().positive().max(MAX_PROTOCOL_PRICE);
const volumeSchema = z.number().finite().positive().max(MAX_PROTOCOL_VOLUME);

/** Provider-side instrument symbol (broker spelling, bounded, opaque). */
export const bridgeProviderSymbolSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/);
/** Platform-side canonical symbol — uppercase, per the shared market model. */
export const bridgeCanonicalSymbolSchema = z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,31}$/);

/* -------------------------------------------------------------------------- */
/* §11 Client order identity                                                   */
/*                                                                             */
/* `ve-<24 lowercase hex>` is the durable identity; `ve-<20 hex>-rN` is the   */
/* approved retry form. Validation is pure and deterministic so it can run    */
/* BEFORE any provider call (B2).                                              */
/* -------------------------------------------------------------------------- */

export const CLIENT_ORDER_ID_PREFIX = 've-';
const CLIENT_ORDER_HASH_HEX = 24;
const CLIENT_ORDER_RETRY_HASH_HEX = 20;
const CLIENT_ORDER_RETRY_MAX_DIGITS = 9;

const CLIENT_ORDER_ID_INITIAL = new RegExp(`^${CLIENT_ORDER_ID_PREFIX}[0-9a-f]{${CLIENT_ORDER_HASH_HEX}}$`);
const CLIENT_ORDER_ID_RETRY = new RegExp(
  `^${CLIENT_ORDER_ID_PREFIX}([0-9a-f]{${CLIENT_ORDER_RETRY_HASH_HEX}})-r([1-9][0-9]{0,${CLIENT_ORDER_RETRY_MAX_DIGITS - 1}})$`,
);

export const bridgeClientOrderIdSchema = z
  .string()
  .max(64)
  .refine((value) => validateBridgeClientOrderId(value).ok, 'clientOrderId is not a VeltrixEye durable order identity');

export const CLIENT_ORDER_ID_FAILURE_CODES = [
  'ok',
  'client_order_id_missing',
  'client_order_id_not_a_string',
  'client_order_id_too_long',
  'client_order_id_prefix_invalid',
  'client_order_id_hash_invalid',
  'client_order_id_retry_form_invalid',
] as const;
export type ClientOrderIdFailureCode = (typeof CLIENT_ORDER_ID_FAILURE_CODES)[number];

export interface ClientOrderIdDecision {
  ok: boolean;
  code: ClientOrderIdFailureCode;
  /** Present when `ok`; the retry counter of the `-rN` form, else null. */
  retry: number | null;
  /** Present when `ok`; the lowercase hex identity core. */
  hash: string | null;
}

/** Deterministic client-order-id validation (B2). Never throws, never coerces. */
export function validateBridgeClientOrderId(raw: unknown): ClientOrderIdDecision {
  const fail = (code: ClientOrderIdFailureCode): ClientOrderIdDecision => ({ ok: false, code, retry: null, hash: null });
  if (raw === undefined || raw === null) return fail('client_order_id_missing');
  if (typeof raw !== 'string') return fail('client_order_id_not_a_string');
  if (raw.length > 64) return fail('client_order_id_too_long');
  if (!raw.startsWith(CLIENT_ORDER_ID_PREFIX)) return fail('client_order_id_prefix_invalid');
  if (CLIENT_ORDER_ID_INITIAL.test(raw)) {
    return { ok: true, code: 'ok', retry: null, hash: raw.slice(CLIENT_ORDER_ID_PREFIX.length) };
  }
  const retryMatch = CLIENT_ORDER_ID_RETRY.exec(raw);
  if (retryMatch) {
    const retry = Number(retryMatch[2]);
    if (Number.isSafeInteger(retry) && retry > 0) {
      return { ok: true, code: 'ok', retry, hash: retryMatch[1] ?? null };
    }
  }
  // A `-r` shaped value that is not the approved retry form gets its own code:
  // callers can tell "not ours" apart from "one of ours, but malformed".
  if (raw.slice(CLIENT_ORDER_ID_PREFIX.length).includes('-r')) return fail('client_order_id_retry_form_invalid');
  return fail('client_order_id_hash_invalid');
}

/** True only for the two accepted durable forms (used by the retry rule below). */
export function isVeltrixClientOrderId(raw: unknown): boolean {
  return validateBridgeClientOrderId(raw).ok;
}

/**
 * Retry derivation contract: `ve-<20 hex>-rN`. The retry counter is part of the
 * durable identity, so a retry is a *new identity with a recorded lineage* —
 * it is never a silent reuse of the initial id. (Reservation/persistence is
 * Gate 9 Step 5; only the derivation contract is pinned here.)
 */
export function deriveRetryClientOrderId(initialClientOrderId: string, retry: number): string {
  const decision = validateBridgeClientOrderId(initialClientOrderId);
  if (!decision.ok || decision.hash === null) {
    throw new BridgeProtocolViolation('client_order_id_hash_invalid', 'retry derivation requires a valid durable clientOrderId');
  }
  if (!Number.isSafeInteger(retry) || retry < 1 || retry > 999_999_999) {
    throw new BridgeProtocolViolation('client_order_id_retry_form_invalid', 'retry number must be a positive bounded decimal');
  }
  return `${CLIENT_ORDER_ID_PREFIX}${decision.hash.slice(0, CLIENT_ORDER_RETRY_HASH_HEX)}-r${retry}`;
}

/* -------------------------------------------------------------------------- */
/* §4 Account / environment binding                                            */
/* -------------------------------------------------------------------------- */

export const bridgeExecutionEnvironmentSchema = z.enum(EXECUTION_MODES);

/**
 * The only environment the bridge protocol may bind to while this milestone
 * stands. `paper` is the internal simulator (not a bridge target) and `live`
 * is prohibited outright (§33) — a correctly configured transport does not make
 * a live account acceptable.
 */
export const MT5_BRIDGE_ACCEPTED_ENVIRONMENTS: readonly ('paper' | 'demo' | 'live')[] = ['demo'];
export const MT5_BRIDGE_PROHIBITED_ENVIRONMENTS: readonly ('paper' | 'demo' | 'live')[] = ['live'];

export function isBridgeEnvironmentAccepted(environment: unknown): boolean {
  return (
    typeof environment === 'string'
    && (MT5_BRIDGE_ACCEPTED_ENVIRONMENTS as readonly string[]).includes(environment)
  );
}

/**
 * Execution identity: every mutation-related operation is bound to an account,
 * a broker/server identity where applicable, an explicit environment and the
 * protocol identity/version. A mismatch must fail closed (§4).
 */
export const bridgeAccountBindingSchema = z
  .object({
    protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
    protocolVersion: protocolVersionSchema,
    /** Platform-side account reference. Never a login credential (§31). */
    accountRef: tokenSchema(1, 128),
    broker: tokenSchema(1, 128).nullable(),
    server: tokenSchema(1, 128).nullable(),
    environment: bridgeExecutionEnvironmentSchema,
  })
  .strict();
export type BridgeAccountBinding = z.infer<typeof bridgeAccountBindingSchema>;

/** Deterministic identity/environment binding check used before any mutation. */
export function validateBridgeAccountBinding(
  binding: unknown,
  expected: { accountRef: string; broker?: string | null; server?: string | null; environment?: string },
): { ok: boolean; code: BridgeViolationCode } {
  const parsed = bridgeAccountBindingSchema.safeParse(binding);
  if (!parsed.success) return { ok: false, code: 'binding_malformed' };
  const row = parsed.data;
  if (!isProtocolVersionAccepted(row.protocolVersion)) return { ok: false, code: 'protocol_version_unsupported' };
  if (!isBridgeEnvironmentAccepted(row.environment)) {
    return { ok: false, code: row.environment === 'live' ? 'live_environment_prohibited' : 'environment_unsupported' };
  }
  if (row.accountRef !== expected.accountRef) return { ok: false, code: 'account_identity_mismatch' };
  if (expected.broker !== undefined && (row.broker ?? null) !== (expected.broker ?? null)) {
    return { ok: false, code: 'broker_identity_mismatch' };
  }
  if (expected.server !== undefined && (row.server ?? null) !== (expected.server ?? null)) {
    return { ok: false, code: 'server_identity_mismatch' };
  }
  return { ok: true, code: 'ok' };
}

/* -------------------------------------------------------------------------- */
/* §6 Attestation contract (declared only — no resolver in Gate 9)             */
/* -------------------------------------------------------------------------- */

/**
 * Attestation carries identity, never secrets. Both the attestation login
 * credential and the broker credential must resolve through the *same*
 * approved secret-manager binding; Gate 9 only pins that equality rule and
 * does not integrate a secret manager (§6, §31).
 */
export const bridgeCredentialBindingSchema = z
  .object({
    /** Non-secret binding reference name (e.g. an env/manager key name). */
    attestationCredentialRef: tokenSchema(1, 128),
    brokerCredentialRef: tokenSchema(1, 128),
    /** Explicit: no external secret manager is wired at Gate 9. */
    secretManagerIntegrated: z.literal(false),
  })
  .strict()
  .refine((value) => value.attestationCredentialRef === value.brokerCredentialRef, {
    message: 'attestation and broker credentials must share one approved binding',
    path: ['brokerCredentialRef'],
  });
export type BridgeCredentialBinding = z.infer<typeof bridgeCredentialBindingSchema>;

export const bridgeAttestationSchema = z
  .object({
    accountRef: tokenSchema(1, 128),
    broker: tokenSchema(1, 128).nullable(),
    server: tokenSchema(1, 128).nullable(),
    environment: bridgeExecutionEnvironmentSchema,
    attestedAt: isoTimestampSchema,
    /** sha-256 hex of the attested identity material — never the material itself. */
    identityFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    credentialBinding: bridgeCredentialBindingSchema,
  })
  .strict();
export type BridgeAttestation = z.infer<typeof bridgeAttestationSchema>;

/* -------------------------------------------------------------------------- */
/* §7 / §26 Transport health + the single readiness interpretation             */
/* -------------------------------------------------------------------------- */

export const PROVIDER_HEALTH_STATES_STRICT = ['healthy', 'degraded', 'unavailable', 'disabled'] as const;

/**
 * Closed readiness-decision vocabulary. `core`'s resolver is the ONLY producer,
 * so the health path and the execution path cannot drift (R7.4.4).
 */
export const TRANSPORT_READINESS_CODES = [
  'ready',
  'health_missing',
  'health_not_an_object',
  'health_malformed',
  'state_uncertain',
  'not_configured',
  'not_authenticated',
  'not_connected',
  'not_available',
  'not_healthy',
] as const;
export type TransportReadinessCode = (typeof TRANSPORT_READINESS_CODES)[number];

/** The readiness conditions a transport/adapter health record must state. */
export const TRANSPORT_READINESS_CONDITIONS = [
  'configured',
  'authenticated',
  'connected',
  'available',
  'healthy',
] as const;
export type TransportReadinessCondition = (typeof TRANSPORT_READINESS_CONDITIONS)[number];

/**
 * The wire contract for transport health. Booleans are plain `z.boolean()` on
 * purpose: a truthy string, a `1`, or a missing field is a validation failure
 * here — and a validation failure is never readiness (§7).
 */
export const bridgeTransportHealthSchema = z
  .object({
    configured: z.boolean(),
    authenticated: z.boolean(),
    connected: z.boolean(),
    available: z.boolean(),
    healthy: z.boolean(),
    state: z.enum(['unknown', 'ready', 'not_ready', 'uncertain']),
    checkedAt: isoTimestampSchema,
    reason: tokenSchema(1, 64).nullable().optional(),
  })
  .strict();
export type BridgeTransportHealth = z.infer<typeof bridgeTransportHealthSchema>;

/** The projection both the health path and the execution path publish. */
export const bridgeReadinessDecisionSchema = z
  .object({
    ready: z.boolean(),
    code: z.enum(TRANSPORT_READINESS_CODES),
    /** Conditions that were explicitly `true`; a non-`true` value never appears. */
    satisfied: z.array(z.enum(TRANSPORT_READINESS_CONDITIONS)),
    evaluatedAt: isoTimestampSchema,
  })
  .strict()
  .refine((value) => value.ready === (value.code === 'ready'), {
    message: 'only the `ready` code may authorize the transport',
  });
export type BridgeReadinessDecision = z.infer<typeof bridgeReadinessDecisionSchema>;

/** The one definition of "explicitly true" used by every readiness consumer. */
export function isExplicitTrue(value: unknown): value is true {
  return value === true;
}

export type BridgeHealthFlags = Record<TransportReadinessCondition, boolean>;

const NO_HEALTH_FLAGS: BridgeHealthFlags = Object.freeze({
  configured: false, authenticated: false, connected: false, available: false, healthy: false,
});

/**
 * Reads a health record's conditions as strict booleans. A truthy value, a
 * provider-specific string, a nested object or a missing field all read as
 * `false` — they are never upgraded into readiness (§7).
 */
export function readBridgeHealthFlags(health: unknown): BridgeHealthFlags {
  if (typeof health !== 'object' || health === null || Array.isArray(health)) return { ...NO_HEALTH_FLAGS };
  const row = health as Record<string, unknown>;
  return {
    configured: isExplicitTrue(row.configured),
    authenticated: isExplicitTrue(row.authenticated),
    connected: isExplicitTrue(row.connected),
    available: isExplicitTrue(row.available),
    healthy: isExplicitTrue(row.healthy),
  };
}

/** Which conditions each condition presupposes (§7). Availability is not a label. */
const READINESS_DEPENDENCIES: Partial<Record<TransportReadinessCondition, readonly TransportReadinessCondition[]>> = {
  authenticated: ['configured'],
  connected: ['configured', 'authenticated'],
  available: ['configured', 'authenticated', 'connected'],
  healthy: ['configured', 'available'],
};

/**
 * The authoritative readiness resolver (§26). The health path and the
 * execution path call this same function, so they cannot drift: readiness is
 * only ever the explicit boolean `true` of every condition the record's own
 * contract declares.
 */
export function resolveBridgeReadiness(
  health: unknown,
  required: readonly TransportReadinessCondition[] = TRANSPORT_READINESS_CONDITIONS,
  now: () => Date = () => new Date(),
): BridgeReadinessDecision {
  const build = (ready: boolean, code: TransportReadinessCode, satisfied: readonly TransportReadinessCondition[]): BridgeReadinessDecision =>
    ({ ready, code, satisfied: [...satisfied], evaluatedAt: now().toISOString() });
  if (health === undefined || health === null) return build(false, 'health_missing', []);
  if (typeof health !== 'object' || Array.isArray(health)) return build(false, 'health_not_an_object', []);
  const row = health as Record<string, unknown>;
  for (const condition of required) {
    if (typeof row[condition] !== 'boolean') return build(false, 'health_malformed', []);
  }
  // An explicitly uncertain/unknown health state is not a readable `false`:
  // it is unknown, and unknown prevents execution (§7, §38).
  if (row.state === 'uncertain' || row.state === 'unknown') return build(false, 'state_uncertain', []);
  const flags = readBridgeHealthFlags(health);
  const satisfied = required.filter((condition) => flags[condition]);
  const failing = required.find((condition) => !flags[condition]);
  if (failing) return build(false, `not_${failing}` as TransportReadinessCode, satisfied);
  // §7: the conditions form a dependency chain, not a set of independent
  // labels. A record may not assert a required condition while it explicitly
  // states `false` for one that condition depends on — otherwise a narrower
  // profile (reconciliation's `available + healthy`, for instance) could be
  // satisfied by a transport that admits it is not connected or not
  // authenticated. Only EXPLICITLY stated flags participate, so a record that
  // does not declare a dependency is unaffected.
  for (const condition of required) {
    for (const dependency of READINESS_DEPENDENCIES[condition] ?? []) {
      if (row[dependency] === false) return build(false, `not_${dependency}` as TransportReadinessCode, satisfied);
    }
  }
  return build(true, 'ready', satisfied);
}

/* -------------------------------------------------------------------------- */
/* §8 Quotes — bounded market data with two-sided freshness                  */
/* -------------------------------------------------------------------------- */

export const MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS = 5_000;
export const MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS = 15_000;

export const bridgeQuoteSchema = z
  .object({
    symbol: bridgeProviderSymbolSchema,
    bid: priceSchema,
    ask: priceSchema,
    /** Provider quote timestamp in epoch milliseconds. */
    timestampMs: epochMillisSchema,
  })
  .strict();
export type BridgeQuote = z.infer<typeof bridgeQuoteSchema>;

export const QUOTE_FRESHNESS_CODES = [
  'fresh',
  'quote_missing',
  'quote_malformed',
  'quote_timestamp_invalid',
  'quote_clock_unavailable',
  'quote_spread_inverted',
  'quote_stale',
  'quote_future_beyond_clock_skew',
] as const;
export type QuoteFreshnessCode = (typeof QUOTE_FRESHNESS_CODES)[number];

export interface QuoteFreshnessDecision {
  fresh: boolean;
  code: QuoteFreshnessCode;
  /** `nowMs − timestampMs`; negative inside the tolerated skew window. */
  ageMs: number | null;
  /** Forward drift in ms when the quote claims a future time, else 0. */
  forwardSkewMs: number;
  maxAgeMs: number;
  clockSkewMs: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Two-sided freshness (§8, B6): too old ⇒ stale; materially in the future ⇒
 * invalid. Only a bounded skew window (default 5000 ms) tolerates forward
 * drift, and a tolerated future quote is evaluated as age 0 rather than being
 * allowed to imply "infinitely fresh".
 */
export function evaluateQuoteFreshness(args: {
  quote: unknown;
  nowMs: unknown;
  maxAgeMs?: number;
  clockSkewMs?: number;
}): QuoteFreshnessDecision {
  const maxAgeMs = args.maxAgeMs ?? MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS;
  const clockSkewMs = args.clockSkewMs ?? MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS;
  const invalid = (code: QuoteFreshnessCode): QuoteFreshnessDecision => ({
    fresh: false,
    code,
    ageMs: null,
    forwardSkewMs: 0,
    maxAgeMs,
    clockSkewMs,
  });
  if (
    !isFiniteNumber(maxAgeMs) || maxAgeMs < 0 || !isFiniteNumber(clockSkewMs) || clockSkewMs < 0
    || !isFiniteNumber(args.nowMs) || !Number.isSafeInteger(args.nowMs)
  ) {
    return invalid('quote_clock_unavailable');
  }
  if (args.quote === undefined || args.quote === null) return invalid('quote_missing');
  if (typeof args.quote !== 'object' || Array.isArray(args.quote)) return invalid('quote_malformed');
  const row = args.quote as { bid?: unknown; ask?: unknown; timestampMs?: unknown; symbol?: unknown };
  if (row.timestampMs === undefined || row.timestampMs === null) return invalid('quote_timestamp_invalid');
  if (!isFiniteNumber(row.timestampMs) || !Number.isSafeInteger(row.timestampMs)
    || row.timestampMs < 1 || row.timestampMs > MAX_EPOCH_MS) {
    return invalid('quote_timestamp_invalid');
  }
  const bid = row.bid;
  const ask = row.ask;
  if (
    !isFiniteNumber(bid) || !isFiniteNumber(ask)
    || !(bid > 0) || !(ask > 0)
    || bid > MAX_PROTOCOL_PRICE || ask > MAX_PROTOCOL_PRICE
  ) {
    return invalid('quote_malformed');
  }
  if (ask < bid) return invalid('quote_spread_inverted');
  const ageMs = args.nowMs - row.timestampMs;
  if (ageMs < -clockSkewMs) {
    return {
      fresh: false,
      code: 'quote_future_beyond_clock_skew',
      ageMs,
      forwardSkewMs: -ageMs,
      maxAgeMs,
      clockSkewMs,
    };
  }
  const effectiveAgeMs = Math.max(0, ageMs);
  if (effectiveAgeMs > maxAgeMs) {
    return { fresh: false, code: 'quote_stale', ageMs, forwardSkewMs: Math.max(0, -ageMs), maxAgeMs, clockSkewMs };
  }
  return { fresh: true, code: 'fresh', ageMs: effectiveAgeMs, forwardSkewMs: Math.max(0, -ageMs), maxAgeMs, clockSkewMs };
}

/* -------------------------------------------------------------------------- */
/* §9 Instrument / symbol contract                                             */
/* -------------------------------------------------------------------------- */

export const bridgeInstrumentContractSchema = z
  .object({
    assetClass: assetClassSchema,
    canonicalSymbol: bridgeCanonicalSymbolSchema,
    providerSymbol: bridgeProviderSymbolSchema,
    contractSize: volumeSchema,
    tickSize: priceSchema,
    priceDigits: z.number().int().min(0).max(MAX_PROTOCOL_PRICE_DIGITS),
    minVolume: volumeSchema,
    maxVolume: volumeSchema,
    volumeStep: volumeSchema,
    orderTypes: z.array(z.enum(ORDER_TYPES)).min(1).max(ORDER_TYPES.length),
    tradingStatus: z.enum(['open', 'closed', 'disabled', 'unknown']),
    quote: bridgeQuoteSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxVolume < value.minVolume) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxVolume'], message: 'maxVolume must be >= minVolume' });
    }
    if (value.volumeStep > value.maxVolume) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['volumeStep'], message: 'volumeStep must not exceed maxVolume' });
    }
  });
export type BridgeInstrumentContract = z.infer<typeof bridgeInstrumentContractSchema>;

export const INSTRUMENT_CONTRACT_CODES = [
  'valid',
  'instrument_missing',
  'instrument_malformed',
  'contract_size_invalid',
  'tick_size_invalid',
  'price_digits_invalid',
  'volume_min_invalid',
  'volume_max_invalid',
  'volume_range_inverted',
  'volume_step_invalid',
  'order_types_invalid',
  'trading_status_invalid',
  'symbol_mismatch',
] as const;
export type InstrumentContractCode = (typeof INSTRUMENT_CONTRACT_CODES)[number];

export interface InstrumentContractDecision {
  ok: boolean;
  code: InstrumentContractCode;
  contract: BridgeInstrumentContract | null;
}

/**
 * Deterministic instrument-contract validation (§9, B7). Every field is checked
 * explicitly instead of being trusted: zero/negative/NaN/Infinity/overflow
 * `contractSize`, `tickSize` or `volumeStep`, out-of-range digits and inverted
 * volume ranges all fail closed. A provider instrument that cannot be
 * validated is never usable as execution input.
 */
export function validateInstrumentContract(
  raw: unknown,
  expected: { canonicalSymbol?: string; assetClass?: AssetClass; providerSymbol?: string } = {},
): InstrumentContractDecision {
  const fail = (code: InstrumentContractCode): InstrumentContractDecision => ({ ok: false, code, contract: null });
  if (raw === undefined || raw === null) return fail('instrument_missing');
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('instrument_malformed');
  const row = raw as Record<string, unknown>;
  const badNumber = (value: unknown, cap: number) => !isFiniteNumber(value) || !(value > 0) || value > cap;
  if (badNumber(row.contractSize, MAX_PROTOCOL_VOLUME)) return fail('contract_size_invalid');
  if (badNumber(row.tickSize, MAX_PROTOCOL_PRICE)) return fail('tick_size_invalid');
  if (
    !isFiniteNumber(row.priceDigits) || !Number.isInteger(row.priceDigits)
    || (row.priceDigits as number) < 0 || (row.priceDigits as number) > MAX_PROTOCOL_PRICE_DIGITS
  ) {
    return fail('price_digits_invalid');
  }
  if (badNumber(row.minVolume, MAX_PROTOCOL_VOLUME)) return fail('volume_min_invalid');
  if (badNumber(row.maxVolume, MAX_PROTOCOL_VOLUME)) return fail('volume_max_invalid');
  if ((row.maxVolume as number) < (row.minVolume as number)) return fail('volume_range_inverted');
  if (badNumber(row.volumeStep, MAX_PROTOCOL_VOLUME)) return fail('volume_step_invalid');
  if (
    !Array.isArray(row.orderTypes) || row.orderTypes.length === 0
    || row.orderTypes.length > ORDER_TYPES.length
    || row.orderTypes.some((type: unknown) => !(ORDER_TYPES as readonly string[]).includes(type as OrderType))
  ) {
    return fail('order_types_invalid');
  }
  if (row.tradingStatus !== 'open' && row.tradingStatus !== 'closed' && row.tradingStatus !== 'disabled' && row.tradingStatus !== 'unknown') {
    return fail('trading_status_invalid');
  }
  if (typeof row.canonicalSymbol !== 'string' || typeof row.providerSymbol !== 'string') return fail('instrument_malformed');
  if (expected.canonicalSymbol !== undefined && row.canonicalSymbol !== expected.canonicalSymbol) return fail('symbol_mismatch');
  if (expected.providerSymbol !== undefined && row.providerSymbol !== expected.providerSymbol) return fail('symbol_mismatch');
  if (expected.assetClass !== undefined && row.assetClass !== expected.assetClass) return fail('symbol_mismatch');
  if (
    row.assetClass !== undefined && row.assetClass !== null
    && !(ASSET_CLASSES as readonly string[]).includes(row.assetClass as string)
  ) {
    return fail('instrument_malformed');
  }
  const parsed = bridgeInstrumentContractSchema.safeParse(row);
  return parsed.success
    ? { ok: true, code: 'valid', contract: parsed.data }
    : { ok: false, code: 'instrument_malformed', contract: null };
}

/** Tolerance for float representation noise when counting volume steps. */
export const VOLUME_STEP_TOLERANCE = 1e-8;

export const VOLUME_RULE_CODES = [
  'valid',
  'volume_missing',
  'volume_not_finite',
  'volume_not_positive',
  'volume_above_maximum',
  'volume_below_minimum',
  'volume_step_invalid',
  'volume_not_on_step',
] as const;
export type VolumeRuleCode = (typeof VOLUME_RULE_CODES)[number];

/**
 * Volume versus instrument contract (§9, B7): range AND step alignment.
 * A zero/invalid step is itself a failure — it must never divide into a
 * permissive "infinite steps" comparison that silently accepts any size.
 */
export function validateVolumeAgainstInstrument(args: {
  volume: unknown;
  contract: Pick<BridgeInstrumentContract, 'minVolume' | 'maxVolume' | 'volumeStep'> | null | undefined;
}): { ok: boolean; code: VolumeRuleCode } {
  const { volume, contract } = args;
  if (volume === undefined || volume === null) return { ok: false, code: 'volume_missing' };
  if (!isFiniteNumber(volume)) return { ok: false, code: 'volume_not_finite' };
  if (!(volume > 0)) return { ok: false, code: 'volume_not_positive' };
  if (volume > MAX_PROTOCOL_VOLUME) return { ok: false, code: 'volume_above_maximum' };
  if (!contract) return { ok: false, code: 'volume_step_invalid' };
  const step = contract.volumeStep;
  if (!isFiniteNumber(step) || !(step > 0)) return { ok: false, code: 'volume_step_invalid' };
  if (!isFiniteNumber(contract.maxVolume) || !(contract.maxVolume > 0)) return { ok: false, code: 'volume_above_maximum' };
  if (volume - contract.maxVolume > VOLUME_STEP_TOLERANCE * step) return { ok: false, code: 'volume_above_maximum' };
  if (!isFiniteNumber(contract.minVolume) || !(contract.minVolume > 0)) return { ok: false, code: 'volume_below_minimum' };
  if (contract.minVolume - volume > VOLUME_STEP_TOLERANCE * step) return { ok: false, code: 'volume_below_minimum' };
  const steps = (volume - contract.minVolume) / step;
  if (!Number.isFinite(steps)) return { ok: false, code: 'volume_step_invalid' };
  const rounded = Math.round(steps);
  if (rounded < 0) return { ok: false, code: 'volume_below_minimum' };
  if (Math.abs(steps - rounded) > VOLUME_STEP_TOLERANCE) return { ok: false, code: 'volume_not_on_step' };
  return { ok: true, code: 'valid' };
}

/* -------------------------------------------------------------------------- */
/* §10 Prices (bounded contract; V16 limit/stop rules stay external)          */
/* -------------------------------------------------------------------------- */

export const bridgePriceSchema = priceSchema;

/**
 * Instrument-compatibility of a price: finite, positive and representable at
 * the instrument's digits/tick size. The approved V16 limit/stop *relational*
 * rules are not restated here — that rule text is not part of Gate 9's
 * in-repo authority, so this contract only pins the bounded, mechanical part.
 */
export function isPriceCompatibleWithInstrument(
  price: unknown,
  contract: Pick<BridgeInstrumentContract, 'tickSize' | 'priceDigits'> | null | undefined,
): boolean {
  if (!isFiniteNumber(price) || !(price > 0) || price > MAX_PROTOCOL_PRICE) return false;
  if (!contract) return false;
  const { tickSize, priceDigits } = contract;
  if (!isFiniteNumber(tickSize) || !(tickSize > 0)) return false;
  if (!isFiniteNumber(priceDigits) || !Number.isInteger(priceDigits) || priceDigits < 0) return false;
  const ticks = price / tickSize;
  if (!Number.isFinite(ticks)) return false;
  if (Math.abs(ticks - Math.round(ticks)) > VOLUME_STEP_TOLERANCE) return false;
  const quantum = 10 ** priceDigits;
  const scaled = price * quantum;
  return Number.isFinite(scaled) && Math.abs(scaled - Math.round(scaled)) <= 1e-6;
}

/* -------------------------------------------------------------------------- */
/* §5 Handshake                                                                */
/* -------------------------------------------------------------------------- */

/** Closed capability vocabulary — an unknown capability fails, it is not ignored. */
export const MT5_BRIDGE_CAPABILITIES = [
  'order_submit',
  'order_cancel',
  'order_modify',
  'position_close',
  'quote_snapshot',
  'reconciliation_lookup',
  'client_order_id_echo',
] as const;
export type BridgeCapability = (typeof MT5_BRIDGE_CAPABILITIES)[number];

export const bridgeCapabilitySchema = z.enum(MT5_BRIDGE_CAPABILITIES);

export const BRIDGE_HANDSHAKE_CODES = [
  'accepted',
  'handshake_malformed',
  'protocol_identity_mismatch',
  'protocol_version_unsupported',
  'protocol_higher_major_rejected',
  'capability_unsupported',
  'environment_unsupported',
  'live_environment_prohibited',
  'account_identity_mismatch',
  'attestation_required',
  'attestation_mismatch',
] as const;
export type BridgeHandshakeCode = (typeof BRIDGE_HANDSHAKE_CODES)[number];

export const bridgeHandshakeRequestSchema = z
  .object({
    protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
    protocolVersion: protocolVersionSchema,
    requestedCapabilities: z.array(bridgeCapabilitySchema).max(MT5_BRIDGE_CAPABILITIES.length).default([]),
    accountBinding: bridgeAccountBindingSchema,
    /** Attestation is optional at the contract level; enforcement is Step 6. */
    attestation: bridgeAttestationSchema.nullable().default(null),
    /** Readiness snapshot the peer observed. Never a mutation receipt (§5). */
    transportReadiness: bridgeReadinessDecisionSchema.nullable().default(null),
  })
  .strict();
export type BridgeHandshakeRequest = z.infer<typeof bridgeHandshakeRequestSchema>;

export const bridgeHandshakeResultSchema = z
  .object({
    protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
    protocolVersion: protocolVersionSchema,
    supportedCapabilities: z.array(bridgeCapabilitySchema).max(MT5_BRIDGE_CAPABILITIES.length),
    accountBinding: bridgeAccountBindingSchema,
    decision: z.enum(BRIDGE_HANDSHAKE_CODES),
    /** A handshake is never proof of a mutation: no ticket/order field exists. */
    attestedAt: isoTimestampSchema,
  })
  .strict();
export type BridgeHandshakeResult = z.infer<typeof bridgeHandshakeResultSchema>;

export interface BridgeHandshakeDecision {
  ok: boolean;
  code: BridgeHandshakeCode;
  capabilities: readonly BridgeCapability[];
}

/**
 * Pure handshake evaluation (§5). Order of checks is fixed and short-circuiting:
 * shape → protocol identity → version → capabilities → environment/binding →
 * attestation identity. A handshake never reports success for a mutation.
 */
export function evaluateBridgeHandshake(
  raw: unknown,
  expected: {
    accountRef: string;
    broker?: string | null;
    server?: string | null;
    supportedCapabilities?: readonly BridgeCapability[];
  },
): BridgeHandshakeDecision {
  const none: BridgeHandshakeDecision = { ok: false, code: 'handshake_malformed', capabilities: [] };
  const parsed = bridgeHandshakeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // An unusable attestation is reported as an attestation failure, not as a
    // generic handshake error: the distinction matters because "the account
    // could not be attested" must never be retried as "just fix the envelope".
    // Everything else in the message still has to be strict — only the
    // attestation subtree is inspected again.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const attested = (raw as Record<string, unknown>).attestation;
      if (attested !== null && attested !== undefined) {
        // Everything EXCEPT the attestation must be well formed; if it is, the
        // only reason the strict parse failed is the attestation subtree.
        const { attestation: _attested, ...restRaw } = raw as Record<string, unknown>;
        const rest = bridgeHandshakeRequestSchema.omit({ attestation: true }).safeParse(restRaw);
        if (rest.success) return { ...none, code: 'attestation_mismatch' };
      }
    }
    return none;
  }
  const row = parsed.data;
  if (row.protocolId !== MT5_BRIDGE_PROTOCOL_ID) return { ...none, code: 'protocol_identity_mismatch' };
  const compatibility = evaluateProtocolCompatibility(row.protocolVersion);
  if (!compatibility.accepted) {
    return { ...none, code: compatibility.higherMajor ? 'protocol_higher_major_rejected' : 'protocol_version_unsupported' };
  }
  const supported = new Set<BridgeCapability>(expected.supportedCapabilities ?? MT5_BRIDGE_CAPABILITIES);
  for (const capability of row.requestedCapabilities) {
    if (!supported.has(capability)) return { ...none, code: 'capability_unsupported' };
  }
  if (!isBridgeEnvironmentAccepted(row.accountBinding.environment)) {
    return {
      ...none,
      code: row.accountBinding.environment === 'live' ? 'live_environment_prohibited' : 'environment_unsupported',
    };
  }
  if (row.accountBinding.accountRef !== expected.accountRef) return { ...none, code: 'account_identity_mismatch' };
  if (expected.broker !== undefined && (row.accountBinding.broker ?? null) !== (expected.broker ?? null)) {
    return { ...none, code: 'account_identity_mismatch' };
  }
  if (expected.server !== undefined && (row.accountBinding.server ?? null) !== (expected.server ?? null)) {
    return { ...none, code: 'account_identity_mismatch' };
  }
  if (row.attestation) {
    const attested = bridgeAttestationSchema.safeParse(row.attestation);
    if (!attested.success) return { ...none, code: 'attestation_mismatch' };
    if (
      attested.data.accountRef !== row.accountBinding.accountRef
      || (attested.data.broker ?? null) !== (row.accountBinding.broker ?? null)
      || (attested.data.server ?? null) !== (row.accountBinding.server ?? null)
      || attested.data.environment !== row.accountBinding.environment
    ) {
      return { ...none, code: 'attestation_mismatch' };
    }
  }
  return { ok: true, code: 'accepted', capabilities: [...row.requestedCapabilities] };
}

/* -------------------------------------------------------------------------- */
/* §12 / §13–§17 Mutations                                                     */
/* -------------------------------------------------------------------------- */

export const BRIDGE_MUTATION_KINDS = ['submit', 'cancel', 'modify', 'close'] as const;
export type BridgeMutationKind = (typeof BRIDGE_MUTATION_KINDS)[number];

/** Durable mutation identity. The 64-hex form is the platform's sha-256 key. */
export const bridgeIdempotencyKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Reservation states the protocol distinguishes (§12). Only the vocabulary is
 * pinned by Gate 9 Step 1/2: durable reservation, restart survival and
 * uncertainty resolution are Step 5/8 and are NOT implemented here.
 */
export const BRIDGE_RESERVATION_STATES = [
  'reserved',
  'known_completed',
  'known_rejected',
  'uncertain',
] as const;
export type BridgeReservationState = (typeof BRIDGE_RESERVATION_STATES)[number];

export const bridgeReservationSchema = z
  .object({
    mutation: z.enum(BRIDGE_MUTATION_KINDS),
    idempotencyKey: bridgeIdempotencyKeySchema,
    clientOrderId: bridgeClientOrderIdSchema.nullable(),
    state: z.enum(BRIDGE_RESERVATION_STATES),
    /** An uncertain reservation is never silently retryable as a new mutation. */
    requiresReconciliation: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'uncertain' && value.requiresReconciliation !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiresReconciliation'], message: 'uncertain reservations require reconciliation' });
    }
    if (value.state === 'known_completed' && value.requiresReconciliation === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiresReconciliation'], message: 'completed reservations do not require reconciliation' });
    }
  });
export type BridgeReservation = z.infer<typeof bridgeReservationSchema>;

const mutationEnvelope = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
      protocolVersion: protocolVersionSchema,
      accountBinding: bridgeAccountBindingSchema,
      idempotencyKey: bridgeIdempotencyKeySchema,
      /** Durable VeltrixEye identity: validated before any provider call. */
      clientOrderId: bridgeClientOrderIdSchema,
      ...shape,
    })
    .strict();

export const bridgeSubmitOrderSchema = mutationEnvelope({
  symbol: bridgeCanonicalSymbolSchema,
  side: z.enum(ORDER_SIDES),
  orderType: z.enum(ORDER_TYPES),
  volume: volumeSchema,
  price: bridgePriceSchema.nullable(),
  stopLoss: bridgePriceSchema,
  takeProfit: bridgePriceSchema,
}).superRefine((value, ctx) => {
  if (value.orderType !== 'market' && value.price === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'limit/stop orders require an explicit price' });
  }
  if (value.orderType === 'market' && value.price !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'market orders must not carry a price' });
  }
});
export type BridgeSubmitOrder = z.infer<typeof bridgeSubmitOrderSchema>;

/** Cancel/modify/close identify the intended order by durable identity (§15–§19). */
export const bridgeOrderTicketSchema = tokenSchema(1, 128);

export const bridgeCancelOrderSchema = mutationEnvelope({
  providerTicket: bridgeOrderTicketSchema,
}).strict();

export const bridgeModifyOrderSchema = mutationEnvelope({
  providerTicket: bridgeOrderTicketSchema,
  symbol: bridgeCanonicalSymbolSchema,
  stopLoss: bridgePriceSchema.nullable(),
  takeProfit: bridgePriceSchema.nullable(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.stopLoss === null && value.takeProfit === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopLoss'], message: 'a modify must change at least one permitted price field' });
    }
  });
export type BridgeModifyOrder = z.infer<typeof bridgeModifyOrderSchema>;

export const bridgeClosePositionSchema = z
  .object({
    protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
    protocolVersion: protocolVersionSchema,
    accountBinding: bridgeAccountBindingSchema,
    idempotencyKey: bridgeIdempotencyKeySchema,
    providerTicket: bridgeOrderTicketSchema,
    clientOrderId: bridgeClientOrderIdSchema.nullable(),
  })
  .strict();
export type BridgeClosePosition = z.infer<typeof bridgeClosePositionSchema>;

/* -------------------------------------------------------------------------- */
/* §18 Provider response normalization + §27 deterministic market closure      */
/* -------------------------------------------------------------------------- */

/**
 * The closed provider-status vocabulary. Matching is EXACT: a case variant
 * (`FILLED`), an empty string, a number or an unknown token is NOT folded into
 * a known state — §18 requires unsupported values to stay unknown, and Gate 9
 * has no vendor status documentation (§30 item 6) that would license widening
 * this table.
 */
export const PROVIDER_ORDER_STATUS_VOCABULARY: Readonly<Record<string, OrderStatus>> = Object.freeze({
  requested: 'submitted',
  placed: 'accepted',
  accepted: 'accepted',
  partial: 'partially_filled',
  filled: 'filled',
  rejected: 'rejected',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
});

/** The deterministic market-closure condition (§27) — never a free-text error. */
export const BRIDGE_MARKET_CLOSED_CONDITION = 'market_closed';

export const BRIDGE_NORMALIZED_STATUSES = [...ORDER_STATUSES, 'uncertain'] as const;
export type BridgeNormalizedStatus = (typeof BRIDGE_NORMALIZED_STATUSES)[number];

/**
 * The status vocabulary a reconciliation SNAPSHOT may carry. Identical to the
 * normalized protocol statuses — i.e. the existing durable order statuses plus
 * the explicit `uncertain`. It exists so the extra state can never leak into
 * the durable `order_status` column, whose CHECK constraint stays untouched.
 */
export const RECONCILIATION_SNAPSHOT_ORDER_STATUSES = BRIDGE_NORMALIZED_STATUSES;

export interface NormalizedProviderOrderStatus {
  /** The mapped durable order status, or null when the provider state is unknown. */
  status: OrderStatus | null;
  /** True whenever the provider state could not be established from the vocabulary. */
  statusUncertain: boolean;
  /** Normalized snapshot status: the mapped status, or the explicit `uncertain`. */
  snapshotStatus: BridgeNormalizedStatus;
  /** Deterministic `market_closed` marker when the vocabulary states it. */
  deterministicCondition: typeof BRIDGE_MARKET_CLOSED_CONDITION | null;
}

/**
 * Normalizes a provider status into the closed vocabulary. Unknown/missing/
 * malformed values stay unknown (B9): they are never converted into
 * `failed`/`rejected`, because that would turn "we could not observe the
 * outcome" into a definitive claim.
 */
export function normalizeProviderOrderStatus(raw: unknown): NormalizedProviderOrderStatus {
  const unknown: NormalizedProviderOrderStatus = {
    status: null,
    statusUncertain: true,
    snapshotStatus: 'uncertain',
    deterministicCondition: null,
  };
  if (typeof raw !== 'string') return unknown;
  if (raw === BRIDGE_MARKET_CLOSED_CONDITION) {
    return { ...unknown, deterministicCondition: BRIDGE_MARKET_CLOSED_CONDITION };
  }
  const mapped = Object.prototype.hasOwnProperty.call(PROVIDER_ORDER_STATUS_VOCABULARY, raw)
    ? PROVIDER_ORDER_STATUS_VOCABULARY[raw]
    : undefined;
  if (!mapped) return unknown;
  return { status: mapped, statusUncertain: false, snapshotStatus: mapped, deterministicCondition: null };
}

/* -------------------------------------------------------------------------- */
/* §19 Ticket mapping identity + §20/§21 reconciliation outcomes               */
/* -------------------------------------------------------------------------- */

/**
 * A provider ticket may be stored only with the identity evidence that ties it
 * to this VeltrixEye order (§19). A ticket alone is never sufficient, and this
 * contract cannot be satisfied by omitting every identity field.
 */
export const bridgeTicketMappingSchema = z
  .object({
    providerTicket: bridgeOrderTicketSchema,
    clientOrderId: bridgeClientOrderIdSchema.nullable(),
    idempotencyKey: bridgeIdempotencyKeySchema.nullable(),
    accountBinding: bridgeAccountBindingSchema,
    symbol: bridgeCanonicalSymbolSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const identityCount = [value.clientOrderId, value.idempotencyKey, value.symbol].filter((v) => typeof v === 'string').length;
    if (identityCount === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providerTicket'], message: 'a provider ticket requires identity-verified fields before it may be stored' });
    }
  });
export type BridgeTicketMapping = z.infer<typeof bridgeTicketMappingSchema>;

/** Reconciliation lookup identity (§20): exactly one durable selector. */
export const bridgeReconciliationLookupSchema = z
  .object({
    protocolId: z.literal(MT5_BRIDGE_PROTOCOL_ID),
    protocolVersion: protocolVersionSchema,
    accountBinding: bridgeAccountBindingSchema,
    providerTicket: bridgeOrderTicketSchema.nullable().default(null),
    clientOrderId: bridgeClientOrderIdSchema.nullable().default(null),
    idempotencyKey: bridgeIdempotencyKeySchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const selectors = [value.providerTicket, value.clientOrderId, value.idempotencyKey].filter((v) => v !== null);
    if (selectors.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clientOrderId'], message: 'exactly one of providerTicket/clientOrderId/idempotencyKey is required' });
    }
  });
export type BridgeReconciliationLookup = z.infer<typeof bridgeReconciliationLookupSchema>;

/**
 * Reconciliation outcome (§20/§21). `not_found` is a *proven* observation;
 * an unobservable provider state is `uncertain` and never `failed`.
 */
export const BRIDGE_RECONCILIATION_OUTCOMES = ['matched', 'mismatched', 'not_found', 'uncertain'] as const;
export type BridgeReconciliationOutcome = (typeof BRIDGE_RECONCILIATION_OUTCOMES)[number];

export const bridgeReconciliationResultSchema = z
  .object({
    outcome: z.enum(BRIDGE_RECONCILIATION_OUTCOMES),
    status: z.enum(BRIDGE_NORMALIZED_STATUSES).nullable(),
    statusUncertain: z.boolean(),
    /** Uncertain results always require reconciliation; proven ones never do. */
    requiresReconciliation: z.boolean(),
    observedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const uncertain = value.outcome === 'uncertain' || value.statusUncertain === true || value.status === 'uncertain';
    if (uncertain && value.requiresReconciliation !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiresReconciliation'], message: 'uncertain provider state must require reconciliation' });
    }
    if (uncertain && (value.status === 'failed' || value.status === 'rejected')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'uncertain provider state must not be recorded as a definitive failure' });
    }
    // `not_found` is a PROVEN observation, so it carries no provider status:
    // "the order is not at the provider" must never be recorded as a failed
    // status (that is how uncertainty gets laundered into a definitive result).
    if (value.outcome === 'not_found' && (value.status !== null || value.statusUncertain !== false)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'a proven not-found observation carries no provider status' });
    }
    if ((value.outcome === 'matched' || value.outcome === 'mismatched') && value.status === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'a matched or mismatched result must state the observed provider status' });
    }
  });
export type BridgeReconciliationResult = z.infer<typeof bridgeReconciliationResultSchema>;

/* -------------------------------------------------------------------------- */
/* §23 Terminal transition evidence                                            */
/* -------------------------------------------------------------------------- */

/** The only evidence that may close a mutation into a definitive state. */
export const BRIDGE_TERMINAL_EVIDENCE = [
  'provider_response_verified',
  'reconciliation_verified',
  'operator_resolution',
  'pre_exchange_reservation_proof',
] as const;
export type BridgeTerminalEvidence = (typeof BRIDGE_TERMINAL_EVIDENCE)[number];

export const BRIDGE_OUTCOMES = ['accepted', 'rejected', 'uncertain'] as const;
export type BridgeOutcome = (typeof BRIDGE_OUTCOMES)[number];

/**
 * The normalized mutation outcome (§14, §23). `uncertain` always carries
 * `outcomeUnknown: true`; a definitive outcome always carries evidence. A
 * missing response is therefore not expressible as a definitive failure.
 */
export const bridgeMutationOutcomeSchema = z
  .object({
    mutation: z.enum(BRIDGE_MUTATION_KINDS),
    outcome: z.enum(BRIDGE_OUTCOMES),
    outcomeUnknown: z.boolean(),
    evidence: z.enum(BRIDGE_TERMINAL_EVIDENCE).nullable(),
    /** Deterministic condition (e.g. `market_closed`) when one was established. */
    condition: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
    clientOrderId: bridgeClientOrderIdSchema.nullable(),
    idempotencyKey: bridgeIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === 'uncertain') {
      if (value.outcomeUnknown !== true) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeUnknown'], message: 'uncertain outcomes must set outcomeUnknown=true' });
      }
      if (value.evidence !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'an uncertain outcome cannot carry terminal evidence' });
      }
      return;
    }
    if (value.outcomeUnknown === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcomeUnknown'], message: 'a definitive outcome cannot claim an unknown outcome' });
    }
    if (value.evidence === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'a definitive terminal outcome requires identity-verified evidence' });
    }
  });
export type BridgeMutationOutcome = z.infer<typeof bridgeMutationOutcomeSchema>;

/* -------------------------------------------------------------------------- */
/* §24 / §25 Durable audit contract                                            */
/* -------------------------------------------------------------------------- */

export const BRIDGE_AUDIT_RECONCILIATION_STATES = ['not_required', 'pending', 'resolved'] as const;

/**
 * Allowlisted, bounded audit record for an execution mutation (§24). It carries
 * identity + binding + outcome only — never a payload, provider text, or any
 * credential-ish field. `durable: false` is how the contract distinguishes
 * query/read observability from a durable audit write (§25).
 */
export const bridgeAuditEventSchema = z
  .object({
    mutation: z.enum(BRIDGE_MUTATION_KINDS),
    clientOrderId: bridgeClientOrderIdSchema.nullable(),
    idempotencyKey: bridgeIdempotencyKeySchema,
    accountBinding: bridgeAccountBindingSchema,
    outcome: z.enum(BRIDGE_OUTCOMES),
    outcomeUnknown: z.boolean(),
    reconciliationState: z.enum(BRIDGE_AUDIT_RECONCILIATION_STATES),
    durable: z.boolean(),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type BridgeAuditEvent = z.infer<typeof bridgeAuditEventSchema>;

/** Credential-shaped keys are rejected wherever an audit payload is accepted. */
export const BRIDGE_FORBIDDEN_AUDIT_KEYS: readonly string[] = [
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'privatekey',
  'credential',
];

export function containsForbiddenAuditKey(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  if (Array.isArray(record)) return record.some(containsForbiddenAuditKey);
  return Object.entries(record as Record<string, unknown>).some(([key, value]) =>
    BRIDGE_FORBIDDEN_AUDIT_KEYS.includes(key.toLowerCase().replace(/[^a-z_]/g, '')) || containsForbiddenAuditKey(value));
}

/* -------------------------------------------------------------------------- */
/* §3 Strict violation vocabulary + error type                                 */
/* -------------------------------------------------------------------------- */

export const MT5_BRIDGE_VIOLATION_CODES = [
  'ok',
  'message_malformed',
  'unknown_field',
  'protocol_identity_mismatch',
  'protocol_version_unsupported',
  'protocol_higher_major_rejected',
  'capability_unsupported',
  'environment_unsupported',
  'live_environment_prohibited',
  'binding_malformed',
  'account_identity_mismatch',
  'broker_identity_mismatch',
  'server_identity_mismatch',
  'attestation_required',
  'attestation_mismatch',
  'client_order_id_missing',
  'client_order_id_not_a_string',
  'client_order_id_too_long',
  'client_order_id_prefix_invalid',
  'client_order_id_hash_invalid',
  'client_order_id_retry_form_invalid',
  'idempotency_key_invalid',
  'readiness_not_explicit',
  'readiness_unavailable',
  'readiness_uncertain',
  'quote_stale',
  'quote_future_beyond_clock_skew',
  'quote_malformed',
  'instrument_contract_invalid',
  'volume_invalid',
  'volume_step_invalid',
  'price_invalid',
  'provider_status_uncertain',
  'ticket_identity_unverified',
  'market_closed',
] as const;
export type BridgeViolationCode = (typeof MT5_BRIDGE_VIOLATION_CODES)[number];

/**
 * The single error type the bridge protocol raises for a deterministic contract
 * violation. It carries a closed code, the mutation it applies to and the
 * `outcomeUnknown` rule: a pre-call validation failure is never uncertain
 * (nothing was sent), while an outcome that cannot be established is (§14).
 */
export class BridgeProtocolViolation extends Error {
  readonly code: BridgeViolationCode;
  readonly mutation: BridgeMutationKind | null;
  readonly outcomeUnknown: boolean;

  constructor(code: BridgeViolationCode, message: string, options: { mutation?: BridgeMutationKind | null; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = 'BridgeProtocolViolation';
    this.code = code;
    this.mutation = options.mutation ?? null;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

export function isBridgeProtocolViolation(err: unknown): err is BridgeProtocolViolation {
  return err instanceof BridgeProtocolViolation;
}

/** Validates any strict protocol message and fails with a closed code. */
export function parseBridgeMessage<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  code: BridgeViolationCode = 'message_malformed',
): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BridgeProtocolViolation(code, 'Bridge protocol message failed strict validation');
  return parsed.data;
}
