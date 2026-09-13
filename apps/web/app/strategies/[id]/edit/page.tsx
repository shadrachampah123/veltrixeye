'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { StrategyForm } from '@/components/strategy-form';
import type { StrategyDetailDto, StrategyVersionDetailDto } from '@veltrixeye/contracts';

function EditStrategyContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [strategy, setStrategy] = React.useState<StrategyDetailDto | null>(null);
  const [draftDetail, setDraftDetail] = React.useState<StrategyVersionDetailDto | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .getStrategy(params.id)
      .then(async (r) => {
        const s = r.strategy;
        const draft = s.versions.find((v) => v.status === 'draft');
        setStrategy(s);
        if (draft) {
          const { version } = await api.getVersion(s.id, draft.id);
          setDraftDetail(version);
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError('Failed to load strategy');
      });
  }, [params.id]);

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Strategy not found.</p>
          <Link href="/strategies" className="mt-3 inline-block">
            <Button variant="secondary">Back to strategies</Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <Alert tone="danger">{error}</Alert>
      </AppShell>
    );
  }

  if (!strategy) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const draft = strategy.versions.find((v) => v.status === 'draft') ?? null;

  if (draft && !draftDetail) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  if (!draft) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">This strategy has no editable draft.</p>
          <p className="mt-1 text-xs text-ink-400">
            Published versions are immutable. Create a new version to make changes.
          </p>
          <Link href={`/strategies/${strategy.id}`} className="mt-3 inline-block">
            <Button variant="secondary">Back to strategy</Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={`Edit ${strategy.name}`}
        subtitle={`Editing draft v${draft.versionNumber} — publish to freeze it and activate`}
      />
      <StrategyForm
        mode="edit"
        strategyId={strategy.id}
        strategy={strategy}
        initialVersion={draftDetail}
        onDone={() => router.push(`/strategies/${strategy.id}`)}
      />
    </AppShell>
  );
}

export default function EditStrategyPage() {
  return (
    <RequireAuth>
      <EditStrategyContent />
    </RequireAuth>
  );
}
