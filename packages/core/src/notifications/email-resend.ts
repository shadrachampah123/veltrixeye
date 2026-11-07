import type { NotificationProvider, NotificationSendRequest, NotificationSendResult } from './provider.js';

/**
 * Resend HTTP API adapter. Uses HTTPS (port 443), so it works on Render Free
 * where outbound SMTP ports 25/465/587 are blocked.
 */
export interface ResendEmailConfig {
  apiKey: string;
  from: string;
}

export const RESEND_PROVIDER_NAME = 'resend';

export function isResendConfigured(config: ResendEmailConfig): boolean {
  return config.apiKey.trim() !== '' && config.from.trim() !== '';
}

export function createResendEmailProvider(
  config: ResendEmailConfig,
  fetchImpl: typeof fetch = fetch,
): NotificationProvider {
  const configured = isResendConfigured(config);

  return {
    channel: 'email',
    name: RESEND_PROVIDER_NAME,
    configured,
    describe(): Record<string, unknown> {
      return {
        channel: 'email',
        provider: RESEND_PROVIDER_NAME,
        configured,
        from: config.from,
        transport: 'https',
      };
    },
    async send(request: NotificationSendRequest): Promise<NotificationSendResult> {
      if (!configured) {
        return { outcome: 'unavailable', failureCategory: 'configuration', error: 'Resend is not configured' };
      }
      if (!request.recipient.trim()) {
        return { outcome: 'permanent', failureCategory: 'permanent', error: 'recipient address is missing' };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [request.recipient],
            subject: request.payload.subject,
            text: request.payload.text,
            headers: {
              'X-VeltrixEye-Job-Id': request.jobId,
              'X-VeltrixEye-Template': request.template,
              'Auto-Submitted': 'auto-generated',
              'X-Auto-Response-Suppress': 'All',
            },
          }),
          signal: controller.signal,
        });

        const body = await response.json().catch(() => null) as { id?: unknown } | null;
        if (response.ok) {
          return {
            outcome: 'delivered',
            providerMessageId: typeof body?.id === 'string' ? body.id.slice(0, 320) : null,
            providerResponseCode: String(response.status),
          };
        }
        const code = String(response.status);
        // Never persist provider-supplied error text: keep diagnostics bounded
        // and make credential echo/leakage impossible at this boundary.
        const error = `Resend rejected request (HTTP ${code})`;
        if (response.status === 401 || response.status === 403) {
          // A configured key rejected by Resend is not the same as missing
          // provider configuration. Park this job as a permanent failure:
          // `unavailable` rows are automatically re-queued when a provider is
          // configured, which would otherwise retry a bad key on every worker
          // cycle and reset attempts indefinitely. Correct the key, then
          // explicitly recover the failed job after correcting the key.
          return { outcome: 'permanent', failureCategory: 'configuration', providerResponseCode: code, error };
        }
        if (response.status === 400 || response.status === 422) {
          return { outcome: 'permanent', failureCategory: 'permanent', providerResponseCode: code, error };
        }
        return { outcome: 'retryable', failureCategory: 'transient', providerResponseCode: code, error };
      } catch (err) {
        const timedOut = controller.signal.aborted ||
          (err !== null && typeof err === 'object' && 'name' in err && err.name === 'AbortError');
        return {
          outcome: timedOut ? 'timeout' : 'retryable',
          failureCategory: timedOut ? 'timeout' : 'transient',
          error: timedOut ? 'Resend request timed out' : 'Resend request failed',
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

