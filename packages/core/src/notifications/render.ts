import { createHash } from 'node:crypto';
import {
  ALERT_NOTIFICATION_TEMPLATE,
  alertNotificationPayloadSchema,
  assetClassSchema,
  type AlertNotificationData,
  type AlertNotificationPayload,
  type AlertTriggerState,
  type AssetClass,
  type DetectionInstrument,
  type NotificationChannel,
  type SetupDirection,
} from '@veltrixeye/contracts';
import { canonicalize } from '../alerts/sender.js';
import { Errors } from '../errors.js';

/**
 * Server-side rendering of an alert notification (M7.3).
 *
 * The rendered payload is a **pure function of persisted state**: it is built
 * from the stored `alerts` row (title/body/ids/timestamps) plus the published
 * strategy-version config (timeframe). No clock, no randomness, no request
 * input — so:
 *
 *  - a client cannot alter direction, entry, stop loss, take profits, the
 *    score, the strategy result or the alert identity after generation;
 *    those values were frozen by the deterministic M3–M6 pipeline,
 *  - the same alert always renders the same payload, hence the same
 *    `payloadHash`, hence the same outbox row (idempotency).
 *
 * The payload is stored verbatim with the job and handed to the provider, so
 * what is delivered is exactly what was decided — not a re-render that could
 * observe a later state.
 */

export interface RenderAlertNotificationArgs {
  /**
   * Authoritative facts, read from the persisted `alerts` row (and its joins).
   * These columns are DB-constrained, so the notification can never contradict
   * what the alert actually says — and an old or hand-written `body` cannot
   * break rendering (it is supplementary, see below).
   */
  alertId: string;
  setupId: string;
  strategyId: string;
  strategyVersionId: string;
  versionNumber: number;
  direction: string;
  triggerState: string;
  qualityScore: number;
  minQualityScore: number;
  /** ISO timestamp of `alerts.created_at`. */
  createdAt: string;
  /**
   * The persisted `alerts.body` (M6 structured payload). It is treated as
   * SUPPLEMENTARY: levels, grade and detection time are taken from it when
   * present and degrade to nulls otherwise, because a legacy or out-of-band
   * alert row must never fail to render (delivery may not break generation).
   */
  body: Record<string, unknown>;
  symbol: string;
  assetClass: string;
  /** Setup timeframe of the version that produced the alert (nullable). */
  timeframe: string | null;
}

/** sha256 hex — the format of the outbox `payload_hash` / `idempotency_key`. */
export const NOTIFICATION_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Deterministic idempotency key: one job per (template, channel, alert).
 *
 * The payload hash is deliberately NOT part of it: a template change must not
 * mint a second delivery job for an alert that was already queued — an alert
 * is notified once per channel, full stop.
 */
export function notificationIdempotencyKey(args: {
  template: string;
  channel: NotificationChannel;
  alertId: string;
}): string {
  return sha256(`${args.template}|${args.channel}|${args.alertId}`);
}

/** sha256 of the canonical JSON of a rendered payload. */
export function notificationPayloadHash(payload: AlertNotificationPayload): string {
  return sha256(JSON.stringify(canonicalize(payload)));
}

/**
 * Render the email (or any text channel) payload for one persisted alert.
 * Throws a domain error when the stored body is missing a required fact —
 * a malformed notification must fail loudly at enqueue time, not silently
 * deliver a half-empty message.
 */
export function renderAlertNotification(args: RenderAlertNotificationArgs): AlertNotificationPayload {
  const body = args.body;
  const data: AlertNotificationData = {
    // Identity and trade facts come from the alert ROW (DB-constrained), never
    // from the free-form body: a client can ask for an alert, but it cannot
    // influence what the alert — or the notification about it — says.
    alertId: args.alertId,
    setupId: args.setupId,
    strategyId: args.strategyId,
    strategyVersionId: args.strategyVersionId,
    versionNumber: Math.max(1, Math.trunc(args.versionNumber)),
    instrument: asInstrument(body['instrument'], args.symbol, args.assetClass),
    timeframe: args.timeframe,
    direction: asEnum(body['direction'], args.direction, ['long', 'short']) as SetupDirection,
    triggerState: asEnum(body['triggerState'], args.triggerState, ['confirmed', 'triggered']) as AlertTriggerState,
    qualityScore: Math.trunc(args.qualityScore),
    qualityGrade: asString(body['qualityGrade'], 'n/a'),
    minQualityScore: Math.trunc(args.minQualityScore),
    // Supplementary levels: null when the body does not carry them.
    entryPrice: asPrice(body['entryPrice']),
    stopLossPrice: asPrice(body['stopLossPrice']),
    tp1Price: asPrice(body['tp1Price']),
    tp2Price: asPrice(body['tp2Price']),
    tp3Price: asPrice(body['tp3Price']),
    detectedAt: asIso(body['detectedAt'], args.createdAt),
    generatedAt: args.createdAt,
  };

  const payload: AlertNotificationPayload = {
    template: ALERT_NOTIFICATION_TEMPLATE,
    subject: buildSubject(data),
    text: buildText(data),
    data,
  };

  const parsed = alertNotificationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw Errors.internal(
      `Rendered alert notification is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `EURUSD long setup confirmed - quality 80/100 (B)`, capped at 200 chars.
 * Plain ASCII on purpose: a non-ASCII subject forces an encoded-word header,
 * which some filters and inboxes render badly.
 */
function buildSubject(data: AlertNotificationData): string {
  const subject = `${data.instrument.symbol} ${data.direction} setup ${data.triggerState} - quality ${data.qualityScore}/100 (${data.qualityGrade})`;
  return subject.slice(0, 200);
}

/**
 * Plain-text body. Fixed field order and fixed decimals: the same alert always
 * renders byte-identical text (no locale, no clock, no environment).
 */
function buildText(data: AlertNotificationData): string {
  const lines: string[] = [
    `VeltrixEye alert — ${data.instrument.symbol} ${data.direction} setup ${data.triggerState}`,
    '',
    label('Alert ID', data.alertId),
    label('Instrument', `${data.instrument.symbol} (${data.instrument.assetClass})`),
    label('Timeframe', data.timeframe ?? 'not set'),
    label('Direction', data.direction),
    label('Trigger', data.triggerState),
    label('Quality', `${data.qualityScore}/100 (grade ${data.qualityGrade})`),
    label('Quality gate', String(data.minQualityScore)),
    label('Strategy version', `#${data.versionNumber}`),
    '',
    label('Entry', formatPrice(data.entryPrice)),
    label('Stop loss', formatPrice(data.stopLossPrice)),
    label('Take profit 1', formatPrice(data.tp1Price)),
    label('Take profit 2', formatPrice(data.tp2Price)),
    label('Take profit 3', formatPrice(data.tp3Price)),
    '',
    label('Detected at', data.detectedAt),
    label('Generated at', data.generatedAt),
    '',
    'This alert was produced by your VeltrixEye strategy. It is information, not investment advice, and no trade has been placed on your behalf.',
  ];
  return lines.join('\n');
}

function label(name: string, value: string): string {
  // 17 columns: the longest label ("Strategy version") still gets a separator.
  return `${name.padEnd(17, ' ')}${value}`;
}

/**
 * Fixed-decimal, locale-independent price formatting: 5 decimals below 1000
 * (forex/indices), 2 above it (crypto/equities). `null` renders as an em dash
 * rather than a fabricated number.
 */
export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(5);
}

/* -------------------------------------------------------------------------- */
/* Defensive readers (persisted jsonb → typed facts)                           */
/* -------------------------------------------------------------------------- */

function sha256(value: string): string {
  const hash = createHash('sha256').update(value, 'utf8').digest('hex');
  if (!NOTIFICATION_HASH_RE.test(hash)) {
    throw new Error(`computed notification hash has invalid format: ${hash}`);
  }
  return hash;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asEnum(value: unknown, fallback: string, allowed: readonly string[]): string {
  const candidate = typeof value === 'string' ? value : fallback;
  if (!allowed.includes(candidate)) {
    throw Errors.internal(`Alert body has an invalid value for "${String(value)}"`);
  }
  return candidate;
}

function asPrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function asIso(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return fallback;
  return new Date(ms).toISOString();
}

function asInstrument(
  value: unknown,
  symbolFallback: string,
  assetClassFallback: string,
): DetectionInstrument {
  const record = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const parsed = assetClassSchema.safeParse(record['assetClass']);
  return {
    assetClass: parsed.success ? parsed.data : (assetClassFallback as AssetClass),
    symbol: asString(record['symbol'], symbolFallback),
  };
}
