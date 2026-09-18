import { createHmac } from 'node:crypto';
import type { NotificationProvider, NotificationSendRequest, NotificationSendResult } from './provider.js';
import { resolveWebhookDestination, type ResolvedWebhookDestination } from './webhook-security.js';
import { postPinnedHttps, type WebhookTransportResponse } from './webhook-transport.js';

export const WEBHOOK_PROVIDER_NAME = 'webhook';

export interface WebhookProviderConfig {
  timeoutMs?: number;
  /** Optional fixed signing secret for deployments that use one endpoint. */
  signingSecret?: string;
  /** Test-only transport seam; production uses the pinned HTTPS transport. */
  transport?: (destination: ResolvedWebhookDestination, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<WebhookTransportResponse>;
}

export interface WebhookNotificationProvider extends NotificationProvider {
  readonly channel: 'webhook';
}

/** Generic HTTPS JSON webhook adapter. Endpoint selection comes from the job recipient. */
export function createWebhookNotificationProvider(config: WebhookProviderConfig = {}): WebhookNotificationProvider {
  const timeoutMs = config.timeoutMs ?? 15_000;
  return {
    channel: 'webhook',
    name: WEBHOOK_PROVIDER_NAME,
    configured: true,
    describe: () => ({ channel: 'webhook', provider: WEBHOOK_PROVIDER_NAME, configured: true }),
    async send(request: NotificationSendRequest): Promise<NotificationSendResult> {
      const deadline = Date.now() + Math.max(1, Math.min(request.timeoutMs, timeoutMs));
      let destination: ResolvedWebhookDestination;
      try {
        destination = await resolveWebhookDestination(request.recipient, Math.max(1, deadline - Date.now()));
      } catch (err) {
        if (/timed out/i.test(err instanceof Error ? err.message : '')) {
          return { outcome: 'timeout', failureCategory: 'timeout', error: 'webhook DNS lookup timed out' };
        }
        return { outcome: 'permanent', failureCategory: 'permanent', error: 'webhook destination validation failed' };
      }
      try {
        const body = JSON.stringify({
          idempotencyKey: request.idempotencyKey,
          template: request.template,
          subject: request.payload.subject,
          text: request.payload.text,
          data: request.payload.data,
        });
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'user-agent': 'VeltrixEye-Webhook/1',
          'x-veltrixeye-idempotency-key': request.idempotencyKey,
        };
        const secret = request.signingSecret ?? config.signingSecret;
        if (secret) headers['x-veltrixeye-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
        const transport = config.transport ?? postPinnedHttps;
        const remaining = Math.max(1, deadline - Date.now());
        const response = await transport(destination, body, headers, remaining);
        const code = String(response.statusCode);
        if (response.statusCode >= 200 && response.statusCode < 300) return { outcome: 'delivered', providerResponseCode: code };
        if (response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500) {
          return { outcome: 'retryable', failureCategory: 'transient', providerResponseCode: code, error: `webhook returned ${code}` };
        }
        return { outcome: 'permanent', failureCategory: 'permanent', providerResponseCode: code, error: `webhook returned ${code}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (/timed out/i.test(message)) return { outcome: 'timeout', failureCategory: 'timeout', error: 'webhook request timed out' };
        return { outcome: 'retryable', failureCategory: 'transient', error: 'webhook request failed' };
      }
    },
  };
}
