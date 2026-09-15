'use client';

import * as React from 'react';
import Link from 'next/link';
import type { SetupDto, SetupScoreDto, SetupState, SetupStateEventDto } from '@veltrixeye/contracts';
import { Alert, Badge, Button, Card, CardHeader, Monospace, TextArea } from '@/components/ui';
import { AnchorField } from '@/components/anchor-field';
import { GenerateAlertOutcomeBanner, SetupGenerateRow } from '@/components/generate-alert-panel';
import { StubDeliveryHint, StubDeliveryNotice } from '@/components/stub-delivery-notice';
import { gradeTone, type GenerateAlertOutcome } from '@/lib/alerts-view';
import { formatDateTime, formatPrice } from '@/lib/formats';
import {
  SCORE_AUTHORITY_NOTE,
  SETUP_LIST_NEVER_DETECTED,
  isTerminalSetupState,
  setupAnchorText,
  setupDetectorVersion,
  setupLevelRows,
  setupStateLabel,
  setupStateTone,
  terminalNote,
  transitionOptions,
} from '@/lib/workbench';

/**
 * Setup list + detail panels (M7.1) — presentational and prop-driven.
 *
 * Every value comes from the API: prices, anchors, states, grades, component
 * points and event history. The panels never compute a score, never guess
 * ownership (an id in the URL proves nothing — the API answers with a masked
 * 404), and never imply that generation delivered a notification: M6 writes a
 * local stub-ledger row only.
 */

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function SetupsNeverDetectedState() {
  return (
    <Card className="px-6 py-14 text-center">
      <p className="text-sm text-ink-300">No setups yet.</p>
      <p className="mt-1 text-xs text-ink-400">{SETUP_LIST_NEVER_DETECTED}</p>
      <Link href="/workbench" className="mt-4 inline-block text-xs text-signal-400 underline underline-offset-2">
        Open the strategy workbench
      </Link>
    </Card>
  );
}

export function SetupsTable({ setups, filtered = false }: { setups: readonly SetupDto[]; filtered?: boolean }) {
  if (setups.length === 0) {
    return (
      <Card className="px-6 py-14 text-center">
        <p className="text-sm text-ink-300">{filtered ? 'No setups match these filters.' : 'No setups yet.'}</p>
        <p className="mt-1 text-xs text-ink-400">
          {filtered ? 'Clear a filter to see more of your setups.' : SETUP_LIST_NEVER_DETECTED}
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={`Setups (${setups.length})`} subtitle="Newest detection anchor first — owner-scoped by the API" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <caption className="sr-only">Your detected setups with state, quality score and levels</caption>
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-5 py-2.5 font-medium">
                Instrument
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                Direction
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                State
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                Version
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium text-right">
                Score
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                Entry / stop
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                Detected
              </th>
              <th scope="col" className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-750">
            {setups.map((setup) => (
              <tr key={setup.id} className="transition-colors hover:bg-ink-750/50">
                <td className="px-5 py-3">
                  <Monospace>{setup.instrument.symbol}</Monospace>
                  <div className="text-xs capitalize text-ink-400">{setup.instrument.assetClass}</div>
                </td>
                <td className="px-5 py-3">
                  <Badge tone={setup.direction === 'long' ? 'success' : 'danger'}>{setup.direction}</Badge>
                </td>
                <td className="px-5 py-3">
                  <Badge tone={setupStateTone(setup.state)}>{setupStateLabel(setup.state)}</Badge>
                </td>
                <td className="px-5 py-3 font-mono text-xs text-ink-300">v{setup.versionNumber}</td>
                <td className="px-5 py-3 text-right font-mono text-xs text-ink-200">
                  {setup.qualityScore === null ? '—' : setup.qualityScore}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-ink-300">
                  {formatPrice(setup.entryPrice)} / {formatPrice(setup.stopLossPrice)}
                </td>
                <td className="px-5 py-3 text-xs text-ink-400">{formatDateTime(setup.detectedAt)}</td>
                <td className="px-5 py-3 text-right text-xs">
                  <Link
                    href={`/setups/${setup.id}`}
                    className="text-ink-300 underline underline-offset-2 hover:text-signal-400"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function SetupSummaryCard({ setup }: { setup: SetupDto }) {
  const detectorVersion = setupDetectorVersion(setup);
  const facts: Array<{ label: string; value: React.ReactNode; mono?: boolean }> = [
    { label: 'Instrument', value: `${setup.instrument.symbol} · ${setup.instrument.assetClass}` },
    { label: 'Direction', value: setup.direction },
    { label: 'State', value: setupStateLabel(setup.state) },
    { label: 'Strategy version', value: `v${setup.versionNumber}`, mono: true },
    { label: 'Setup id', value: setup.id, mono: true },
    { label: 'Anchor (asOfMs)', value: setupAnchorText(setup), mono: true },
    { label: 'Detected', value: formatDateTime(setup.detectedAt) },
    { label: 'Updated', value: formatDateTime(setup.updatedAt) },
    { label: 'Expires', value: setup.expiresAt === null ? 'no expiry recorded' : formatDateTime(setup.expiresAt) },
    { label: 'Quality score', value: setup.qualityScore === null ? 'not scored yet' : String(setup.qualityScore), mono: true },
    ...(detectorVersion ? [{ label: 'Detector version', value: detectorVersion, mono: true }] : []),
  ];
  return (
    <Card>
      <CardHeader
        title="Setup"
        subtitle="Persisted by M4 from one qualifying evaluation — the row is the API’s, not the UI’s"
        actions={<Badge tone={setupStateTone(setup.state)}>{setupStateLabel(setup.state)}</Badge>}
      />
      <dl className="grid gap-x-4 gap-y-3 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt className="text-[11px] uppercase tracking-wider text-ink-400">{fact.label}</dt>
            <dd className={fact.mono ? 'font-mono text-[13px] text-ink-100' : 'text-ink-100'}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function SetupLevelsCard({ setup }: { setup: SetupDto }) {
  return (
    <Card>
      <CardHeader title="Levels" subtitle="Exactly the levels M4 persisted — the UI rounds nothing" />
      <dl className="grid gap-x-4 gap-y-3 px-5 py-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {setupLevelRows(setup).map((row) => (
          <div key={row.label}>
            <dt className="text-[11px] uppercase tracking-wider text-ink-400">{row.label}</dt>
            <dd className="font-mono text-[13px] text-ink-100">{formatPrice(row.value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function SetupEventTimeline({ events }: { events: readonly SetupStateEventDto[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardHeader title="Lifecycle" subtitle="Every transition writes an append-only event" />
        <p className="px-5 py-6 text-sm text-ink-400">No lifecycle events recorded for this setup.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Lifecycle" subtitle={`${events.length} append-only event(s), oldest first`} />
      <ol className="divide-y divide-ink-750">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
            <Monospace>{event.fromState === null ? 'created' : setupStateLabel(event.fromState)}</Monospace>
            <span className="text-ink-500">→</span>
            <Badge tone={setupStateTone(event.toState)}>{setupStateLabel(event.toState)}</Badge>
            <span className="text-xs text-ink-400">{formatDateTime(event.createdAt)}</span>
            {event.reason && <span className="text-xs text-ink-300">“{event.reason}”</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export interface SetupScorePanelProps {
  setup: SetupDto;
  scores: readonly SetupScoreDto[] | null;
  scoresError: string | null;
  pending: boolean;
  error: string | null;
  notice: string | null;
  anchorValue: string;
  anchorError: string | null;
  onAnchorChange: (value: string) => void;
  onUseSetupAnchor: () => void;
  onUseNow: () => void;
  onScore: () => void;
}

export function SetupScorePanel(props: SetupScorePanelProps) {
  const { setup, scores, scoresError, pending, error, notice, anchorValue, anchorError, onAnchorChange, onUseSetupAnchor, onUseNow, onScore } = props;
  const latest = scores && scores.length > 0 ? scores[0] : null;
  const terminal = isTerminalSetupState(setup.state);

  return (
    <Card>
      <CardHeader
        title="Quality score"
        subtitle="M5 scoring — append-only per (setup, engine version, anchor)"
        actions={
          <Button onClick={onScore} disabled={pending || terminal}>
            {pending ? 'Scoring…' : 'Score setup'}
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        {terminal && (
          <Alert tone="info" role="status">
            {terminalNote(setup.state)} The API refuses to score terminal setups, so scoring is disabled here.
          </Alert>
        )}
        <AnchorField
          id="score-anchor"
          label="Scoring anchor"
          value={anchorValue}
          onChange={onAnchorChange}
          onUseNow={onUseNow}
          disabled={pending}
          error={anchorError}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={onUseSetupAnchor} disabled={pending}>
            Use the setup’s own detection anchor
          </Button>
          <span className="text-xs text-ink-500">
            Detection anchor: <span className="font-mono">{setupAnchorText(setup)}</span>
          </span>
        </div>

        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
        {notice && (
          <Alert tone="info" role="status">
            {notice}
          </Alert>
        )}

        {latest ? (
          <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg text-ink-50">{latest.total}</span>
              <Badge tone={gradeTone(latest.grade)}>{latest.grade}</Badge>
              <span className="text-xs text-ink-400">
                engine <Monospace>{latest.engineVersion}</Monospace>
              </span>
              <span className="text-xs text-ink-400">
                anchor <Monospace>{latest.asOfMs}</Monospace>
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-500">{SCORE_AUTHORITY_NOTE}</p>
            <ul className="mt-3 space-y-1.5">
              {latest.components.map((component) => (
                <li key={component.name} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-100">{component.label}</span>
                    <span className="font-mono text-ink-300">
                      {component.points} / {component.maxPoints} pts
                    </span>
                    <span className="text-ink-500">
                      component score {component.score} · weight {component.weight}
                    </span>
                  </div>
                  <p className="text-ink-400">{component.explanation}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-ink-400">
            This setup has no score at any anchor yet. Scoring rebuilds the evaluation context at the chosen anchor through
            the same M3 service and runs the M5 engine on it.
          </p>
        )}

        {scoresError && (
          <Alert tone="danger" role="alert">
            {scoresError}
          </Alert>
        )}

        {scores && scores.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <caption className="sr-only">Score history for this setup, newest anchor first</caption>
              <thead>
                <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="py-2 font-medium">
                    Anchor
                  </th>
                  <th scope="col" className="py-2 font-medium text-right">
                    Total
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Grade
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Engine
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Components
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-750">
                {scores.map((score) => (
                  <tr key={score.id}>
                    <td className="py-2 font-mono text-xs text-ink-300">
                      {formatDateTime(score.createdAt)}
                      <div className="text-ink-500">{score.asOfMs}</div>
                    </td>
                    <td className="py-2 text-right font-mono text-ink-100">{score.total}</td>
                    <td className="py-2">
                      <Badge tone={gradeTone(score.grade)}>{score.grade}</Badge>
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-400">{score.engineVersion}</td>
                    <td className="py-2 text-xs text-ink-400">
                      <details>
                        <summary className="cursor-pointer">{score.components.length} components</summary>
                        <ul className="mt-1 space-y-1">
                          {score.components.map((component) => (
                            <li key={`${score.id}-${component.name}`}>
                              {component.label}: <span className="font-mono">{component.points} / {component.maxPoints}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

export interface SetupTransitionPanelProps {
  setup: SetupDto;
  toState: SetupState | '';
  onToStateChange: (state: SetupState | '') => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  pending: boolean;
  error: string | null;
  notice: string | null;
  anchorValue: string;
  anchorError: string | null;
  onAnchorChange: (value: string) => void;
  onUseNow: () => void;
  onTransition: () => void;
}

export function SetupTransitionPanel(props: SetupTransitionPanelProps) {
  const {
    setup,
    toState,
    onToStateChange,
    reason,
    onReasonChange,
    pending,
    error,
    notice,
    anchorValue,
    anchorError,
    onAnchorChange,
    onUseNow,
    onTransition,
  } = props;
  const options = transitionOptions(setup.state);
  const terminal = options.length === 0;

  return (
    <Card>
      <CardHeader
        title="Lifecycle transition"
        subtitle="Only the transitions the M4 state machine allows from the current state"
        actions={
          <Button onClick={onTransition} disabled={pending || terminal || toState === '' || anchorError !== null}>
            {pending ? 'Requesting…' : 'Request transition'}
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        {terminal ? (
          <Alert tone="info" role="status">
            {terminalNote(setup.state)}
          </Alert>
        ) : (
          <p className="text-xs text-ink-400">
            Current state <span className="text-ink-200">{setupStateLabel(setup.state)}</span> allows:{' '}
            {options.map((state) => setupStateLabel(state)).join(', ')}. The API is the final authority — a rejected
            transition writes nothing.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-ink-300">
              Transition to
            </span>
            <select
              className="w-full appearance-none rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500/50 disabled:opacity-50"
              value={toState}
              disabled={pending || terminal}
              onChange={(e) => onToStateChange(e.target.value as SetupState | '')}
            >
              <option value="">{terminal ? 'No transitions available' : 'Choose a state…'}</option>
              {options.map((state) => (
                <option key={state} value={state}>
                  {setupStateLabel(state)}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-ink-500">
            A same-state repeat is an idempotent no-op on the API: no event is written and the setup does not move.
          </div>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-ink-300">
            Reason (optional, max 280 characters)
          </span>
          <TextArea
            rows={2}
            maxLength={280}
            value={reason}
            disabled={pending || terminal}
            placeholder="Why is this setup moving?"
            onChange={(e) => onReasonChange(e.target.value)}
          />
        </label>

        <AnchorField
          id="transition-anchor"
          label="Transition anchor"
          value={anchorValue}
          onChange={onAnchorChange}
          onUseNow={onUseNow}
          disabled={pending}
          error={anchorError}
        />

        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
        {notice && (
          <Alert tone="success" role="status">
            {notice}
          </Alert>
        )}
      </div>
    </Card>
  );
}

export interface SetupAlertPanelProps {
  setup: SetupDto;
  pending: boolean;
  error: string | null;
  outcome: GenerateAlertOutcome | null;
  onGenerate: () => void;
}

/**
 * Stub-ledger alert generation for one setup.
 *
 * Reuses the M6 building blocks verbatim: `SetupGenerateRow` owns the
 * eligibility rule and the button state, `GenerateAlertOutcomeBanner` owns the
 * created / replayed / skipped wording, and the stub notice states plainly that
 * nothing left the platform.
 */
export function SetupAlertPanel({ setup, pending, error, outcome, onGenerate }: SetupAlertPanelProps) {
  return (
    <Card>
      <CardHeader
        title="Alert"
        subtitle="Generated explicitly from this setup — no scheduler, no background scanner"
        actions={<StubDeliveryHint />}
      />
      <div className="space-y-3 px-5 py-4">
        <ul>
          <SetupGenerateRow setup={setup} pending={pending} onGenerate={() => onGenerate()} />
        </ul>
        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
        {outcome && <GenerateAlertOutcomeBanner outcome={outcome} />}
        <StubDeliveryNotice />
      </div>
    </Card>
  );
}
