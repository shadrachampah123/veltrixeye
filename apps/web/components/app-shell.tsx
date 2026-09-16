'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BRAND } from '@/lib/brand';
import { useAuth } from '@/components/auth-context';
import { Badge } from '@/components/ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '◧' },
  { href: '/strategies', label: 'Strategies', icon: '⌘' },
  { href: '/workbench', label: 'Workbench', icon: '▶' },
  { href: '/setups', label: 'Setups', icon: '◉' },
  { href: '/alerts', label: 'Alerts', icon: '◎' },
  { href: '/backtests', label: 'Backtests', icon: '◫' },
  { href: '/markets', label: 'Markets', icon: '◈' },
  { href: '/scanner', label: 'Live Scanner', icon: '◐' },
  { href: '/trading', label: 'Trading', icon: '⚡' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const onLogout = async () => {
    await logout();
    router.push('/login');
  };

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center gap-2.5 border-b border-ink-700 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-signal-600 font-mono text-sm font-bold text-white">
            {BRAND.short}
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-ink-50">{BRAND.name}</div>
            <div className="text-[10px] uppercase tracking-widest text-ink-400">{BRAND.stage}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-ink-750 font-medium text-ink-50'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                }`}
              >
                <span className="w-4 text-center text-base leading-none">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-ink-700 px-4 py-3">
          <div className="mb-2 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-ink-100">{user?.name}</div>
              <Badge tone={user?.plan === 'free' ? 'neutral' : 'success'}>{user?.plan} plan</Badge>
            </div>
          </div>
          <button
            onClick={() => void onLogout()}
            className="w-full rounded-md border border-ink-600 px-2 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-750 hover:text-ink-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="ml-56 flex-1">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
