'use client';

import * as React from 'react';
import { Alert, Badge, Button, Card, CardHeader, buttonClass } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/formats';
import { BRAND } from '@/lib/brand';
import {
  BILLING_CHECKOUT_CHOICES,
  billingCheckoutOffered,
  resolveBillingCheckoutState,
  type BillingCheckoutRequestDto,
  type BillingCheckoutSessionDto,
  type BillingCheckoutState,
  type BillingPaymentReconciliationFailureReason,
  type BillingPaymentVerificationResult,
  type BillingStateDto,
} from '@veltrixeye/contracts';

/**
 * Billing Step 9 — the SANDBOX checkout surface on `/settings`.
 *
 * WHAT THIS COMPONENT DOES
 *  - offers exactly four choices (Pro monthly, Pro annual, Elite monthly, Elite
 *    annual) rendered from the shared authoritative catalogue — Starter is not
 *    sellable and is never offered;
 *  - provisions/uses the caller's own billing customer where checkout requires
 *    one (`POST /api/billing/customer`, idempotent, empty `{}` body);
 *  - initializes a sandbox checkout with `{ cataloguePlan, interval }` and
 *    NOTHING else, then displays the SERVER-PROVIDED price and FX disclosure
 *    (commercial USD price, exact GHS amount, rate, rate version and time);
 *  - renders the returned `authorizationUrl` VERBATIM as the payment link — it
 *    is never rewritten, prefixed, re-encoded or reconstructed here;
 *  - offers an EXPLICIT "Verify payment" action (`POST /api/billing/verify`,
 *    empty `{}` body) and shows the structured result;
 *  - keeps the five states visibly distinct: free, awaiting verification,
 *    evidence awaiting operator activation, activated, unavailable/error;
 *  - suppresses checkout once evidence is recorded in this UI state and once
 *    the server confirms an activation.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT DO
 *  - NO polling and NO automatic verification: there is no timer, no interval,
 *    no retry loop and no "check again shortly" — the provider is only read
 *    when the user clicks "Verify payment". Returning from the provider's page
 *    changes nothing by itself.
 *  - NO payment confirmation and NO entitlement claim. Evidence is a receipt:
 *    the panel says so, and the authoritative state stays whatever
 *    `GET /api/billing/me` returned (`paymentConfirmed` is derived server-side
 *    from the Step 8 activation fact, which no browser can write).
 *  - NO provider detail. The verification result is reduced to
 *    `toVerificationSummary` below: the evidence row's provider references,
 *    transaction id, customer code, evidence hash and idempotency key are never
 *    carried into the UI, and the checkout DTO the API sends already omits the
 *    checkout reference, provider identifiers, idempotency key and the internal
 *    pricing snapshot.
 *  - NO execution claim: automation, live execution and broker execution stay
 *    unavailable on every plan, whatever is displayed here.
 */

/** The verification facts this surface is allowed to show. */
export interface BillingVerificationSummary {
  verified: boolean;
  failureReason: BillingPaymentReconciliationFailureReason | null;
  failureMessage: string | null;
  replayed: boolean;
  verifiedAt: string;
}

/**
 * Reduce `BillingPaymentVerificationResult` to its displayable facts. The
 * durable `evidence` row is dropped on purpose — it carries provider
 * identifiers and hashes the browser has no use for.
 */
export function toVerificationSummary(result: BillingPaymentVerificationResult): BillingVerificationSummary {
  return {
    verified: result.verified,
    failureReason: result.failureReason,
    failureMessage: result.failureMessage,
    replayed: result.replayed,
    verifiedAt: result.verifiedAt,
  };
}

/** The five states, each with its own label, tone and explanation. */
export const BILLING_CHECKOUT_STATE_COPY: Readonly<
  Record<BillingCheckoutState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; body: string }>
> = Object.freeze({
  free: {
    label: 'free plan',
    tone: 'neutral',
    body:
      'No paid subscription exists for this account. Creating a sandbox checkout is the only path that writes one — ' +
      'and it buys nothing on its own: the plan stays free until verified evidence exists AND an operator authorizes ' +
      'the activation out of band.',
  },
  awaiting_verification: {
    label: 'awaiting payment verification',
    tone: 'warning',
    body:
      'A sandbox checkout exists for this account and no payment has been verified yet. The plan and its price are ' +
      'locked server-side, so creating the checkout again returns the same locked price. Free-plan limits still apply.',
  },
  evidence_recorded: {
    label: 'evidence recorded · awaiting operator activation',
    tone: 'info',
    body:
      'Verified payment evidence has been recorded for this checkout. Evidence is a receipt, never an activation: the ' +
      'account stays on free-plan limits until an operator authorizes the activation out of band ' +
      '(`npm run billing:activate`). Checkout is closed — there is nothing further to pay.',
  },
  activated: {
    label: 'activated',
    tone: 'success',
    body:
      'An operator authorized this subscription, so the server derived a confirmed payment and the paid limits shown ' +
      'above are what it enforces. Checkout is closed. Automation, live execution and broker execution remain ' +
      'unavailable on every plan.',
  },
  unavailable: {
    label: 'billing unavailable',
    tone: 'danger',
    body:
      'Billing state could not be read, or the sandbox checkout is refusing (no billing provider configured, no plan ' +
      'registered, or a provider refusal). Nothing is offered and nothing is claimed — the account keeps the limits the ' +
      'server last enforced.',
  },
});

/**
 * Mode-aware bodies for the three states that describe the checkout itself.
 * The exported map above stays the sandbox (test) copy — and the DEFAULT copy
 * whenever the mode is unknown (a failed or in-flight read) — so a surface
 * that cannot prove live mode never claims live mode. A LIVE-rendered panel
 * never says "sandbox", and never calls a live payment a test payment.
 */
const BILLING_CHECKOUT_STATE_COPY_LIVE: Readonly<
  Partial<Record<BillingCheckoutState, string>>
> = Object.freeze({
  free:
    'No paid subscription exists for this account. Creating a checkout is the only path that writes one — ' +
    'and it buys nothing on its own: the plan stays free until verified evidence exists AND an operator ' +
    'authorizes the activation out of band.',
  awaiting_verification:
    'A checkout exists for this account and no payment has been verified yet. The plan and its price are ' +
    'locked server-side, so creating the checkout again returns the same locked price. Free-plan limits still apply.',
  unavailable:
    'Billing state could not be read, or the checkout is refusing (no billing provider configured, no plan ' +
    'registered, or a provider refusal). Nothing is offered and nothing is claimed — the account keeps the limits the ' +
    'server last enforced.',
});

/** The state copy for the configured domain (sandbox copy unless live is proven). */
function billingStateCopy(
  state: BillingCheckoutState,
  mode: 'test' | 'live' | null,
): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; body: string } {
  const base = BILLING_CHECKOUT_STATE_COPY[state];
  // `unavailable` can render without a read answer (mode unknown); its live
  // body is deliberately domain-neutral, so it serves both — while the two
  // payment states, which only exist after a read, keep their mode.
  const override = mode === 'live' || (mode === null && state === 'unavailable');
  if (!override) return base;
  const body = BILLING_CHECKOUT_STATE_COPY_LIVE[state];
  return body === undefined ? base : { ...base, body };
}

/** Why a verification did not produce evidence, in user-facing words. */
export const BILLING_VERIFICATION_FAILURE_COPY: Readonly<
  Record<BillingPaymentReconciliationFailureReason, string>
> = Object.freeze({
  invalid_status:
    'The provider has not reported this transaction as paid. Complete the payment on the provider page, then verify again.',
  missing_paid_at:
    'The provider has not reported a payment time for this transaction yet. Complete the payment, then verify again.',
  amount_mismatch:
    'The amount the provider reported does not match the locked price exactly. Nothing was recorded — contact support.',
  currency_mismatch:
    'The currency the provider reported does not match the locked price. Nothing was recorded — contact support.',
  exponent_mismatch:
    'The amount unit the provider reported does not match the locked price. Nothing was recorded — contact support.',
  snapshot_mismatch:
    'The locked pricing snapshot disagrees with the provider report. Nothing was recorded — contact support.',
  invalid_snapshot:
    'The locked pricing snapshot could not be verified. Nothing was recorded — contact support.',
  reference_mismatch:
    'The provider answered for a different transaction reference. Nothing was recorded — contact support.',
  customer_mismatch:
    'The provider reported a different customer than this account. Nothing was recorded — contact support.',
  provider_mismatch:
    'The provider report is not from the configured billing provider. Nothing was recorded — contact support.',
  domain_mismatch:
    'The provider report is not from the sandbox (test) domain. Nothing was recorded — contact support.',
});

/**
 * The live-mode wording for the ONE failure that names a domain. The exported
 * map above stays the sandbox copy (and the default when the mode is
 * unknown); a live-mode panel must never call a live payment a test payment.
 */
export const BILLING_VERIFICATION_FAILURE_COPY_LIVE: Readonly<
  Partial<Record<BillingPaymentReconciliationFailureReason, string>>
> = Object.freeze({
  domain_mismatch:
    'The provider report is not from the configured live domain. Nothing was recorded — contact support.',
});

export interface BillingCheckoutPanelProps {
  /** The server billing state, or `null` while it is loading / unreadable. */
  billing: BillingStateDto | null;
  /** True when the billing read failed (as opposed to still being in flight). */
  unavailable?: boolean;
  /** True once THIS UI session recorded verified payment evidence. */
  evidenceRecorded?: boolean;
  /** Lifts the evidence fact to the page, so every billing surface agrees. */
  onEvidenceRecorded?: () => void;
  /** Asks the page to re-read the billing state (a first checkout writes a row). */
  onBillingChange?: () => void;
}

/**
 * The checkout surface. All provider contact goes through the API client; this
 * component holds no credential, no reference and no provider identifier.
 */
export function BillingCheckoutPanel({
  billing,
  unavailable = false,
  evidenceRecorded = false,
  onEvidenceRecorded,
  onBillingChange,
}: BillingCheckoutPanelProps) {
  const [selected, setSelected] = React.useState<BillingCheckoutRequestDto>({
    cataloguePlan: BILLING_CHECKOUT_CHOICES[0]?.cataloguePlan ?? 'pro',
    interval: BILLING_CHECKOUT_CHOICES[0]?.interval ?? 'monthly',
  });
  const [session, setSession] = React.useState<BillingCheckoutSessionDto | null>(null);
  const [verification, setVerification] = React.useState<BillingVerificationSummary | null>(null);
  const [busy, setBusy] = React.useState<'idle' | 'checkout' | 'verify'>('idle');
  /** Which action failed, and what the API said — the two refusals read differently. */
  const [error, setError] = React.useState<{ action: 'checkout' | 'verify'; message: string } | null>(null);

  const state = resolveBillingCheckoutState({ billing, evidenceRecorded, unavailable });
  const offered = billingCheckoutOffered(state);
  /** The server-reported provider domain; null until a read answers. */
  const mode = billing?.mode ?? null;
  const copy = billingStateCopy(state, mode);
  const loading = billing === null && !unavailable;

  /**
   * Provision/use the billing customer where checkout requires one, then
   * initialize the checkout. Two explicit calls, both initiated by this click:
   * the customer call is idempotent server-side, and the checkout body is
   * exactly `{ cataloguePlan, interval }`.
   */
  const createCheckout = React.useCallback(async () => {
    setBusy('checkout');
    setError(null);
    setSession(null);
    setVerification(null);
    try {
      await api.ensureBillingCustomer();
      setSession(await api.checkoutBilling(selected));
      // A first checkout creates the subscription row and its immutable pricing
      // lock, so the authoritative billing state has to be re-read.
      onBillingChange?.();
    } catch (err) {
      setError({
        action: 'checkout',
        message:
          err instanceof ApiError
            ? err.message
            : mode === 'live'
              ? 'The checkout could not be created.'
              : 'The sandbox checkout could not be created.',
      });
      onBillingChange?.();
    } finally {
      setBusy('idle');
    }
  }, [mode, onBillingChange, selected]);

  /**
   * The ONLY verification path: an explicit user action. There is no timer, no
   * interval and no automatic re-check anywhere in this component.
   */
  const verifyPayment = React.useCallback(async () => {
    setBusy('verify');
    setError(null);
    try {
      const summary = toVerificationSummary(await api.verifyBillingPayment());
      setVerification(summary);
      if (summary.verified) onEvidenceRecorded?.();
    } catch (err) {
      setVerification(null);
      setError({
        action: 'verify',
        message: err instanceof ApiError ? err.message : 'The payment could not be verified.',
      });
    } finally {
      setBusy('idle');
    }
  }, [onEvidenceRecorded]);

  if (loading) {
    return (
      <Card>
        <CardHeader title="Checkout" subtitle="Billing Step 9 · Paystack" />
        <div className="px-5 py-6 text-sm text-ink-400">Loading billing state…</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={mode === 'test' ? 'Sandbox Checkout' : 'Checkout'}
        subtitle={`${
          mode === 'live'
            ? 'Paystack live mode'
            : mode === 'test'
              ? 'Paystack sandbox (test mode)'
              : 'Paystack'
        } · ${BRAND.name} ${BRAND.stage} · a payment here grants no execution`}
        actions={<Badge tone={copy.tone}>{copy.label}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <p className="text-xs leading-snug text-ink-300">{copy.body}</p>

        {error ? (
          <Alert
            tone="danger"
            role="alert"
            title={error.action === 'checkout' ? 'Checkout unavailable' : 'Verification unavailable'}
          >
            {error.message} Nothing was charged by this page, no evidence was recorded and no entitlement changed.
          </Alert>
        ) : null}

        {offered ? (
          <>
            <BillingCheckoutChoices
              selected={selected}
              onSelect={setSelected}
              disabled={busy !== 'idle'}
              mode={mode === 'live' ? 'live' : 'test'}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void createCheckout()} disabled={busy !== 'idle'}>
                {busy === 'checkout'
                  ? 'Creating checkout…'
                  : mode === 'live'
                    ? 'Create checkout'
                    : 'Create sandbox checkout'}
              </Button>
              <span className="text-[11px] text-ink-500">
                The exact amount and FX rate are provided by the server when the checkout is created.
              </span>
            </div>

            {session ? (
              <BillingCheckoutSessionDisclosure
                session={session}
                selected={selected}
                verification={verification}
                busy={busy}
                onVerify={() => void verifyPayment()}
                mode={mode === 'live' ? 'live' : 'test'}
              />
            ) : null}
          </>
        ) : null}

        {verification && !offered && verification.verified ? (
          // The evidence fact is already in the state copy above; nothing to act on.
          <p className="text-[11px] text-ink-500">
            Payment evidence recorded {formatDateTime(verification.verifiedAt)}.
          </p>
        ) : null}

        <div className="rounded-md border border-amber-450/20 bg-amber-450/5 px-3 py-2.5 text-[11px] leading-snug text-ink-400">
          <strong className="text-amber-450">
            {mode === 'live' ? 'Live mode:' : mode === 'test' ? 'Sandbox only:' : 'Billing:'}
          </strong>{' '}
          {mode === 'live'
            ? 'this surface uses the provider’s live environment and real money can move. It never polls the ' +
              'provider, never confirms a payment by itself and never activates a plan — activation is an out-of-band ' +
              'operator action. Automation, live execution and broker execution remain unavailable on every plan.'
            : mode === 'test'
              ? 'this surface uses the provider’s test environment. It never polls the provider, never confirms a ' +
                'payment by itself and never activates a plan — activation is an out-of-band operator action. ' +
                'Automation, live execution and broker execution remain unavailable on every plan.'
              : 'this surface uses the provider environment the server has configured. It never polls the provider, ' +
                'never confirms a payment by itself and never activates a plan — activation is an out-of-band ' +
                'operator action. Automation, live execution and broker execution remain unavailable on every plan.'}
        </div>
      </div>
    </Card>
  );
}

/**
 * The four choices, rendered from the shared catalogue. Exactly four: Pro and
 * Elite × monthly and annual. Starter has no internal plan value and is never
 * offered; the server refuses it independently.
 */
export function BillingCheckoutChoices({
  selected,
  onSelect,
  disabled = false,
  mode = 'test',
}: {
  selected: BillingCheckoutRequestDto;
  onSelect?: (choice: BillingCheckoutRequestDto) => void;
  disabled?: boolean;
  /** The configured provider domain (defaults to the sandbox copy). */
  mode?: 'test' | 'live';
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-300">
        Plan &amp; interval — {mode === 'live' ? 'four choices' : 'four sandbox choices'}
      </legend>
      {BILLING_CHECKOUT_CHOICES.map((choice) => {
        const key = `${choice.cataloguePlan}:${choice.interval}`;
        const isSelected =
          selected.cataloguePlan === choice.cataloguePlan && selected.interval === choice.interval;
        return (
          <label
            key={key}
            className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs ${
              isSelected ? 'border-signal-500/60 bg-signal-500/5 text-ink-50' : 'border-ink-700 bg-ink-850 text-ink-200'
            }`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name="billing-checkout-choice"
                value={key}
                checked={isSelected}
                disabled={disabled}
                onChange={() =>
                  onSelect?.({ cataloguePlan: choice.cataloguePlan, interval: choice.interval })
                }
              />
              <span className="font-medium">
                {choice.planName} · {choice.interval}
              </span>
            </span>
            <span className="font-mono text-ink-100">
              {choice.price.display}
              <span className="text-[11px] text-ink-400">
                /{choice.interval === 'monthly' ? 'mo' : 'yr'}
              </span>
            </span>
          </label>
        );
      })}
      <p className="text-[11px] text-ink-500">
        Prices are the {BILLING_CHECKOUT_CHOICES[0]?.price.currency ?? 'USD'} catalogue prices. You pay the GHS
        equivalent at the server&rsquo;s published FX rate, disclosed before you pay.
      </p>
    </fieldset>
  );
}

/**
 * The server-provided disclosure for one checkout session, plus the explicit
 * verification action.
 *
 * The payment link is the `authorizationUrl` exactly as the API sent it
 * (already pinned to an absolute https URL by the DTO): it is rendered verbatim
 * as the `href` and shown verbatim as text, so what the user reads is what the
 * user clicks. Nothing here builds a provider URL.
 */
export function BillingCheckoutSessionDisclosure({
  session,
  selected,
  verification,
  busy,
  onVerify,
  mode = 'test',
}: {
  session: BillingCheckoutSessionDto;
  selected?: BillingCheckoutRequestDto;
  verification?: BillingVerificationSummary | null;
  busy?: 'idle' | 'checkout' | 'verify';
  onVerify?: () => void;
  /** The configured provider domain (defaults to the sandbox copy). */
  mode?: 'test' | 'live';
}) {
  const initialized = session.status === 'initialized' && session.authorizationUrl !== null;
  const lockedPlanDiffers =
    session.price !== null &&
    selected !== undefined &&
    (session.price.cataloguePlan !== selected.cataloguePlan || session.price.interval !== selected.interval);

  return (
    <div className="space-y-3 rounded-md border border-ink-700 bg-ink-850/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-400">Server-provided price</div>
          <div className="font-mono text-xl font-semibold text-ink-50">{session.price?.display ?? '—'}</div>
          <div className="text-[11px] text-ink-400">
            {session.price ? `${session.price.cataloguePlan} · ${session.price.interval} · ${session.price.currency}` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-ink-400">You pay</div>
          <div className="font-mono text-xl font-semibold text-signal-400">{session.paymentDisplay ?? '—'}</div>
          <div className="text-[11px] text-ink-400">exact amount, integer minor units</div>
        </div>
      </div>

      {lockedPlanDiffers ? (
        <Alert tone="info" role="status">
          The server priced {session.price?.cataloguePlan} · {session.price?.interval}: an existing checkout locked
          that plan and price, and the lock is immutable. Your selection does not re-price it.
        </Alert>
      ) : null}

      {session.fx ? (
        <dl className="grid gap-1.5 text-[11px] sm:grid-cols-2">
          <DisclosureRow label="FX rate" value={session.fx.rateDisplay} />
          <DisclosureRow label="Rounding" value={session.fx.roundingMode} />
          <DisclosureRow label="Rate version" value={session.fx.fxRateVersionId} mono />
          <DisclosureRow label="Rate source" value={session.fx.fxRateSource} />
          <DisclosureRow label="Rate captured" value={formatDateTime(session.fx.fxRateCapturedAt)} />
          <DisclosureRow label="Rate effective from" value={formatDateTime(session.fx.fxRateEffectiveFrom)} />
        </dl>
      ) : null}

      {initialized ? (
        <div className="space-y-2 border-t border-ink-700 pt-3">
          {/* VERBATIM: the href is exactly the string the API returned. */}
          <a
            className={buttonClass('primary')}
            href={session.authorizationUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            Authorize payment
          </a>
          <p className="text-[11px] leading-snug text-ink-500">
            Opens the provider&rsquo;s {mode === 'live' ? 'payment page' : 'sandbox payment page'}:
            <span className="ml-1 font-mono text-ink-300">{session.authorizationUrl}</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={onVerify} disabled={busy !== undefined && busy !== 'idle'}>
              {busy === 'verify' ? 'Verifying payment…' : 'Verify payment'}
            </Button>
            <span className="text-[11px] text-ink-500">
              After you pay, click &ldquo;Verify payment&rdquo;. Nothing is checked automatically — this page never
              polls the provider.
            </span>
          </div>
        </div>
      ) : (
        <Alert tone="warning" role="status">
          The provider did not initialize this checkout (<span className="font-mono">{session.status}</span>). Nothing
          was charged and no payment link exists; free-plan limits still apply.
        </Alert>
      )}

      {verification ? <BillingVerificationNotice verification={verification} mode={mode} /> : null}

      <p className="text-[11px] leading-snug text-ink-500">
        Created {formatDateTime(session.initializedAt)}. A checkout session is an offer to pay: it confirms no payment,
        changes no plan and grants no execution.
      </p>
    </div>
  );
}

/** The structured verification outcome — no provider identifier, no hash. */
export function BillingVerificationNotice({
  verification,
  mode = 'test',
}: {
  verification: BillingVerificationSummary;
  /** The configured provider domain (defaults to the sandbox copy). */
  mode?: 'test' | 'live';
}) {
  if (verification.verified) {
    return (
      <Alert tone="success" role="status" title="Payment evidence recorded">
        Verified {formatDateTime(verification.verifiedAt)}
        {verification.replayed ? ' (replayed — this evidence was already recorded)' : ''}. Evidence is a receipt, not
        an activation: the account stays on free-plan limits until an operator authorizes the activation out of band.
      </Alert>
    );
  }
  const reason = verification.failureReason;
  return (
    <Alert tone="warning" role="status" title="Payment not verified">
      {reason !== null
        ? (mode === 'live'
            ? BILLING_VERIFICATION_FAILURE_COPY_LIVE[reason] ?? BILLING_VERIFICATION_FAILURE_COPY[reason]
            : BILLING_VERIFICATION_FAILURE_COPY[reason])
        : verification.failureMessage ?? 'Verification failed.'}
      {reason !== null ? <span className="ml-1 font-mono text-[11px]">({reason})</span> : null}
      {' '}
      No evidence was recorded and no entitlement changed.
    </Alert>
  );
}

function DisclosureRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded bg-ink-850 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className={`mt-0.5 break-all text-ink-200 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
