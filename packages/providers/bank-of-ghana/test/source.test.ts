/**
 * `@veltrixeye/provider-bank-of-ghana` — the reader as the platform consumes it.
 *
 * Pins the seam's contract:
 *  - a retrieved page yields the RAW published cells plus digests, and the page
 *    itself never travels upward (the response is digests and figures only);
 *  - an unreadable page and an unrecognised page are DISTINCT typed outcomes, so
 *    an operator can tell "we could not reach the publisher" from "the page shape
 *    changed";
 *  - nothing here can publish, approve, price or write: the package holds no
 *    database handle, no rate-version store and no publication option, and it
 *    does not depend on `@veltrixeye/core` at all (so transport cannot call the
 *    pricing authority, and the authority cannot fetch).
 *
 * No socket is opened: the transport is injected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FX_SOURCE_BANK_OF_GHANA,
  FX_SOURCE_BANK_OF_GHANA_URL,
} from '@veltrixeye/contracts';
import {
  BankOfGhanaUsdGhsSource,
  createBankOfGhanaUsdGhsSource,
  type BogFetchFn,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXED_NOW = new Date('2026-10-15T09:30:00.000Z');

const USD_ROW =
  '<tr><td>14 Oct 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.6692</td><td>11.6808</td><td>11.6750</td></tr>';

function page(rows = USD_ROW): string {
  return `<!doctype html><html><body><table><thead><tr><th>Date</th><th>Currency</th><th>Currency Pair</th><th>Buying</th><th>Selling</th><th>Mid Rate</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function stub(
  reply: { status?: number; body?: string; contentType?: string | null; throw?: unknown } = {},
): BogFetchFn {
  return async () => {
    if (reply.throw !== undefined) throw reply.throw;
    return {
      status: reply.status ?? 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? (reply.contentType ?? 'text/html') : null,
      },
      text: async () => reply.body ?? page(),
    };
  };
}

const reader = (fetchFn: BogFetchFn) =>
  createBankOfGhanaUsdGhsSource({ fetchFn, timeoutMs: 5_000, clock: () => FIXED_NOW });

describe('the reader as consumed by the observation layer', () => {
  test('a published page yields raw cells and digests, and never the page itself', async () => {
    const result = await reader(stub()).retrieve();
    assert.equal(result.outcome, 'retrieved');
    if (result.outcome !== 'retrieved') return;

    assert.equal(result.sourceId, FX_SOURCE_BANK_OF_GHANA);
    assert.equal(result.sourceUrl, FX_SOURCE_BANK_OF_GHANA_URL);
    assert.equal(result.retrievedAt.toISOString(), FIXED_NOW.toISOString());
    assert.deepEqual(result.row, {
      publishedOnText: '14 Oct 2026',
      currencyText: 'US Dollar',
      pairText: 'USDGHS',
      buyingText: '11.6692',
      sellingText: '11.6808',
      midText: '11.6750',
    });
    assert.match(result.bodyDigest, /^[0-9a-f]{64}$/);
    assert.match(result.rowDigest, /^[0-9a-f]{64}$/);

    // The page (markup and all) is NOT part of the upward contract.
    assert.equal('body' in result, false);
    assert.equal(JSON.stringify(result).includes('<html'), false);
    assert.equal(JSON.stringify(result).includes('<td>'), false);
  });

  test('an unreachable publisher is `unavailable`; an unrecognised page is `unparseable`', async () => {
    const unreachable = await reader(stub({ throw: new Error('socket hang up') })).retrieve();
    assert.equal(unreachable.outcome, 'unavailable');
    if (unreachable.outcome === 'unavailable') {
      assert.equal(unreachable.reason, 'network');
      assert.equal(unreachable.bodyDigest, null);
    }

    const unrecognised = await reader(stub({ body: '<html><table><tr><td>no</td></tr></table></html>' })).retrieve();
    assert.equal(unrecognised.outcome, 'unparseable');
    if (unrecognised.outcome === 'unparseable') {
      assert.equal(unrecognised.reason, 'no_usd_row');
      // The digest of WHAT was read is still reported, so the operator can tell
      // two different broken pages apart.
      assert.match(unrecognised.bodyDigest ?? '', /^[0-9a-f]{64}$/);
    }
  });

  test('the source identity is fixed by the class, not supplied by a caller', () => {
    const instance = new BankOfGhanaUsdGhsSource({ timeoutMs: 1_000, fetchFn: stub() });
    assert.equal(instance.sourceId, 'bank_of_ghana');
    assert.equal(instance.sourceUrl, 'https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/');
  });
});

describe('the package cannot reach the pricing authority', () => {
  test('it does not depend on @veltrixeye/core at all', () => {
    const pkg = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, 'packages', 'providers', 'bank-of-ghana', 'package.json'),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies), ['@veltrixeye/contracts']);
    assert.equal('@veltrixeye/core' in pkg.dependencies, false);
  });

  test('no publishing, approving, pricing or database path exists in the package sources', () => {
    const files = ['client.ts', 'parse.ts', 'source.ts', 'index.ts'];
    for (const file of files) {
      const source = readFileSync(
        path.join(REPO_ROOT, 'packages', 'providers', 'bank-of-ghana', 'src', file),
        'utf8',
      )
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(source, /\bpublish\s*\(/, `${file}: no publication path`);
      assert.doesNotMatch(source, /BillingFxRateVersionStore|billing_fx_rate_versions/, `${file}: no FX authority`);
      assert.doesNotMatch(source, /catalogue|Paystack|price/i, `${file}: no pricing or provider path`);
      assert.doesNotMatch(source, /\bpool\b|createPool|DATABASE_URL/, `${file}: no database`);
      assert.doesNotMatch(source, /\bwriteFile\b|\bappendFile\b/, `${file}: no filesystem write`);
      assert.doesNotMatch(source, /process\.env/, `${file}: no environment access`);
    }
  });

  test('every outbound request is confined to the one approved URL', () => {
    const calls: string[] = [];
    const recording: BogFetchFn = async (url) => {
      calls.push(url);
      return { status: 200, headers: { get: () => 'text/html' }, text: async () => page() };
    };
    return reader(recording)
      .retrieve()
      .then(() => {
        assert.deepEqual(calls, [FX_SOURCE_BANK_OF_GHANA_URL]);
      });
  });
});
