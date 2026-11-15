/**
 * Database connection / startup tuning contracts.
 *
 * These constants are shared across packages so the API's boot-time database
 * wait and any other consumer agree on a single source of truth for tuning
 * defaults.
 */

/**
 * Default overall wall-clock budget (milliseconds) for the database readiness
 * wait at boot.
 *
 * The readiness probe is a bounded raw-socket connect, so a reachable database
 * answers in milliseconds and an unreachable one fails fast on
 * ECONNREFUSED/ENOTFOUND. The only case a probe consumes its full per-attempt
 * timeout is a black-hole host (firewall drops the SYN). Bounding the WHOLE
 * wait — not just each attempt — keeps the database phase from eating the
 * deployment's startup deadline (e.g. Render) when the database is
 * unreachable: both each probe and each retry sleep are clamped so they can
 * never run past this deadline.
 *
 * 60s is generous for a TCP/Unix-socket connect retry loop while leaving
 * ample headroom for migrations, app build and listen within a typical
 * platform startup budget.
 */
export const DEFAULT_DATABASE_STARTUP_TIMEOUT_MS = 60_000;
