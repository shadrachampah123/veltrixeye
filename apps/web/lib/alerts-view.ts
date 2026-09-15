import {
  ALERT_STATUSES,
  ALERT_TRIGGER_STATES,
  type AlertChannel,
  type AlertDeliveryDto,
  type AlertDto,
  type AlertGenerateResponse,
  type AlertSkippedReason,
  type AlertStatus,
  type SetupDto,
  type SetupState,
} from '@veltrixeye/contracts';

/**
 * Alert UI helpers (M6 Phase 4, frontend only).
 *
 * The single most important rule encoded here: **M6 delivery is a stub.** The
 * API writes one `alert_deliveries` row with `channel: 'stub'` and performs no
 * external I/O, so no string rendered by the UI may claim that an email,
 * webhook, push notification, SMS, Telegram/WhatsApp message or broker order
 * was sent. Every delivery-related label in this module says what was actually
 * done — a local ledger row was recorded.
 */

/** Headline copy for the stub-delivery banner (alerts list + detail + generate). */
export const STUB_DELIVERY_TITLE = 'Stub delivery only';
export const STUB_DELIVERY_BODY =
  'Alerts are recorded in VeltrixEye’s own delivery ledger (channel “stub”). No email, webhook, push, SMS or broker notification is sent, and real external delivery is not enabled in this milestone.';

/** Per-channel wording. `stub` is the only channel M6 ever writes. */
export function deliveryChannelLabel(channel: AlertChannel | string): string {
  if (channel === 'stub') return 'Stub (local ledger record)';
  // Reserved contract values; nothing in M6 writes them. Say so plainly
  // instead of implying a channel is live.
  return `${channel} (reserved — not enabled)`;
}

/**
 * One delivery row → one sentence. Deliberately avoids the word "sent" for the
 * stub: the stub records a delivery attempt locally and transmits nothing.
 */
export function describeDelivery(delivery: AlertDeliveryDto): string {
  const base =
    delivery.channel === 'stub'
      ? `Recorded locally on the stub channel (attempt ${delivery.attempt}) — nothing was transmitted externally.`
      : `Ledger row on the reserved "${delivery.channel}" channel (attempt ${delivery.attempt}) — this channel is not enabled in this milestone.`;
  if (delivery.error) return `${base} Ledger error: ${delivery.error}`;
  return base;
}

export function deliveryStatusTone(status: AlertDeliveryDto['status']): 'success' | 'danger' {
  return status === 'delivered' ? 'success' : 'danger';
}

// ---------------------------------------------------------------------------
// Generate-alert outcomes
// ---------------------------------------------------------------------------

export type GenerateAlertOutcome =
  | { kind: 'created'; alert: AlertDto; deliveries: AlertDeliveryDto[] }
  | { kind: 'replayed'; alert: AlertDto; deliveries: AlertDeliveryDto[] }
  | { kind: 'skipped'; reason: AlertSkippedReason };

/**
 * Map the API's generate response onto exactly one UI outcome.
 *
 * The API distinguishes three things and the UI must not blur them:
 *  - `created: true`  → a new alert row (201);
 *  - `created: false` with an alert → the existing dedup winner (200), i.e. a
 *    replay — **not** a new alert;
 *  - `alert: null` → the minQualityScore gate skipped generation (200) —
 *    **not** an alert, and not an error.
 */
export function classifyGenerateOutcome(response: AlertGenerateResponse): GenerateAlertOutcome {
  if (response.alert === null) {
    return { kind: 'skipped', reason: response.skippedReason ?? 'below_min_quality' };
  }
  return {
    kind: response.created ? 'created' : 'replayed',
    alert: response.alert,
    deliveries: response.deliveries ?? [],
  };
}

export interface GenerateOutcomeCopy {
  tone: 'success' | 'info' | 'warning';
  title: string;
  detail: string;
}

/** Truthful copy per outcome. A skip or a replay is never described as created. */
export function describeGenerateOutcome(outcome: GenerateAlertOutcome): GenerateOutcomeCopy {
  switch (outcome.kind) {
    case 'created':
      return {
        tone: 'success',
        title: 'Alert generated',
        detail: `${STUB_DELIVERY_TITLE}: the alert was written to your alerts and its delivery recorded on the stub ledger. No external notification was sent.`,
      };
    case 'replayed':
      return {
        tone: 'info',
        title: 'Alert already exists',
        detail:
          'An alert for this setup and trigger state was already generated, so the existing alert was returned — no second alert and no second delivery row were created.',
      };
    case 'skipped':
      return {
        tone: 'warning',
        title: 'No alert generated — below the minimum quality score',
        detail:
          'The setup’s quality score is below the strategy version’s minimum quality score gate, so the API skipped generation. No alert row was written.',
      };
  }
}

// ---------------------------------------------------------------------------
// Alert presentation
// ---------------------------------------------------------------------------

export function alertStatusLabel(status: AlertStatus): string {
  if (status === 'acknowledged') return 'Acknowledged';
  if (status === 'pending') return 'Pending';
  return status;
}

export function alertStatusTone(status: AlertStatus): 'success' | 'warning' | 'neutral' {
  if (status === 'acknowledged') return 'success';
  if (status === 'pending') return 'warning';
  return 'neutral';
}

export function triggerStateLabel(state: string): string {
  return state === 'confirmed' ? 'Confirmed' : state === 'triggered' ? 'Triggered' : state;
}

/** M5 grade → badge tone (grades come from the scoring engine, not the UI). */
export function gradeTone(grade: string | null | undefined): 'success' | 'info' | 'warning' | 'neutral' {
  if (grade === 'A+' || grade === 'A') return 'success';
  if (grade === 'B') return 'info';
  if (grade === 'C') return 'warning';
  return 'neutral';
}

export const ALERT_STATUS_FILTERS: Array<{ value: '' | AlertStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  ...ALERT_STATUSES.map((s) => ({ value: s, label: alertStatusLabel(s) })),
];

/** Whether an alert is already acknowledged (the button must not re-offer it). */
export function isAcknowledged(alert: AlertDto): boolean {
  return alert.status === 'acknowledged' && alert.acknowledgedAt !== null;
}

/**
 * The acknowledge control's state: `disabled` when the alert is already
 * acknowledged (idempotent — nothing to do) and `pending` while a request is
 * in flight, so a double-click cannot fire a second call.
 */
export function acknowledgeControlState(alert: AlertDto, pending: boolean): {
  disabled: boolean;
  label: string;
  reason: string | null;
} {
  if (pending) return { disabled: true, label: 'Acknowledging…', reason: null };
  if (isAcknowledged(alert)) {
    return { disabled: true, label: 'Acknowledged', reason: 'This alert is already acknowledged.' };
  }
  return { disabled: false, label: 'Acknowledge', reason: null };
}

// ---------------------------------------------------------------------------
// Structured alert body — read known fields only, never dump raw JSON
// ---------------------------------------------------------------------------

export interface AlertBodyView {
  qualityGrade: string | null;
  entryPrice: number | null;
  stopLossPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  detectedAt: string | null;
  scoreId: number | null;
  scoreEngineVersion: string | null;
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Narrow the API's `body` record to the fields the UI knows how to render. */
export function readAlertBody(body: Record<string, unknown>): AlertBodyView {
  return {
    qualityGrade: readString(body, 'qualityGrade'),
    entryPrice: readNumber(body, 'entryPrice'),
    stopLossPrice: readNumber(body, 'stopLossPrice'),
    tp1Price: readNumber(body, 'tp1Price'),
    tp2Price: readNumber(body, 'tp2Price'),
    tp3Price: readNumber(body, 'tp3Price'),
    detectedAt: readString(body, 'detectedAt'),
    scoreId: readNumber(body, 'scoreId'),
    scoreEngineVersion: readString(body, 'scoreEngineVersion'),
  };
}

// ---------------------------------------------------------------------------
// Generate-from-setup source list
// ---------------------------------------------------------------------------

/** Only `confirmed` / `triggered` setups can generate an alert (API gate). */
export function isGenerateEligibleState(state: SetupState | string): boolean {
  return (ALERT_TRIGGER_STATES as readonly string[]).includes(state);
}

export interface SetupGenerateEligibility {
  eligible: boolean;
  reason: string | null;
}

export function setupGenerateEligibility(setup: Pick<SetupDto, 'state'>): SetupGenerateEligibility {
  if (isGenerateEligibleState(setup.state)) return { eligible: true, reason: null };
  const terminal = setup.state === 'completed' || setup.state === 'invalidated' || setup.state === 'expired';
  return {
    eligible: false,
    reason: terminal
      ? `The setup is ${setup.state.replace('_', ' ')} — no alert can be generated for a terminal setup.`
      : `The setup is ${setup.state.replace('_', ' ')} — only confirmed or triggered setups can generate alerts.`,
  };
}

/** Sort eligible setups first, newest detection first (stable, no invented order). */
export function sortSetupsForGenerate(setups: readonly SetupDto[]): SetupDto[] {
  return [...setups].sort((a, b) => {
    const ae = isGenerateEligibleState(a.state) ? 0 : 1;
    const be = isGenerateEligibleState(b.state) ? 0 : 1;
    if (ae !== be) return ae - be;
    return b.detectedAt.localeCompare(a.detectedAt);
  });
}
