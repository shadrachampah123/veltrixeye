import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { SessionDto } from '@veltrixeye/contracts';

export interface NewSessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Server-side sessions.
 *
 * - The raw token is 256 bits of CSPRNG randomness; only its SHA-256 is
 *   stored, so a database leak does not yield usable session tokens.
 * - The cookie (set by the API layer) is HttpOnly, SameSite=Strict, and
 *   Secure in production.
 */
export class SessionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlDays = 30,
  ) {}

  /** Create a session; returns the raw token (sent once, in the cookie). */
  async create(userId: string, meta: NewSessionMeta): Promise<{ token: string; record: SessionRecord }> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);
    const res = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, tokenHash, meta.ip ?? null, meta.userAgent ?? null, expiresAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Failed to create session');
    return { token, record: toRecord(row) };
  }

  /** Validate a token: not revoked, not expired, user active. */
  async findByToken(token: string): Promise<SessionRecord | null> {
    const tokenHash = sha256(token);
    const res = await this.pool.query<SessionRow & { email: string; deleted_at: Date | null }>(
      `SELECT s.*, u.email, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.deleted_at !== null) return null;
    if (row.expires_at.getTime() <= Date.now()) return null;
    // Touch last_seen (throttled: at most once per 30s per session).
    const stale = row.last_seen_at === null || Date.now() - row.last_seen_at.getTime() > 30_000;
    if (stale) {
      await this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
    }
    return toRecord(row);
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
  }

  /** Revoke every session of a user (e.g. password change). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
  }

  async listForUser(userId: string, currentToken: string | null): Promise<SessionDto[]> {
    const res = await this.pool.query<SessionRow & { token_hash: string }>(
      `SELECT s.*, s.token_hash
       FROM sessions s
       WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       ORDER BY s.created_at DESC`,
      [userId],
    );
    const currentHash = currentToken ? sha256(currentToken) : null;
    return res.rows.map((row) => toDto(row, row.token_hash === currentHash));
  }

  /** Delete expired sessions (housekeeping; safe to run on a schedule). */
  async deleteExpired(): Promise<number> {
    const res = await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    return res.rowCount ?? 0;
  }
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function toDto(row: SessionRow, current: boolean): SessionDto {
  return {
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    current,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
