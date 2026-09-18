import dns from 'node:dns/promises';
import net from 'node:net';

export interface ResolvedWebhookDestination {
  url: URL;
  address: string;
  family: 4 | 6;
  /** Test-only trust anchor for an actual local transport test. Resolvers never set this. */
  ca?: string;
}

/** Resolve every address and fail closed unless every possible destination is public. */
export async function resolveWebhookDestination(raw: string, timeoutMs = 5_000): Promise<ResolvedWebhookDestination> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('webhook endpoint is invalid'); }
  if (url.protocol !== 'https:') throw new Error('webhook endpoint must use HTTPS');
  if (url.username !== '' || url.password !== '') throw new Error('webhook endpoint must not contain URL credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') throw new Error('webhook endpoint hostname is missing');

  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
    : await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('webhook DNS lookup timed out')), Math.max(1, timeoutMs))),
    ]);
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
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const n = (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0;
    const first = octets[0]!;
    return first === 0 || first === 10 || first === 127 || first === 169 && octets[1] === 254 ||
      first === 172 && octets[1]! >= 16 && octets[1]! <= 31 || first === 192 && octets[1] === 168 ||
      first === 192 && octets[1] === 0 && octets[2] === 0 || first === 192 && octets[1] === 2 ||
      first === 192 && octets[1] === 88 && octets[2] === 99 ||
      first === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51) ||
      first === 203 && octets[1] === 0 && octets[2] === 113 ||
      first >= 224 || n === 0xffffffff || first === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split('%')[0]!;
  if (!normalized.includes(':')) return true;
  const groups = expandIpv6(normalized);
  if (!groups) return true;
  const first = groups[0]!;
  const second = groups[1]!;
  const isV4Mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    const bytes = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255];
    return isUnsafeAddress(bytes.join('.'), 4);
  }
  return groups.every((part) => part === 0) || (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && (second === 0x0db8 || second === 0x0000 || second === 0x0003 ||
      second === 0x0010 || second === 0x0020 || second === 0x0030 ||
      (second === 0x0002 && groups[2] === 0) || (second === 0x0004 && groups[2] === 0x0112))) ||
    (first === 0x0100 && groups[1] === 0) || (first === 0x5f00);
}

function expandIpv6(value: string): number[] | null {
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0]!.split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1]!.split(':') : [];
  const parse = (part: string): number | null => /^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : null;
  const parsed = [...left, ...right].map(parse);
  if (parsed.some((part) => part === null)) return null;
  const values = parsed as number[];
  const missing = 8 - values.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  return pieces.length === 2 ? [...values.slice(0, left.length), ...Array.from({ length: missing }, () => 0), ...values.slice(left.length)] : values;
}
