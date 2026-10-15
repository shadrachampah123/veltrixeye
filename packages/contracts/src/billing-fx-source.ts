import { z } from 'zod';

/**
 * Billing FX **source observation** contracts (read-only).
 *
 * This file describes the shape of an *observation* taken from an external
 * publisher of a USD→GHS reference rate — today exactly one publisher is
 * recognised, the Bank of Ghana's published daily interbank FX rates.
 *
 * WHAT AN OBSERVATION IS, AND WHAT IT IS NOT
 *  - It IS an immutable, append-only record of what a named external publisher
 *    had published at a moment we retrieved it: the publication date, the
 *    buying/selling/mid figures exactly as published, the URL, a content
 *    digest and the retrieval instant.
 *  - It is NOT a billing rate. An observation never prices a payment, is never
 *    read by the pricing path, and is deliberately stored in its own table
 *    (`billing_fx_source_observations`) with NO foreign key to
 *    `billing_fx_rate_versions`. Publishing an authoritative rate version stays
 *    the separate, operator-approved operation it already is, and every
 *    observation carries the decision `need_source` until such an approval is
 *    recorded outside this feature.
 *
 * Nothing here enables a charge, a plan, a price or an execution path.
 */

/**
 * The recognised FX **source** identifiers. Pinned and closed: adding a
 * publisher is a deliberate, reviewable change to this list (and to the
 * matching database CHECK), never a runtime configuration value — a deployment
 * cannot choose who the platform treats as an authority.
 */
export const FX_SOURCE_IDS = ['bank_of_ghana'] as const;
export type FxSourceId = (typeof FX_SOURCE_IDS)[number];

export const fxSourceIdSchema = z.enum(FX_SOURCE_IDS);

/** The Bank of Ghana identifier, as used in `source_id` and observation keys. */
export const FX_SOURCE_BANK_OF_GHANA: FxSourceId = 'bank_of_ghana';

/**
 * The ONLY source URL this build may record or request: the Bank of Ghana's
 * published daily interbank FX rates page.
 *
 * A constant, not a setting. There is no environment variable for it, no
 * configuration key and no parameter: no deployment can point the observation
 * layer at a different publisher or host, and an observation row's `source_url`
 * is CHECK-constrained to this exact literal. Third-party mirrors and
 * aggregators that re-publish Bank of Ghana figures are NOT this source — using
 * one would be a separate source-approval decision.
 */
export const FX_SOURCE_BANK_OF_GHANA_URL =
  'https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/' as const;

/** The only host the observation layer may reach (no configuration for it). */
export const FX_SOURCE_BANK_OF_GHANA_HOST = 'https://www.bog.gov.gh' as const;

/**
 * Advisory lock key for FX source observation checks — pinned, arbitrary but
 * stable. Distinct from `SCANNER_ADVISORY_LOCK_KEY` (875421009) and from the
 * other worker keys, so an FX check can never serialize against (or block) a
 * scan or a delivery drain.
 */
export const FX_SOURCE_ADVISORY_LOCK_KEY = 875_421_010;

/** The currencies an observation is recorded in. Pinned pair. */
export const FX_SOURCE_BASE_CURRENCY = 'USD' as const;
export const FX_SOURCE_QUOTE_CURRENCY = 'GHS' as const;

/**
 * Retrieval outcomes a check can record. These describe the *retrieval*, not a
 * decision about the rate: a failed retrieval is reported (and later visible as
 * staleness), never silently treated as "no change".
 */
export const FX_SOURCE_RETRIEVAL_OUTCOMES = [
  'retrieved',
  'unavailable',
  'unparseable',
] as const;
export type FxSourceRetrievalOutcome = (typeof FX_SOURCE_RETRIEVAL_OUTCOMES)[number];

/** Why a retrieval could not produce a usable observation row. */
export const FX_SOURCE_FAILURE_REASONS = [
  // transport / response shape
  'timeout',
  'network',
  'http_status',
  'redirect_refused',
  'unsupported_content_type',
  'body_too_large',
  // page shape
  'no_usd_row',
  'ambiguous_usd_row',
  'row_shape',
] as const;
export type FxSourceFailureReason = (typeof FX_SOURCE_FAILURE_REASONS)[number];

/**
 * Staleness of the newest observation relative to the source's own publication
 * cadence. `never` means no observation has ever been recorded — which is the
 * truthful state before the first successful check, never a green one.
 */
export const FX_SOURCE_STALENESS_STATES = ['never', 'fresh', 'warning', 'stale'] as const;
export type FxSourceStalenessState = (typeof FX_SOURCE_STALENESS_STATES)[number];
