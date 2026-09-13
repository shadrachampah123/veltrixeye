'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Field, Input } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { useAuth } from '@/components/auth-context';

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.register({ name: name || undefined, email, password });
      await refresh();
      router.push('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) {
          setFieldErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v[0] ?? ''])));
          setError('Please fix the highlighted fields.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-signal-600 font-mono text-lg font-bold text-white">
            {BRAND.short}
          </div>
          <h1 className="text-lg font-semibold text-ink-50">Create your account</h1>
          <p className="mt-1 text-sm text-ink-400">Start defining your strategies</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-lg border border-ink-700 bg-ink-800 p-6">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name" hint="Optional">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </Field>
          <Field
            label="Password"
            error={fieldErrors.password}
            hint="At least 8 characters, with a letter and a number"
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </Field>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Creating account…' : 'Create account'}
          </Button>
          <p className="text-center text-xs text-ink-400">
            Already have an account?{' '}
            <Link href="/login" className="text-signal-400 hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
