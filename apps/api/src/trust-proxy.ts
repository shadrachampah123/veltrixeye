import net from 'node:net';

/**
 * Trusted-proxy pinning — how this service decides which IP address is "the
 * client" (M2 production-hardening F1).
 *
 * `req.ip` is the key for every rate limit (`@fastify/rate-limit`,
 * `keyGenerator: (req) => req.ip`) and the value recorded in `audit_events.ip`
 * and `sessions.ip`. Fastify derives it with `proxy-addr`: starting at the TCP
 * peer it walks the `X-Forwarded-For` chain from right to left and returns the
 * **first address that is NOT in the trusted set**. The trusted set therefore
 * decides who is allowed to speak for the client, which makes it a security
 * boundary rather than a convenience flag:
 *
 *  - `trustProxy: true` (the M1/M2 default) trusts every hop, so `req.ip`
 *    becomes the LEFTMOST `X-Forwarded-For` value — a header any client can
 *    set. Because this API is publicly reachable on `*.onrender.com` (not only
 *    through the Vercel proxy), a caller could rotate that header and mint a
 *    fresh rate-limit bucket per request: 300/min global, 10/min login,
 *    60/min candles, 5/min backfill all keyed on a value the attacker chose.
 *  - `trustProxy: <number>` does NOT mean "trust N hops" in Fastify 5. A hop
 *    count cannot validate the immediate peer, so Fastify deliberately fails
 *    closed and trusts nothing (`getTrustProxyFn` in `fastify/lib/request.js`
 *    returns `() => false` for numbers). `req.ip` would then be Render's load
 *    balancer address for every request, collapsing all users into one bucket
 *    — safe against spoofing, but it breaks per-client limiting and would let
 *    one abuser lock out everybody's logins.
 *  - an explicit ADDRESS LIST is the narrowest correct setting, and the one
 *    this service uses: trust exactly the infrastructure that really sits in
 *    front of the process, and nothing else.
 *
 * Production topology (Render, public web service):
 *
 *     client ──► Cloudflare edge ──► Render load balancer ──► this process
 *              (public, published     (Render's own network:
 *               IP ranges)             private/link-local hops)
 *
 * Render routes **all** inbound traffic for public web services through
 * Cloudflare and then through its own load balancer
 * (https://render.com/articles/how-render-handles-ddos-attacks), and
 * Cloudflare publishes the ranges it connects to origins from
 * (https://www.cloudflare.com/ips/). Those two sets are the whole trust
 * boundary, so `DEFAULT_TRUSTED_PROXIES` below is exactly:
 * Render-internal hops (named ranges) + Cloudflare's published ranges.
 *
 * Result: a spoofed `X-Forwarded-For: <fake>, <real-client>` is resolved to
 * `<real-client>` — the walk stops at the first address that is neither
 * Cloudflare nor Render-internal, and every entry an attacker can add sits to
 * the LEFT of the address Cloudflare appended, so it is never reached.
 *
 * KNOWN LIMIT (documented, fails closed): traffic proxied by the Vercel web
 * app (`next.config.mjs` rewrites `/api/*` server-side) reaches Cloudflare
 * from a **Vercel egress** address, which Vercel does not publish as a range
 * (https://vercel.com/kb/guide/can-i-get-a-fixed-ip-address). For that path
 * `req.ip` resolves to the Vercel egress address instead of the browser's, so
 * those callers share a bucket. That is coarser, never attacker-chosen. To
 * restore per-browser attribution on that path, enable **Vercel Static IPs**
 * and add the fixed egress addresses to `TRUSTED_PROXY_CIDRS`; the walk then
 * skips the Vercel hop and lands on the browser address that Vercel vouches
 * for (Vercel overwrites `X-Forwarded-For` rather than appending to it, so
 * that value is not client-controlled either —
 * https://vercel.com/docs/headers/request-headers).
 *
 * Local development and tests are unaffected: the peer is loopback (trusted),
 * so a single `X-Forwarded-For` value still resolves as it always did.
 */

/**
 * proxy-addr's named ranges, used for the hops inside Render's own network.
 * `loopback` also keeps local dev/test working (the peer is 127.0.0.1).
 */
export const PLATFORM_INTERNAL_RANGES = ['loopback', 'linklocal', 'uniquelocal'] as const;

/**
 * Cloudflare's published IPv4 edge ranges — the addresses Cloudflare connects
 * to origins from. Source: https://www.cloudflare.com/ips-v4 (fetched
 * 2026-09-14). Cloudflare announces changes in advance; re-check the list
 * when the API starts resolving client IPs to a Cloudflare address (that is
 * the observable symptom of a stale list, and it fails closed).
 */
export const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

/** Cloudflare's published IPv6 edge ranges. Source: https://www.cloudflare.com/ips-v6 (fetched 2026-09-14). */
export const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

/** The default trust boundary: Render-internal hops + Cloudflare's edge. */
export const DEFAULT_TRUSTED_PROXIES: string[] = [
  ...PLATFORM_INTERNAL_RANGES,
  ...CLOUDFLARE_IPV4_RANGES,
  ...CLOUDFLARE_IPV6_RANGES,
];

/** Named ranges proxy-addr understands (anything else must be an IP/CIDR). */
const NAMED_RANGES = new Set<string>(PLATFORM_INTERNAL_RANGES);

/**
 * Parse + validate `TRUSTED_PROXY_CIDRS` (comma- or whitespace-separated).
 *
 * Fails loudly: an unusable trust list must stop the boot, not silently widen
 * or narrow who may speak for the client. Entries are lower-cased and
 * de-duplicated so the value handed to Fastify is deterministic.
 */
export function parseTrustedProxies(raw: string): string[] {
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error('no trusted proxies listed — expected CIDRs and/or loopback|linklocal|uniquelocal');
  }

  const invalid: string[] = [];
  for (const entry of entries) {
    if (!isValidTrustEntry(entry)) invalid.push(entry);
  }
  if (invalid.length > 0) {
    throw new Error(
      `invalid trusted-proxy ${invalid.length === 1 ? 'entry' : 'entries'}: ${invalid.join(', ')} ` +
        '(expected an IP address, a CIDR range, or one of loopback|linklocal|uniquelocal)',
    );
  }

  return [...new Set(entries)];
}

/**
 * One trust entry: a proxy-addr named range, a bare IP, or a CIDR range.
 * A `/0` (or an equivalent "trust everything" entry) is rejected on purpose —
 * it would reintroduce exactly the vulnerability this module exists to close.
 */
function isValidTrustEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;

  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const kind = net.isIP(address); // 0 = invalid, 4 = IPv4, 6 = IPv6
  if (kind === 0) return false;

  if (slash === -1) return true; // bare address ⇒ proxy-addr treats it as a /32 or /128

  const prefix = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  const maxBits = kind === 4 ? 32 : 128;
  // bits === 0 trusts the entire internet; refuse it instead of failing open.
  return bits > 0 && bits <= maxBits;
}
