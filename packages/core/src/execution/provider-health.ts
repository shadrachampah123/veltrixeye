import { isExplicitTrue, PROVIDER_HEALTH_STATES, type ExecutionProviderHealth, type ProviderHealthState } from '@veltrixeye/contracts';

/**
 * Gate 10 — the only shape of provider health that leaves the service layer.
 *
 * Adapters own `ExecutionProviderHealth`, and a future adapter (or a bug in
 * one) could place provider-controlled text in `reason` or arbitrary data in
 * `detail`. Every API response and every persisted record therefore goes
 * through this projection instead of returning the adapter object verbatim:
 * strict booleans, the closed state enum, a machine-token reason (or null)
 * and a timestamp. `detail` is never projected.
 */
export interface SafeExecutionProviderHealth {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  available: boolean;
  healthy: boolean;
  state: ProviderHealthState;
  reason: string | null;
  checkedAt: string;
}

/** Reason emitted when no provider is registered for the requested id. */
export const PROVIDER_MISSING_REASON = 'provider_missing';

/** Reasons are stable machine tokens (`mt5_transport_unconfigured`, …); free text is withheld. */
const HEALTH_REASON_TOKEN = /^[a-z0-9_]{1,64}$/;

export function toSafeProviderHealth(health: ExecutionProviderHealth | null | undefined, now: () => Date = () => new Date()): SafeExecutionProviderHealth {
  if (!health) {
    return { configured: false, authenticated: false, connected: false, available: false, healthy: false, state: 'unavailable', reason: PROVIDER_MISSING_REASON, checkedAt: now().toISOString() };
  }
  const state = (PROVIDER_HEALTH_STATES as readonly string[]).includes(health.state) ? health.state : 'unavailable';
  const checkedAt = typeof health.checkedAt === 'string' && Number.isFinite(Date.parse(health.checkedAt)) ? health.checkedAt : now().toISOString();
  return {
    // Gate 9 §26: `isExplicitTrue` is the same predicate the execution path
    // resolves through, so a projection cannot disagree with a readiness
    // decision about what "true" means.
    configured: isExplicitTrue(health.configured),
    authenticated: isExplicitTrue(health.authenticated),
    connected: isExplicitTrue(health.connected),
    available: isExplicitTrue(health.available),
    healthy: isExplicitTrue(health.healthy),
    state,
    reason: typeof health.reason === 'string' && HEALTH_REASON_TOKEN.test(health.reason) ? health.reason : null,
    checkedAt,
  };
}
