/**
 * The shared **local-database write guard** for the billing operator CLIs.
 *
 * Extracted from `provision-sandbox.ts` so the sandbox-provisioning run and the
 * FX publication run enforce the SAME rule from ONE implementation. A second,
 * divergent copy of a safety gate is a drift hazard: the two would eventually
 * disagree about which targets are acceptable, and the weaker one would become
 * the real boundary.
 *
 * The function is behaviour-identical to the original: same accepted protocols,
 * same loopback host allowlist, same query/fragment refusal, same refusal text.
 */

/**
 * The ONLY database targets a `--apply` may write: loopback hosts — the local
 * development database `npm run setup` writes into `.env`, and the embedded
 * test databases the suites boot. Every other target (a managed production
 * host, any remote or unparseable string, anything carrying a query or
 * fragment that could redirect the real connection) is production-or-
 * unverified and is refused BEFORE a pool exists, so no connection — let
 * alone a write — can happen.
 *
 * The configured value is NEVER echoed: the refusal states only which rule
 * failed, so no hostname, credential or connection-string fragment can
 * reach a terminal or a log. Fail closed on every doubt: anything this
 * function cannot positively verify as local is refused.
 */
const LOCAL_DATABASE_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

export function localDatabaseTargetRejection(databaseUrl: string): string | null {
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    return 'the configured DATABASE_URL is not a parseable postgres connection target';
  }
  if (target.protocol !== 'postgres:' && target.protocol !== 'postgresql:') {
    return 'the configured DATABASE_URL is not a postgres connection target';
  }
  if (!LOCAL_DATABASE_HOSTNAMES.has(target.hostname)) {
    return 'the configured DATABASE_URL does not resolve to a local loopback host';
  }
  if (target.search !== '' || target.hash !== '') {
    return (
      'the configured DATABASE_URL carries query or fragment parameters that could redirect ' +
      'the real connection'
    );
  }
  return null;
}
