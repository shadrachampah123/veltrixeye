'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import type { SetupDetailDto, SetupScoreDto, SetupState } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Card, LinkButton, Spinner } from '@/components/ui';
import {
  SetupAlertPanel,
  SetupEventTimeline,
  SetupLevelsCard,
  SetupScorePanel,
  SetupSummaryCard,
  SetupTransitionPanel,
} from '@/components/setup-panels';
import { classifyGenerateOutcome, type GenerateAlertOutcome } from '@/lib/alerts-view';
import { describeApiError } from '@/lib/api-errors';
import {
  anchorInputValue,
  buildTransitionBody,
  defaultAnchorMs,
  describeScoreOutcome,
  describeTransitionOutcome,
  parseAnchorValue,
  setupStateLabel,
} from '@/lib/workbench';

/**
 * Setup detail (M7.1) — GET /api/setups/:id, POST /api/setups/:id/score,
 * GET /api/setups/:id/scores, POST /api/setups/:id/transitions and the existing
 * M6 alert generation.
 *
 * Ownership is decided by the API: a foreign or unknown setup is a masked 404.
 * The page offers only the actions the API will actually accept (no scoring for
 * a terminal setup, no transition out of a terminal state), and after a
 * rejected transition it re-reads the setup so the UI shows the API's truth
 * rather than its own guess.
 */
function SetupDetailContent() {
  const params = useParams<{ id: string }>();
  const setupId = params.id;

  const [detail, setDetail] = React.useState<SetupDetailDto | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [scores, setScores] = React.useState<SetupScoreDto[] | null>(null);
  const [scoresError, setScoresError] = React.useState<string | null>(null);
  const [scoring, setScoring] = React.useState(false);
  const [scoreError, setScoreError] = React.useState<string | null>(null);
  const [scoreNotice, setScoreNotice] = React.useState<string | null>(null);
  const [scoreAnchor, setScoreAnchor] = React.useState('');

  const [toState, setToState] = React.useState<SetupState | ''>('');
  const [reason, setReason] = React.useState('');
  const [transitioning, setTransitioning] = React.useState(false);
  const [transitionError, setTransitionError] = React.useState<string | null>(null);
  const [transitionNotice, setTransitionNotice] = React.useState<string | null>(null);
  const [transitionAnchor, setTransitionAnchor] = React.useState(() => anchorInputValue(defaultAnchorMs(Date.now())));

  const [alertPending, setAlertPending] = React.useState(false);
  const [alertError, setAlertError] = React.useState<string | null>(null);
  const [alertOutcome, setAlertOutcome] = React.useState<GenerateAlertOutcome | null>(null);

  const refreshDetail = React.useCallback(async () => {
    try {
      const res = await api.getSetup(setupId);
      setDetail(res);
    } catch (err) {
      setError(describeApiError(err, 'Could not refresh this setup.'));
    }
  }, [setupId]);

  const refreshScores = React.useCallback(async () => {
    try {
      const res = await api.listSetupScores(setupId);
      setScores(res.scores);
      setScoresError(null);
    } catch (err) {
      setScoresError(describeApiError(err, 'Could not refresh the score history.'));
    }
  }, [setupId]);

  React.useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setScores(null);
    setNotFound(false);
    setError(null);
    setScoresError(null);
    setScoreError(null);
    setScoreNotice(null);
    setScoreAnchor('');
    setTransitionError(null);
    setTransitionNotice(null);
    setToState('');
    setReason('');
    setAlertError(null);
    setAlertOutcome(null);

    api
      .getSetup(setupId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        // Default the scoring anchor to the setup's OWN detection anchor: the
        // exact context the setup came from, which is also the API default.
        setScoreAnchor(anchorInputValue(res.setup.asOfMs));
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError(describeApiError(err, 'Could not load this setup.'));
      });

    api
      .listSetupScores(setupId)
      .then((res) => {
        if (!cancelled) setScores(res.scores);
      })
      .catch((err) => {
        if (cancelled) return;
        setScores([]);
        setScoresError(describeApiError(err, 'Could not load the score history.'));
      });

    return () => {
      cancelled = true;
    };
  }, [setupId]);

  const onScore = async () => {
    if (scoring) return;
    const asOfMs = parseAnchorValue(scoreAnchor);
    if (asOfMs === null) {
      setScoreError('Set a valid scoring anchor before scoring.');
      return;
    }
    setScoring(true);
    setScoreError(null);
    setScoreNotice(null);
    try {
      const res = await api.scoreSetup(setupId, { asOf: asOfMs });
      const copy = describeScoreOutcome(res.created);
      setScoreNotice(`${copy.title} — ${copy.detail}`);
      setDetail((prev) => (prev ? { ...prev, setup: res.setup } : prev));
      await refreshScores();
    } catch (err) {
      setScoreError(describeApiError(err, 'The setup could not be scored. No score was recorded.'));
    } finally {
      setScoring(false);
    }
  };

  const onTransition = async () => {
    if (transitioning) return;
    const built = buildTransitionBody({ toState, asOfMs: parseAnchorValue(transitionAnchor), reason });
    if (!built.ok) {
      setTransitionError(built.error);
      return;
    }
    setTransitioning(true);
    setTransitionError(null);
    setTransitionNotice(null);
    try {
      const res = await api.transitionSetup(setupId, built.body);
      const copy = describeTransitionOutcome(res);
      setTransitionNotice(`${copy.title} — ${copy.detail}`);
      setDetail((prev) => (prev ? { ...prev, setup: res.setup } : prev));
      setToState('');
      setReason('');
      await refreshDetail();
    } catch (err) {
      setTransitionError(describeApiError(err, 'The transition was rejected. Nothing was written.'));
      // A rejection can mean the setup moved meanwhile (another tab or device).
      // Re-read instead of leaving a stale state on screen.
      await refreshDetail();
    } finally {
      setTransitioning(false);
    }
  };

  const onGenerateAlert = async () => {
    if (alertPending) return;
    setAlertPending(true);
    setAlertError(null);
    setAlertOutcome(null);
    try {
      const res = await api.generateAlert(setupId);
      setAlertOutcome(classifyGenerateOutcome(res));
      await refreshDetail();
    } catch (err) {
      setAlertError(describeApiError(err, 'The alert could not be generated. Nothing was created.'));
    } finally {
      setAlertPending(false);
    }
  };

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Setup not found.</p>
          <p className="mt-1 text-xs text-ink-400">It may belong to another account, or it may never have existed.</p>
          <LinkButton href="/setups" variant="secondary" className="mt-3">
            Back to setups
          </LinkButton>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={
          detail
            ? `${detail.setup.instrument.symbol} ${detail.setup.direction} setup`
            : 'Setup detail'
        }
        subtitle={
          detail
            ? `v${detail.setup.versionNumber} · ${setupStateLabel(detail.setup.state)} · detected ${new Date(detail.setup.detectedAt).toISOString()}`
            : 'Lifecycle, scoring, transitions and alert generation'
        }
        actions={
          <>
            <LinkButton href="/setups" variant="secondary">
              All setups
            </LinkButton>
            {detail && (
              <LinkButton
                href={`/strategies/${detail.setup.strategyId}/versions/${detail.setup.strategyVersionId}`}
                variant="secondary"
              >
                Version workbench
              </LinkButton>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        </div>
      )}

      {detail === null ? (
        error ? null : (
          <Spinner label="Loading this setup" />
        )
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-5">
            <SetupSummaryCard setup={detail.setup} />
            <SetupLevelsCard setup={detail.setup} />
            <SetupEventTimeline events={detail.events} />
          </div>
          <div className="space-y-5">
            <SetupScorePanel
              setup={detail.setup}
              scores={scores}
              scoresError={scoresError}
              pending={scoring}
              error={scoreError}
              notice={scoreNotice}
              anchorValue={scoreAnchor}
              anchorError={scoreAnchor.trim() !== '' && parseAnchorValue(scoreAnchor) === null ? 'That anchor is not a valid date and time.' : null}
              onAnchorChange={setScoreAnchor}
              onUseSetupAnchor={() => setScoreAnchor(anchorInputValue(detail.setup.asOfMs))}
              onUseNow={() => setScoreAnchor(anchorInputValue(defaultAnchorMs(Date.now())))}
              onScore={() => void onScore()}
            />
            <SetupTransitionPanel
              setup={detail.setup}
              toState={toState}
              onToStateChange={setToState}
              reason={reason}
              onReasonChange={setReason}
              pending={transitioning}
              error={transitionError}
              notice={transitionNotice}
              anchorValue={transitionAnchor}
              anchorError={parseAnchorValue(transitionAnchor) === null ? 'A transition needs a valid anchor.' : null}
              onAnchorChange={setTransitionAnchor}
              onUseNow={() => setTransitionAnchor(anchorInputValue(defaultAnchorMs(Date.now())))}
              onTransition={() => void onTransition()}
            />
            <SetupAlertPanel
              setup={detail.setup}
              pending={alertPending}
              error={alertError}
              outcome={alertOutcome}
              onGenerate={() => void onGenerateAlert()}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function SetupDetailPage() {
  return (
    <RequireAuth>
      <SetupDetailContent />
    </RequireAuth>
  );
}
