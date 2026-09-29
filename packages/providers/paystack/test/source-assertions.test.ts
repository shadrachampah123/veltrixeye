/**
 * Source-level assertions for the Paystack sandbox package.
 *
 * Some guarantees are properties of the CODE rather than of a behaviour, and a
 * behavioural test would only prove that a particular path was taken. These
 * assertions pin the properties themselves:
 *
 *  - NO plan mutation of any kind (no create/update/delete of a provider plan),
 *    because updating a provider plan can cancel or reprice live subscriptions;
 *  - the only subscription path is the documented READ, and the provider's
 *    cancellation credential (`email_token`) is never read by it;
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

  test('the only request paths are the documented customer, transaction-initialize, transaction-verify, subscription-fetch and subscription-disable operations', () => {
    const paths = new Set<string>();
    for (const file of FILES) {
      for (const match of source(file).matchAll(/['"`](\/[a-z][a-z/]*)['"`]/g)) {
        paths.add(match[1]!);
      }
    }
    assert.deepEqual([...paths].sort(), [
      '/customer',
      '/subscription/disable',
      '/transaction/initialize',
    ]);

    // Parameterized paths (template literals ending in an interpolation): the
    // documented customer fetch, the documented transaction verify read
    // (Later-billing-PR #7) and the documented subscription fetch read
    // (Billing Step 9b Part 1) — and nothing else.
    const templated = new Set<string>();
    for (const file of FILES) {
      for (const match of source(file).matchAll(/`(\/[a-z][a-z/]*)\$\{/g)) {
        templated.add(match[1]!);
      }
    }
    assert.deepEqual([...templated].sort(), ['/customer/', '/subscription/', '/transaction/verify/']);
  });

  test('the only subscription WRITE is the documented disable; nothing else mutates a subscription', () => {
    const text = allSource();
    // No subscription create, no enable, no update link, no listing: the
    // documented disable is the ONLY subscription write in this build.
    for (const forbidden of [
      /['"`]\/subscription\/enable/,
      /['"`]\/subscription['"`]\s*[,)]/,
      /update_existing_subscriptions/,
      /generate_?update_?link/i,
    ]) {
      assert.doesNotMatch(text, forbidden, `only the documented subscription disable may exist (${forbidden})`);
    }
    // Every subscription request is pinned: the documented fetch (twice — the
    // read itself, and the read the cancellation spends its credential on) and
    // the documented disable. Nothing else in the package addresses a
    // subscription, and nothing else writes.
    const subscriptionCalls = [...text.matchAll(/this\.request\(\s*'([A-Z]+)'\s*,\s*([^,)]+)/g)]
      .filter(([, , path]) => String(path).includes('subscription'))
      .map(([, method, path]) => `${method} ${String(path).trim()}`);
    assert.deepEqual(
      subscriptionCalls.map((call) => call.split(' ')[0]),
      ['GET', 'GET', 'POST'],
      `unexpected subscription calls: ${subscriptionCalls.join(', ')}`,
    );
    for (const call of subscriptionCalls.filter((call) => call.startsWith('GET'))) {
      assert.match(call, /^GET `\/(customer|subscription)\/\$\{/, 'only the documented reads address a record');
    }
    assert.ok(
      subscriptionCalls.filter((call) => call.startsWith('POST')).every((call) => call === "POST '/subscription/disable'"),
      'the only subscription write is the documented disable',
    );
  });

  test('the provider cancellation credential is read in exactly one place, and never leaves it', () => {
    const client = source('client.ts');
    // The email token is the documented credential needed to cancel. It must
    // not be a field of the general subscription response schema, nor of any
    // record that crosses the seam, nor be read by the adapter that normalizes
    // a read or a cancellation.
    const schema = /const subscriptionDataSchema = z[\s\S]*?\.passthrough\(\);\n/.exec(client)?.[0] ?? '';
    assert.ok(schema.length > 0, 'the subscription schema is present');
    assert.doesNotMatch(
      schema,
      /email_token|authorization|last4|bin\b|signature/,
      'the subscription schema must declare neither the cancellation credential nor card material',
    );
    const record = /export interface PaystackSubscriptionRecord \{[\s\S]*?\n\}/.exec(client)?.[0] ?? '';
    assert.ok(record.length > 0, 'the subscription record is present');
    assert.doesNotMatch(record, /email_token|authorization/i, 'the record carries no cancellation credential');

    // The adapter's own operations never name the field.
    const provider = source('provider.ts');
    const findSubscription =
      /async findSubscription\([\s\S]*?\n {2}\}\n/.exec(provider)?.[0] ?? '';
    const cancelSubscription =
      /async cancelSubscription\([\s\S]*?\n {2}\}\n/.exec(provider)?.[0] ?? '';
    assert.ok(findSubscription.length > 0, 'findSubscription is implemented');
    assert.ok(cancelSubscription.length > 0, 'cancelSubscription is implemented');
    for (const [label, block] of [
      ['findSubscription', findSubscription],
      ['cancelSubscription', cancelSubscription],
    ] as Array<[string, string]>) {
      assert.doesNotMatch(block, /email_token/i, `${label} never handles the email token`);
    }

    // The one schema that does read it is the cancellation one, and the
    // credential is bound to a LOCAL inside the single method that spends it:
    // no exported record, contract or result type may name it.
    const tokenSchema = /const subscriptionCancellationDataSchema = z[\s\S]*?\.passthrough\(\);\n/.exec(client)?.[0] ?? '';
    assert.ok(tokenSchema.includes('email_token'), 'the cancellation schema reads the documented credential');
    for (const exported of [
      /export interface PaystackSubscriptionRecord \{[\s\S]*?\n\}/,
      /export interface PaystackSubscriptionDisableResult \{[\s\S]*?\n\}/,
    ]) {
      const block = exported.exec(client)?.[0] ?? '';
      assert.ok(block.length > 0);
      assert.doesNotMatch(block, /email_token/i, 'no exported result type carries the credential');
    }
    const disable = /async disableSubscription\([\s\S]*?\n {2}\}\n/.exec(client)?.[0] ?? '';
    assert.ok(disable.length > 0, 'disableSubscription is implemented');
    // It is a local binding, and it is returned nowhere.
    assert.match(disable, /const token = parsed\.data\.email_token/);
    assert.doesNotMatch(disable, /return[^;]*\btoken\b/);
    // …and it is registered as a redaction literal for the call that spends it.
    assert.match(disable, /secrets: \[token\]/);
  });

  test('the transaction-verify read is a GET with an encoded, shape-checked reference', () => {
    const client = source('client.ts');
    assert.match(client, /this\.request\('GET', `\/transaction\/verify\/\$\{encodeURIComponent\(trimmed\)\}`\)/);
    assert.match(client, /PAYSTACK_REFERENCE_SHAPE\.test\(trimmed\)/);
    // The documented authorization object carries reusable-charge material:
    // the verify schema never reads it.
    const verifySchema = /const verifyTransactionDataSchema = z[\s\S]*?\.passthrough\(\);\n/.exec(client)?.[0] ?? '';
    assert.ok(verifySchema.length > 0, 'the verify schema is present');
    assert.doesNotMatch(verifySchema, /authorization|last4|bin|signature|email_token/);
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
