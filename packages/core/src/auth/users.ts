import type pg from 'pg';
import { Errors } from '../errors.js';
import type { UserDto, UserPlan } from '@veltrixeye/contracts';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  plan: UserPlan;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CreateUserData {
  email: string;
  passwordHash: string;
  name: string;
}

export class UserService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Create a user. Email is normalized to lowercase; must be valid + 3-254 chars.
   *
   * PRICING-LOCK LIFECYCLE — MODEL C ("checkout-created commercial
   * subscription"). Registration is an IDENTITY operation and nothing else:
   *
   *  - it creates the user exactly as before — one INSERT in the same
   *    transaction, the same unique-email conflict mapping, the same
   *    `users.plan` default (`free`, from migration 0001);
   *  - it creates **no `subscriptions` row**. A user without one is the
   *    supported free state: `getBillingState` and every entitlement reader
   *    resolve a missing row to `plan: 'free'`, `status: 'active'`,
   *    `paymentConfirmed: false` (no activation fact can exist without a
   *    commercial subscription row), the free entitlement set and
   *    `canAccessAutomation: false` — with no provider and no commercial
   *    entitlement;
   *  - the ONE path that creates a commercial subscription row is the first
   *    `BillingCheckoutService.checkout()` for that user, which derives the
   *    active provider-plan epoch and the pinned FX pricing and writes the sold
   *    subscription together with its immutable pricing lock atomically
   *    (`ON CONFLICT (user_id) DO NOTHING`, so `UNIQUE (user_id)` stays the
   *    concurrency authority);
   *  - there is therefore NO billing, pricing, FX, provider or lock
   *    dependency in registration, and no pricing work may be added here.
   *
   * WHY THE EAGER FREE ROW WAS REMOVED: migration 0032 makes
   * `subscriptions.locked_pricing_snapshot_id` immutable, so `NULL` → non-NULL
   * can never be written later (`subscriptions_locked_pricing_immutable`).
   * A registration-created row could therefore never become a commercial one —
   * it could only make the first checkout fail closed with
   * `pricing_lock_required`. See docs/billing.md, "Pricing-lock lifecycle
   * (Model C)".
   */
  async create(data: CreateUserData): Promise<UserDto> {
    const email = data.email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [email, data.passwordHash, data.name],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        throw Errors.internal('Failed to create user');
      }
      await client.query('COMMIT');
      return toDto(row);
    } catch (err) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(err)) {
        throw Errors.conflict('An account with this email already exists');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Active (non-deleted) user by email, or null. */
  async findByEmail(email: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email.toLowerCase()],
    );
    return res.rows[0] ?? null;
  }

  /** Active user by id, or null. */
  async findById(id: string): Promise<UserRow | null> {
    const res = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateName(id: string, name: string): Promise<void> {
    const res = await this.pool.query('UPDATE users SET name = $2 WHERE id = $1', [id, name]);
    if (res.rowCount === 0) throw Errors.notFound('User not found');
  }

  toDto(row: UserRow): UserDto {
    return toDto(row);
  }
}

function toDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
