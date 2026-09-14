import { z } from 'zod';
import { detectionInstrumentSchema, setupDirectionSchema } from './detection.js';

/**
 * Setup-alert contracts (M6).
 *
 * An alert is generated EXPLICITLY from one owned setup (no scheduler, no
 * scanner in M6 — like M4 detection and M5 scoring, generation is invoked,
 * never automatic). The pinned generation rule (enforced by the Phase 3
 * service):
 *
 *  1. the setup is in an eligible state (`confirmed` or `triggered`) and
 *     non-terminal;
 *  2. an M5 score row exists for the setup at its detection anchor;
 *  3. that score total is ≥ the version's `risk.minQualityScore` gate.
 *
 * Deduplication: at most one alert per (setup, triggering state), so a setup
 * can yield at most two alerts (`confirmed` + `triggered`) — retries and
 * double-clicks collapse onto the existing row.
 *
 * Delivery in M6 is a ledger with a STUB sender: every generated alert
 * records an `alert_deliveries` row (`channel: 'stub'`, `status:
 * 'delivered'`) WITHOUT any external I/O. No email, webhook or push is sent
 * in M6; the `AlertSender` interface plus the `email`/`webhook`/`push`
 * channel values exist so a later milestone can add real delivery behind the
 * same table without a migration.
 *
 * Phase 1 ships these contracts and the 0012 migration only. Generation,
 * delivery ledgering, API routes and audit events land in Phase 3.
 */

/** Alert lifecycle states (`suppressed` is reserved for future mute rules — M6 never writes it). */
export const ALERT_STATUSES = ['pending', 'acknowledged', 'suppressed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Setup states that may generate an alert (the dedup key's second half). */
export const ALERT_TRIGGER_STATES = ['confirmed', 'triggered'] as const;
export type AlertTriggerState = (typeof ALERT_TRIGGER_STATES)[number];

/**
 * Delivery channels. M6 writes `stub` only; the rest are reserved values so
 * real delivery needs no migration later.
 */
export const ALERT_CHANNELS = ['stub', 'email', 'webhook', 'push'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/** Delivery attempt outcomes (the stub always records `delivered`). */
export const ALERT_DELIVERY_STATUSES = ['delivered', 'failed'] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

/** Default/max page size for the alert list endpoint (Phase 3). */
export const DEFAULT_ALERTS_LIMIT = 50;
export const MAX_ALERTS_LIMIT = 100;

/** Max delivery rows returned with one alert (matches the M4 event-history precedent). */
export const MAX_ALERT_DELIVERIES = 64;

export const alertStatusSchema = z.enum(ALERT_STATUSES);
export const alertTriggerStateSchema = z.enum(ALERT_TRIGGER_STATES);
export const alertChannelSchema = z.enum(ALERT_CHANNELS);
export const alertDeliveryStatusSchema = z.enum(ALERT_DELIVERY_STATUSES);

/**
 * POST /api/setups/:setupId/alerts body (Phase 3). Omit `triggerState` to
 * generate from the setup's current state when it is eligible.
 */
export const alertGenerateRequestSchema = z
  .object({
    triggerState: alertTriggerStateSchema.optional(),
  })
  .strict();
export type AlertGenerateRequest = z.infer<typeof alertGenerateRequestSchema>;
export type AlertGenerateRequestInput = z.input<typeof alertGenerateRequestSchema>;

/** POST /api/alerts/:alertId/acknowledge body (Phase 3): empty and idempotent. */
export const alertAcknowledgeRequestSchema = z.object({}).strict();
export type AlertAcknowledgeRequest = z.infer<typeof alertAcknowledgeRequestSchema>;

/** GET /api/alerts query (Phase 3; values arrive as strings over HTTP). */
export const alertListQuerySchema = z
  .object({
    strategyId: z.string().uuid().optional(),
    status: alertStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_ALERTS_LIMIT).default(DEFAULT_ALERTS_LIMIT),
  })
  .strict();
export type AlertListQuery = z.infer<typeof alertListQuerySchema>;

/** One row of `alerts`. */
export const alertDtoSchema = z
  .object({
    id: z.string().uuid(),
    setupId: z.string().uuid(),
    strategyId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    instrument: detectionInstrumentSchema,
    direction: setupDirectionSchema,
    /** The setup state that generated this alert (dedup key with `setupId`). */
    triggerState: alertTriggerStateSchema,
    /** The M5 total at generation (always ≥ `minQualityScore` by the gate). */
    qualityScore: z.number().int().min(0).max(100),
    /** The version's `risk.minQualityScore` at generation time (audit trail). */
    minQualityScore: z.number().int().min(0).max(100),
    /** Deterministic human-readable summary (≤ 280 chars, like transition reasons). */
    title: z.string().min(1).max(280),
    /** Structured payload (levels, score reference, links) — never raw candles. */
    body: z.record(z.string(), z.unknown()),
    status: alertStatusSchema,
    acknowledgedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AlertDto = z.infer<typeof alertDtoSchema>;

/** One row of `alert_deliveries` (append-only delivery ledger). */
export const alertDeliveryDtoSchema = z
  .object({
    id: z.number().int().positive(),
    alertId: z.string().uuid(),
    channel: alertChannelSchema,
    status: alertDeliveryStatusSchema,
    attempt: z.number().int().min(1),
    error: z.string().max(2000).nullable(),
    /** sha256 hex of the rendered payload (dedup + audit). */
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/, 'payloadHash must be sha256 hex'),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AlertDeliveryDto = z.infer<typeof alertDeliveryDtoSchema>;

/** GET /api/alerts/:alertId response (Phase 3): the alert + its delivery ledger. */
export const alertDetailDtoSchema = z
  .object({
    alert: alertDtoSchema,
    deliveries: z.array(alertDeliveryDtoSchema).max(MAX_ALERT_DELIVERIES),
  })
  .strict();
export type AlertDetailDto = z.infer<typeof alertDetailDtoSchema>;
