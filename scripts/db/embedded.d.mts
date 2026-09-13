export interface EmbeddedPostgresOptions {
  dataDir: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface EmbeddedPostgresHandle {
  /** Connection URL for the bootstrapped database. */
  dbUrl: string;
  /** Stop the Postgres instance. */
  stop: () => Promise<void>;
}

/**
 * Boot a throwaway embedded Postgres instance (dev/test infrastructure only).
 * Complements `scripts/db/embedded.mjs`.
 */
export function startEmbeddedPostgres(
  options: EmbeddedPostgresOptions,
): Promise<EmbeddedPostgresHandle>;
