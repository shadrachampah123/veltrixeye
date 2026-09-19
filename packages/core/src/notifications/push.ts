import type { NotificationProvider, NotificationSendRequest, NotificationSendResult } from './provider.js';
import { describeError } from './redact.js';

export const PUSH_PROVIDER_NAME = 'push';

export interface PushProviderConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
  timeoutMs?: number;
  /** Test-only transport seam; production uses web-push */
  transport?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; timeout: number },
  ) => Promise<{ statusCode: number }>;
}

export interface PushNotificationProvider extends NotificationProvider {
  readonly channel: 'push';
}

/**
 * Web Push provider (M9.2) — delivers via Web Push protocol with VAPID.
 *
 * Security:
 * - VAPID private key never appears in describe(), logs, errors, audit.
 * - Subscription keys (p256dh, auth) are redacted from errors.
 * - Endpoint must be HTTPS, validated.
 * - Outcome mapping: 200/201 delivered, 404/410 permanent (gone), 429 retryable, 5xx retryable, timeout/network retryable.
 */

function isPushConfigured(config: PushProviderConfig): boolean {
  return (
    typeof config.vapidPublicKey === 'string' &&
    config.vapidPublicKey.trim() !== '' &&
    typeof config.vapidPrivateKey === 'string' &&
    config.vapidPrivateKey.trim() !== '' &&
    typeof config.subject === 'string' &&
    config.subject.trim() !== ''
  );
}

function parseSubscription(recipient: string, signingSecret: string | null): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  if (!recipient || !recipient.startsWith('https://')) return null;
  if (!signingSecret) return null;
  try {
    const parsed = JSON.parse(signingSecret);
    if (!parsed || typeof parsed !== 'object') return null;
    const p256dh = (parsed as { p256dh?: unknown }).p256dh;
    const auth = (parsed as { auth?: unknown }).auth;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
    if (p256dh.length < 20 || auth.length < 10) return null;
    // Basic base64url check
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
    return { endpoint: recipient, keys: { p256dh, auth } };
  } catch {
    return null;
  }
}

export function createPushNotificationProvider(config: PushProviderConfig): PushNotificationProvider {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const configured = isPushConfigured(config);
  // Secrets for redaction — private key + we will add subscription keys at send time via describeError
  const secrets = [config.vapidPrivateKey].filter((v) => typeof v === 'string' && v.length > 3);

  return {
    channel: 'push',
    name: PUSH_PROVIDER_NAME,
    configured,

    describe(): Record<string, unknown> {
      return {
        channel: 'push',
        provider: PUSH_PROVIDER_NAME,
        configured,
        subject: config.subject,
        hasPublicKey: config.vapidPublicKey.trim() !== '',
        // private key NEVER in describe
      };
    },

    async send(request: NotificationSendRequest): Promise<NotificationSendResult> {
      if (!configured) {
        return {
          outcome: 'unavailable',
          failureCategory: 'configuration',
          error: 'push provider is not configured (VAPID keys or subject missing)',
        };
      }

      if (!request.recipient || !request.recipient.startsWith('https://')) {
        return {
          outcome: 'permanent',
          failureCategory: 'permanent',
          error: 'push endpoint must use HTTPS',
        };
      }

      const subscription = parseSubscription(request.recipient, request.signingSecret ?? null);
      if (!subscription) {
        return {
          outcome: 'permanent',
          failureCategory: 'permanent',
          error: 'push subscription is invalid or missing keys',
        };
      }

      // Build payload — same as webhook/email: subject + text + data
      const payload = JSON.stringify({
        idempotencyKey: request.idempotencyKey,
        template: request.template,
        subject: request.payload.subject,
        text: request.payload.text,
        data: request.payload.data,
      });

      try {
        let result: { statusCode: number };
        if (config.transport) {
          result = await config.transport(subscription, payload, {
            vapidDetails: {
              subject: config.subject,
              publicKey: config.vapidPublicKey,
              privateKey: config.vapidPrivateKey,
            },
            timeout: Math.min(request.timeoutMs, timeoutMs),
          });
        } else {
          // Dynamic import to avoid loading web-push in tests that use transport seam
          const webPush = await import('web-push');
          // web-push expects VAPID details set globally or per send
          // Use sendNotification with options
          try {
            const sendResult = await webPush.default.sendNotification(
              subscription as never,
              payload,
              {
                vapidDetails: {
                  subject: config.subject,
                  publicKey: config.vapidPublicKey,
                  privateKey: config.vapidPrivateKey,
                },
                timeout: Math.min(request.timeoutMs, timeoutMs),
              } as never,
            );
            result = { statusCode: (sendResult as { statusCode?: number })?.statusCode ?? 201 };
          } catch (err) {
            // web-push throws WebPushError with statusCode
            const e = err as { statusCode?: number; message?: string };
            if (typeof e.statusCode === 'number') {
              result = { statusCode: e.statusCode };
              // Re-throw as outcome handling below if needed, but we have statusCode
              // For 404/410 we want permanent, so handle via result
              const code = String(e.statusCode);
              if (e.statusCode === 404 || e.statusCode === 410) {
                return {
                  outcome: 'permanent',
                  failureCategory: 'permanent',
                  providerResponseCode: code,
                  error: 'push subscription expired or not found',
                };
              }
              if (e.statusCode === 429 || e.statusCode >= 500) {
                return {
                  outcome: 'retryable',
                  failureCategory: 'transient',
                  providerResponseCode: code,
                  error: `push provider returned ${code}`,
                };
              }
              // Other 4xx permanent
              if (e.statusCode >= 400 && e.statusCode < 500) {
                return {
                  outcome: 'permanent',
                  failureCategory: 'permanent',
                  providerResponseCode: code,
                  error: `push provider returned ${code}`,
                };
              }
              // Fall through
            }
            // If not a statusCode error, treat as retryable
            throw err;
          }
        }

        const code = String(result.statusCode);
        if (result.statusCode === 201 || (result.statusCode >= 200 && result.statusCode < 300)) {
          return { outcome: 'delivered', providerResponseCode: code };
        }
        if (result.statusCode === 404 || result.statusCode === 410) {
          return {
            outcome: 'permanent',
            failureCategory: 'permanent',
            providerResponseCode: code,
            error: 'push subscription expired or not found',
          };
        }
        if (result.statusCode === 429 || result.statusCode >= 500) {
          return {
            outcome: 'retryable',
            failureCategory: 'transient',
            providerResponseCode: code,
            error: `push provider returned ${code}`,
          };
        }
        // Other 4xx permanent
        return {
          outcome: 'permanent',
          failureCategory: 'permanent',
          providerResponseCode: code,
          error: `push provider returned ${code}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (/timed out/i.test(message)) {
          return { outcome: 'timeout', failureCategory: 'timeout', error: 'push request timed out' };
        }
        // Redact secrets from error
        const redacted = describeError(err, [...secrets, subscription?.keys.p256dh, subscription?.keys.auth]);
        return { outcome: 'retryable', failureCategory: 'transient', error: redacted };
      }
    },
  };
}
