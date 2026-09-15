'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AlertDetailDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { AlertDetailPanel } from '@/components/alert-detail-panel';
import { isAcknowledged } from '@/lib/alerts-view';
import { describeApiError } from '@/lib/api-errors';
import { formatDateTime } from '@/lib/formats';

/**
 * Alert detail (M6 Phase 4) — GET /api/alerts/:id + POST /api/alerts/:id/acknowledge.
 *
 * Acknowledgement is idempotent on the API, and the UI mirrors that: the button
 * is disabled while a request is in flight and stays disabled once the API
 * reports `status: 'acknowledged'`. Re-acknowledging an already-acknowledged
 * alert is reported as a no-op rather than as a new action.
 */
function AlertDetailContent() {
  const params = useParams<{ id: string }>();
  const alertId = params.id;

  const [detail, setDetail] = React.useState<AlertDetailDto | null>(null);
  const [acknowledging, setAcknowledging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setNotice(null);
    setNotFound(false);
    api
      .getAlert(alertId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError(describeApiError(err, 'Could not load this alert.'));
      });
    return () => {
      cancelled = true;
    };
  }, [alertId]);

  const acknowledge = async () => {
    if (!detail || acknowledging) return;
    const wasAcknowledged = isAcknowledged(detail.alert);
    setAcknowledging(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.acknowledgeAlert(alertId);
      setDetail(res);
      setNotice(
        wasAcknowledged
          ? 'This alert was already acknowledged — the API kept the original timestamp and wrote nothing new.'
          : `Acknowledged at ${formatDateTime(res.alert.acknowledgedAt)}.`,
      );
    } catch (err) {
      setError(describeApiError(err, 'The alert could not be acknowledged. Try again.'));
    } finally {
      setAcknowledging(false);
    }
  };

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Alert not found.</p>
          <p className="mt-1 text-xs text-ink-400">It may belong to another account, or it may never have existed.</p>
          <Link href="/alerts" className="mt-3 inline-block">
            <Button variant="secondary">Back to alerts</Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Alert detail"
        subtitle="Trigger state, quality score, delivery ledger and acknowledgement"
        actions={
          <Link href="/alerts">
            <Button variant="secondary">All alerts</Button>
          </Link>
        }
      />

      {detail === null ? (
        error ? (
          <Alert tone="danger">{error}</Alert>
        ) : (
          <Spinner />
        )
      ) : (
        <AlertDetailPanel
          alert={detail.alert}
          deliveries={detail.deliveries}
          acknowledging={acknowledging}
          error={error}
          notice={notice}
          onAcknowledge={() => void acknowledge()}
        />
      )}
    </AppShell>
  );
}

export default function AlertDetailPage() {
  return (
    <RequireAuth>
      <AlertDetailContent />
    </RequireAuth>
  );
}
