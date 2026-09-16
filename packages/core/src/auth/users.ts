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

  /** Create a user. Email is normalized to lowercase; must be valid + 3-254 chars. */
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
      
      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
        [row.id]
      );
      
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
