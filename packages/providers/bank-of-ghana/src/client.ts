import { createHash } from 'node:crypto';
import {
  FX_SOURCE_BANK_OF_GHANA_HOST,
  FX_SOURCE_BANK_OF_GHANA_URL,
  type FxSourceFailureReason,
} from '@veltrixeye/contracts';

/**
 * Bank of Ghana FX **source client** — READ-ONLY retrieval of the published
 * daily interbank FX rates page.
 *
 * This module is the ONLY place in the repository that performs an outbound
 * call to the Bank of Ghana, and it is deliberately narrow:
 *
 *  * ONE host and ONE URL, both constants from `@veltrixeye/contracts`
 *    (`FX_SOURCE_BANK_OF_GHANA_URL`). There is no base-URL setting, no path
 *    parameter and no environment variable: no deployment, test or caller can
 *    point it at another host. Third-party mirrors of the same figures are NOT
 *    this source.
 *  * GET only, ONE attempt, no retry, no request body. A retry is a scheduling
 *    decision made above this layer (the next check), never a hidden loop here.
 *  * NO credential, NO cookie, NO referrer and NO custom header carrying
 *    identity: the published page is public and needs none. The only headers
 *    sent are `accept`, a static `user-agent` and `accept-language`.
 *  * Redirects are REFUSED, not followed (`redirect: 'manual'`): a 3xx is
 *    reported as `redirect_refused`, so a redirect to a different host can
 *    never be treated as the publisher's own response.
 *  * The response is bounded and must declare itself HTML. A JSON API, a PDF,
 *    an error page served as text/plain or an oversized body is refused
 *    (`unsupported_content_type` / `body_too_large`) rather than parsed on the
 *    chance that it contains a number.
 *  * It interprets NOTHING. The decoded body is handed to `parse.ts`, and the
 *    only facts that travel upward are the URL, the retrieval instant, the
 *    HTTP status and a SHA-256 digest of the exact bytes received. The response
 *    body itself never leaves this layer — it is neither returned to a caller
 *    nor logged.
 *
 * Every outcome is a typed VALUE (`fetchDailyFxRatesPage` never throws for a
 * transport or response problem): the caller must decide what a failure means,
 * and "we could not read the page" is a reportable state, not an exception that
 * a scheduler retries into a rate.
 */

/** The only URL this client requests. Re-exported for tests and assertions. */
export const BOG_DAILY_FX_URL = FX_SOURCE_BANK_OF_GHANA_URL;

/** The only host this client may reach. */
export const BOG_HOST = FX_SOURCE_BANK_OF_GHANA_HOST;

/** Hard ceiling on the decoded body we are willing to consider. */
export const BOG_MAX_BODY_BYTES = 512 * 1024;

/** The only content types accepted (the published page is HTML). */
export const BOG_ACCEPTED_CONTENT_TYPES: readonly string[] = Object.freeze(['text/html']);

/** Sent as `accept`; the page is public HTML. */
const ACCEPT_HEADER = 'text/html';

/** Static, non-identifying user agent. Never derived from configuration. */
const USER_AGENT = 'VeltrixEye-FXSourceReader/1.0 (read-only; billing FX observation)';

/** Sent so the publisher's locale-formatted date column is stable. */
const ACCEPT_LANGUAGE = 'en-GH,en;q=0.9';

/**
 * Injected transport. The production default is the global `fetch`; every test
 * injects a stub that records the call and returns a canned response, so the
 * suite never opens a socket.
 *
 * `redirect` is always `'manual'` (see the module header); a transport that
 * ignores it cannot be prevented from following a redirect, which is exactly
 * why a 3xx response is refused by status rather than trusted.
 */
export type BogFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null } | undefined;
  text(): Promise<string>;
}>;

export interface BogClientConfig {
  /** Per-request timeout in ms. Required — there is no hidden default. */
  timeoutMs: number;
  /** Injected transport. Defaults to the global `fetch`. */
  fetchFn?: BogFetchFn;
  /** Injected clock for the retrieval instant (defaults to real time). */
  clock?: () => Date;
}

export interface BogPageRetrieved {
  readonly outcome: 'retrieved';
  readonly url: string;
  readonly status: number;
  readonly retrievedAt: Date;
  /** SHA-256 of the decoded body — the immutable evidence of WHAT was read. */
  readonly bodyDigest: string;
  /**
   * The decoded page. Internal to this layer: consumed by the extractor and
   * never returned to a caller, persisted or logged.
   */
  readonly body: string;
}

export interface BogPageUnavailable {
  readonly outcome: 'unavailable';
  readonly url: string;
  readonly status: number | null;
  readonly retrievedAt: Date;
  readonly reason: FxSourceFailureReason;
  /** Short, bounded, non-secret description (no response body, no headers). */
  readonly detail: string;
}

export type BogPageResult = BogPageRetrieved | BogPageUnavailable;

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Extract the media type, lowercased and without parameters. */
function mediaTypeOf(contentType: string | null): string {
  if (contentType === null) return '';
  const [mediaType] = contentType.split(';');
  return (mediaType ?? '').trim().toLowerCase();
}

function isAcceptedMediaType(mediaType: string): boolean {
  return BOG_ACCEPTED_CONTENT_TYPES.some((accepted) => mediaType === accepted);
}

export class BogSourceClient {
  private readonly fetchFn: BogFetchFn;
  private readonly clock: () => Date;

  constructor(private readonly config: BogClientConfig) {
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new TypeError('A positive, finite timeoutMs is required to read the FX source page.');
    }
    this.fetchFn =
      config.fetchFn ??
      ((url, init) =>
        fetch(url, init) as unknown as ReturnType<BogFetchFn>);
    this.clock = config.clock ?? (() => new Date());
  }

  /**
   * Read the published page ONCE. Returns a typed outcome for every transport,
   * status, header and size condition; throws only if the injected transport
   * misbehaves in a way that is not a transport error (a programming fault).
   */
  async fetchDailyFxRatesPage(): Promise<BogPageResult> {
    const url = BOG_DAILY_FX_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const unavailable = (
      reason: FxSourceFailureReason,
      detail: string,
      status: number | null = null,
    ): BogPageUnavailable => ({
      outcome: 'unavailable',
      url,
      status,
      retrievedAt: this.clock(),
      reason,
      detail,
    });

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          accept: ACCEPT_HEADER,
          'accept-language': ACCEPT_LANGUAGE,
          'user-agent': USER_AGENT,
        },
        redirect: 'manual',
        signal: controller.signal,
      });

      const status = response.status;
      const retrievedAt = this.clock();

      // Redirects are refused before anything else: a 3xx means the response we
      // hold is not the publisher's own document.
      if (status >= 300 && status < 400) {
        return {
          outcome: 'unavailable',
          url,
          status,
          retrievedAt,
          reason: 'redirect_refused',
          detail: `The source answered ${status} (a redirect); only the publisher's own ${BOG_HOST} document is accepted, so the response was not followed.`,
        };
      }
      if (status !== 200) {
        return {
          outcome: 'unavailable',
          url,
          status,
          retrievedAt,
          reason: 'http_status',
          detail: `The source answered HTTP ${status}; only a 200 from the publisher is an observation.`,
        };
      }

      const mediaType = mediaTypeOf(response.headers?.get('content-type') ?? null);
      if (!isAcceptedMediaType(mediaType)) {
        return {
          outcome: 'unavailable',
          url,
          status,
          retrievedAt,
          reason: 'unsupported_content_type',
          detail:
            mediaType === ''
              ? 'The source response declared no content type; the published HTML page is the only accepted response.'
              : `The source response declared "${mediaType}"; the published HTML page is the only accepted response.`,
        };
      }

      const declaredLength = response.headers?.get('content-length') ?? null;
      if (declaredLength !== null && /^[0-9]+$/.test(declaredLength.trim())) {
        const declared = Number.parseInt(declaredLength.trim(), 10);
        if (declared > BOG_MAX_BODY_BYTES) {
          return {
            outcome: 'unavailable',
            url,
            status,
            retrievedAt,
            reason: 'body_too_large',
            detail: `The source declared ${declared} bytes; at most ${BOG_MAX_BODY_BYTES} are accepted.`,
          };
        }
      }

      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > BOG_MAX_BODY_BYTES) {
        return {
          outcome: 'unavailable',
          url,
          status,
          retrievedAt,
          reason: 'body_too_large',
          detail: `The source body exceeds ${BOG_MAX_BODY_BYTES} bytes; an oversized response is not parsed.`,
        };
      }

      return {
        outcome: 'retrieved',
        url,
        status,
        retrievedAt,
        bodyDigest: digest(body),
        body,
      };
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error !== null &&
          typeof error === 'object' &&
          ((error as { name?: unknown }).name === 'AbortError' ||
            (error as { name?: unknown }).name === 'TimeoutError'));
      if (aborted) {
        return unavailable(
          'timeout',
          `The source did not answer within ${this.config.timeoutMs}ms; the attempt was aborted and is not retried.`,
        );
      }
      // A transport fault is reported as a state, never as a rate. The message
      // is not echoed: it can carry a host, a port or a proxy URL.
      return unavailable(
        'network',
        'The source could not be reached; the transport failed before a response was received.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convenience factory (keeps the constructor contract explicit at call sites). */
export function createBogSourceClient(config: BogClientConfig): BogSourceClient {
  return new BogSourceClient(config);
}

/** Exposed so tests can prove the digest is over the exact bytes received. */
export const bogBodyDigest = digest;
