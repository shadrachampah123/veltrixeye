'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth, useAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Spinner } from '@/components/ui';
import { formatDateTime } from '@/lib/formats';
import type { SessionDto, BillingStateDto } from '@veltrixeye/contracts';
import { SubscriptionPanel, PlanComparison } from '@/components/subscription-panel';
import { WatchlistPanel } from '@/components/watchlist';
import { BRAND } from '@/lib/brand';

function SettingsContent() {
  const { user, refresh } = useAuth();
  const [sessions, setSessions] = React.useState<SessionDto[] | null>(null);
  const [billing, setBilling] = React.useState<BillingStateDto | null>(null);
  const [name, setName] = React.useState(user?.name ?? '');
  const [profileMsg, setProfileMsg] = React.useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [cur, setCur] = React.useState('');
  const [next, setNext] = React.useState('');
  const [pwdMsg, setPwdMsg] = React.useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const loadSessions = React.useCallback(() => {
    api
      .me()
      .then(({ sessions: s }) => setSessions(s))
      .catch(() => setSessions([]));
  }, []);

  const loadBilling = React.useCallback(() => {
    api
      .getBillingState()
      .then((b) => setBilling(b))
      .catch(() => setBilling(null));
  }, []);

  React.useEffect(() => {
    loadSessions();
    loadBilling();
  }, [loadSessions, loadBilling]);

  if (!user) return <Spinner />;

  const saveProfile = async () => {
    setBusy(true);
    setProfileMsg(null);
    try {
      const { user: u } = await api.updateProfile({ name: name.trim() });
      setName(u.name);
      await refresh();
      setProfileMsg({ tone: 'success', text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({ tone: 'danger', text: err instanceof ApiError ? err.message : 'Failed to update profile' });
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setBusy(true);
    setPwdMsg(null);
    try {
      await api.changePassword({ currentPassword: cur, newPassword: next });
      setCur('');
      setNext('');
      setPwdMsg({ tone: 'success', text: 'Password changed. Your other sessions were signed out.' });
      loadSessions();
    } catch (err) {
      setPwdMsg({
        tone: 'danger',
        text: err instanceof ApiError ? err.message : 'Failed to change password',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Settings"
        subtitle={`${BRAND.name} user settings — profile, security, watchlist, subscription & entitlement foundations · ${BRAND.stage} safety preserved`}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Profile & Security */}
        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-6 sm:grid-cols-2">
            <Card>
              <CardHeader title="Profile" subtitle="User settings — stored server-side" />
              <div className="space-y-4 px-5 py-4">
                {profileMsg && <Alert tone={profileMsg.tone}>{profileMsg.text}</Alert>}
                <Field label="Email" hint="Email change disabled in M1 — contact support">
                  <Input value={user.email} disabled className="opacity-60" />
                </Field>
                <Field label="Display Name" hint="Shown in dashboard and session list">
                  <Input value={name} onChange={(e) => setName(e.target.value)} minLength={1} maxLength={80} placeholder="Your name" />
                </Field>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge tone={user.plan === 'free' ? 'neutral' : 'success'}>{user.plan} plan</Badge>
                    <span className="text-[11px] text-ink-500">ID: {user.id.slice(0, 8)}…</span>
                  </div>
                  <Button onClick={() => void saveProfile()} disabled={busy || name.trim().length < 1}>Save profile</Button>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Change Password" subtitle="Secure credential rotation — signs out other sessions" />
              <div className="space-y-4 px-5 py-4">
                {pwdMsg && <Alert tone={pwdMsg.tone}>{pwdMsg.text}</Alert>}
                <Field label="Current Password">
                  <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" placeholder="Current password" />
                </Field>
                <Field label="New Password" hint="At least 8 characters, with a letter and a number">
                  <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} placeholder="New password" />
                </Field>
                <div className="flex justify-end">
                  <Button onClick={() => void changePassword()} disabled={busy || !cur || next.length < 8}>Change password</Button>
                </div>
              </div>
            </Card>
          </div>

          {/* Subscription & Entitlement Foundations */}
          <SubscriptionPanel billing={billing} />

          <PlanComparison currentPlan={billing?.subscription.plan ?? user.plan} />

          {/* Active sessions */}
          <Card>
            <CardHeader title="Active Sessions" subtitle="Where you are signed in — revoke to sign out elsewhere" />
            <div className="divide-y divide-ink-750">
              {sessions === null ? (
                <div className="px-5 py-6"><Spinner /></div>
              ) : sessions.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-400">No active sessions.</p>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm text-ink-100">
                        {s.userAgent ? <span className="truncate">{s.userAgent}</span> : <span className="text-ink-400">Unknown device</span>}
                        {s.current && <Badge tone="success">this device</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-400">{s.ip ?? 'unknown ip'} · since {formatDateTime(s.createdAt)} · expires {formatDateTime(s.expiresAt)}</div>
                    </div>
                    {!s.current && (
                      <Button variant="ghost" onClick={() => api.deleteSession(s.id).then(() => loadSessions()).catch(() => {})}>Revoke</Button>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Right: Watchlist, Branding, Safety */}
        <div className="space-y-6">
          <WatchlistPanel />

          <Card>
            <CardHeader title="VeltrixEye Branding" subtitle="Centralized brand — single source of truth" />
            <div className="p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-signal-600 font-mono text-sm font-bold text-white">{BRAND.short}</div>
                <div>
                  <div className="text-sm font-semibold text-ink-50">{BRAND.name}</div>
                  <div className="text-xs text-ink-400">{BRAND.tagline}</div>
                  <div className="text-[11px] text-ink-500">{BRAND.stage} · {BRAND.description}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Name: {BRAND.name}</div>
                <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Short: {BRAND.short}</div>
                <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Version: {BRAND.version}</div>
                <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Stage: {BRAND.stage}</div>
              </div>
              <div className="rounded-md border border-ink-700 bg-ink-850/50 p-2.5 text-[11px] text-ink-400">
                Branding is centralized in <span className="font-mono text-ink-200">lib/brand.ts</span> — all UI surfaces read from there. No hard-coded names elsewhere.
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="M8.7 Safety Status" subtitle="Execution-safety controls preserved" />
            <div className="space-y-3 p-4 text-xs">
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Automation</span><Badge tone="neutral">OFF default</Badge></div>
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Live trading</span><Badge tone="neutral">No path</Badge></div>
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Paper sim</span><Badge tone="success">Available</Badge></div>
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Drawdown</span><Badge tone="success">Active 2%/3%·4%/6%·8%/10%</Badge></div>
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Kill-switch</span><Badge tone="success">Enforced</Badge></div>
              <div className="flex items-center justify-between rounded bg-ink-850 px-3 py-2"><span className="text-ink-300">Risk ceilings</span><Badge tone="success">Server-side</Badge></div>
              <p className="text-[11px] leading-relaxed text-ink-500">All M8.7 controls intact: daily 2%/3% weekly 4%/6% max 8%/10% ceilings 10/15/25, codes DAILY/WEEKLY/MAX_DRAWDOWN_LIMIT + EQUITY_DATA_UNAVAILABLE trip M8.6 circuit breaker, automation OFF, no live execution path.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Responsive Layout" subtitle="Desktop & mobile — Phase 3" />
            <div className="p-4 text-xs leading-relaxed text-ink-400">
              <ul className="space-y-1">
                <li>• Sidebar: fixed on desktop (w-60), drawer on mobile with overlay</li>
                <li>• Header: sticky mobile header with hamburger</li>
                <li>• Main: max-w-7xl centered, px-4 sm:px-6 lg:px-8</li>
                <li>• Cards: grid responsive sm:grid-cols-2 lg:grid-cols-3</li>
                <li>• Tables: overflow-x-auto with min-width for scroll</li>
                <li>• No localhost calls — relative /api proxy via next.config.mjs</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

export default function SettingsPage() {
  return (
    <RequireAuth>
      <SettingsContent />
    </RequireAuth>
  );
}
