import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyServerOptions } from 'fastify';

import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  DEFAULT_TRUSTED_PROXIES,
  PLATFORM_INTERNAL_RANGES,
  parseTrustedProxies,
} from '../src/trust-proxy.js';
import { loadConfig } from '../src/config.js';

/**
 * F1 regression tests: client-IP resolution must never be chosen by the
 * caller, while legitimate proxy chains must still resolve to the real client.
 *
 * Pure unit tests — no database, no listener. The end-to-end rate-limit
 * regressions live in `api.test.ts`.
 */

const DUMMY_ENV = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' } as NodeJS.ProcessEnv;

/** Render's production chain: peer = Render LB (private), then Cloudflare. */
const RENDER_LB = '10.128.0.7';
const CF_EDGE = '173.245.48.7'; // inside Cloudflare's published 173.245.48.0/20
const CLIENT = '203.0.113.9'; // RFC 5737 documentation range
const SPOOFED = '198.18.0.1'; // RFC 2544 benchmark range — stands in for an attacker-chosen value
const VERCEL_EGRESS = '76.76.21.21'; // not published as a range ⇒ not in the default list

const apps: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

/** Build a throwaway app exposing how Fastify resolved the client address. */
async function probe(trustProxy: FastifyServerOptions['trustProxy']): Promise<(xff: string | undefined, peer: string) => Promise<string>> {
  const app = Fastify({ trustProxy, logger: false });
  apps.push(app);
  app.get('/ip', (req) => ({ ip: req.ip }));
  await app.ready();
  return async (xff, peer) => {
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: peer,
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
    return res.json().ip as string;
  };
}

describe('TRUSTED_PROXY_CIDRS parsing', () => {
  test('accepts named ranges, bare IPs and IPv4/IPv6 CIDRs', () => {
    assert.deepEqual(parseTrustedProxies('loopback, 10.0.0.1, 172.16.0.0/12, 2606:4700::/32'), [
      'loopback',
      '10.0.0.1',
      '172.16.0.0/12',
      '2606:4700::/32',
    ]);
  });

  test('trims, lower-cases, splits on commas or whitespace, and de-duplicates', () => {
    assert.deepEqual(parseTrustedProxies('  Loopback \n 10.0.0.0/8   10.0.0.0/8 ,LINKLOCAL '), [
      'loopback',
      '10.0.0.0/8',
      'linklocal',
    ]);
  });

  test('rejects a /0 wildcard — trusting everything is the vulnerability this closes', () => {
    assert.throws(() => parseTrustedProxies('loopback,0.0.0.0/0'), /invalid trusted-proxy entry: 0\.0\.0\.0\/0/);
    assert.throws(() => parseTrustedProxies('::/0'), /invalid trusted-proxy entry: ::\/0/);
  });

  test('rejects malformed addresses, prefixes and unknown names', () => {
    for (const bad of ['not-an-ip', '10.0.0.0/33', '2606:4700::/129', '10.0.0.0/', '10.0.0.0/abc', 'everywhere', '']) {
      assert.throws(
        () => parseTrustedProxies(bad),
        /invalid trusted-proxy entr|no trusted proxies listed/,
        `expected "${bad}" to be rejected`,
      );
    }
  });

  test('the default pins Render-internal hops + both Cloudflare families, with no wildcard', () => {
    for (const range of PLATFORM_INTERNAL_RANGES) assert.ok(DEFAULT_TRUSTED_PROXIES.includes(range), range);
    for (const range of CLOUDFLARE_IPV4_RANGES) assert.ok(DEFAULT_TRUSTED_PROXIES.includes(range), range);
    for (const range of CLOUDFLARE_IPV6_RANGES) assert.ok(DEFAULT_TRUSTED_PROXIES.includes(range), range);
    assert.equal(
      DEFAULT_TRUSTED_PROXIES.filter((entry) => entry.endsWith('/0')).length,
      0,
      'no entry may trust the whole internet',
    );
    assert.equal(
      DEFAULT_TRUSTED_PROXIES.length,
      PLATFORM_INTERNAL_RANGES.length + CLOUDFLARE_IPV4_RANGES.length + CLOUDFLARE_IPV6_RANGES.length,
    );
  });

  test('loadConfig defaults to the pinned list (production needs no new variable)', () => {
    assert.deepEqual(loadConfig(DUMMY_ENV).trustedProxies, DEFAULT_TRUSTED_PROXIES);
  });

  test('loadConfig honours an override (e.g. adding a Vercel Static IP)', () => {
    const config = loadConfig({ ...DUMMY_ENV, TRUSTED_PROXY_CIDRS: 'loopback,uniquelocal,76.76.21.21' } as NodeJS.ProcessEnv);
    assert.deepEqual(config.trustedProxies, ['loopback', 'uniquelocal', '76.76.21.21']);
  });

  test('loadConfig fails fast on an unusable trust list', () => {
    assert.throws(
      () => loadConfig({ ...DUMMY_ENV, TRUSTED_PROXY_CIDRS: '0.0.0.0/0' } as NodeJS.ProcessEnv),
      /Invalid environment configuration:\n {2}- TRUSTED_PROXY_CIDRS:/,
    );
    assert.throws(
      () => loadConfig({ ...DUMMY_ENV, TRUSTED_PROXY_CIDRS: 'nonsense' } as NodeJS.ProcessEnv),
      /TRUSTED_PROXY_CIDRS: invalid trusted-proxy entry: nonsense/,
    );
  });
});

describe('client-IP resolution across proxy configurations', () => {
  test('PINNED LIST (the shipped config): spoofed prefix ignored, real client resolved', async () => {
    const ip = await probe(DEFAULT_TRUSTED_PROXIES);

    // Honest direct call: Cloudflare appends the client, Render appends Cloudflare.
    assert.equal(await ip(`${CLIENT}, ${CF_EDGE}`, RENDER_LB), CLIENT);
    // One spoofed value in front of the address Cloudflare vouched for.
    assert.equal(await ip(`${SPOOFED}, ${CLIENT}, ${CF_EDGE}`, RENDER_LB), CLIENT);
    // A long spoofed prefix, including values that look like infrastructure.
    assert.equal(await ip(`10.0.0.9, ${CF_EDGE}, ${SPOOFED}, 198.18.0.2, ${CLIENT}, ${CF_EDGE}`, RENDER_LB), CLIENT);
    // No X-Forwarded-For at all: the socket peer.
    assert.equal(await ip(undefined, RENDER_LB), RENDER_LB);
    // A peer we do not operate: X-Forwarded-For is ignored completely.
    assert.equal(await ip(`${SPOOFED}, ${CLIENT}`, '198.51.100.44'), '198.51.100.44');
    // Local dev/test shape (loopback peer + one value) keeps working.
    assert.equal(await ip('10.9.9.9', '127.0.0.1'), '10.9.9.9');
  });

  test('trustProxy: true (the old value) is spoofable — this is the regression being fixed', async () => {
    const ip = await probe(true);
    assert.equal(
      await ip(`${SPOOFED}, ${CLIENT}, ${CF_EDGE}`, RENDER_LB),
      SPOOFED,
      'documented unsafe behaviour: the caller picks its own rate-limit bucket',
    );
  });

  test('trustProxy: 1 is NOT "one hop" in Fastify 5 — it trusts nothing and loses the client IP', async () => {
    // Fastify's own types refuse a number (`string | boolean | string[] |
    // TrustProxyFunction`), so `trustProxy: 1` does not even compile in this
    // codebase. The runtime still handles it, and fails closed — which is why
    // the "obvious" fix for this finding would silently put every caller in a
    // single bucket. Cast to document the trap instead of shipping it.
    const ip = await probe(1 as unknown as FastifyServerOptions['trustProxy']);
    assert.equal(
      await ip(`${CLIENT}, ${CF_EDGE}`, RENDER_LB),
      RENDER_LB,
      'every caller would share one bucket (the Render LB address) — safe but wrong',
    );
    assert.equal(await ip(`${SPOOFED}, ${CLIENT}`, RENDER_LB), RENDER_LB);
  });

  test('web-proxied traffic fails closed today, and resolves per browser once the Vercel hop is pinned', async () => {
    // Vercel overwrites X-Forwarded-For with the browser address, Cloudflare
    // appends Vercel's egress, Render's LB appends the Cloudflare edge.
    const chain = `${CLIENT}, ${VERCEL_EGRESS}, ${CF_EDGE}`;

    const unpinned = await probe(DEFAULT_TRUSTED_PROXIES);
    assert.equal(
      await unpinned(chain, RENDER_LB),
      VERCEL_EGRESS,
      'coarse bucket (Vercel egress), never a caller-chosen one',
    );

    const pinned = await probe([...DEFAULT_TRUSTED_PROXIES, VERCEL_EGRESS]);
    assert.equal(await pinned(chain, RENDER_LB), CLIENT, 'per-browser attribution once the hop is pinned');
    // …and spoofing stays impossible with that extra hop trusted.
    assert.equal(await pinned(`${SPOOFED}, ${CLIENT}, ${VERCEL_EGRESS}, ${CF_EDGE}`, RENDER_LB), CLIENT);
  });
});
