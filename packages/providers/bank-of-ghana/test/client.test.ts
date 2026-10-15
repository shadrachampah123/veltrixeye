/**
 * `@veltrixeye/provider-bank-of-ghana` — the transport.
 *
 * The properties that matter, each pinned here WITHOUT a network:
 *  - ONE host and ONE URL, both constants. There is no base-URL setting, no
 *    path parameter and no environment variable, so no deployment can point the
 *    reader at another host;
 *  - GET only, exactly ONE attempt, no retry, no request body, no credential,
 *    no cookie and no identity-bearing header;
 *  - redirects are REFUSED (the 3xx response is never followed, and a 3xx is a
 *    reported failure rather than the publisher's document);
 *  - a response that is not 200 HTML, or is oversized, is a reported failure —
 *    never "parsed anyway" on the chance it contains a number;
 *  - the emitted evidence is a SHA-256 of the exact body read, and the body
 *    itself never travels upward;
 *  - every failure is a typed VALUE, so a scheduler cannot turn "we could not
 *    read the page" into a rate.
 *
 * The injected transport makes this deterministic: no socket is opened.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FX_SOURCE_BANK_OF_GHANA_HOST,
  FX_SOURCE_BANK_OF_GHANA_URL,
} from '@veltrixeye/contracts';
import {
  BOG_ACCEPTED_CONTENT_TYPES,
  BOG_DAILY_FX_URL,
  BOG_HOST,
  BOG_MAX_BODY_BYTES,
  BogSourceClient,
  createBogSourceClient,
  type BogFetchFn,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const FIXED_NOW = new Date('2026-10-15T09:30:00.000Z');

interface RecordedCall {
  url: string;
  init: Parameters<BogFetchFn>[1];
}

/** A transport stub: records every call and answers with the given response. */
function stubFetch(
  reply: {
    status?: number;
    contentType?: string | null;
    contentLength?: string | null;
    body?: string;
    throw?: unknown;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const fetchFn: BogFetchFn = async (url, init) => {
    calls.push({ url, init });
    if (reply.throw !== undefined) throw reply.throw;
    const headers = new Map<string, string>();
    if (reply.contentType !== null) headers.set('content-type', reply.contentType ?? 'text/html');
    if (reply.contentLength !== null && reply.contentLength !== undefined) {
      headers.set('content-length', reply.contentLength);
    }
    return {
      status: reply.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => reply.body ?? '<html><body>ok</body></html>',
    };
  };
  return { fetchFn, calls };
}

const client = (fetchFn: BogFetchFn, timeoutMs = 5_000) =>
  createBogSourceClient({ fetchFn, timeoutMs, clock: () => FIXED_NOW });

describe('bank of ghana source client — pinned address', () => {
  test('the URL and host are the approved constants, with no configuration path', () => {
    assert.equal(BOG_DAILY_FX_URL, FX_SOURCE_BANK_OF_GHANA_URL);
    assert.equal(BOG_HOST, FX_SOURCE_BANK_OF_GHANA_HOST);
    assert.equal(BOG_HOST, 'https://www.bog.gov.gh');
    assert.ok(BOG_DAILY_FX_URL.startsWith(`${BOG_HOST}/`));

    // No setting can move the target: the module reads no environment variable,
    // and the constants are the only address it can use.
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages', 'providers', 'bank-of-ghana', 'src', 'client.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /process\.env/, 'no environment access');
    assert.doesNotMatch(source, /baseUrl|BASE_URL/, 'no configurable base URL');
    assert.doesNotMatch(source, /['"`]https?:\/\/(?!www\.bog\.gov\.gh)/, 'no other host appears');
  });

  test('requests the approved URL once, with GET, redirect refused and no credential', async () => {
    const { fetchFn, calls } = stubFetch();
    const result = await client(fetchFn).fetchDailyFxRatesPage();

    assert.equal(calls.length, 1, 'exactly one attempt');
    assert.equal(calls[0]!.url, FX_SOURCE_BANK_OF_GHANA_URL);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(calls[0]!.init.redirect, 'manual');
    assert.equal(calls[0]!.init.signal instanceof AbortSignal, true, 'a timeout signal is always supplied');

    const headerNames = Object.keys(calls[0]!.init.headers).map((name) => name.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'x-api-key', 'apikey', 'referer', 'origin']) {
      assert.equal(headerNames.includes(forbidden), false, `${forbidden} must never be sent`);
    }
    assert.deepEqual(headerNames.sort(), ['accept', 'accept-language', 'user-agent']);
    assert.equal(
      JSON.stringify(calls[0]!.init.headers).includes('sk_'),
      false,
      'no key-shaped material in headers',
    );

    assert.equal(result.outcome, 'retrieved');
  });

  test('the emitted digest is the SHA-256 of exactly the bytes read, and the body is not carried further', async () => {
    const body = '<html><td>USDGHS</td></html>';
    const { fetchFn } = stubFetch({ body });
    const result = await client(fetchFn).fetchDailyFxRatesPage();
    assert.equal(result.outcome, 'retrieved');
    if (result.outcome !== 'retrieved') return;

    assert.equal(result.bodyDigest, createHash('sha256').update(body, 'utf8').digest('hex'));
    assert.equal(result.body, body, 'the extractor sees the body…');
    // …but the PUBLIC result of the reader (see source.test.ts) is digests and
    // cells only. Here we pin that a digest is what is exposed as evidence.
    assert.match(result.bodyDigest, /^[0-9a-f]{64}$/);
  });
});

describe('bank of ghana source client — refused responses', () => {
  test('a redirect is refused rather than followed', async () => {
    const { fetchFn, calls } = stubFetch({ status: 302 });
    const result = await client(fetchFn).fetchDailyFxRatesPage();
    assert.equal(calls.length, 1, 'the redirect target is never requested');
    assert.equal(result.outcome, 'unavailable');
    if (result.outcome !== 'unavailable') return;
    assert.equal(result.reason, 'redirect_refused');
    assert.equal(result.status, 302);
    assert.match(result.detail, /not followed/);
  });

  test('a non-200 status is a reported failure, never a parse attempt', async () => {
    for (const status of [400, 403, 404, 429, 500, 503]) {
      const { fetchFn } = stubFetch({ status, body: '<html>12.5</html>' });
      const result = await client(fetchFn).fetchDailyFxRatesPage();
      assert.equal(result.outcome, 'unavailable', `HTTP ${status}`);
      if (result.outcome !== 'unavailable') continue;
      assert.equal(result.reason, 'http_status');
      assert.equal(result.status, status);
      assert.equal(
        JSON.stringify(result).includes('12.5'),
        false,
        'the body must not leak into the outcome',
      );
    }
  });

  test('a non-HTML response is refused (a JSON API is not this source)', async () => {
    for (const contentType of ['application/json', 'text/plain', 'application/pdf', '']) {
      const { fetchFn } = stubFetch({ contentType });
      const result = await client(fetchFn).fetchDailyFxRatesPage();
      assert.equal(result.outcome, 'unavailable', `content-type "${contentType}"`);
      if (result.outcome !== 'unavailable') continue;
      assert.equal(result.reason, 'unsupported_content_type');
    }
    assert.deepEqual([...BOG_ACCEPTED_CONTENT_TYPES], ['text/html']);
  });

  test('an oversized response is refused before it is parsed', async () => {
    const declared = stubFetch({ contentLength: String(BOG_MAX_BODY_BYTES + 1) });
    const byHeader = await client(declared.fetchFn).fetchDailyFxRatesPage();
    assert.equal(byHeader.outcome, 'unavailable');
    if (byHeader.outcome === 'unavailable') assert.equal(byHeader.reason, 'body_too_large');

    const actual = stubFetch({ body: 'a'.repeat(BOG_MAX_BODY_BYTES + 1) });
    const byLength = await client(actual.fetchFn).fetchDailyFxRatesPage();
    assert.equal(byLength.outcome, 'unavailable');
    if (byLength.outcome === 'unavailable') assert.equal(byLength.reason, 'body_too_large');
  });

  test('a transport fault is a typed state, and its message is never echoed', async () => {
    const secretish = new Error('connect ECONNREFUSED postgres://user:pa55w0rd@host/db');
    secretish.name = 'FetchError';
    const { fetchFn } = stubFetch({ throw: secretish });
    const result = await client(fetchFn).fetchDailyFxRatesPage();

    assert.equal(result.outcome, 'unavailable');
    if (result.outcome !== 'unavailable') return;
    assert.equal(result.reason, 'network');
    assert.equal(JSON.stringify(result).includes('pa55w0rd'), false, 'no transport message is echoed');
    assert.equal(JSON.stringify(result).includes('ECONNREFUSED'), false);
  });

  test('an aborted attempt is reported as a timeout, with one attempt and no retry', async () => {
    const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const { fetchFn, calls } = stubFetch({ throw: abortError });
    const result = await client(fetchFn, 25).fetchDailyFxRatesPage();

    assert.equal(calls.length, 1, 'no retry');
    assert.equal(result.outcome, 'unavailable');
    if (result.outcome !== 'unavailable') return;
    assert.equal(result.reason, 'timeout');
    assert.match(result.detail, /25ms/);
  });

  test('a non-positive timeout is refused at construction (no hidden default)', () => {
    const { fetchFn } = stubFetch();
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new BogSourceClient({ timeoutMs, fetchFn }), TypeError);
    }
  });
});
