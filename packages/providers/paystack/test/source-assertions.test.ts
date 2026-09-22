/**
 * Source-level assertions for the Paystack sandbox package.
 *
 * Some guarantees are properties of the CODE rather than of a behaviour, and a
 * behavioural test would only prove that a particular path was taken. These
 * assertions pin the properties themselves:
 *
 *  - NO plan mutation of any kind (no create/update/delete of a provider plan),
 *    because updating a provider plan can cancel or reprice live subscriptions;
 *  - NO FX or market-rate lookup: the adapter never converts currency and never
 *    learns a rate;
 *  - NO money arithmetic: the adapter cannot invent, round or re-scale an
 *    amount;
 *  - NO credential in source, and no environment read;
 *  - exactly ONE outbound host, reached only through the injectable transport.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAYSTACK_API_BASE_URL, PAYSTACK_LIVE, PAYSTACK_TEST_KEY_PREFIX } from '../src/index.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FILES = readdirSync(SRC).filter((file) => file.endsWith('.ts'));

const source = (file: string): string => readFileSync(path.join(SRC, file), 'utf8');
const allSource = (): string => FILES.map(source).join('\n');

describe('Paystack package — no plan mutation, ever', () => {
  test('the package contains no write operation against a provider plan', () => {
    const text = allSource();
    for (const forbidden of [
      /['"`]\/plan['"`]/, // any /plan request path, whatever the verb
      /['"`]PUT['"`]/,
      /['"`]PATCH['"`]/,
      /['"`]DELETE['"`]/,
      /update_existing_subscriptions/,
      /\bupdatePlan\b/,
      /\bcreatePlan\b/,
      /\bdeletePlan\b/,
    ]) {
      assert.doesNotMatch(text, forbidden, `the adapter must never mutate a provider plan (${forbidden})`);
    }
  });

  test('the only request paths are the documented customer and transaction-initialize operations', () => {
    const paths = new Set<string>();
    for (const file of FILES) {
      for (const match of source(file).matchAll(/['"`](\/[a-z][a-z/]*)['"`]/g)) {
        paths.add(match[1]!);
      }
    }
    assert.deepEqual([...paths].sort(), ['/customer', '/transaction/initialize']);
  });

  test('only GET and POST are ever sent', () => {
    const methods = new Set<string>();
    for (const file of FILES) {
      for (const match of source(file).matchAll(/this\.request\(\s*'([A-Z]+)'/g)) {
        methods.add(match[1]!);
      }
    }
    assert.deepEqual([...methods].sort(), ['GET', 'POST']);
  });
});

describe('Paystack package — no FX, no conversion, no money arithmetic', () => {
  test('no market-rate or FX provider is referenced or contacted', () => {
    const text = allSource();
    for (const forbidden of [
      /forex/i,
      /exchangerate/i,
      /openexchange/i,
      /apilayer/i,
      /fixer\.io/i,
      /currencyapi/i,
      /ratefeed/i,
      /\bconvertCurrency\b/,
      /\bFX_RATE\b/,
    ]) {
      assert.doesNotMatch(text, forbidden, `the adapter must never obtain a rate (${forbidden})`);
    }
  });

  test('the adapter performs no amount arithmetic or formatting', () => {
    const text = allSource();
    for (const forbidden of [
      /parseFloat/,
      /parseInt/,
      /\.toFixed\(/,
      /Math\.round/,
      /Math\.floor/,
      /Math\.ceil/,
      /\*\s*100\b/,
      /\/\s*100\b/,
      /toLocaleString/,
    ]) {
      assert.doesNotMatch(text, forbidden, `the authorized amount is passed through untouched (${forbidden})`);
    }
  });

  test('the amount that reaches the provider is the authorized amount object, unchanged', () => {
    assert.match(
      source('provider.ts'),
      /amountMinor: snapshot\.payment\.paymentAmountMinor/,
      'the payable amount comes from the authorized snapshot',
    );
    assert.match(
      source('provider.ts'),
      /currency: snapshot\.payment\.paymentCurrency/,
      'the payment currency comes from the authorized snapshot',
    );
  });
});

describe('Paystack package — credentials and transport', () => {
  test('no credential literal, no live key and no environment read exists in source', () => {
    const text = allSource();
    assert.doesNotMatch(text, /sk_test_[A-Za-z0-9]{12,}/, 'no test key literal');
    assert.doesNotMatch(text, /sk_live_[A-Za-z0-9]{8,}/, 'no live key is present in source');
    assert.doesNotMatch(text, /process\.env/, 'configuration is injected, never read from the environment here');
    assert.doesNotMatch(text, /[A-Z]{3,}_SECRET\b/, 'no secret is read by name');
  });

  test('exactly one host exists, and only the client may reach it', () => {
    assert.equal(PAYSTACK_API_BASE_URL, 'https://api.paystack.co');
    assert.equal(PAYSTACK_TEST_KEY_PREFIX, 'sk_test_');
    assert.equal(PAYSTACK_LIVE, false);

    const client = source('client.ts');
    const hosts = new Set([...client.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]));
    assert.deepEqual([...hosts], ['api.paystack.co']);
    for (const file of FILES.filter((name) => name !== 'client.ts')) {
      assert.doesNotMatch(source(file), /https?:\/\/(?!checkout\.paystack\.com)/i, `only the client holds a host (${file})`);
    }
    assert.doesNotMatch(source('provider.ts'), /\bfetch\s*\(/, 'the adapter never touches fetch directly');
  });

  test('no HTTP library is imported: the transport is injectable', () => {
    const text = allSource();
    for (const forbidden of [/from 'node:http'/, /from 'node:https'/, /from 'axios'/, /from 'node-fetch'/, /from 'undici'/]) {
      assert.doesNotMatch(text, forbidden, `no HTTP dependency (${forbidden})`);
    }
    assert.match(source('client.ts'), /config\.fetchFn\s*\?\?/, 'the client falls back to the injected transport');
  });

  test('documented provider facts are marked as such, and unknown behaviour is left alone', () => {
    const provider = source('provider.ts');
    assert.match(provider, /FAILS CLOSED/i, 'unimplemented operations are documented as fail-closed');
    assert.match(provider, /implemented = false/, 'capability reporting stays honest');
  });
});
