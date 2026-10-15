import {
  FX_SOURCE_BANK_OF_GHANA,
  FX_SOURCE_BANK_OF_GHANA_URL,
  type FxSourceFailureReason,
  type FxSourceId,
} from '@veltrixeye/contracts';
import { BogSourceClient, type BogFetchFn } from './client.js';
import { extractUsdGhsRow, type BogRateRowTexts } from './parse.js';

/**
 * The Bank of Ghana USD→GHS **source reader**: one retrieval, one extraction,
 * one typed outcome.
 *
 * This is the seam the platform's observation layer consumes. It performs the
 * only outbound call in the feature (`BogSourceClient`) and the deterministic
 * row extraction (`extractUsdGhsRow`), then returns either:
 *
 *  * `retrieved`   — the raw cell texts of the published USD→GHS row plus the
 *                    body/row digests and the retrieval instant. NOTHING is
 *                    interpreted: the figures are still strings.
 *  * `unparseable` — the page was read but no single USD→GHS row could be
 *                    identified.
 *  * `unavailable` — the page was not read at all (transport, status, content
 *                    type or size).
 *
 * It NEVER returns a rate, never decides that a rate is acceptable, never
 * publishes anything and never writes anywhere. Recording and validating an
 * observation, deduplicating it and reporting staleness are the job of
 * `FxSourceObservationService` in `@veltrixeye/core`; publishing an
 * authoritative billing FX version remains a separate, operator-approved
 * operation that this feature cannot reach.
 *
 * The response body never leaves this module: `retrieved` carries digests and
 * cell texts, not the page.
 */

export interface BogSourceReaderConfig {
  /** Per-request timeout in ms (required — no hidden default). */
  timeoutMs: number;
  /** Injected transport (tests inject a stub; production uses global fetch). */
  fetchFn?: BogFetchFn;
  /** Injected clock for the retrieval instant (defaults to real time). */
  clock?: () => Date;
}

export interface BankOfGhanaObservationRetrieved {
  readonly outcome: 'retrieved';
  readonly sourceId: FxSourceId;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
  /** SHA-256 of the decoded page. */
  readonly bodyDigest: string;
  /** SHA-256 of the normalized USD→GHS row cells. */
  readonly rowDigest: string;
  readonly row: BogRateRowTexts;
}

export interface BankOfGhanaObservationNotRetrieved {
  readonly outcome: 'unavailable' | 'unparseable';
  readonly sourceId: FxSourceId;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
  /** HTTP status when a response was received, else null. */
  readonly status: number | null;
  readonly reason: FxSourceFailureReason;
  /** Short, bounded, non-secret description (never the body). */
  readonly detail: string;
  /** Present when a body was read (even if it could not be parsed). */
  readonly bodyDigest: string | null;
}

export type BankOfGhanaObservationResult =
  | BankOfGhanaObservationRetrieved
  | BankOfGhanaObservationNotRetrieved;

export class BankOfGhanaUsdGhsSource {
  /** Stable source id, so a caller cannot construct a mismatched pair. */
  readonly sourceId: FxSourceId = FX_SOURCE_BANK_OF_GHANA;
  readonly sourceUrl: string = FX_SOURCE_BANK_OF_GHANA_URL;

  private readonly client: BogSourceClient;

  constructor(config: BogSourceReaderConfig) {
    this.client = new BogSourceClient(config);
  }

  /** Read the published page once and return a typed, uninterpreted outcome. */
  async retrieve(): Promise<BankOfGhanaObservationResult> {
    const page = await this.client.fetchDailyFxRatesPage();

    if (page.outcome === 'unavailable') {
      return {
        outcome: 'unavailable',
        sourceId: this.sourceId,
        sourceUrl: this.sourceUrl,
        retrievedAt: page.retrievedAt,
        status: page.status,
        reason: page.reason,
        detail: page.detail,
        bodyDigest: null,
      };
    }

    const extraction = extractUsdGhsRow(page.body);
    if (extraction.outcome === 'failed') {
      return {
        outcome: 'unparseable',
        sourceId: this.sourceId,
        sourceUrl: this.sourceUrl,
        retrievedAt: page.retrievedAt,
        status: page.status,
        reason: extraction.reason,
        detail: extraction.detail,
        bodyDigest: page.bodyDigest,
      };
    }

    return {
      outcome: 'retrieved',
      sourceId: this.sourceId,
      sourceUrl: this.sourceUrl,
      retrievedAt: page.retrievedAt,
      bodyDigest: page.bodyDigest,
      rowDigest: extraction.rowDigest,
      row: extraction.row,
    };
  }
}

export function createBankOfGhanaUsdGhsSource(
  config: BogSourceReaderConfig,
): BankOfGhanaUsdGhsSource {
  return new BankOfGhanaUsdGhsSource(config);
}
