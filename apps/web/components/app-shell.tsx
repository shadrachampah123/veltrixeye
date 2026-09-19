'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BRAND } from '@/lib/brand';
import { useAuth } from '@/components/auth-context';
import { Badge } from '@/components/ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '◧', desc: 'Overview & health' },
  { href: '/strategies', label: 'Strategies', icon: '⌘', desc: 'Deterministic configs' },
  { href: '/workbench', label: 'Workbench', icon: '▶', desc: 'HTF → Setup → Entry' },
  { href: '/setups', label: 'Setups', icon: '◉', desc: 'Signals & quality' },
  { href: '/alerts', label: 'Alerts', icon: '◎', desc: 'Scored alerts' },
  { href: '/backtests', label: 'Backtests', icon: '◫', desc: 'History & replay' },
  { href: '/markets', label: 'Markets', icon: '◈', desc: 'Watchlist & data' },
  { href: '/scanner', label: 'Live Scanner', icon: '◐', desc: 'Market workspace' },
  { href: '/trading', label: 'Trading', icon: '⚡', desc: 'Paper & safety' },
  { href: '/settings', label: 'Settings', icon: '⚙', desc: 'Profile & plan' },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const onLogout = async () => {
    await logout();
    router.push('/login');
  };

  // Close mobile drawer on route change
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen bg-ink-950">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar - responsive */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-ink-700 bg-ink-900 transition-transform duration-200 ease-in-out lg:z-20 lg:w-60 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        aria-label="Primary navigation"
      >
        {/* Brand header - centralized */}
        <div className="flex items-center gap-3 border-b border-ink-700 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal-600 font-mono text-sm font-bold text-white shadow-sm">
            {BRAND.short}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold leading-tight text-ink-50">{BRAND.name}</span>
              <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-300">
                {BRAND.version}
              </span>
            </div>
            <div className="truncate text-[10px] uppercase tracking-widest text-ink-400">{BRAND.tagline}</div>
          </div>
        </div>

        {/* Safety banner - M8.7 preserved */}
        <div className="border-b border-ink-700 bg-ink-850/50 px-4 py-2.5">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-500" />
            <span className="font-medium uppercase tracking-wider text-ink-300">Safety: Automation {BRAND.safety.automationDefault}</span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-ink-400">{BRAND.safety.executionNote}</p>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
          {NAV.map((item) => {
            const isActive = item.href === '/dashboard' ? pathname.startsWith('/dashboard') : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-ink-750 font-medium text-ink-50 shadow-sm'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={`flex h-6 w-6 items-center justify-center rounded text-base leading-none transition-colors ${isActive ? 'bg-signal-600/20 text-signal-400' : 'bg-ink-800 text-ink-400 group-hover:bg-ink-700'}`}>
                  {item.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{item.label}</div>
                  <div className="truncate text-[10px] text-ink-400">{item.desc}</div>
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-ink-700 px-4 py-3">
          <div className="mb-2.5 flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200 ring-1 ring-ink-600">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-ink-100">{user?.name ?? 'Trader'}</div>
              <div className="flex items-center gap-1.5">
                <Badge tone={user?.plan === 'free' ? 'neutral' : 'success'}>{user?.plan ?? 'free'} plan</Badge>
              </div>
            </div>
          </div>
          <button
            onClick={() => void onLogout()}
            className="w-full rounded-md border border-ink-600 bg-ink-800 px-2.5 py-2 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-750 hover:text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-500"
          >
            Sign out
          </button>
          <div className="mt-3 text-center text-[10px] text-ink-500">
            <span>{BRAND.stage}</span>
          </div>
        </div>
      </aside>

      {/* Main content area - responsive */}
      <div className="flex min-h-screen w-full flex-col lg:pl-60">
        {/* Mobile header */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-ink-700 bg-ink-900/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-ink-900/80 lg:hidden">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen((v) => !v)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-600 bg-ink-800 text-ink-300 transition-colors hover:bg-ink-700 hover:text-ink-100"
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileOpen}
            >
              <span className="text-lg leading-none">{mobileOpen ? '✕' : '☰'}</span>
            </button>
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-signal-600 font-mono text-xs font-bold text-white">
                {BRAND.short}
              </div>
              <span className="text-sm font-semibold text-ink-50">{BRAND.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{BRAND.version}</Badge>
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
        </main>

        {/* Footer - branding */}
        <footer className="border-t border-ink-800 px-4 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 text-[11px] text-ink-500 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink-400">{BRAND.name}</span>
              <span>·</span>
              <span>{BRAND.tagline}</span>
              <span>·</span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px]">{BRAND.stage}</span>
            </div>
            <div className="flex items-center gap-3">
              <span>Automation {BRAND.safety.automationDefault}</span>
              <span>·</span>
              <span>{BRAND.safety.riskNote}</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink-50 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function BrandingHeader({ showTagline = true }: { showTagline?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-signal-600 font-mono text-sm font-bold text-white">
        {BRAND.short}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-ink-50">{BRAND.name}</span>
          <Badge tone="info">{BRAND.version}</Badge>
        </div>
        {showTagline && <div className="text-xs text-ink-400">{BRAND.tagline} · {BRAND.stage}</div>}
      </div>
    </div>
  );
}
