import type pg from 'pg';
import {
  notificationPreferenceRequestSchema,
  notificationPreferenceSchema,
  notificationPreferencesRequestSchema,
  notificationPreferencesResponseSchema,
  pushSubscriptionRequestSchema,
  quietHoursSchema,
  strategyNotificationPreferenceRequestSchema,
  strategyNotificationPreferenceSchema,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationPreferenceRequest,
  type NotificationPreferencesRequest,
  type NotificationPreferencesResponse,
  type PushSubscriptionRequest,
  type QuietHours,
  type StrategyNotificationPreference,
  type StrategyNotificationPreferenceRequest,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { SecretManager } from './secret-manager.js';
import { looksEncrypted } from './secret-manager.js';

interface PreferenceRow {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  enabled: boolean;
  endpoint_url: string | null;
  signing_secret: string | null;
  signing_secret_encrypted: string | null;
  signing_secret_key_version: number | null;
  created_at: Date;
  updated_at: Date;
}
interface SettingsRow {
  quiet_hours_start_minute: number | null;
  quiet_hours_end_minute: number | null;
  quiet_hours_timezone: string;
}
interface StrategyRow {
  strategy_id: string;
  muted: boolean;
  channels: NotificationChannel[] | null;
}
export interface NotificationDeliveryTarget {
  channel: NotificationChannel;
  recipient: string;
  signingSecret: string | null;
  signingSecretEncrypted?: string | null;
  signingSecretKeyVersion?: number | null;
}
export type PreferenceQueryable = Pick<pg.Pool, 'query'>;

/** Owner-scoped persistence and effective-routing rules for notifications. */
export class NotificationPreferenceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secretManager?: SecretManager,
  ) {}

  async list(userId: string, q: PreferenceQueryable = this.pool): Promise<NotificationPreference[]> {
    const res = await q.query<PreferenceRow>(
      'SELECT id, user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version, created_at, updated_at FROM notification_preferences WHERE user_id = $1 ORDER BY channel',
      [userId],
    );
    return res.rows.map(toDto);
  }

  async get(userId: string, channel: NotificationChannel): Promise<NotificationPreference | null> {
    const res = await this.pool.query<PreferenceRow>(
      'SELECT id, user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version, created_at, updated_at FROM notification_preferences WHERE user_id = $1 AND channel = $2',
      [userId, channel],
    );
    return res.rows[0] ? toDto(res.rows[0]) : null;
  }

  private encryptSecret(plaintext: string | null | undefined): { encrypted: string | null; keyVersion: number | null; plaintextForLegacy: string | null } {
    if (!plaintext) return { encrypted: null, keyVersion: null, plaintextForLegacy: null };
    if (!this.secretManager) {
      // No manager: keep plaintext for backwards compat, but will be migrated later
      return { encrypted: null, keyVersion: null, plaintextForLegacy: plaintext };
    }
    // If already looks encrypted, keep as is (avoid double encryption)
    if (looksEncrypted(plaintext)) {
      return { encrypted: plaintext, keyVersion: this.secretManager.keyVersion, plaintextForLegacy: null };
    }
    try {
      const enc = this.secretManager.encrypt(plaintext);
      return { encrypted: enc.ciphertext, keyVersion: enc.keyVersion, plaintextForLegacy: null };
    } catch {
      // If encryption fails in dev (noop manager), fallback to plaintext handling
      // In production, EnvKeySecretManager would throw earlier if key missing, so this path is dev/test only
      return { encrypted: null, keyVersion: null, plaintextForLegacy: plaintext };
    }
  }

  private decryptSecret(row: { signing_secret: string | null; signing_secret_encrypted: string | null; signing_secret_key_version: number | null }): string | null {
    // Prefer encrypted
    if (row.signing_secret_encrypted) {
      if (!this.secretManager) {
        // No manager, cannot decrypt, fallback to plaintext if available
        return row.signing_secret ?? null;
      }
      try {
        const version = row.signing_secret_key_version ?? this.secretManager.keyVersion;
        return this.secretManager.decrypt(row.signing_secret_encrypted, version);
      } catch {
        // Decryption failed, fallback to plaintext for migration path
        return row.signing_secret ?? null;
      }
    }
    return row.signing_secret ?? null;
  }

  async upsert(userId: string, input: NotificationPreferenceRequest, q: PreferenceQueryable = this.pool): Promise<NotificationPreference> {
    const parsed = notificationPreferenceRequestSchema.safeParse(input);
    if (!parsed.success) throw Errors.invalidInput('Invalid notification preference');
    const value = parsed.data;
    validateChannelPreference(value);

    const enc = this.encryptSecret(value.signingSecret ?? null);

    // M9.2: after migration, we must not write new plaintext secrets
    // If we have encrypted value, store encrypted and null out plaintext
    // If we don't have secret manager (dev/test), keep plaintext for backwards compat
    const res = await q.query<PreferenceRow>(
      `INSERT INTO notification_preferences (user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled,
         endpoint_url = EXCLUDED.endpoint_url,
         signing_secret = CASE WHEN EXCLUDED.signing_secret_encrypted IS NOT NULL THEN NULL ELSE COALESCE(EXCLUDED.signing_secret, notification_preferences.signing_secret) END,
         signing_secret_encrypted = COALESCE(EXCLUDED.signing_secret_encrypted, notification_preferences.signing_secret_encrypted),
         signing_secret_key_version = COALESCE(EXCLUDED.signing_secret_key_version, notification_preferences.signing_secret_key_version)
       RETURNING id, user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version, created_at, updated_at`,
      [
        userId,
        value.channel,
        value.enabled,
        value.endpointUrl ?? null,
        enc.plaintextForLegacy,
        enc.encrypted,
        enc.keyVersion,
      ],
    );
    const row = res.rows[0];
    if (!row) throw Errors.internal('Failed to save notification preference');
    return toDto(row);
  }

  async upsertPushSubscription(
    userId: string,
    input: PushSubscriptionRequest,
    q: PreferenceQueryable = this.pool,
  ): Promise<NotificationPreference> {
    const parsed = pushSubscriptionRequestSchema.safeParse(input);
    if (!parsed.success) throw Errors.invalidInput('Invalid push subscription');
    const value = parsed.data;
    // Store endpoint as endpoint_url, keys as JSON string encrypted
    const keysJson = JSON.stringify(value.keys);
    const enc = this.encryptSecret(keysJson);

    const res = await q.query<PreferenceRow>(
      `INSERT INTO notification_preferences (user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version)
       VALUES ($1, 'push', true, $2, $3, $4, $5)
       ON CONFLICT (user_id, channel) DO UPDATE SET enabled = true,
         endpoint_url = EXCLUDED.endpoint_url,
         signing_secret = CASE WHEN EXCLUDED.signing_secret_encrypted IS NOT NULL THEN NULL ELSE COALESCE(EXCLUDED.signing_secret, notification_preferences.signing_secret) END,
         signing_secret_encrypted = COALESCE(EXCLUDED.signing_secret_encrypted, notification_preferences.signing_secret_encrypted),
         signing_secret_key_version = COALESCE(EXCLUDED.signing_secret_key_version, notification_preferences.signing_secret_key_version)
       RETURNING id, user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version, created_at, updated_at`,
      [userId, value.endpoint, enc.plaintextForLegacy, enc.encrypted, enc.keyVersion],
    );
    const row = res.rows[0];
    if (!row) throw Errors.internal('Failed to save push subscription');
    return toDto(row);
  }

  async saveSettings(userId: string, quietHours: QuietHours | null, q: PreferenceQueryable = this.pool): Promise<void> {
    if (quietHours === null) {
      await q.query('DELETE FROM notification_user_settings WHERE user_id = $1', [userId]);
      return;
    }
    const parsed = quietHoursSchema.safeParse(quietHours);
    if (!parsed.success) throw Errors.invalidInput('Invalid quiet-hours configuration');
    await q.query(
      `INSERT INTO notification_user_settings (user_id, quiet_hours_start_minute, quiet_hours_end_minute, quiet_hours_timezone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET quiet_hours_start_minute = EXCLUDED.quiet_hours_start_minute,
         quiet_hours_end_minute = EXCLUDED.quiet_hours_end_minute, quiet_hours_timezone = EXCLUDED.quiet_hours_timezone`,
      [userId, parsed.data.startMinute, parsed.data.endMinute, parsed.data.timezone],
    );
  }

  async preferencesResponse(userId: string, q: PreferenceQueryable = this.pool): Promise<NotificationPreferencesResponse> {
    const prefs = await this.list(userId, q);
    const settings = await q.query<SettingsRow>(
      'SELECT quiet_hours_start_minute, quiet_hours_end_minute, quiet_hours_timezone FROM notification_user_settings WHERE user_id = $1',
      [userId],
    );
    const s = settings.rows[0];
    const result = {
      preferences: prefs,
      quietHours:
        s && s.quiet_hours_start_minute !== null && s.quiet_hours_end_minute !== null
          ? { startMinute: s.quiet_hours_start_minute, endMinute: s.quiet_hours_end_minute, timezone: s.quiet_hours_timezone }
          : null,
    };
    return notificationPreferencesResponseSchema.parse(result);
  }

  async upsertStrategy(userId: string, strategyId: string, input: StrategyNotificationPreferenceRequest): Promise<StrategyNotificationPreference> {
    const parsed = strategyNotificationPreferenceRequestSchema.safeParse(input);
    if (!parsed.success) throw Errors.invalidInput('Invalid strategy notification preference');
    const owned = await this.pool.query('SELECT 1 FROM strategies WHERE id = $1 AND user_id = $2', [strategyId, userId]);
    if (!owned.rowCount) throw Errors.notFound('Strategy not found');
    const value = parsed.data;
    const res = await this.pool.query<StrategyRow>(
      `INSERT INTO strategy_notification_preferences (user_id, strategy_id, muted, channels)
       VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, strategy_id) DO UPDATE SET muted = EXCLUDED.muted, channels = EXCLUDED.channels RETURNING strategy_id, muted, channels`,
      [userId, strategyId, value.muted, value.channels],
    );
    const row = res.rows[0];
    if (!row) throw Errors.internal('Failed to save strategy notification preference');
    return strategyDto(row);
  }

  async listStrategies(userId: string): Promise<StrategyNotificationPreference[]> {
    const res = await this.pool.query<StrategyRow>(
      'SELECT strategy_id, muted, channels FROM strategy_notification_preferences WHERE user_id = $1 ORDER BY strategy_id',
      [userId],
    );
    return res.rows.map(strategyDto);
  }

  async getStrategy(userId: string, strategyId: string): Promise<StrategyNotificationPreference | null> {
    const owned = await this.pool.query('SELECT 1 FROM strategies WHERE id = $1 AND user_id = $2', [strategyId, userId]);
    if (!owned.rowCount) throw Errors.notFound('Strategy not found');
    const res = await this.pool.query<StrategyRow>(
      'SELECT strategy_id, muted, channels FROM strategy_notification_preferences WHERE user_id = $1 AND strategy_id = $2',
      [userId, strategyId],
    );
    return res.rows[0] ? strategyDto(res.rows[0]) : null;
  }

  async deliveryTargets(
    userId: string,
    strategyId: string,
    q: PreferenceQueryable = this.pool,
    now = new Date(),
  ): Promise<NotificationDeliveryTarget[]> {
    const settings = await q.query<SettingsRow>(
      'SELECT quiet_hours_start_minute, quiet_hours_end_minute, quiet_hours_timezone FROM notification_user_settings WHERE user_id = $1',
      [userId],
    );
    const s = settings.rows[0];
    if (
      s &&
      s.quiet_hours_start_minute !== null &&
      s.quiet_hours_end_minute !== null &&
      isQuiet(now, s.quiet_hours_start_minute, s.quiet_hours_end_minute, s.quiet_hours_timezone)
    )
      return [];
    const strategy = await q.query<StrategyRow>(
      'SELECT strategy_id, muted, channels FROM strategy_notification_preferences WHERE user_id = $1 AND strategy_id = $2',
      [userId, strategyId],
    );
    const route = strategy.rows[0];
    if (route?.muted) return [];
    const rows = await q.query<PreferenceRow>(
      `SELECT id, user_id, channel, enabled, endpoint_url, signing_secret, signing_secret_encrypted, signing_secret_key_version, created_at, updated_at
       FROM notification_preferences WHERE user_id = $1 AND (channel = 'email' OR (enabled = true AND endpoint_url IS NOT NULL)) ORDER BY channel`,
      [userId],
    );
    const allowed = route?.channels ?? null;
    const targets = rows.rows
      .filter((row) => row.enabled && (!allowed || allowed.includes(row.channel)))
      .map((row) => ({
        channel: row.channel,
        recipient: row.endpoint_url ?? '',
        signingSecret: this.decryptSecret(row),
      }))
      .filter((target) => (target.channel !== 'webhook' && target.channel !== 'push') || target.recipient !== '');
    if (!rows.rows.some((row) => row.channel === 'email') && (!allowed || allowed.includes('email'))) {
      const user = await q.query<{ email: string }>('SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
      if (user.rows[0]) targets.unshift({ channel: 'email', recipient: user.rows[0].email, signingSecret: null });
    }
    return targets;
  }

  async remove(userId: string, channel: NotificationChannel): Promise<void> {
    await this.pool.query('DELETE FROM notification_preferences WHERE user_id = $1 AND channel = $2', [userId, channel]);
  }
}

function validateChannelPreference(value: { channel: NotificationChannel; endpointUrl?: string; signingSecret?: string }): void {
  if (value.channel === 'webhook' && !value.endpointUrl) throw Errors.invalidInput('A webhook endpoint URL is required');
  if (value.channel === 'webhook' && value.endpointUrl && !value.endpointUrl.startsWith('https://'))
    throw Errors.invalidInput('Webhook endpoints must use HTTPS');
  if (value.channel === 'push' && !value.endpointUrl) throw Errors.invalidInput('A push endpoint URL is required');
  if (value.channel === 'push' && value.endpointUrl && !value.endpointUrl.startsWith('https://'))
    throw Errors.invalidInput('Push endpoints must use HTTPS');
  if (value.channel === 'push' && value.signingSecret) {
    try {
      const parsed = JSON.parse(value.signingSecret);
      if (!parsed || typeof parsed.p256dh !== 'string' || typeof parsed.auth !== 'string') {
        throw Errors.invalidInput('Push subscription keys must include p256dh and auth');
      }
    } catch (e) {
      if ((e as { code?: string })?.code === 'invalid_input') throw e;
      throw Errors.invalidInput('Push subscription keys must be valid JSON with p256dh and auth');
    }
  }
  if (value.channel === 'email' && (value.endpointUrl !== undefined || value.signingSecret !== undefined))
    throw Errors.invalidInput('Email preferences do not accept webhook fields');
}

function strategyDto(row: StrategyRow): StrategyNotificationPreference {
  return strategyNotificationPreferenceSchema.parse({
    strategyId: row.strategy_id,
    muted: row.muted,
    channels: row.channels,
  });
}

function toDto(row: PreferenceRow): NotificationPreference {
  return notificationPreferenceSchema.parse({
    id: row.id,
    channel: row.channel,
    enabled: row.enabled,
    endpointUrl: row.endpoint_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function isQuiet(now: Date, start: number, end: number, timezone: string): boolean {
  let minute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    minute = hour * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  } catch {
    throw Errors.invalidInput('Invalid quiet-hours timezone');
  }
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
