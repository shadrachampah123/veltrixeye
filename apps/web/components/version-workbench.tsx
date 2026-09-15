'use client';

import * as React from 'react';
import Link from 'next/link';
import type {
  DetectionResponseDto,
  EvaluationResultDto,
  StrategyDetailDto,
  StrategyVersionDetailDto,
} from '@veltrixeye/contracts';
import { api } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, LinkButton, Select, Spinner } from '@/components/ui';
import { AnchorField } from '@/components/anchor-field';
import { EvaluationResultView } from '@/components/evaluation-result';
import { DetectionResultView } from '@/components/detection-result';
import { describeApiError } from '@/lib/api-errors';
import {
  anchorInputValue,
  anchorReadout,
  anchorValidationError,
  buildDetectBody,
  buildEvaluateBody,
  defaultAnchorMs,
  detectInstrumentChoices,
  instrumentKey,
  instrumentLabel,
  parseAnchorValue,
  type DetectInstrumentChoices,
} from '@/lib/workbench';

/**
 * Published-version workbench (M7.1): evaluate → detect.
 *
 * The two deterministic steps of the core workflow, in order, against the
 * version's own market scope. The browser never invents an engine input: the
 * evaluate body is exactly `{ asOf }`, the detect body is exactly
 * `{ instrument, asOf, direction? }`, and only published (or deprecated,
 * already-frozen) versions can be evaluated — a draft is rejected by the API
 * and blocked here.
 *
 * The anchor is shared by both steps and printed as raw epoch-ms, so the
 * detection run is pinned to the very instant the evaluation was pinned to.
 * No result is ever fabricated: before a run, the panels say so.
 */

export const DRAFT_BLOCKED_REASON =
  'Only published versions can be evaluated or detected — this version is still a draft. Publish it first.';
export const THIRD_PARTY_NOTE =
  'Evaluation reads the shared candle store only. It never calls a market-data provider, so it works with no provider key configured — an empty result usually means no candles are stored for this anchor.';

// ---------------------------------------------------------------------------
// Panels (presentational — fully prop-driven so the states can be asserted)
// ---------------------------------------------------------------------------

export interface EvaluatePanelProps {
  anchorError: string | null;
  currentAnchorMs: number | null;
  /** Anchor the displayed result was produced at (null when there is no result). */
  resultAnchorMs: number | null;
  pending: boolean;
  result: EvaluationResultDto | null;
  error: string | null;
  /** Set when the API refuses the call (e.g. a draft version) — the control is then disabled. */
  blockedReason: string | null;
  onEvaluate: () => void;
}

export function EvaluatePanel(props: EvaluatePanelProps) {
  const { anchorError, currentAnchorMs, resultAnchorMs, pending, result, error, blockedReason, onEvaluate } = props;
  const stale = result !== null && currentAnchorMs !== null && resultAnchorMs !== currentAnchorMs;

  return (
    <Card>
      <CardHeader
        title="Step 1 · Evaluate the version"
        subtitle="Deterministic M3 engine over stored candles — explicit anchor, store-only, reproducible"
        actions={
          <Button onClick={onEvaluate} disabled={pending || blockedReason !== null || anchorError !== null}>
            {pending ? 'Evaluating…' : 'Evaluate'}
          </Button>
        }
      />
      <div className="space-y-3 px-5 py-4">
        {blockedReason && (
          <Alert tone="warning" role="status">
            {blockedReason}
          </Alert>
        )}
        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
        {pending && <Spinner label="Evaluating the strategy version" />}
        {stale && resultAnchorMs !== null && (
          <Alert tone="info" role="status">
            The result below was produced at anchor <span className="font-mono">{anchorReadout(resultAnchorMs)}</span>,
            which is no longer the anchor in the field. Evaluate again to re-pin it.
          </Alert>
        )}
        {result ? (
          <EvaluationResultView result={result} />
        ) : (
          !pending &&
          !error && (
            <div className="text-sm text-ink-400">
              <p>
                Nothing has been evaluated at this anchor yet. Evaluation returns the pass/fail status of every rule group
                and condition for each instrument in the version’s market scope, together with the candidate levels and the
                achievable risk:reward.
              </p>
              <p className="mt-2 text-xs text-ink-500">{THIRD_PARTY_NOTE}</p>
            </div>
          )
        )}
      </div>
    </Card>
  );
}

export interface DetectPanelProps {
  choices: DetectInstrumentChoices;
  instrumentKeyValue: string;
  onInstrumentChange: (key: string) => void;
  direction: '' | 'long' | 'short';
  onDirectionChange: (direction: '' | 'long' | 'short') => void;
  anchorError: string | null;
  currentAnchorMs: number | null;
  resultAnchorMs: number | null;
  pending: boolean;
  result: DetectionResponseDto | null;
  error: string | null;
  blockedReason: string | null;
  onDetect: () => void;
}

export function DetectPanel(props: DetectPanelProps) {
  const {
    choices,
    instrumentKeyValue,
    onInstrumentChange,
    direction,
    onDirectionChange,
    anchorError,
    currentAnchorMs,
    resultAnchorMs,
    pending,
    result,
    error,
    blockedReason,
    onDetect,
  } = props;
  const noInstruments = choices.options.length === 0;
  const stale = result !== null && currentAnchorMs !== null && resultAnchorMs !== currentAnchorMs;

  return (
    <Card>
      <CardHeader
        title="Step 2 · Detect a setup"
        subtitle="M4 persists one setup per qualifying direction at the anchor — idempotent, never automatic"
        actions={
          <Button
            onClick={onDetect}
            disabled={pending || blockedReason !== null || anchorError !== null || noInstruments}
          >
            {pending ? 'Detecting…' : 'Detect setup'}
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        {blockedReason && (
          <Alert tone="warning" role="status">
            {blockedReason}
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Instrument" hint={choices.note}>
            <Select
              value={instrumentKeyValue}
              disabled={pending || noInstruments}
              onChange={(e) => onInstrumentChange(e.target.value)}
            >
              {noInstruments ? (
                <option value="">No instruments available</option>
              ) : (
                choices.options.map((option) => (
                  <option key={instrumentKey(option)} value={instrumentKey(option)}>
                    {instrumentLabel(option)}
                  </option>
                ))
              )}
            </Select>
          </Field>
          <Field label="Direction" hint="“Both directions” omits the field, which is the API default.">
            <Select
              value={direction}
              disabled={pending}
              onChange={(e) => onDirectionChange(e.target.value as '' | 'long' | 'short')}
            >
              <option value="">Both directions</option>
              <option value="long">Long only</option>
              <option value="short">Short only</option>
            </Select>
          </Field>
        </div>

        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
        {pending && <Spinner label="Detecting setups" />}
        {stale && resultAnchorMs !== null && (
          <Alert tone="info" role="status">
            The detection below ran at anchor <span className="font-mono">{anchorReadout(resultAnchorMs)}</span>, which is
            no longer the anchor in the field. Detect again to run at the current anchor.
          </Alert>
        )}
        {result ? (
          <DetectionResultView result={result} />
        ) : (
          !pending &&
          !error && (
            <p className="text-sm text-ink-400">
              Nothing has been detected at this anchor yet. Detection persists a setup for a direction only when the M3
              evaluation passed for it; repeating it with the same anchor returns the existing setup instead of creating a
              second one.
            </p>
          )
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export function VersionWorkbench({
  strategy,
  version,
  nowMs = Date.now(),
}: {
  strategy: StrategyDetailDto;
  version: StrategyVersionDetailDto;
  /** Test seam for the default anchor (the only clock read in the workflow UI). */
  nowMs?: number;
}) {
  const [anchorValue, setAnchorValue] = React.useState(() => anchorInputValue(defaultAnchorMs(nowMs)));
  const [evaluation, setEvaluation] = React.useState<{ result: EvaluationResultDto; anchorMs: number } | null>(null);
  const [evaluationPending, setEvaluationPending] = React.useState(false);
  const [evaluationError, setEvaluationError] = React.useState<string | null>(null);
  const [detection, setDetection] = React.useState<{ result: DetectionResponseDto; anchorMs: number } | null>(null);
  const [detectionPending, setDetectionPending] = React.useState(false);
  const [detectionError, setDetectionError] = React.useState<string | null>(null);
  const [platformInstruments, setPlatformInstruments] = React.useState<Array<{ assetClass: string; symbol: string }>>([]);
  const [instrumentSelection, setInstrumentSelection] = React.useState('');
  const [direction, setDirection] = React.useState<'' | 'long' | 'short'>('');

  const anchorMs = parseAnchorValue(anchorValue);
  const anchorError = anchorValidationError(anchorValue, anchorMs);
  const blockedReason = version.status === 'draft' ? DRAFT_BLOCKED_REASON : null;

  // Platform instruments are only a fallback for scope "all" before the first
  // evaluation; a failure here must not break the page.
  React.useEffect(() => {
    let cancelled = false;
    api
      .listInstruments()
      .then((res) => {
        if (!cancelled) setPlatformInstruments(res.instruments.map((i) => ({ assetClass: i.assetClass, symbol: i.symbol })));
      })
      .catch(() => {
        if (!cancelled) setPlatformInstruments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choices = React.useMemo(
    () =>
      detectInstrumentChoices({
        version,
        evaluation: evaluation?.result ?? null,
        platformInstruments,
      }),
    [version, evaluation, platformInstruments],
  );

  // Keep the selection inside the offered set as the source of options changes
  // (scope → evaluated set → platform list), so the select can never submit an
  // instrument the API would reject as out of scope.
  React.useEffect(() => {
    if (choices.options.length === 0) {
      setInstrumentSelection('');
      return;
    }
    const keys = choices.options.map((option) => instrumentKey(option));
    if (!keys.includes(instrumentSelection)) setInstrumentSelection(keys[0] ?? '');
  }, [choices, instrumentSelection]);

  const onEvaluate = async () => {
    if (evaluationPending || blockedReason) return;
    const built = buildEvaluateBody(anchorMs);
    if (!built.ok) {
      setEvaluationError(built.error);
      return;
    }
    setEvaluationPending(true);
    setEvaluationError(null);
    try {
      const result = await api.evaluateVersion(strategy.id, version.id, built.body);
      setEvaluation({ result, anchorMs: built.body.asOf ?? anchorMs ?? 0 });
    } catch (err) {
      setEvaluationError(describeApiError(err, 'The evaluation could not be run. Nothing was stored.'));
    } finally {
      setEvaluationPending(false);
    }
  };

  const onDetect = async () => {
    if (detectionPending || blockedReason) return;
    const instrument = choices.options.find((option) => instrumentKey(option) === instrumentSelection);
    const built = buildDetectBody({
      assetClass: instrument?.assetClass ?? '',
      symbol: instrument?.symbol ?? '',
      direction,
      asOfMs: anchorMs,
    });
    if (!built.ok) {
      setDetectionError(built.error);
      return;
    }
    setDetectionPending(true);
    setDetectionError(null);
    try {
      const result = await api.detectSetup(strategy.id, version.id, built.body);
      setDetection({ result, anchorMs: built.body.asOf });
    } catch (err) {
      setDetectionError(describeApiError(err, 'Detection could not be run. No setup was created.'));
    } finally {
      setDetectionPending(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Deterministic anchor"
          subtitle="Shared by evaluation and detection — the same instant, read from the field, never the clock"
          actions={<Badge tone="neutral">{versionLabelText(version)}</Badge>}
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <AnchorField
            value={anchorValue}
            onChange={setAnchorValue}
            onUseNow={() => setAnchorValue(anchorInputValue(defaultAnchorMs(Date.now())))}
            disabled={evaluationPending || detectionPending}
            error={anchorError}
          />
          <p className="text-xs text-ink-500 sm:max-w-64">
            The anchor is sent with both requests. Re-running with the same anchor reproduces the same evaluation and the
            same setup instead of creating another one.
          </p>
        </div>
      </Card>

      <EvaluatePanel
        anchorError={anchorError}
        currentAnchorMs={anchorMs}
        resultAnchorMs={evaluation?.anchorMs ?? null}
        pending={evaluationPending}
        result={evaluation?.result ?? null}
        error={evaluationError}
        blockedReason={blockedReason}
        onEvaluate={() => void onEvaluate()}
      />

      <DetectPanel
        choices={choices}
        instrumentKeyValue={instrumentSelection}
        onInstrumentChange={setInstrumentSelection}
        direction={direction}
        onDirectionChange={setDirection}
        anchorError={anchorError}
        currentAnchorMs={anchorMs}
        resultAnchorMs={detection?.anchorMs ?? null}
        pending={detectionPending}
        result={detection?.result ?? null}
        error={detectionError}
        blockedReason={blockedReason}
        onDetect={() => void onDetect()}
      />

      <Card>
        <CardHeader title="Next steps" subtitle="The rest of the workflow runs on a setup, not on this page" />
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <LinkButton href="/setups" variant="secondary">
            Open setups
          </LinkButton>
          <LinkButton href="/alerts" variant="secondary">
            Alerts & acknowledgement
          </LinkButton>
          <p className="text-xs text-ink-500">
            A detected setup can be scored, transitioned through its lifecycle and turned into a stub-ledger alert from{' '}
            <Link href="/setups" className="underline underline-offset-2">
              Setups
            </Link>
            .
          </p>
        </div>
      </Card>
    </div>
  );
}

function versionLabelText(version: StrategyVersionDetailDto): string {
  return `v${version.versionNumber} · ${version.status}`;
}
