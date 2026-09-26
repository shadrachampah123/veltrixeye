import type pg from 'pg';

export interface AuditEntry {
  userId?: string | null;
  /** Stable machine action, e.g. 'auth.login', 'strategy.version_published'. */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit log for security-relevant events.
 * Fire-and-forget from the caller's perspective: a failed audit write must
 * not break the user-facing operation, but it IS logged to the app log.
 */
export class AuditService {
  constructor(private readonly pool: pg.Pool) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await recordAuditEvent(this.pool, entry);
    } catch (err) {
      console.error('[audit] failed to write audit event', err);
    }
  }
}

/**
 * TRANSACTIONAL audit write.
 *
 * Runs on the caller's client — inside the caller's transaction — and
 * PROPAGATES failure instead of swallowing it. This is the only correct way to
 * record an event that is part of a durable fact: the audit row and the fact
 * it describes must commit together or roll back together. A swallowed audit
 * failure would leave an authoritative fact with no record of who authorized
 * it.
 *
 * Deliberately separate from `AuditService.log`, which stays fire-and-forget
 * for request-scoped events (a failed audit write must never break a
 * user-facing operation).
 */
export async function recordAuditEvent(
  db: Pick<pg.Pool | pg.PoolClient, 'query'>,
  entry: AuditEntry,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (user_id, action, entity_type, entity_id, ip, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

export interface AuditEventRow {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export function readAuditEvents(pool: pg.Pool, userId: string, action?: string): Promise<AuditEventRow[]> {
  if (action) {
    return pool
      .query<AuditEventRow>(
        'SELECT * FROM audit_events WHERE user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 50',
        [userId, action],
      )
      .then((r) => r.rows);
  }
  return pool
    .query<AuditEventRow>('SELECT * FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [
      userId,
    ])
    .then((r) => r.rows);
}
