import net from 'node:net';

/**
 * Billing Step 5.2 — the webhook SOURCE-IP ALLOW-LIST (defence in depth).
 *
 * The provider documents that webhook deliveries only originate from three
 * addresses (the same set in test and live mode) and that "any webhook from
 * outside of these can safely be considered counterfeit":
 *
 *     52.31.139.75, 52.49.173.169, 52.214.14.220
 *
 * (Paystack Webhooks documentation — see docs/paystack-provider-contract.md
 * §1.) The allow-list pins exactly those addresses by default; the operator
 * may widen or replace the list per deployment via
 * `PAYSTACK_WEBHOOK_ALLOWED_IPS` (for example to admit loopback deliveries in
 * local development, or a staging egress address). The list is enforced by
 * the webhook route ON TOP of signature verification — it is a network-layer
 * filter, never a substitute for the HMAC check, which remains the authority.
 *
 * `req.ip` is what gets matched, and it is only trustworthy because Fastify's
 * `trustProxy` is pinned to the real infrastructure hops (see trust-proxy.ts):
 * a caller cannot choose its own address by setting `X-Forwarded-For`.
 */

/** The provider's documented webhook source addresses (test and live). */
export const PAYSTACK_DOCUMENTED_WEBHOOK_SOURCE_IPS = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
] as const;

/** One parsed allow-list entry: a network and its prefix length. */
export interface WebhookAllowListEntry {
  /** Parsed network address, as a BigInt host-order integer. */
  bits: bigint;
  /** 32 for IPv4, 128 for IPv6. */
  family: 4 | 6;
  /** Prefix length (32 or 128 for a bare address). */
  prefix: number;
  /** The entry as written (normalized), for diagnostics. */
  raw: string;
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;

/**
 * Parse an IPv4 or IPv6 address into an integer. IPv4-mapped IPv6 forms
 * (`::ffff:a.b.c.d`) normalize to their IPv4 value so a v4 entry admits the
 * same address however the platform spells it.
 */
function parseIpToBits(address: string): { bits: bigint; family: 4 | 6 } | null {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  const candidate = mapped ? (mapped[1] as string) : address;
  const family = net.isIP(candidate);
  if (family === 4) {
    const octets = candidate.split('.').map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    return {
      bits: (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d),
      family: 4,
    };
  }
  if (family === 6) {
    return parseIpv6(candidate);
  }
  return null;
}

function parseIpv6(address: string): { bits: bigint; family: 4 | 6 } | null {
  // Reject zone ids and anything outside hex/colon/dot territory early.
  if (!/^[0-9a-fA-F:.]+$/.test(address) || address.includes('%')) return null;
  if ((address.match(/::/g) ?? []).length > 1) return null;

  // Rewrite an embedded IPv4 tail as two hex groups so the rest of the parser
  // sees one shape only (`::ffff:1.2.3.4` → `::ffff:102:304`).
  let work = address;
  const v4Tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(work);
  if (v4Tail !== null) {
    const v4 = parseIpToBits(v4Tail[1] as string);
    if (v4 === null || v4.family !== 4) return null;
    const hi = ((v4.bits >> 16n) & 0xffffn).toString(16);
    const lo = (v4.bits & 0xffffn).toString(16);
    work = work.slice(0, work.length - (v4Tail[1] as string).length) + `${hi}:${lo}`;
  }

  let sides: [string[], string[]];
  if (work.includes('::')) {
    const [leftRaw, rightRaw] = work.split('::') as [string, string];
    sides = [leftRaw === '' ? [] : leftRaw.split(':'), rightRaw === '' ? [] : rightRaw.split(':')];
  } else {
    sides = [work.split(':'), []];
  }

  const left = parseGroups(sides[0]);
  const right = parseGroups(sides[1]);
  if (left === null || right === null) return null;

  if (!work.includes('::')) {
    if (left.length !== 8) return null;
    return { bits: groupsToBits(left), family: 6 };
  }
  // '::' must stand for at least one zero group.
  if (left.length + right.length > 7) return null;
  const fill = Array.from({ length: 8 - left.length - right.length }, () => 0);
  return { bits: groupsToBits([...left, ...fill, ...right]), family: 6 };
}

/** Parse `hex[:hex…]` into 16-bit group values; null on any malformed group. */
function parseGroups(side: string[]): number[] | null {
  const values: number[] = [];
  for (const group of side) {
    if (group === '' || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

function groupsToBits(groups: number[]): bigint {
  if (groups.length !== 8) throw new Error('an IPv6 address has exactly eight groups');
  let bits = 0n;
  for (const group of groups) bits = (bits << 16n) | BigInt(group);
  return bits;
}

/**
 * Parse + validate `PAYSTACK_WEBHOOK_ALLOWED_IPS` (comma- or
 * whitespace-separated IPs/CIDRs). Empty input selects the provider's
 * documented source addresses — the fail-closed default.
 *
 * Fails loudly: an unusable entry must stop the boot, never silently widen or
 * narrow who may deliver. A `/0` (admit everything) is rejected on purpose —
 * it would switch the allow-list off while pretending to have one.
 */
export function parsePaystackWebhookAllowList(raw: string): WebhookAllowListEntry[] {
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const source = entries.length === 0 ? [...PAYSTACK_DOCUMENTED_WEBHOOK_SOURCE_IPS] : entries;
  const parsed: WebhookAllowListEntry[] = [];
  for (const entry of source) {
    const slash = entry.lastIndexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const ip = parseIpToBits(address);
    if (ip === null) {
      throw new Error(`invalid webhook allow-list entry "${entry}" (expected an IP address or a CIDR range)`);
    }
    const maxBits = ip.family === 4 ? IPV4_BITS : IPV6_BITS;
    let prefix = maxBits;
    if (slash !== -1) {
      const rawPrefix = entry.slice(slash + 1);
      if (!/^\d+$/.test(rawPrefix)) {
        throw new Error(`invalid webhook allow-list entry "${entry}" (prefix must be a number of bits)`);
      }
      prefix = Number(rawPrefix);
      if (!(prefix > 0 && prefix <= maxBits)) {
        throw new Error(
          `invalid webhook allow-list entry "${entry}" — a /0 admits everything and is refused; ` +
            'remove the entry instead of disabling the allow-list',
        );
      }
    }
    parsed.push({ bits: ip.bits, family: ip.family, prefix, raw: entry });
  }
  return parsed;
}

/** True when `address` falls inside ANY allow-list entry. */
export function webhookIpAllowed(address: string, allowList: WebhookAllowListEntry[]): boolean {
  const ip = parseIpToBits(address);
  if (ip === null) return false;
  return allowList.some((entry) => {
    if (entry.family !== ip.family) return false;
    const total = entry.family === 4 ? IPV4_BITS : IPV6_BITS;
    const shift = BigInt(total - entry.prefix);
    return (entry.bits >> shift) === (ip.bits >> shift);
  });
}
