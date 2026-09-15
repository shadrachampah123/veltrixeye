'use client';

import * as React from 'react';
import type {
  CandidateLevels,
  DirectionEvaluation,
  EvaluationResultDto,
  GroupOutcome,
  InstrumentEvaluation,
  SessionFilterOutcome,
} from '@veltrixeye/contracts';
import { Alert, Badge, Card, CardHeader, Monospace } from '@/components/ui';
import { formatDateTime, formatPrice } from '@/lib/formats';
import {
  conditionStatusLabel,
  conditionStatusTone,
  directionSummaryText,
  evaluationSummaryText,
  instrumentOutcomeText,
  relevanceLabel,
  summariseDirection,
  timeframeRoleLabel,
} from '@/lib/workbench';

/**
 * M3 evaluation result (M7.1) — presentational, prop-driven.
 *
 * Only fields the API returns are rendered: the API's own statuses
 * (satisfied / unsatisfied / insufficient_data / unsupported), the groups and
 * their logic, session filtering, the candidate levels, the engine version and
 * the anchor. Nothing here computes a level, a score or a probability.
 */

function CandidateLevelsView({ candidate }: { candidate: CandidateLevels }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Entry', value: formatPrice(candidate.entryPrice) },
    { label: 'Stop loss', value: formatPrice(candidate.stopLossPrice) },
    { label: 'Risk distance', value: formatPrice(candidate.riskDistance) },
    { label: 'Take profit 1', value: formatPrice(candidate.tp1Price) },
    { label: 'Take profit 2', value: formatPrice(candidate.tp2Price) },
    { label: 'Take profit 3', value: formatPrice(candidate.tp3Price) },
    { label: 'Achievable risk:reward', value: candidate.achievableRr === null ? '—' : String(candidate.achievableRr) },
  ];
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3.5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">Candidate levels</span>
        <span className="text-xs text-ink-500">{candidate.basis}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-[11px] uppercase tracking-wider text-ink-400">{row.label}</dt>
            <dd className="font-mono text-[13px] text-ink-100">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function GroupView({ group }: { group: GroupOutcome }) {
  return (
    <div className="rounded-md border border-ink-700">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-750 px-3.5 py-2.5">
        <span className="text-sm font-medium text-ink-50">{group.name}</span>
        <Badge tone="neutral">{group.logic}</Badge>
        <Badge tone={group.satisfied ? 'success' : 'danger'}>{group.satisfied ? 'satisfied' : 'not satisfied'}</Badge>
        <span className="text-xs text-ink-500">{relevanceLabel(group.relevance)}</span>
      </div>
      <ul className="divide-y divide-ink-750">
        {group.conditions.map((condition, index) => (
          <li key={`${condition.conditionType}-${index}`} className="px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Monospace>{condition.conditionType.replace(/_/g, ' ')}</Monospace>
              <Badge tone={conditionStatusTone(condition.status)}>{conditionStatusLabel(condition.status)}</Badge>
              <span className="text-[11px] uppercase tracking-wider text-ink-500">
                {timeframeRoleLabel(condition.timeframeRole)}
              </span>
              <span className="text-[11px] uppercase tracking-wider text-ink-500">
                {condition.classification.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-300">{condition.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionFiltersView({ filters }: { filters: SessionFilterOutcome[] }) {
  if (filters.length === 0) return null;
  return (
    <div className="rounded-md border border-ink-700">
      <div className="border-b border-ink-750 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-ink-300">
        Session filtering
      </div>
      <ul className="divide-y divide-ink-750 text-xs">
        {filters.map((filter, index) => (
          <li key={`${filter.session}-${index}`} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
            <span className="capitalize text-ink-100">{filter.session.replace('_', ' ')}</span>
            <Badge tone="neutral">{filter.mode === 'include' ? 'included' : 'excluded'}</Badge>
            <span className="text-ink-500">{filter.timezone}</span>
            <Badge tone={conditionStatusTone(filter.status)}>{conditionStatusLabel(filter.status)}</Badge>
            <span className="text-ink-300">{filter.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DirectionView({ evaluation }: { evaluation: DirectionEvaluation }) {
  const summary = summariseDirection(evaluation);
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={evaluation.passed ? 'success' : 'danger'}>
          {evaluation.direction} {evaluation.passed ? 'passed' : 'failed'}
        </Badge>
        <span className="text-xs text-ink-400">{directionSummaryText(summary)}</span>
      </div>

      {evaluation.groups.length === 0 ? (
        <p className="text-xs text-ink-500">This direction has no rule groups, so nothing could pass.</p>
      ) : (
        evaluation.groups.map((group, index) => <GroupView key={`${group.name}-${index}`} group={group} />)
      )}

      <SessionFiltersView filters={evaluation.sessionFilters} />

      {evaluation.candidate === null ? (
        <p className="text-xs text-ink-500">
          No candidate levels were derived for this direction
          {evaluation.passed ? '.' : ' because the direction did not pass.'}
        </p>
      ) : (
        <CandidateLevelsView candidate={evaluation.candidate} />
      )}

      {evaluation.failureReasons.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-300">Why this direction failed</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-300">
            {evaluation.failureReasons.map((reason, index) => (
              <li key={`${reason}-${index}`}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function InstrumentView({ instrument }: { instrument: InstrumentEvaluation }) {
  const passed = instrument.directions.long.passed || instrument.directions.short.passed;
  return (
    <Card>
      <CardHeader
        title={`${instrument.symbol} · ${instrument.assetClass}`}
        subtitle={instrumentOutcomeText(instrument)}
        actions={<Badge tone={passed ? 'success' : 'neutral'}>{passed ? 'a direction passed' : 'no direction passed'}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <DirectionView evaluation={instrument.directions.long} />
        <div className="border-t border-ink-750" />
        <DirectionView evaluation={instrument.directions.short} />
      </div>
    </Card>
  );
}

export function EvaluationResultView({ result }: { result: EvaluationResultDto }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-400">
        <span className="flex items-center gap-2">
          Engine <Monospace>{result.engineVersion}</Monospace>
        </span>
        <span className="flex items-center gap-2">
          Version <Monospace>v{result.versionNumber}</Monospace>
        </span>
        <span className="flex items-center gap-2">
          Anchor <Monospace>{formatDateTime(result.evaluatedAt)}</Monospace>
          <Monospace>{result.asOfMs}</Monospace>
        </span>
        <span>{evaluationSummaryText(result)}</span>
      </div>

      {result.truncated && (
        <Alert tone="warning" role="status">
          The version’s market scope is larger than the {result.instruments.length}-instrument evaluation cap, so this run
          covered only the first instruments in (asset class, symbol) order. Narrow the scope to evaluate the rest.
        </Alert>
      )}

      {result.notes.length > 0 && (
        <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3.5 py-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-300">Engine notes</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-300">
            {result.notes.map((note, index) => (
              <li key={`${note}-${index}`}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {result.instruments.map((instrument) => (
        <InstrumentView key={`${instrument.assetClass}/${instrument.symbol}`} instrument={instrument} />
      ))}
    </div>
  );
}
