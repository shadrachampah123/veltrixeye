'use client';

import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { isPushSupported, getPermissionState, registerServiceWorker, getExistingSubscription, subscribePush, unsubscribePush, subscriptionToRequest } from '@/lib/push';
import type { NotificationPreferencesResponse, StrategyNotificationPreference } from '@veltrixeye/contracts';

function NotificationPreferencesPanel() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [prefs, setPrefs] = React.useState<NotificationPreferencesResponse | null>(null);
  void prefs;
  const [strategyPrefs, setStrategyPrefs] = React.useState<StrategyNotificationPreference[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Webhook form
  const [webhookUrl, setWebhookUrl] = React.useState('');
  const [webhookSecret, setWebhookSecret] = React.useState('');
  const [webhookEnabled, setWebhookEnabled] = React.useState(true);

  // Quiet hours
  const [quietStart, setQuietStart] = React.useState<number | ''>('');
  const [quietEnd, setQuietEnd] = React.useState<number | ''>('');
  const [quietTz, setQuietTz] = React.useState('UTC');

  // Push state
  const [pushSupported, setPushSupported] = React.useState(false);
  const [pushPermission, setPushPermission] = React.useState<NotificationPermission | 'unsupported'>('default');
  const [pushSubExists, setPushSubExists] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);
  const [pushError, setPushError] = React.useState<string | null>(null);
  const [vapidKey, setVapidKey] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, sp] = await Promise.all([
        api.getNotificationPreferences().catch(() => null),
        api.listStrategyNotificationPreferences().catch(() => ({ preferences: [] })),
      ]);
      if (p) {
        setPrefs(p);
        const wh = p.preferences.find((pr) => pr.channel === 'webhook');
        if (wh?.endpointUrl) setWebhookUrl(wh.endpointUrl);
        if (wh) setWebhookEnabled(wh.enabled);
        if (p.quietHours) {
          setQuietStart(p.quietHours.startMinute);
          setQuietEnd(p.quietHours.endMinute);
          setQuietTz(p.quietHours.timezone);
        }
      }
      if (sp) setStrategyPrefs(sp.preferences);
      // Push support
      setPushSupported(isPushSupported());
      setPushPermission(getPermissionState());
      if (isPushSupported()) {
        try {
          await registerServiceWorker();
          const existing = await getExistingSubscription();
          setPushSubExists(!!existing);
        } catch {
          // ignore
        }
        try {
          const vk = await api.getVapidPublicKey().catch(() => null);
          if (vk) setVapidKey(vk.publicKey);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load preferences');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const saveWebhook = async () => {
    setSaving(true);
    setMsg(null);
    try {
      if (webhookUrl && !webhookUrl.startsWith('https://')) {
        throw new Error('Webhook must use HTTPS');
      }
      const preferences = [
        { channel: 'email', enabled: true },
        ...(webhookUrl
          ? [
              {
                channel: 'webhook',
                enabled: webhookEnabled,
                endpointUrl: webhookUrl,
                ...(webhookSecret ? { signingSecret: webhookSecret } : {}),
              },
            ]
          : []),
      ];
      const result = await api.updateNotificationPreferences({
        preferences: preferences as never,
        quietHours:
          quietStart !== '' && quietEnd !== ''
            ? { startMinute: Number(quietStart), endMinute: Number(quietEnd), timezone: quietTz }
            : null,
      });
      setPrefs(result);
      setWebhookSecret('');
      setMsg({ tone: 'success', text: 'Preferences saved. Secrets are encrypted at rest.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const handlePushSubscribe = async () => {
    setPushBusy(true);
    setPushError(null);
    try {
      if (!vapidKey) {
        const vk = await api.getVapidPublicKey();
        setVapidKey(vk.publicKey);
      }
      const key = vapidKey || (await api.getVapidPublicKey()).publicKey;
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        setPushPermission(perm);
        if (perm !== 'granted') throw new Error(`Permission ${perm}`);
      }
      if (Notification.permission !== 'granted') throw new Error(`Permission ${Notification.permission}`);
      await registerServiceWorker();
      const sub = await subscribePush(key);
      const req = subscriptionToRequest(sub);
      await api.subscribePush(req as never);
      setPushSubExists(true);
      setMsg({ tone: 'success', text: 'Push subscribed. Keys encrypted at rest.' });
      await load();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Push subscription failed');
    } finally {
      setPushBusy(false);
    }
  };

  const handlePushUnsubscribe = async () => {
    setPushBusy(true);
    setPushError(null);
    try {
      await unsubscribePush();
      await api.deleteNotificationPreference('push');
      setPushSubExists(false);
      setMsg({ tone: 'success', text: 'Push unsubscribed.' });
      await load();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Unsubscribe failed');
    } finally {
      setPushBusy(false);
    }
  };

  if (loading) return <Card><div className="p-5 text-sm text-ink-400">Loading notification preferences…</div></Card>;
  if (error) return <Card><div className="p-5"><Alert tone="danger">{error}</Alert></div></Card>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={`${BRAND.name} Notifications`} subtitle="Email, webhook, push — encrypted at rest, 3-way fairness preserved, M8.7 safety intact" />
        <div className="space-y-5 p-5">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded bg-ink-850 p-3">
              <div className="text-xs font-medium text-ink-200">Email</div>
              <div className="mt-1 text-[11px] text-ink-400">Fallback to account email, always available. No secrets stored.</div>
              <Badge tone="success">enabled</Badge>
            </div>
            <div className="rounded bg-ink-850 p-3">
              <div className="text-xs font-medium text-ink-200">Webhook</div>
              <div className="mt-1 text-[11px] text-ink-400">HTTPS only, SSRF protected, HMAC signed, secret encrypted at rest.</div>
              <Badge tone={webhookUrl ? 'success' : 'neutral'}>{webhookUrl ? 'configured' : 'not set'}</Badge>
            </div>
            <div className="rounded bg-ink-850 p-3">
              <div className="text-xs font-medium text-ink-200">Push (Web Push)</div>
              <div className="mt-1 text-[11px] text-ink-400">VAPID, browser push, keys encrypted at rest, 3-way fairness.</div>
              <Badge tone={pushSubExists ? 'success' : 'neutral'}>{pushSubExists ? 'subscribed' : 'not subscribed'}</Badge>
            </div>
          </div>

          <div className="space-y-3">
            <Field label="Webhook Endpoint" hint="HTTPS only, private IPs rejected, no URL credentials">
              <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhook" />
            </Field>
            <Field label="Webhook Signing Secret" hint="Write-only — never displayed, encrypted at rest with AES-256-GCM">
              <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="•••••••• (write-only)" />
            </Field>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" checked={webhookEnabled} onChange={(e) => setWebhookEnabled(e.target.checked)} /> Enabled
              </label>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Quiet Hours Start (minutes)" hint="0-1439">
              <Input type="number" min={0} max={1439} value={quietStart} onChange={(e) => setQuietStart(e.target.value === '' ? '' : Number(e.target.value))} placeholder="e.g. 0" />
            </Field>
            <Field label="Quiet Hours End" hint="0-1439">
              <Input type="number" min={0} max={1439} value={quietEnd} onChange={(e) => setQuietEnd(e.target.value === '' ? '' : Number(e.target.value))} placeholder="e.g. 360" />
            </Field>
            <Field label="Timezone" hint="IANA timezone, e.g. UTC">
              <Input value={quietTz} onChange={(e) => setQuietTz(e.target.value)} placeholder="UTC" />
            </Field>
          </div>

          <Button onClick={() => void saveWebhook()} disabled={saving}>{saving ? 'Saving…' : 'Save preferences'}</Button>

          <div className="border-t border-ink-700 pt-4">
            <h3 className="text-sm font-semibold text-ink-100">Push Notifications</h3>
            <div className="mt-2 space-y-2 text-xs text-ink-400">
              <div>Supported: {pushSupported ? 'yes' : 'no'}</div>
              <div>Permission: {pushPermission}</div>
              <div>Subscription: {pushSubExists ? 'exists' : 'missing'}</div>
              <div>VAPID key: {vapidKey ? `${vapidKey.slice(0, 12)}…` : 'not loaded (server may not have VAPID configured)'}</div>
              {pushError && <Alert tone="danger">{pushError}</Alert>}
              <div className="flex gap-2">
                <Button onClick={() => void handlePushSubscribe()} disabled={pushBusy || !pushSupported || pushPermission === 'denied'}>
                  {pushBusy ? 'Working…' : pushSubExists ? 'Resubscribe' : 'Subscribe push'}
                </Button>
                <Button variant="ghost" onClick={() => void handlePushUnsubscribe()} disabled={pushBusy || !pushSubExists}>
                  Unsubscribe
                </Button>
              </div>
              {pushPermission === 'denied' && <Alert tone="warning">Push permission denied — enable in browser site settings.</Alert>}
              {!pushSupported && <Alert tone="info">Push not supported in this browser.</Alert>}
            </div>
          </div>

          {strategyPrefs && strategyPrefs.length > 0 && (
            <div className="border-t border-ink-700 pt-4">
              <h3 className="text-sm font-semibold text-ink-100">Strategy Routing</h3>
              <div className="mt-2 space-y-2">
                {strategyPrefs.map((sp) => (
                  <div key={sp.strategyId} className="flex items-center justify-between rounded bg-ink-850 px-3 py-2 text-xs">
                    <span className="text-ink-300">{sp.strategyId.slice(0, 8)}…</span>
                    <span className="text-ink-400">{sp.muted ? 'muted' : (sp.channels?.join(',') || 'all')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-md border border-ink-700 bg-ink-850/50 p-2.5 text-[11px] text-ink-400">
            M9.2: webhook signing secrets and push keys are encrypted at rest via AES-256-GCM with <span className="font-mono text-ink-200">WEBHOOK_SECRET_ENCRYPTION_KEY</span>. Production fails closed without the key. VAPID private key is server-only, never in DTOs/logs. Fairness uses lifetime <span className="font-mono">email_claims/webhook_claims/push_claims</span> under advisory lock 611_231_008, durable across cleanup/cascade/retry/stale. M8.7 safety unchanged, automation OFF, no live trading path.
          </div>
        </div>
      </Card>
    </div>
  );
}

export { NotificationPreferencesPanel };
