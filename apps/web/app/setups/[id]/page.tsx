'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import type { SetupDetailDto, SetupScoreDto, SetupState } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Card, CardHeader, LinkButton, Spinner, Badge } from '@/components/ui';
import {
  SetupAlertPanel,
  SetupEventTimeline,
  SetupLevelsCard,
  SetupScorePanel,
  SetupSummaryCard,
  SetupTransitionPanel,
} from '@/components/setup-panels';
import { SetupDetailLevels } from '@/components/setup-card';
import { TimeframeWorkflowDetailed } from '@/components/timeframe-workflow';
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
  setupStateTone,
} from '@/lib/workbench';
import { BRAND } from '@/lib/brand';
import { useWatchlist } from '@/lib/watchlist';
import { formatPrice } from '@/lib/formats';

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

  const { has, toggle } = useWatchlist();

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
        title={detail ? `${detail.setup.instrument.symbol} ${detail.setup.direction} setup` : 'Setup detail'}
        subtitle={
          detail
            ? `v${detail.setup.versionNumber} · ${setupStateLabel(detail.setup.state)} · ${BRAND.stage} · market, direction, timeframe, entry, SL, TP, R/R, quality/conditions, status`
            : 'Lifecycle, scoring, transitions and alert generation'
        }
        actions={
          <>
            <LinkButton href="/setups" variant="secondary">All setups</LinkButton>
            {detail && (
              <>
                <button
                  onClick={() => toggle(detail.setup.instrument.assetClass, detail.setup.instrument.symbol)}
                  className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${has(detail.setup.instrument.assetClass, detail.setup.instrument.symbol) ? 'border-signal-500/40 bg-signal-500/10 text-signal-400' : 'border-ink-600 bg-ink-800 text-ink-300 hover:bg-ink-700'}`}
                >
                  {has(detail.setup.instrument.assetClass, detail.setup.instrument.symbol) ? '★ Watching' : '☆ Watchlist'}
                </button>
                <LinkButton href={`/strategies/${detail.setup.strategyId}/versions/${detail.setup.strategyVersionId}`} variant="secondary">Workbench</LinkButton>
              </>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">{error}</Alert>
        </div>
      )}

      {detail === null ? (
        error ? null : <Spinner label="Loading this setup" />
      ) : (
        <div className="space-y-6">
          {/* Top: Market, Direction, Timeframe, Entry, SL, TP, RR, Quality, Status */}
          <Card>
            <CardHeader
              title="Setup Overview — Market · Direction · Timeframe · Entry · SL · TP · R/R · Quality · Status"
              subtitle="All values from API — no client-side calculation except R/R display, no live trading"
              actions={<Badge tone={setupStateTone(detail.setup.state)}>{setupStateLabel(detail.setup.state)}</Badge>}
            />
            <div className="space-y-5 p-5">
              <SetupDetailLevels setup={detail.setup} />

              {/* HTF → Setup → Entry workflow visualization */}
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-300">HTF → Setup → Entry Timeframe Workflow</div>
                <TimeframeWorkflowDetailed
                  timeframes={{
                    htf_bias: '1d',
                    setup: '1h',
                    entry: '15m',
                  }}
                />
                <p className="mt-2 text-[11px] text-ink-500">
                  Timeframes shown are illustrative — actual timeframes are stored in strategy version config. This setup was detected at anchor {new Date(detail.setup.asOfMs).toISOString()} using deterministic evaluation.
                </p>
              </div>

              {/* Entry / SL / TP visualization */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-ink-400">Entry & Risk</div>
                  <div className="mt-2 space-y-1 font-mono text-xs">
                    <div>Entry: <span className="text-ink-100">{formatPrice(detail.setup.entryPrice)}</span></div>
                    <div>Stop: <span className="text-danger-450">{formatPrice(detail.setup.stopLossPrice)}</span></div>
                    <div className="text-[11px] text-ink-500">Risk = |Entry - SL|</div>
                  </div>
                </div>
                <div className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-ink-400">Take Profits & R:R</div>
                  <div className="mt-2 space-y-1 font-mono text-xs">
                    <div>TP1: <span className="text-signal-400">{formatPrice(detail.setup.tp1Price)}</span> · R:R {detail.setup.entryPrice && detail.setup.stopLossPrice && detail.setup.tp1Price ? ((Math.abs(detail.setup.tp1Price - detail.setup.entryPrice) / Math.abs(detail.setup.entryPrice - detail.setup.stopLossPrice)).toFixed(2) + 'R') : '—'}</div>
                    <div>TP2: <span className="text-ink-300">{formatPrice(detail.setup.tp2Price)}</span></div>
                    <div>TP3: <span className="text-ink-300">{formatPrice(detail.setup.tp3Price)}</span></div>
                  </div>
                </div>
                <div className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-ink-400">Quality & Conditions</div>
                  <div className="mt-2 space-y-1 text-xs">
                    <div>Quality: <span className="font-mono text-ink-100">{detail.setup.qualityScore ?? 'Not scored'}</span> {detail.setup.qualityScore !== null && <Badge tone={detail.setup.qualityScore >= 75 ? 'success' : detail.setup.qualityScore >= 50 ? 'info' : 'warning'}>{detail.setup.qualityScore >= 75 ? 'High' : detail.setup.qualityScore >= 50 ? 'Medium' : 'Low'}</Badge>}</div>
                    <div>Status: <Badge tone={setupStateTone(detail.setup.state)}>{setupStateLabel(detail.setup.state)}</Badge></div>
                    <div className="text-[11px] text-ink-500">Conditions breakdown in scoring panel</div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

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
              <SetupAlertPanel setup={detail.setup} pending={alertPending} error={alertError} outcome={alertOutcome} onGenerate={() => void onGenerateAlert()} />
            </div>
          </div>

          {/* Safety footer */}
          <div className="rounded-md border border-ink-700 bg-ink-800 px-4 py-3 text-xs leading-relaxed text-ink-400">
            <strong className="text-ink-200">M8.7 Safety preserved:</strong> This setup detail view shows market, direction, timeframe (HTF→setup→entry), entry, SL, TP, R/R, quality/conditions, status — all from API. No live trading, no order submission, automation OFF, drawdown protection active, kill-switch enforced. Scoring is append-only, transitions are state-machine validated.
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
