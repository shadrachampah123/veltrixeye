import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

/**
 * CL-1 — shared chrome for the public legal pages.
 *
 * Public by construction: this tree renders outside AppShell and RequireAuth
 * and makes no API calls, so the routes answer 200 without a session.
 */

export const metadata: Metadata = {
  title: 'Legal',
  description: `Legal information for ${BRAND.name}: terms of use, privacy, risk disclosure, and cookies.`,
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ink-950">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal-600 font-mono text-xs font-bold text-white">
              {BRAND.short}
            </span>
            <span className="text-sm font-semibold text-ink-50">{BRAND.name}</span>
          </Link>
          <Link href="/login" className="text-xs font-medium text-ink-300 hover:text-ink-100 hover:underline">
            Sign in
          </Link>
        </div>
      </header>
      <main className="px-4 py-8">{children}</main>
    </div>
  );
}
