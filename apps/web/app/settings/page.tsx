'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth, useAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Spinner } from '@/components/ui';
import { formatDateTime } from '@/lib/formats';
import type { SessionDto } from '@veltrixeye/contracts';

function SettingsContent() {
  const { user, refresh } = useAuth();
  const [sessions, setSessions] = React.useState<SessionDto[] | null>(null);
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

  React.useEffect(() => {
    loadSessions();
  }, [loadSessions]);

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
      <PageHeader title="Settings" subtitle="Profile, security and sessions" />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Profile" />
            <div className="space-y-4 px-5 py-4">
              {profileMsg && <Alert tone={profileMsg.tone}>{profileMsg.text}</Alert>}
              <Field label="Email" hint="Email change is disabled in M1">
                <Input value={user.email} disabled className="opacity-60" />
              </Field>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} minLength={1} maxLength={80} />
              </Field>
              <div className="flex items-center justify-between">
                <Badge tone={user.plan === 'free' ? 'neutral' : 'success'}>{user.plan} plan</Badge>
                <Button onClick={() => void saveProfile()} disabled={busy || name.trim().length < 1}>
                  Save profile
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Change password"
              subtitle="Signing out all other sessions when the password changes"
            />
            <div className="space-y-4 px-5 py-4">
              {pwdMsg && <Alert tone={pwdMsg.tone}>{pwdMsg.text}</Alert>}
              <Field label="Current password">
                <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
              </Field>
              <Field label="New password" hint="At least 8 characters, with a letter and a number">
                <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} />
              </Field>
              <div className="flex justify-end">
                <Button onClick={() => void changePassword()} disabled={busy || !cur || next.length < 8}>
                  Change password
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title="Active sessions" subtitle="Where you are signed in" />
          <div className="divide-y divide-ink-750">
            {sessions === null ? (
              <div className="px-5 py-6">
                <Spinner />
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-400">No active sessions.</p>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-ink-100">
                      {s.userAgent ? (
                        <span className="truncate">{s.userAgent}</span>
                      ) : (
                        <span className="text-ink-400">Unknown device</span>
                      )}
                      {s.current && <Badge tone="success">this device</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-400">
                      {s.ip ?? 'unknown ip'} · since {formatDateTime(s.createdAt)} · expires {formatDateTime(s.expiresAt)}
                    </div>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        api
                          .deleteSession(s.id)
                          .then(() => loadSessions())
                          .catch(() => {})
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
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
