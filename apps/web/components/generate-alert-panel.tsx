'use client';

import * as React from 'react';
import Link from 'next/link';
import type { SetupDto } from '@veltrixeye/contracts';
import { api } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Monospace, Spinner } from '@/components/ui';
import {
  type GenerateAlertOutcome,
  describeGenerateOutcome,
  isGenerateEligibleState,
  setupGenerateEligibility,
  sortSetupsForGenerate,
} from '@/lib/alerts-view';
import { describeApiError } from '@/lib/api-errors';
import { formatDateTime, formatPrice } from '@/lib/formats';
import { StubDeliveryNotice } from '@/components/stub-delivery-notice';

/**
 * “Generate alert from a setup” (M6 Phase 4).
 *
 * The UI never invents a setup id and never guesses eligibility: it lists only
 * setups the API returned for this session (owner-scoped) and calls
 * `POST /api/setups/:setupId/alerts`. The three outcomes the API can return are
 * rendered distinctly — created, dedup replay, and the quality-gate skip — and
 * a skip or a replay is never presented as a newly generated alert.
 */

export function GenerateAlertOutcomeBanner({ outcome }: { outcome: GenerateAlertOutcome }) {
  const copy = describeGenerateOutcome(outcome);
  return (
    <Alert tone={copy.tone} title={copy.title}>
      <p>{copy.detail}</p>
      {outcome.kind !== 'skipped' && (
        <p className="mt-1.5">
          <Link href={`/alerts/${outcome.alert.id}`} className="underline">
            Open alert
          </Link>
          <span className="ml-2 text-xs opacity-80">
            {outcome.alert.instrument.symbol} · {outcome.alert.direction} · score {outcome.alert.qualityScore}
          </span>
        </p>
      )}
    </Alert>
  );
}

export function SetupGenerateRow({
  setup,
  pending,
  onGenerate,
}: {
  setup: SetupDto;
  pending: boolean;
  onGenerate: (setupId: string) => void;
}) {
  const eligibility = setupGenerateEligibility(setup);
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Monospace>{setup.instrument.symbol}</Monospace>
          <Badge tone={setup.direction === 'long' ? 'success' : 'danger'}>{setup.direction}</Badge>
          <Badge tone={isGenerateEligibleState(setup.state) ? 'info' : 'neutral'}>{setup.state.replace('_', ' ')}</Badge>
          <span className="text-xs text-ink-500">v{setup.versionNumber}</span>
        </div>
        <p className="mt-0.5 text-xs text-ink-400">
          detected {formatDateTime(setup.detectedAt)} · entry {formatPrice(setup.entryPrice)} · stop{' '}
          {formatPrice(setup.stopLossPrice)} · latest score{' '}
          {setup.qualityScore === null ? 'not scored yet' : setup.qualityScore}
        </p>
        {!eligibility.eligible && <p className="mt-0.5 text-xs text-amber-450">{eligibility.reason}</p>}
      </div>
      <Button
        variant={eligibility.eligible ? 'primary' : 'secondary'}
        disabled={!eligibility.eligible || pending}
        onClick={() => onGenerate(setup.id)}
      >
        {pending ? 'Generating…' : 'Generate alert'}
      </Button>
    </li>
  );
}

export function SetupGenerateList({
  setups,
  pendingSetupId,
  onGenerate,
}: {
  setups: readonly SetupDto[];
  pendingSetupId: string | null;
  onGenerate: (setupId: string) => void;
}) {
  if (setups.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-ink-400">
        No setups found for your account. Setups are created by running detection on a published version — there is no
        background scanner, so nothing appears here on its own.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-750">
      {setups.map((setup) => (
        <SetupGenerateRow
          key={setup.id}
          setup={setup}
          pending={pendingSetupId === setup.id}
          onGenerate={onGenerate}
        />
      ))}
    </ul>
  );
}

/** Container: loads the caller's eligible setups and drives generation. */
export function GenerateAlertPanel() {
  const [setups, setSetups] = React.useState<SetupDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingSetupId, setPendingSetupId] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<GenerateAlertOutcome | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      // Two owner-scoped reads (one per eligible state) so the panel is not
      // limited by whichever state happens to dominate a single page.
      const [confirmed, triggered] = await Promise.all([
        api.listSetups({ state: 'confirmed', limit: 100 }),
        api.listSetups({ state: 'triggered', limit: 100 }),
      ]);
      const byId = new Map<string, SetupDto>();
      for (const s of [...confirmed.setups, ...triggered.setups]) byId.set(s.id, s);
      setSetups(sortSetupsForGenerate([...byId.values()]));
    } catch (err) {
      setSetups([]);
      setError(describeApiError(err, 'Could not load your setups. Try again.'));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const generate = async (setupId: string) => {
    if (pendingSetupId) return; // one in-flight generation at a time
    setPendingSetupId(setupId);
    setOutcome(null);
    setError(null);
    try {
      const res = await api.generateAlert(setupId);
      setOutcome(
        res.alert === null
          ? { kind: 'skipped', reason: res.skippedReason ?? 'below_min_quality' }
          : { kind: res.created ? 'created' : 'replayed', alert: res.alert, deliveries: res.deliveries ?? [] },
      );
    } catch (err) {
      setError(describeApiError(err, 'The alert could not be generated. Nothing was created.'));
    } finally {
      setPendingSetupId(null);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Generate from a setup"
          subtitle="Explicit generation only — confirmed or triggered setups with a quality score at their detection anchor"
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh setups
            </Button>
          }
        />
        {outcome && (
          <div className="px-5 pt-4">
            <GenerateAlertOutcomeBanner outcome={outcome} />
          </div>
        )}
        {error && (
          <div className="px-5 pt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
        {setups === null ? <Spinner /> : <SetupGenerateList setups={setups} pendingSetupId={pendingSetupId} onGenerate={(id) => void generate(id)} />}
      </Card>
      <StubDeliveryNotice />
    </div>
  );
}
