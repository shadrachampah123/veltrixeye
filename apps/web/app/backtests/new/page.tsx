'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { BacktestFormPanel } from '@/components/backtest-form';

/**
 * New backtest (M6 Phase 4) — POST /api/backtests.
 *
 * The form itself lives in `components/backtest-form.tsx` (controlled +
 * presentational) so the field rules can be tested without a browser.
 */
function NewBacktestContent() {
  return (
    <AppShell>
      <PageHeader
        title="New backtest"
        subtitle="Replay a published strategy version over stored candles — deterministic, provider-free"
      />
      <BacktestFormPanel />
    </AppShell>
  );
}

export default function NewBacktestPage() {
  return (
    <RequireAuth>
      <NewBacktestContent />
    </RequireAuth>
  );
}
