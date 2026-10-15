/**
 * `@veltrixeye/provider-bank-of-ghana` — deterministic row extraction.
 *
 * The published page presents `Date | Currency | Currency Pair | Buying |
 * Selling | Mid Rate`. These tests pin that the reader:
 *  - finds the ONE row whose pair cell is `USDGHS`, from REALISTIC published
 *    markup (tags, entities, whitespace and a script block that mentions the
 *    pair token);
 *  - returns the RAW cell text and interprets no number (rates are validated by
 *    the billing FX authority in core, which is the only definition of a valid
 *    GHS-per-USD figure);
 *  - applies ONLY the documented currency-prefix removal to value cells;
 *  - refuses, deterministically, a page with no USD row, with two USD rows, with
 *    a wrong cell count, with a contradictory currency label, or with empty
 *    cells — it never picks "the first plausible row" and never returns a
 *    partial one;
 *  - digests the row it read, so the evidence is exact and stable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOG_TABLE_COLUMNS,
  BOG_USD_GHS_PAIR_TOKEN,
  bogRowDigest,
  extractUsdGhsRow,
  isUsdCurrencyLabel,
  normalizeCellText,
  stripCurrencyPrefix,
} from '../src/index.js';

/**
 * A page shaped like the publisher's published table (the values are the ones
 * the Bank of Ghana published for 18 Sep 2026: buying 11.5442, selling 11.5558,
 * mid 11.5500).
 */
function publishedPage(options: { usdRow?: string; extraRows?: string[] } = {}): string {
  const usdRow =
    options.usdRow ??
    '<tr><td>18 Sep 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.5442</td><td>11.5558</td><td>11.5500</td></tr>';
  return `<!doctype html>
<html><head>
  <title>Daily Interbank FX Rates</title>
  <style>.rate { color: #111; }</style>
</head><body>
  <h2>Day's Weighted Average Rate</h2>
  <p>Day&rsquo;s Weighted Median Rate: 11.5500</p>
  <table class="rates">
    <thead>
      <tr><th>Date</th><th>Currency</th><th>Currency Pair</th><th>Buying</th><th>Selling</th><th>Mid Rate</th></tr>
    </thead>
    <tbody>
      ${usdRow}
      ${(options.extraRows ?? [
        '<tr><td>18 Sep 2026</td><td>Pound Sterling</td><td>GBPGHS</td><td>15.1000</td><td>15.2200</td><td>15.1600</td></tr>',
        '<tr><td>18 Sep 2026</td><td>Euro</td><td>EURGHS</td><td>12.9000</td><td>13.0000</td><td>12.9500</td></tr>',
      ]).join('\n      ')}
    </tbody>
  </table>
  <script>
    // A page script that mentions the pair token must never be read as data.
    window.rates = [{ pair: "USDGHS", mid: 999.9999 }];
  </script>
</body></html>`;
}

describe('deterministic extraction — the published USD row', () => {
  test('extracts the one USD→GHS row and returns its raw cells', () => {
    const result = extractUsdGhsRow(publishedPage());
    assert.equal(result.outcome, 'row');
    if (result.outcome !== 'row') return;

    assert.deepEqual(result.row, {
      publishedOnText: '18 Sep 2026',
      currencyText: 'US Dollar',
      pairText: 'USDGHS',
      buyingText: '11.5442',
      sellingText: '11.5558',
      midText: '11.5500',
    });
    assert.equal(result.usdRowCount, 1);
    assert.equal(result.rowDigest, bogRowDigest(result.row));
    assert.match(result.rowDigest, /^[0-9a-f]{64}$/);
  });

  test('a script block mentioning the pair token is never mistaken for a row', () => {
    const result = extractUsdGhsRow(
      `<html><script>const rows = [{ pair: 'USDGHS', mid: '999.9999' }];</script>` +
        '<table><tr><td>US Dollar</td><td>USDGHS</td><td>1</td></tr></table></html>',
    );
    // The only real row has three cells, so the shape is refused — proving the
    // script was not counted as a row (it would have made the result ambiguous).
    assert.equal(result.outcome, 'failed');
    if (result.outcome !== 'failed') return;
    assert.equal(result.reason, 'row_shape');
    assert.equal(result.usdRowCount, 1);
  });

  test('is deterministic: the same page always yields the same row and digest', () => {
    const page = publishedPage();
    const first = extractUsdGhsRow(page);
    const second = extractUsdGhsRow(page);
    assert.deepEqual(first, second);
  });

  test('the digest changes when a published figure changes', () => {
    const changed = extractUsdGhsRow(
      publishedPage({
        usdRow:
          '<tr><td>18 Sep 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.5443</td><td>11.5558</td><td>11.5500</td></tr>',
      }),
    );
    const original = extractUsdGhsRow(publishedPage());
    assert.equal(changed.outcome, 'row');
    assert.equal(original.outcome, 'row');
    if (changed.outcome !== 'row' || original.outcome !== 'row') return;
    assert.notEqual(changed.rowDigest, original.rowDigest);
  });

  test('accepts the pair token with whitespace and a lower-case currency label', () => {
    const result = extractUsdGhsRow(
      publishedPage({
        usdRow:
          '<tr><td>18 Sep 2026</td><td>us dollar</td><td> usd ghs </td><td>11.5442</td><td>11.5558</td><td>11.5500</td></tr>',
      }),
    );
    assert.equal(result.outcome, 'row');
  });
});

describe('deterministic extraction — refusals', () => {
  test('a page without a USD row is refused (the page shape may have changed)', () => {
    const result = extractUsdGhsRow(publishedPage({ usdRow: '' }));
    assert.equal(result.outcome, 'failed');
    if (result.outcome !== 'failed') return;
    assert.equal(result.reason, 'no_usd_row');
    assert.equal(result.usdRowCount, 0);
    assert.match(result.detail, /nothing is recorded/i);
  });

  test('an ambiguous page (two USD rows) is refused rather than guessed', () => {
    const duplicate =
      '<tr><td>17 Sep 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.5000</td><td>11.5200</td><td>11.5100</td></tr>';
    const result = extractUsdGhsRow(publishedPage({ extraRows: [duplicate] }));
    assert.equal(result.outcome, 'failed');
    if (result.outcome !== 'failed') return;
    assert.equal(result.reason, 'ambiguous_usd_row');
    assert.equal(result.usdRowCount, 2);
    assert.match(result.detail, /never guessed/);
  });

  test('a row with the wrong number of cells is refused', () => {
    const result = extractUsdGhsRow(
      publishedPage({
        usdRow: '<tr><td>18 Sep 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.5442</td><td>11.5558</td></tr>',
      }),
    );
    assert.equal(result.outcome, 'failed');
    if (result.outcome !== 'failed') return;
    assert.equal(result.reason, 'row_shape');
    assert.match(result.detail, new RegExp(String(BOG_TABLE_COLUMNS)));
  });

  test('a USD pair labelled as another currency is refused', () => {
    const result = extractUsdGhsRow(
      publishedPage({
        usdRow:
          '<tr><td>18 Sep 2026</td><td>Pound Sterling</td><td>USDGHS</td><td>11.5442</td><td>11.5558</td><td>11.5500</td></tr>',
      }),
    );
    assert.equal(result.outcome, 'failed');
    if (result.outcome !== 'failed') return;
    assert.equal(result.reason, 'row_shape');
    assert.match(result.detail, /contradicts its pair/);
  });

  test('empty cells are refused: a partial row is never recorded', () => {
    for (const usdRow of [
      '<tr><td></td><td>US Dollar</td><td>USDGHS</td><td>11.5442</td><td>11.5558</td><td>11.5500</td></tr>',
      '<tr><td>18 Sep 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.5442</td><td>11.5558</td><td> </td></tr>',
    ]) {
      const result = extractUsdGhsRow(publishedPage({ usdRow }));
      assert.equal(result.outcome, 'failed');
      if (result.outcome !== 'failed') continue;
      assert.equal(result.reason, 'row_shape');
      assert.match(result.detail, /empty cells/);
    }
  });

  test('an empty or non-string body is refused without inventing a row', () => {
    for (const body of ['', '   ', '\n\t']) {
      const result = extractUsdGhsRow(body);
      assert.equal(result.outcome, 'failed');
      if (result.outcome !== 'failed') continue;
      assert.equal(result.reason, 'no_usd_row');
    }
  });
});

describe('cell normalization', () => {
  test('strips tags, decodes the published entities and collapses whitespace', () => {
    assert.equal(normalizeCellText('<td><span>US&nbsp;Dollar</span></td>'), 'US Dollar');
    assert.equal(normalizeCellText(' 18&nbsp;Sep\n2026 '), '18 Sep 2026');
    assert.equal(normalizeCellText('<strong>11.5442</strong>'), '11.5442');
    assert.equal(normalizeCellText('&#162;11.5500'), '\u00A211.5500');
    assert.equal(normalizeCellText('&#x20B5;11.5500'), '\u20B511.5500');
    // An out-of-range reference is left as written: an unrecognised cell must
    // fail validation loudly rather than silently become something else.
    assert.equal(normalizeCellText('&#9999999999;x'), '&#9999999999;x');
    assert.equal(normalizeCellText('&unknown;'), '&unknown;');
  });

  test('removes ONLY the documented currency prefixes from value cells', () => {
    for (const [input, expected] of [
      ['GH¢11.6692', '11.6692'],
      ['GH₵11.6692', '11.6692'],
      ['₵11.6692', '11.6692'],
      ['GHS 11.6692', '11.6692'],
      ['ghs11.6692', '11.6692'],
      ['11.6692', '11.6692'],
    ] as const) {
      assert.equal(stripCurrencyPrefix(input), expected, input);
    }
    // It can never manufacture a digit: a figure-less cell stays figure-less.
    assert.equal(stripCurrencyPrefix('GHS '), '');
    assert.equal(stripCurrencyPrefix('rate: GH¢'), 'rate: GH¢');
  });

  test('the currency label corroboration accepts USD/dollar and refuses others', () => {
    for (const label of ['US Dollar', 'usd', 'USD', 'United States Dollar']) {
      assert.equal(isUsdCurrencyLabel(label), true, label);
    }
    for (const label of ['Pound Sterling', 'Euro', 'Swiss Franc', '', 'GHANA CEDI']) {
      assert.equal(isUsdCurrencyLabel(label), false, label);
    }
    assert.equal(BOG_USD_GHS_PAIR_TOKEN, 'USDGHS');
  });
});
