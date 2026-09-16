import type {
  AlertNotificationPayload,
  NotificationChannel,
  NotificationFailureCategory,
} from '@veltrixeye/contracts';

/**
 * The provider/adapter boundary for alert delivery (M7.3).
 *
 * This interface is the ONLY place that knows an external notification
 * service exists. Everything above it — the strategy engine, the alert
 * service, the outbox and the worker — speaks in channels, payloads and
 * outcomes, never in SMTP/HTTP/vendor vocabulary:
 *
 *   alert → outbox row → worker → NotificationProvider.send() → outcome
 *
 * Adding a channel (push, webhook, SMS, another vendor) is therefore additive:
 * implement this interface, register it at boot, and extend the channel enum.
 * Nothing else in the repository changes.
 *
 * Two rules every adapter must honour:
 *  - **`configured` is honest.** It is false when credentials are missing, and
 *    the worker then records `unavailable` instead of pretending to deliver.
 *  - **errors are redacted by the adapter**, because only the adapter knows
 *    which strings are secrets (`describeError(err, [config.pass])`).
 */

/** How the worker must treat one attempt. */
export type NotificationOutcome =
  /** the provider accepted the message */
  | 'delivered'
  /** temporary failure — try again after backoff */
  | 'retryable'
  /** the provider did not answer in time — try again after backoff */
  | 'timeout'
  /** permanent rejection (bad recipient, content refused) — dead-letter */
  | 'permanent'
  /** no usable configuration — record `unavailable`, never retry blindly */
  | 'unavailable';

export interface NotificationSendRequest {
  /** Outbox job id (log/trace correlation). */
  jobId: string;
  /**
   * Stable across every retry of this job. A provider MUST send it upstream
   * (for email: the `Message-ID`) so a receiver can collapse a duplicate
   * caused by a timeout *after* the provider accepted the message.
   */
  idempotencyKey: string;
  channel: NotificationChannel;
  /** Destination for the channel (an email address for `email`). */
  recipient: string;
  /** Renderer identifier, e.g. `alert.email.v1`. */
  template: string;
  /** Server-rendered content — never caller-supplied. */
  payload: AlertNotificationPayload;
  /** 1-based attempt number (for logging / upstream hints). */
  attempt: number;
  /** Per-attempt budget; the adapter aborts and reports `timeout` past it. */
  timeoutMs: number;
}

export interface NotificationSendResult {
  outcome: NotificationOutcome;
  /** Upstream identifier (SMTP `Message-ID`), for traceability. */
  providerMessageId?: string | null;
  /** Upstream status code (`250`, `550`, …) when the provider reports one. */
  providerResponseCode?: string | null;
  /**
   * Short, redacted failure summary. Stored in `last_error` and logged; never
   * returned to a browser and never containing a credential.
   */
  error?: string | null;
  /** Overrides the worker's default category when the provider knows better. */
  failureCategory?: NotificationFailureCategory;
}

export interface NotificationProvider {
  /** The channel this adapter serves. */
  readonly channel: NotificationChannel;
  /** Short adapter name for logs/rows (`smtp`). */
  readonly name: string;
  /** True only when the adapter has everything it needs to send. */
  readonly configured: boolean;
  /**
   * Operator-safe description for boot logs. MUST NOT contain credentials —
   * tests assert the rendered description of the SMTP adapter never contains
   * its password.
   */
  describe(): Record<string, unknown>;
  send(request: NotificationSendRequest): Promise<NotificationSendResult>;
}

export interface RegisteredNotificationProviderInfo {
  channel: NotificationChannel;
  name: string;
  configured: boolean;
}

/**
 * Runtime registry of notification providers, keyed by channel. Mirrors the
 * M1 market-data registry: the core resolves delivery through the registry so
 * no service ever imports a concrete adapter.
 */
export class NotificationProviderRegistry {
  private readonly providers = new Map<NotificationChannel, NotificationProvider>();

  register(provider: NotificationProvider): void {
    if (this.providers.has(provider.channel)) {
      throw new Error(`A notification provider is already registered for channel "${provider.channel}"`);
    }
    this.providers.set(provider.channel, provider);
  }

  get(channel: NotificationChannel): NotificationProvider | undefined {
    return this.providers.get(channel);
  }

  /** Channels that have a configured (credentialed) adapter right now. */
  configuredChannels(): NotificationChannel[] {
    return [...this.providers.values()].filter((p) => p.configured).map((p) => p.channel);
  }

  list(): RegisteredNotificationProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      channel: p.channel,
      name: p.name,
      configured: p.configured,
    }));
  }

  get size(): number {
    return this.providers.size;
  }
}

export function createNotificationProviderRegistry(): NotificationProviderRegistry {
  return new NotificationProviderRegistry();
}
