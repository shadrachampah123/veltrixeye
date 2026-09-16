import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationProvider, NotificationSendRequest, NotificationSendResult } from './provider.js';
import { describeError } from './redact.js';

/**
 * The `email` channel adapter (M7.3): SMTP submission.
 *
 * Why SMTP: it is the one transport every operator can configure later
 * (their own Postfix, or any transactional vendor's SMTP endpoint — Postmark,
 * SendGrid, Mailgun, SES…). It needs no vendor SDK, no new service account
 * type and no code change to switch: only `SMTP_HOST` / `SMTP_PORT` /
 * `SMTP_USER` / `SMTP_PASS` / `NOTIFICATION_FROM`.
 *
 * Hard rules this adapter follows:
 *  - **No credentials, ever, outside this module.** They arrive from the API's
 *    environment, are held in a closure, and are never returned by
 *    `describe()`, never logged and never included in an error string
 *    (`describeError` redacts the password out of provider messages).
 *  - **Honest `configured`.** False when the host or the From address is
 *    missing, so the worker records `unavailable` instead of inventing a
 *    delivery.
 *  - **No connection at construction.** The transporter is created lazily on
 *    the first send, so an unconfigured deployment performs zero network I/O
 *    (the alert-generation path proves this in tests).
 *  - **Stable `Message-ID`.** The job's idempotency key is sent as the message
 *    id, so a retry after a timeout can be de-duplicated by the receiver.
 *  - **STARTTLS is required** on the plain port; implicit TLS on 465.
 */

export interface SmtpEmailConfig {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465). When false, STARTTLS is required. */
  secure: boolean;
  user: string;
  pass: string;
  /** Envelope/From address, e.g. `VeltrixEye Alerts <alerts@example.com>`. */
  from: string;
}

export interface SmtpEmailProvider extends NotificationProvider {
  readonly channel: 'email';
}

/** The adapter name recorded in `notification_deliveries.provider`. */
export const SMTP_PROVIDER_NAME = 'smtp';

/** An SMTP host AND a From address are the minimum for a usable adapter. */
export function isSmtpConfigured(config: SmtpEmailConfig): boolean {
  return config.host.trim() !== '' && config.from.trim() !== '';
}

export function createSmtpEmailProvider(config: SmtpEmailConfig): SmtpEmailProvider {
  let transporter: Transporter | null = null;

  /** Lazily built: constructing a transporter opens no socket. */
  function getTransporter(timeoutMs: number): Transporter {
    if (transporter) return transporter;
    const secure = config.secure;
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure,
      // Never fall back to plaintext: on the plain port, STARTTLS is mandatory.
      requireTLS: !secure,
      auth: config.user !== '' ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    return transporter;
  }

  const configured = isSmtpConfigured(config);
  // Everything an operator may see. `pass` is deliberately absent, and it is
  // also redacted out of any provider error text.
  const secrets: string[] = [config.pass, config.user].filter((v) => v.length > 3);

  return {
    channel: 'email',
    name: SMTP_PROVIDER_NAME,
    configured,

    describe(): Record<string, unknown> {
      return {
        channel: 'email',
        provider: SMTP_PROVIDER_NAME,
        configured,
        host: config.host,
        port: config.port,
        secure: config.secure,
        from: config.from,
        auth: config.user !== '',
      };
    },

    async send(request: NotificationSendRequest): Promise<NotificationSendResult> {
      if (!configured) {
        return {
          outcome: 'unavailable',
          failureCategory: 'configuration',
          error: 'email provider is not configured (SMTP host or From address missing)',
        };
      }
      if (request.recipient.trim() === '') {
        return {
          outcome: 'permanent',
          failureCategory: 'permanent',
          error: 'recipient address is missing',
        };
      }

      try {
        const info = await getTransporter(request.timeoutMs).sendMail({
          from: config.from,
          to: request.recipient,
          subject: request.payload.subject,
          text: request.payload.text,
          // Stable across retries: the receiver can collapse a duplicate.
          messageId: buildMessageId(request.idempotencyKey, config.from),
          headers: {
            'X-VeltrixEye-Job-Id': request.jobId,
            'X-VeltrixEye-Idempotency-Key': request.idempotencyKey,
            'X-VeltrixEye-Template': request.template,
            // Machine-generated mail: suppress auto-replies and vacation bots.
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
          },
        });
        return {
          outcome: 'delivered',
          providerMessageId: typeof info?.messageId === 'string' ? info.messageId.slice(0, 320) : null,
          providerResponseCode: responseCodeOf(info?.response),
        };
      } catch (err) {
        const classified = classifySmtpError(err, secrets);
        return {
          outcome: classified.outcome,
          failureCategory: classified.failureCategory,
          providerResponseCode: classified.responseCode,
          error: classified.error,
        };
      }
    },
  };
}

/**
 * `Message-Id` for the job: `<sha256(idempotency key)@from-domain>`.
 * Deterministic, unique per job and stable across retries.
 */
export function buildMessageId(idempotencyKey: string, from: string): string {
  const domain = from.split('@').at(-1)?.replace(/[>\s]+$/g, '') ?? '';
  const host = domain !== '' && domain.includes('.') ? domain : 'veltrixeye.local';
  return `<${idempotencyKey}@${host}>`;
}

/** SMTP reply code → short string (`250`, `550`), null when absent. */
function responseCodeOf(response: unknown): string | null {
  if (typeof response === 'number') return String(response);
  if (typeof response !== 'string') return null;
  const match = /^[1-5]\d\d/.exec(response.trim());
  return match ? match[0] : response.slice(0, 16);
}

interface SmtpErrorShape {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  command?: unknown;
}

/**
 * Map an SMTP failure to a delivery outcome.
 *
 * Classification is what makes retries *bounded and meaningful*: transient
 * network/server faults are retried with backoff, permanent rejections
 * (unknown recipient, refused content) are dead-lettered immediately instead
 * of burning the retry budget, and configuration faults are reported as
 * `unavailable` so they are fixed by configuration rather than by retrying.
 */
export function classifySmtpError(
  err: unknown,
  secrets: readonly string[] = [],
): { outcome: NotificationSendResult['outcome']; failureCategory: NonNullable<NotificationSendResult['failureCategory']>; responseCode: string | null; error: string } {
  const shape = (err !== null && typeof err === 'object' ? err : {}) as SmtpErrorShape;
  const code = typeof shape.code === 'string' ? shape.code : '';
  const responseCode = responseCodeOf(shape.responseCode ?? shape.response);
  const message = describeError(err, secrets);

  // Authentication/configuration: retrying cannot fix it.
  if (code === 'EAUTH' || (responseCode !== null && ['530', '534', '535', '538'].includes(responseCode))) {
    return { outcome: 'unavailable', failureCategory: 'configuration', responseCode, error: message };
  }

  // Message/envelope rejected: the mail itself will never be accepted.
  if (code === 'EMESSAGE' || code === 'EENVELOPE') {
    return { outcome: 'permanent', failureCategory: 'permanent', responseCode, error: message };
  }

  // Timeouts (socket/greeting/connection) — the provider may still have
  // accepted it, hence the stable Message-Id rather than a blind re-send.
  if (code === 'ETIMEDOUT' || (code === 'ESOCKET' && /timeout/i.test(message))) {
    return { outcome: 'timeout', failureCategory: 'timeout', responseCode, error: message };
  }

  // 5xx from the server: permanent rejection (bad recipient, policy refusal).
  if (responseCode !== null && responseCode.startsWith('5')) {
    return { outcome: 'permanent', failureCategory: 'permanent', responseCode, error: message };
  }

  // 4xx (greylisting, mailbox busy) and every transport-level fault
  // (DNS/connection/reset) are temporary: retry them with backoff.
  return { outcome: 'retryable', failureCategory: 'transient', responseCode, error: message };
}
