/**
 * DATABASE IDENTITY ALLOWLIST — the independent authority that decides which
 * database a billing write may touch. Billing Step 4 remediation (PR #150
 * review, finding H1; PR #151).
 *
 * WHY THIS EXISTS. A loopback hostname proves nothing about which database
 * answers it (a localhost tunnel can reach production), and a database COMMENT
 * is set by whoever owns the database — so a COMMENT can never establish that a
 * database is a sandbox. This module therefore decides identity from THREE
 * things that are never taken from the connection string, the operator's
 * runtime input, or the database's own comments:
 *
 *  1. an ALLOWLIST FILE committed to the repository (`config/billing/
 *     database-identity-allowlist.json`), outside the database it protects,
 *     whose exact bytes are PINNED by SHA-256 in this module — so an edited
 *     copy on an operator's machine is refused, and changing the allowlist
 *     requires a code change that a reviewer sees;
 *  2. an ENTRY the operator selects BY ID (`--target <id>`). An id is a
 *     selector, never an authority: the operator cannot supply a database name
 *     or system identifier at runtime and thereby authorize a target;
 *  3. the CONNECTED database's actual `current_database()` and cluster
 *     `system_identifier`, which must equal the entry's values exactly and must
 *     be read on the very connection the write uses (inside its transaction).
 *
 * Entries are typed by ENVIRONMENT: `sandbox` (test-domain provisioning) or
 * `production` (live provisioning). An environment mismatch is refused, so a
 * sandbox entry can never authorize a live write and vice versa. The allowlist
 * parser also refuses any (name, system identifier) pair that appears under both
 * environments.
 *
 * NO COMMENT MARKER IS CONSULTED. A database comment is not evidence of anything
 * and establishes no trust. Failure is closed everywhere: a missing, unpinned,
 * malformed or unreadable allowlist, an unknown id, an unreadable identity, and
 * any mismatch all refuse before a write.
 *
 * A cluster SYSTEM IDENTIFIER is an identity, not an environment assertion.
 * Every PostgreSQL cluster is born with its own system_identifier, so a PHYSICAL
 * CLONE of a production cluster receives a DIFFERENT identifier and does not
 * inherit production's. The identifier therefore never authenticates a database
 * as "non-production": a physical clone of production is still production data,
 * and it must be reviewed and allowlisted on its own, with the environment its
 * owner asserts. The entry's `environment` is a reviewed assertion, never
 * derived from the identifier.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const DATABASE_IDENTITY_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type DatabaseIdentityEnvironment = (typeof DATABASE_IDENTITY_ENVIRONMENTS)[number];

export const DATABASE_IDENTITY_ALLOWLIST_SCHEMA_VERSION = 1 as const;

/**
 * The pinned SHA-256 of the committed allowlist file's exact bytes. Changing the
 * allowlist requires changing this constant in the same reviewed change. The
 * value below is the digest of the committed file with NO entries: every
 * database is refused until an owner adds a reviewed entry and updates the pin.
 */
export const DATABASE_IDENTITY_ALLOWLIST_SHA256 =
  '7060c267c912e3156b87c646e3bc970eac1ac8bdd964cf0a794b83e6f1250614' as const;

/** Repository-relative path of the committed allowlist (resolved by callers). */
export const DATABASE_IDENTITY_ALLOWLIST_RELATIVE_PATH = 'config/billing/database-identity-allowlist.json' as const;

export type DatabaseIdentityFailureReason =
  | 'allowlist_missing'
  | 'allowlist_malformed'
  | 'allowlist_pin_mismatch'
  | 'target_not_approved'
  | 'environment_mismatch'
  | 'confirmation_missing'
  | 'identity_unverified'
  | 'identity_mismatch'
  /** No approved target was configured for this store/run: fail closed. */
  | 'identity_not_configured';

/**
 * `static`: refused from the configuration and the operator's selector, before
 * any connection. `connected`: refused on the connection's real identity.
 */
export type DatabaseIdentityPhase = 'static' | 'connected';

/** A typed refusal. Messages never echo a database name, identifier or credential. */
export class DatabaseIdentityError extends Error {
  readonly code = 'database_identity_refused' as const;

  constructor(
    readonly reason: DatabaseIdentityFailureReason,
    readonly phase: DatabaseIdentityPhase,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DatabaseIdentityError';
  }
}

export function isDatabaseIdentityError(value: unknown): value is DatabaseIdentityError {
  return value instanceof DatabaseIdentityError;
}

export interface DatabaseIdentityEntry {
  readonly id: string;
  readonly environment: DatabaseIdentityEnvironment;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly description?: string;
}

/** A parsed, validated allowlist. Only this module's parser creates one. */
export interface DatabaseIdentityAllowlist {
  readonly entries: readonly DatabaseIdentityEntry[];
}

const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
/** pg_control_system().system_identifier is a signed bigint: at most 19 digits. */
const SYSTEM_IDENTIFIER_PATTERN = /^[0-9]{1,19}$/;
const MAX_ENTRIES = 20;

const entrySchema = z
  .object({
    id: z.string().regex(TARGET_ID_PATTERN, 'a target id is lowercase letters, digits and hyphens'),
    environment: z.enum(DATABASE_IDENTITY_ENVIRONMENTS),
    databaseName: z.string().regex(DATABASE_NAME_PATTERN, 'a database name is a plain identifier'),
    systemIdentifier: z.string().regex(SYSTEM_IDENTIFIER_PATTERN, 'a system identifier is unsigned decimal digits'),
    description: z.string().min(1).max(200).optional(),
  })
  .strict();

const allowlistSchema = z
  .object({
    schemaVersion: z.literal(DATABASE_IDENTITY_ALLOWLIST_SCHEMA_VERSION),
    entries: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();

/**
 * Parse and validate an allowlist object. Refuses duplicate ids, duplicate
 * identities, and any identity that appears under BOTH environments.
 */
export function parseDatabaseIdentityAllowlist(raw: unknown): DatabaseIdentityAllowlist {
  const parsed = allowlistSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DatabaseIdentityError(
      'allowlist_malformed',
      'static',
      'The database identity allowlist is malformed. Nothing was connected or written.',
      { cause: parsed.error },
    );
  }
  const ids = new Set<string>();
  const identities = new Map<string, DatabaseIdentityEnvironment>();
  for (const entry of parsed.data.entries) {
    if (ids.has(entry.id)) {
      throw new DatabaseIdentityError(
        'allowlist_malformed',
        'static',
        'The database identity allowlist repeats a target id. Nothing was connected or written.',
      );
    }
    ids.add(entry.id);
    const key = `${entry.databaseName}\u0000${entry.systemIdentifier}`;
    const seen = identities.get(key);
    if (seen !== undefined) {
      throw new DatabaseIdentityError(
        'allowlist_malformed',
        'static',
        seen === entry.environment
          ? 'The database identity allowlist repeats a database identity. Nothing was connected or written.'
          : 'The database identity allowlist lists one database under both sandbox and production. Nothing was connected or written.',
      );
    }
    identities.set(key, entry.environment);
  }
  return Object.freeze({
    entries: Object.freeze(parsed.data.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Load the committed allowlist from `filePath` and verify its exact bytes
 * against the pinned SHA-256 in this module. Every failure is a typed,
 * fail-closed refusal.
 *
 * The pin is a security control, so it is NOT a caller-supplied parameter: a
 * caller that could override it could point the loader at an edited allowlist
 * and defeat the pin entirely. The only way to change the allowlist is a
 * reviewed change that updates {@link DATABASE_IDENTITY_ALLOWLIST_SHA256} in
 * code, together with the committed file.
 */
export function loadDatabaseIdentityAllowlist(filePath: string): DatabaseIdentityAllowlist {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new DatabaseIdentityError(
      'allowlist_missing',
      'static',
      'The database identity allowlist could not be read. Nothing was connected or written.',
      { cause: error },
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== DATABASE_IDENTITY_ALLOWLIST_SHA256) {
    throw new DatabaseIdentityError(
      'allowlist_pin_mismatch',
      'static',
      'The database identity allowlist does not match its pinned digest. Nothing was connected or written. ' +
        'The allowlist changes only through a reviewed change that updates the pin in code.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new DatabaseIdentityError(
      'allowlist_malformed',
      'static',
      'The database identity allowlist is not valid JSON. Nothing was connected or written.',
      { cause: error },
    );
  }
  return parseDatabaseIdentityAllowlist(raw);
}

/**
 * Resolve the operator's selector to ONE entry of the expected environment,
 * BEFORE any connection. Refuses an unknown id, an entry of the wrong
 * environment (sandbox↔production crossover), and a production run whose typed
 * confirmation does not repeat the target id.
 */
export function resolveDatabaseTarget(
  allowlist: DatabaseIdentityAllowlist,
  environment: DatabaseIdentityEnvironment,
  targetId: string,
  confirmTargetId?: string,
): DatabaseIdentityEntry {
  const entry = allowlist.entries.find((candidate) => candidate.id === targetId);
  if (entry === undefined) {
    throw new DatabaseIdentityError(
      'target_not_approved',
      'static',
      `The target "${targetId}" is not in the reviewed ${environment} allowlist. Nothing was connected or written.`,
    );
  }
  if (entry.environment !== environment) {
    throw new DatabaseIdentityError(
      'environment_mismatch',
      'static',
      `The target "${targetId}" is a ${entry.environment} entry and cannot authorize a ${environment} run. ` +
        'Nothing was connected or written.',
    );
  }
  if (environment === 'production' && confirmTargetId !== targetId) {
    throw new DatabaseIdentityError(
      'confirmation_missing',
      'static',
      'A production run requires the explicit confirmation of the target id (typed twice, identically). ' +
        'Nothing was connected or written.',
    );
  }
  return entry;
}

/**
 * Verify, on the CONNECTION THE WRITE USES, that the connected database is the
 * approved entry. Read-only: one catalogue SELECT. Fails closed: an unreadable
 * identity is never assumed to match.
 */
export async function verifyConnectedDatabaseIdentity(
  runner: { query: (text: string) => Promise<{ rows: unknown[] }> },
  entry: DatabaseIdentityEntry,
): Promise<void> {
  let row: { name?: unknown; system_identifier?: unknown } | undefined;
  try {
    const result = await runner.query(
      'SELECT current_database() AS name, (SELECT c.system_identifier::text FROM pg_catalog.pg_control_system() c) AS system_identifier',
    );
    row = result.rows[0] as typeof row;
  } catch (error) {
    throw new DatabaseIdentityError(
      'identity_unverified',
      'connected',
      'The connected database identity could not be read, so it cannot be established as the approved target. ' +
        'Nothing was written.',
      { cause: error },
    );
  }
  if (row === undefined || typeof row.name !== 'string' || typeof row.system_identifier !== 'string') {
    throw new DatabaseIdentityError(
      'identity_unverified',
      'connected',
      'The connected database identity could not be read. Nothing was written.',
    );
  }
  // Each mismatch names WHICH fact differs, never its value: a refusal must
  // diagnose the target without echoing a database name or identifier.
  if (row.name !== entry.databaseName) {
    throw new DatabaseIdentityError(
      'identity_mismatch',
      'connected',
      'The connected database NAME does not match the approved target this run selected. Nothing was written.',
    );
  }
  if (row.system_identifier !== entry.systemIdentifier) {
    throw new DatabaseIdentityError(
      'identity_mismatch',
      'connected',
      'The connected database CLUSTER IDENTIFIER does not match the approved target this run selected. Nothing was written.',
    );
  }
}
