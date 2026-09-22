import { z } from 'zod';

/**
 * Billing — shared primitives used by BOTH the provider seam contracts
 * (`./billing-provider.ts`) and the payment/pricing contracts
 * (`./billing-payment.ts`).
 *
 * They live in their own module so the two contract files can share exactly one
 * definition of the hashing format and of the credential-shape rejection rule,
 * without either importing the other (which would be a cycle). Nothing here
 * knows a provider, an endpoint, a price or a status.
 */

/** SHA-256 hex — the format used for every billing hash/idempotency key. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const sha256HexSchema = z.string().regex(SHA256_HEX_RE);

/**
 * Credential-shaped material. A provider REFERENCE is an identifier
 * (`cus_…`, `sub_…`, a transaction reference) — never a key, token or
 * password. Reference values matching this pattern are rejected, mirroring the
 * database-level posture in migration 0031 (and 0029 for execution receipts).
 */
export const BILLING_CREDENTIAL_SHAPED_RE =
  /(password|passwd|token|secret|api[_-]?key|authorization|private[_-]?key|credential|bearer)/i;

/** A provider-side identifier for a customer/subscription/plan. */
export const providerReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !BILLING_CREDENTIAL_SHAPED_RE.test(value), {
    message: 'a provider reference must be an identifier, never credential-shaped material',
  });

/** A provider-side reference carried by an event/transaction (wider bound). */
export const providerEventReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(190)
  .refine((value) => !BILLING_CREDENTIAL_SHAPED_RE.test(value), {
    message: 'a provider reference must be an identifier, never credential-shaped material',
  });

/** ISO-8601 UTC timestamp, the only timestamp format billing uses on the wire. */
export const billingIsoDateTimeSchema = z.string().datetime();

/** UUID identifier. */
export const billingUuidSchema = z.string().uuid();
