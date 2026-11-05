/**
 * Provider-request budget signal for bounded, caller-owned fetch loops.
 *
 * WHY THIS IS ITS OWN MODULE. The scheduled warm cycle passes a
 * `beforeProviderRequest` guard into `IngestionService.getCandles()` so it can
 * stop before spending another provider credit. That guard is the *caller's*
 * control signal, not a provider outcome:
 *
 *  - it must not be mapped to a provider error (`provider_unavailable` /
 *    `rate_limited`) by the ingestion layer, which would make a planned stop
 *    look like a broken provider;
 *  - it must not be recorded as a failed `fetch_through` run row;
 *  - it must stay distinguishable from a genuine provider rate limit (`429`),
 *    which really does require a cooldown and an alarm.
 *
 * The class therefore lives here — imported by both the ingestion layer and the
 * scheduled-ingestion service — instead of inside either of them.
 */
export class ProviderBudgetExhaustedError extends Error {
  constructor(readonly budget: number) {
    super(`Scheduled ingestion provider request budget (${budget}) exhausted`);
    this.name = 'ProviderBudgetExhaustedError';
  }
}
