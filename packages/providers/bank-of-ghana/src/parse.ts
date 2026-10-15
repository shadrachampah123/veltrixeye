import { createHash } from 'node:crypto';
import type { FxSourceFailureReason } from '@veltrixeye/contracts';

/**
 * Deterministic extraction of the USD→GHS row from the Bank of Ghana's
 * published daily interbank FX rates page.
 *
 * The published page presents a table whose columns are
 * `Date | Currency | Currency Pair | Buying | Selling | Mid Rate`, with rows
 * such as `18 Sep 2026 | US Dollar | USDGHS | 11.5442 | 11.5558 | 11.5500`.
 *
 * WHAT THIS MODULE DOES — and all it does:
 *  * strips script/style/comment blocks (so a mention of `USDGHS` inside page
 *    JavaScript can never be mistaken for the published row);
 *  * walks `<tr>` rows and their `<td>`/`<th>` cells in document order;
 *  * returns the RAW TEXT of the cells of the one row whose pair cell is
 *    `USDGHS`, with a digest of those cells as evidence.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — it does not interpret a single number.
 * A rate is validated by the billing FX authority in `@veltrixeye/core`
 * (`parseFxRateDecimal` plus the coherence/precision rules), which is the ONE
 * implementation of "what a valid GHS-per-USD figure is". Extracting `"11.5"`
 * here and validating it there is what keeps a second, drifting definition of a
 * valid rate from existing.
 *
 * FAIL CLOSED, DETERMINISTICALLY. No USD row, more than one USD row, a row with
 * the wrong number of cells or an empty required cell are all reported as a
 * typed failure. It never picks "the first plausible row", never falls back to
 * a second table, and never returns a partial row.
 */

/** Cell text normalization: strip tags, decode a small entity set, collapse. */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&#xa0;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ndash;': '-',
  '&mdash;': '-',
});

/**
 * A value cell may be published with a currency prefix (`GH¢11.6692`,
 * `GHS 11.6692`, `₵11.6692`). Exactly those prefixes are removed, and nothing
 * else: the removal cannot manufacture a digit, and the remainder must still be
 * a plain decimal string for the core validator to accept it.
 */
const CURRENCY_PREFIX = /^(?:GHS|GH\u00A2|GH\u20B5|\u20B5|\u00A2)\s*/i;

/** The pair token that identifies the row we record (whitespace- and case-insensitive). */
export const BOG_USD_GHS_PAIR_TOKEN = 'USDGHS';

/** True when a currency cell corroborates that the row is the US dollar's. */
export function isUsdCurrencyLabel(cellText: string): boolean {
  const normalized = cellText.toLowerCase();
  return normalized.includes('usd') || normalized.includes('dollar');
}

/**
 * Decode one entity reference. Named entities come from the small published set
 * above; NUMERIC references (`&#162;`, `&#xA2;`) are decoded generally, because
 * a currency symbol for the cedi is commonly written that way and the value cell
 * must be reduced to a plain decimal for the validator.
 *
 * An out-of-range code point is left as written rather than turned into a
 * replacement character: an unrecognised cell should fail validation loudly, not
 * silently become something else.
 */
function decodeEntity(entity: string): string {
  const named = ENTITIES[entity.toLowerCase()];
  if (named !== undefined) return named;

  const decimal = /^&#([0-9]+);$/.exec(entity);
  const hexadecimal = /^&#[xX]([0-9a-fA-F]+);$/.exec(entity);
  const codePointText = decimal?.[1] ?? hexadecimal?.[1];
  if (codePointText === undefined) return entity;
  const codePoint = Number.parseInt(codePointText, decimal !== null ? 10 : 16);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
  // Surrogate halves are not scalar values; leaving them as written keeps the
  // failure visible instead of producing an unpaired surrogate.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return entity;
  return String.fromCodePoint(codePoint);
}

/** Collapse a cell's HTML to its text (tags removed, entities decoded). */
export function normalizeCellText(html: string): string {
  let text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => decodeEntity(entity));
  text = text.replace(/[\s\u00A0\u200B]+/g, ' ').trim();
  return text;
}

/** Remove a published currency prefix from a value cell, then trim. */
export function stripCurrencyPrefix(cellText: string): string {
  return cellText.replace(CURRENCY_PREFIX, '').trim();
}

/** The raw, uninterpreted cells of the published USD→GHS row. */
export interface BogRateRowTexts {
  /** e.g. `18 Sep 2026` — parsed by the core validator, not here. */
  readonly publishedOnText: string;
  readonly currencyText: string;
  readonly pairText: string;
  readonly buyingText: string;
  readonly sellingText: string;
  readonly midText: string;
}

export interface BogRowExtracted {
  readonly outcome: 'row';
  readonly row: BogRateRowTexts;
  /** SHA-256 over the normalized cells — evidence of exactly which row was read. */
  readonly rowDigest: string;
  /** How many `USDGHS` rows the page contained (1 when `outcome: 'row'`). */
  readonly usdRowCount: number;
}

export interface BogExtractionFailed {
  readonly outcome: 'failed';
  readonly reason: Extract<FxSourceFailureReason, 'no_usd_row' | 'ambiguous_usd_row' | 'row_shape'>;
  readonly detail: string;
  readonly usdRowCount: number;
}

export type BogExtraction = BogRowExtracted | BogExtractionFailed;

/** Strip regions of the document that cannot be the published table. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
}

/** Extract the text of every `<tr>` row, as an array of cell texts. */
function extractRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of rowHtml.matchAll(cellPattern)) {
      cells.push(normalizeCellText(cellMatch[2] ?? ''));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** Canonical single string for a row's cells (used for the row digest). */
function canonicalRow(row: BogRateRowTexts): string {
  return [
    row.publishedOnText,
    row.currencyText,
    row.pairText,
    row.buyingText,
    row.sellingText,
    row.midText,
  ].join('|');
}

export function bogRowDigest(row: BogRateRowTexts): string {
  return createHash('sha256').update(canonicalRow(row), 'utf8').digest('hex');
}

/** The expected column count of the published table's data rows. */
export const BOG_TABLE_COLUMNS = 6;

/**
 * Extract the one published USD→GHS row. Pure, synchronous and deterministic:
 * the same page always yields the same result, and no network, clock or
 * environment is consulted.
 */
export function extractUsdGhsRow(html: string): BogExtraction {
  if (typeof html !== 'string' || html.trim() === '') {
    return {
      outcome: 'failed',
      reason: 'no_usd_row',
      detail: 'The source response was empty; no published USD→GHS row can be read from it.',
      usdRowCount: 0,
    };
  }

  const rows = extractRows(stripNonContent(html));
  const usdRows = rows.filter((cells) =>
    cells.some((cell) => cell.replace(/\s+/g, '').toUpperCase() === BOG_USD_GHS_PAIR_TOKEN),
  );

  if (usdRows.length === 0) {
    return {
      outcome: 'failed',
      reason: 'no_usd_row',
      detail:
        `The published page carried no "${BOG_USD_GHS_PAIR_TOKEN}" row. The page shape may have ` +
        'changed; nothing is recorded from an unrecognised page.',
      usdRowCount: 0,
    };
  }

  if (usdRows.length > 1) {
    return {
      outcome: 'failed',
      reason: 'ambiguous_usd_row',
      detail:
        `The published page carried ${usdRows.length} "${BOG_USD_GHS_PAIR_TOKEN}" rows. Which one is ` +
        'current is never guessed; an ambiguous page is not recorded.',
      usdRowCount: usdRows.length,
    };
  }

  const cells = usdRows[0]!;
  if (cells.length !== BOG_TABLE_COLUMNS) {
    return {
      outcome: 'failed',
      reason: 'row_shape',
      detail:
        `The "${BOG_USD_GHS_PAIR_TOKEN}" row carried ${cells.length} cells; the published table has ` +
        `${BOG_TABLE_COLUMNS} (date, currency, pair, buying, selling, mid).`,
      usdRowCount: 1,
    };
  }

  const [publishedOnText = '', currencyText = '', pairText = '', buying = '', selling = '', mid = ''] =
    cells;

  if (!isUsdCurrencyLabel(currencyText)) {
    return {
      outcome: 'failed',
      reason: 'row_shape',
      detail:
        `The "${BOG_USD_GHS_PAIR_TOKEN}" row is labelled "${currencyText}", which does not name the US ` +
        'dollar; a row whose label contradicts its pair is not recorded.',
      usdRowCount: 1,
    };
  }

  const row: BogRateRowTexts = {
    publishedOnText,
    currencyText,
    pairText,
    buyingText: stripCurrencyPrefix(buying),
    sellingText: stripCurrencyPrefix(selling),
    midText: stripCurrencyPrefix(mid),
  };

  const blanks = (['publishedOnText', 'buyingText', 'sellingText', 'midText'] as const).filter(
    (field) => row[field] === '',
  );
  if (blanks.length > 0) {
    return {
      outcome: 'failed',
      reason: 'row_shape',
      detail: `The "${BOG_USD_GHS_PAIR_TOKEN}" row has empty cells (${blanks.join(', ')}); a partial row is never recorded.`,
      usdRowCount: 1,
    };
  }

  return { outcome: 'row', row, rowDigest: bogRowDigest(row), usdRowCount: 1 };
}
