'use client';

import * as React from 'react';
import type { AlertDto, StrategySummaryDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Alert, Button, Card, CardHeader, Field, Select, Spinner } from '@/components/ui';
import { AlertsTable, AlertsNeverGeneratedState } from '@/components/alerts-table';
import { GenerateAlertPanel } from '@/components/generate-alert-panel';
import { StubDeliveryNotice } from '@/components/stub-delivery-notice';
import { ALERT_STATUS_FILTERS } from '@/lib/alerts-view';
import { describeApiError } from '@/lib/api-errors';
import { MAX_ALERTS_LIMIT } from '@veltrixeye/contracts';

/**
 * Alerts (M6 Phase 4) — GET /api/alerts + POST /api/setups/:setupId/alerts.
 *
 * Everything on this page is owner-scoped by the API. The stub-delivery notice
 * is rendered above the list so no state of this screen can imply that an
 * external notification was sent.
 */
function AlertsContent() {
  const [strategies, setStrategies] = React.useState<StrategySummaryDto[]>([]);
  const [strategyId, setStrategyId] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [alerts, setAlerts] = React.useState<AlertDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    api
      .listStrategies()
      .then(({ strategies: list }) => setStrategies(list))
      .catch(() => setStrategies([]));
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listAlerts({
        strategyId: strategyId || undefined,
        status: (status || undefined) as AlertDto['status'] | undefined,
        limit: MAX_ALERTS_LIMIT,
      });
      setAlerts(res.alerts);
    } catch (err) {
      setAlerts([]);
      setError(describeApiError(err, 'Could not load your alerts. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [strategyId, status]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell>
      <PageHeader
        title="Alerts"
        subtitle="Generated explicitly from your own setups — never by a background scanner"
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      />

      <div className="mb-5">
        <StubDeliveryNotice />
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <Card className="mb-5">
        <CardHeader title="Filter" subtitle="Up to the most recent 100 alerts" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {ALERT_STATUS_FILTERS.map((f) => (
                <option key={f.value || 'all'} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Strategy">
            <Select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">All strategies</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {alerts === null ? (
        <Spinner />
      ) : alerts.length === 0 && status === '' && strategyId === '' ? (
        <AlertsNeverGeneratedState />
      ) : (
        <AlertsTable alerts={alerts} />
      )}

      <div className="mt-6">
        <GenerateAlertPanel />
      </div>
    </AppShell>
  );
}

export default function AlertsPage() {
  return (
    <RequireAuth>
      <AlertsContent />
    </RequireAuth>
  );
}
