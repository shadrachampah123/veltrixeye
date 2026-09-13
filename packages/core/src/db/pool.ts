import pg from 'pg';

export interface DatabaseConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/dbname */
  databaseUrl: string;
  /** Max pool size. */
  max?: number;
  /**
   * SSL mode for the connection:
   *  - 'disable'      no TLS (local dev / trusted network)
   *  - 'require'      TLS, host verification off (typical for managed Postgres)
   *  - 'verify-full'  TLS with full certificate verification
   */
  sslMode?: 'disable' | 'require' | 'verify-full';
}

/**
 * Create a pg Pool from environment-derived configuration.
 * The rest of the application never touches connection details directly.
 */
export function createPool(config: DatabaseConfig): pg.Pool {
  const ssl =
    config.sslMode === 'require'
      ? { rejectUnauthorized: false }
      : config.sslMode === 'verify-full'
        ? { rejectUnauthorized: true }
        : undefined;
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.max ?? 10,
    ssl,
    application_name: 'veltrixeye',
  });
}

export type { pg };
