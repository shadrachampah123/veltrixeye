import dns from 'node:dns/promises';
import net from 'node:net';

export interface ResolvedWebhookDestination {
  url: URL;
  address: string;
  family: 4 | 6;
  /** Test-only trust anchor; DNS resolution never populates this field. */
  ca?: string;
}

/** Central, reviewable deny policy based on IANA special-purpose space. */
export const SPECIAL_PURPOSE_CIDRS = {
  ipv4: [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4',
  ],
  ipv6: [
    '::/128', '::1/128', '100::/64', '2001:1::/32', '2001:2::/48',
    '2001:3::/32', '2001:4:112::/48', '2001:10::/28', '2001:20::/28',
    '2001:30::/28', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10',
    'ff00::/8', '64:ff9b::/96', '64:ff9b:1::/48',
  ],
} as const;

type Cidr = { base: bigint; mask: bigint };
const POLICY = {
  ipv4: SPECIAL_PURPOSE_CIDRS.ipv4.map((cidr) => parseCidr(cidr, 32)),
  ipv6: SPECIAL_PURPOSE_CIDRS.ipv6.map((cidr) => parseCidr(cidr, 128)),
};

/** Resolve every address and fail closed unless every possible destination is public. */
export async function resolveWebhookDestination(
  raw: string,
  timeoutMs = 5_000,
  lookup: typeof dns.lookup = dns.lookup,
): Promise<ResolvedWebhookDestination> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('webhook endpoint is invalid'); }
  if (url.protocol !== 'https:') throw new Error('webhook endpoint must use HTTPS');
  if (url.username !== '' || url.password !== '') throw new Error('webhook endpoint must not contain URL credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') throw new Error('webhook endpoint hostname is missing');

  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
    : await withTimeout(lookup(hostname, { all: true, verbatim: true }), timeoutMs);
  if (addresses.length === 0) throw new Error('webhook endpoint did not resolve');
  for (const candidate of addresses) {
    if (isUnsafeAddress(candidate.address, candidate.family)) {
      throw new Error('webhook endpoint resolves to a private or reserved address');
    }
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family as 4 | 6 };
}

/** Public export for focused security tests; this is intentionally fail-closed. */
export function isUnsafeAddress(address: string, family = net.isIP(address)): boolean {
  if (family !== 4 && family !== 6) return true;
  const parsed = parseAddress(address, family);
  if (parsed === null) return true;
  if (family === 4) return POLICY.ipv4.some((cidr) => inCidr(parsed, cidr));

  // Mapped addresses are rejected as a class, rather than being allowed to
  // bypass the IPv4 policy through an IPv6 parser path.
  const mapped = (parsed & ((1n << 32n) - 1n << 32n)) === (0xffffn << 32n) && (parsed >> 48n) === 0n;
  return mapped || POLICY.ipv6.some((cidr) => inCidr(parsed, cidr));
}

function parseCidr(value: string, bits: 32 | 128): Cidr {
  const [rawAddress, rawPrefix] = value.split('/');
  const prefix = Number(rawPrefix);
  const parsed = parseAddress(rawAddress!, bits === 32 ? 4 : 6);
  if (parsed === null || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new Error(`invalid policy CIDR: ${value}`);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { base: parsed & mask, mask };
}

function inCidr(address: bigint, cidr: Cidr): boolean { return (address & cidr.mask) === cidr.base; }

function parseAddress(address: string, family: 4 | 6): bigint | null {
  if (family === 4) {
    const parts = address.split('.');
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
      value = (value << 8n) | BigInt(part);
    }
    return value;
  }
  let value = address.toLowerCase().split('%')[0]!;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1);
    const parts = ipv4.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    const hi = ((Number(parts[0]) << 8) | Number(parts[1])).toString(16);
    const lo = ((Number(parts[2]) << 8) | Number(parts[3])).toString(16);
    value = `${value.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0]!.split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1]!.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const groups = [...left, ...(pieces.length === 2 ? Array(8 - left.length - right.length).fill('0') : []), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((out, part) => (out << 16n) | BigInt(`0x${part}`), 0n);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('webhook DNS lookup timed out')), Math.max(1, timeoutMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
