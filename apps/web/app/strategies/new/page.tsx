'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { StrategyForm } from '@/components/strategy-form';

function NewStrategyContent() {
  const router = useRouter();
  return (
    <AppShell>
      <PageHeader title="New strategy" subtitle="Define a new deterministic strategy (saved as draft v1)" />
      <StrategyForm mode="create" onDone={() => router.push('/strategies')} />
    </AppShell>
  );
}

export default function NewStrategyPage() {
  return (
    <RequireAuth>
      <NewStrategyContent />
    </RequireAuth>
  );
}
