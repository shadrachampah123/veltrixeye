'use client';

import * as React from 'react';
import Link from 'next/link';
import type { MarketInstrument, BacktestCreateResponseDto } from '@/lib/api';
import { api } from '@/lib/api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  Spinner,
} from '@/components/ui';
import {
  BACKTEST_RANGE_PRESETS,
  DIRECTION_OPTIONS,
  STOP_LOSS_OPTIONS,
  TAKE_PROFIT_OPTIONS,
  applyRangePreset,
  buildBacktestRequest,
  createBacktestFormState,
  type BacktestFormErrors,
  type BacktestFormState,
  type BacktestRangePresetId,
} from '@/lib/backtest-form';
import { describeApiError, fieldErrorsFromApiError } from '@/lib/api-errors';
import { BacktestRunSummary, BacktestMetricsGrid, BacktestNotesList, BacktestTradesTable } from '@/components/backtest-results';

/**
 * Backtest creation form (M6 Phase 4).
 *
 * `BacktestForm` is fully controlled and presentational so it can be rendered
 * in tests; `BacktestFormPanel` owns the data loading, submit state and the
 * result it just produced. The timeframes are **not** an input: the replay
 * uses the selected published version's `htf_bias` / `setup` / `entry`
 * timeframes, so the form displays them read-only instead of offering a
 * control the API would ignore.
 */

export interface BacktestStrategyOption {
  id: string;
  name: string;
  /** Only published versions are backtestable (the API rejects drafts). */
  publishedVersions: Array<{ id: string; versionNumber: number; isCurrent: boolean }>;
}

export interface BacktestVersionConfigView {
  timeframes: { htf_bias: string; setup: string; entry: string } | null;
  minQualityScore: number | null;
  minRr: number | null;
}

export interface BacktestFormProps {
  state: BacktestFormState;
  onChange: (patch: Partial<BacktestFormState>) => void;
  errors: BacktestFormErrors;
  submitting: boolean;
  onSubmit: () => void;
  strategies: readonly BacktestStrategyOption[];
  instruments: readonly MarketInstrument[];
  /** Config of the selected version (timeframes + risk), once loaded. */
  versionConfig: BacktestVersionConfigView | null;
  loadingOptions: boolean;
  optionsError: string | null;
  /** Safe, API-sourced message for a failed submit (never a stack trace). */
  submitError: string | null;
  onPreset: (presetId: BacktestRangePresetId) => void;
}

export function BacktestForm(props: BacktestFormProps) {
  const { state, onChange, errors, submitting, onSubmit, strategies, instruments, versionConfig } = props;

  const selected = strategies.find((s) => s.id === state.strategyId) ?? null;
  const versions = selected?.publishedVersions ?? [];
  const instrumentKey = state.assetClass && state.symbol ? `${state.assetClass}/${state.symbol}` : '';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
      aria-busy={submitting}
    >
      <div className="space-y-5">
        {props.optionsError && <Alert tone="danger">{props.optionsError}</Alert>}

        <Card>
          <CardHeader
            title="Replay inputs"
            subtitle="A backtest replays one published strategy version over stored candles"
          />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            <Field label="Strategy" error={errors.strategyVersion}>
              <Select
                value={state.strategyId}
                disabled={props.loadingOptions || submitting}
                aria-invalid={errors.strategyVersion ? true : undefined}
                onChange={(e) => {
                  const next = strategies.find((s) => s.id === e.target.value);
                  onChange({
                    strategyId: e.target.value,
                    versionId: next?.publishedVersions[0]?.id ?? '',
                  });
                }}
              >
                <option value="">Select a strategy…</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id} disabled={s.publishedVersions.length === 0}>
                    {s.name}
                    {s.publishedVersions.length === 0 ? ' (no published version)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Published version" hint="Drafts are mutable, so they cannot be backtested">
              <Select
                value={state.versionId}
                disabled={!selected || versions.length === 0 || submitting}
                onChange={(e) => onChange({ versionId: e.target.value })}
              >
                <option value="">{versions.length === 0 ? 'No published version' : 'Select a version…'}</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNumber}
                    {v.isCurrent ? ' · current' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Instrument" error={errors.instrument} hint="Instruments with stored market data">
              <Select
                value={instrumentKey}
                disabled={props.loadingOptions || submitting}
                aria-invalid={errors.instrument ? true : undefined}
                onChange={(e) => {
                  const [assetClass, ...rest] = e.target.value.split('/');
                  onChange({ assetClass: assetClass ?? '', symbol: rest.join('/') });
                }}
              >
                <option value="">Select an instrument…</option>
                {instruments.map((i) => (
                  <option key={`${i.assetClass}/${i.symbol}`} value={`${i.assetClass}/${i.symbol}`}>
                    {i.symbol} ({i.assetClass})
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Direction" hint="“Both” replays long and short, long first">
              <Select
                value={state.direction}
                disabled={submitting}
                onChange={(e) => onChange({ direction: e.target.value as BacktestFormState['direction'] })}
              >
                {DIRECTION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d === 'both' ? 'Long + short' : d === 'long' ? 'Long only' : 'Short only'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {versionConfig && (
            <div className="border-t border-ink-700 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                <span className="uppercase tracking-wider">Version timeframes</span>
                {versionConfig.timeframes ? (
                  <>
                    <Badge tone="neutral">{versionConfig.timeframes.htf_bias} bias</Badge>
                    <Badge tone="neutral">{versionConfig.timeframes.setup} setup</Badge>
                    <Badge tone="neutral">{versionConfig.timeframes.entry} entry</Badge>
                  </>
                ) : (
                  <span>not configured</span>
                )}
                {versionConfig.minRr !== null && <Badge tone="info">min R:R 1:{versionConfig.minRr}</Badge>}
                {versionConfig.minQualityScore !== null && (
                  <Badge tone="info">min score {versionConfig.minQualityScore}</Badge>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Range"
            subtitle="Epoch bounds in your local time, sent to the API as UTC epoch-ms (start inclusive, end exclusive)"
            actions={
              <div className="flex flex-wrap gap-1.5">
                {BACKTEST_RANGE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => props.onPreset(p.id)}
                    className="rounded-md border border-ink-600 px-2 py-1 text-[11px] text-ink-300 transition-colors hover:bg-ink-750 disabled:opacity-50"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            }
          />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            <Field label="From (inclusive)" error={errors.from}>
              <Input
                type="datetime-local"
                value={state.fromValue}
                disabled={submitting}
                aria-invalid={errors.from ? true : undefined}
                onChange={(e) => onChange({ fromValue: e.target.value })}
              />
            </Field>
            <Field label="To (exclusive)" error={errors.to} hint="Must not be in the future; max span 10 years">
              <Input
                type="datetime-local"
                value={state.toValue}
                disabled={submitting}
                aria-invalid={errors.to ? true : undefined}
                onChange={(e) => onChange({ toValue: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Exit policy"
            subtitle="Same-candle stop-first and signal-close entry are pinned by the engine and cannot vary"
          />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
            <Field label="Stop-loss">
              <Select
                value={state.stopLoss}
                disabled={submitting}
                onChange={(e) => onChange({ stopLoss: e.target.value as BacktestFormState['stopLoss'] })}
              >
                {STOP_LOSS_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o === 'level' ? 'Exit at the derived level' : 'None — hold through the stop'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Take-profit leg">
              <Select
                value={state.takeProfit}
                disabled={submitting}
                onChange={(e) => onChange({ takeProfit: e.target.value as BacktestFormState['takeProfit'] })}
              >
                {TAKE_PROFIT_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o === 'none' ? 'None — no target exit' : o.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Max hold (setup candles)" error={errors.maxHoldCandles} hint="1–5000 closed candles after the signal">
              <Input
                type="number"
                min={1}
                max={5000}
                step={1}
                inputMode="numeric"
                value={state.maxHoldCandles}
                disabled={submitting}
                aria-invalid={errors.maxHoldCandles ? true : undefined}
                onChange={(e) => onChange({ maxHoldCandles: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Costs and sizing"
            subtitle="Price units, applied adversely: fee and slippage on both sides, spread at entry"
          />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Fee per side" error={errors.feePerSide}>
              <Input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={state.feePerSide}
                disabled={submitting}
                aria-invalid={errors.feePerSide ? true : undefined}
                onChange={(e) => onChange({ feePerSide: e.target.value })}
              />
            </Field>
            <Field label="Slippage per side" error={errors.slippagePerSide}>
              <Input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={state.slippagePerSide}
                disabled={submitting}
                aria-invalid={errors.slippagePerSide ? true : undefined}
                onChange={(e) => onChange({ slippagePerSide: e.target.value })}
              />
            </Field>
            <Field label="Spread (entry only)" error={errors.spread}>
              <Input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={state.spread}
                disabled={submitting}
                aria-invalid={errors.spread ? true : undefined}
                onChange={(e) => onChange({ spread: e.target.value })}
              />
            </Field>
            <Field
              label="Risk per trade (optional)"
              error={errors.riskPerTrade}
              hint="Only converts R into currency; never changes entries, exits or R"
            >
              <Input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                placeholder="blank = R only"
                value={state.riskPerTrade}
                disabled={submitting}
                aria-invalid={errors.riskPerTrade ? true : undefined}
                onChange={(e) => onChange({ riskPerTrade: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {props.submitError && <Alert tone="danger" title="Backtest failed">{props.submitError}</Alert>}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Running backtest…' : 'Run backtest'}
          </Button>
          <Link href="/backtests" className="text-sm text-ink-300 hover:text-ink-100">
            Back to history
          </Link>
          <span className="text-xs text-ink-500">
            Reads stored candles only — a run never triggers a provider fetch, and identical inputs replay the same
            result.
          </span>
        </div>
      </div>
    </form>
  );
}

/** Container: loads selectable strategies/versions/instruments and submits. */
export function BacktestFormPanel() {
  const [strategies, setStrategies] = React.useState<BacktestStrategyOption[]>([]);
  const [instruments, setInstruments] = React.useState<MarketInstrument[]>([]);
  const [loadingOptions, setLoadingOptions] = React.useState(true);
  const [optionsError, setOptionsError] = React.useState<string | null>(null);
  const [versionConfigs, setVersionConfigs] = React.useState<Record<string, BacktestVersionConfigView>>({});
  const [state, setState] = React.useState<BacktestFormState>(() => createBacktestFormState(Date.now()));
  const [errors, setErrors] = React.useState<BacktestFormErrors>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BacktestCreateResponseDto | null>(null);

  const loadOptions = React.useCallback(async () => {
    setLoadingOptions(true);
    setOptionsError(null);
    try {
      const [strategyList, instrumentList] = await Promise.all([api.listStrategies(), api.listInstruments()]);
      const details = await Promise.all(
        strategyList.strategies.map((s) => api.getStrategy(s.id).then((r) => r.strategy)),
      );
      setStrategies(
        details.map((d) => ({
          id: d.id,
          name: d.name,
          publishedVersions: d.versions
            .filter((v) => v.status === 'published')
            .map((v) => ({ id: v.id, versionNumber: v.versionNumber, isCurrent: v.isCurrent }))
            .sort((a, b) => b.versionNumber - a.versionNumber),
        })),
      );
      setInstruments(instrumentList.instruments);
    } catch (err) {
      setOptionsError(
        describeApiError(
          err,
          'Could not load your strategies or the instrument list. Reload the page to try again.',
        ),
      );
    } finally {
      setLoadingOptions(false);
    }
  }, []);

  React.useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const patch = React.useCallback((next: Partial<BacktestFormState>) => {
    setState((prev) => ({ ...prev, ...next }));
    setErrors({});
  }, []);

  // Fetch the selected version's config so the timeframes/risk shown are the
  // real ones from the API (never inferred from the version number).
  const versionKey = `${state.strategyId}:${state.versionId}`;
  React.useEffect(() => {
    if (!state.strategyId || !state.versionId || versionConfigs[versionKey]) return;
    let cancelled = false;
    api
      .getVersion(state.strategyId, state.versionId)
      .then(({ version }) => {
        if (cancelled) return;
        setVersionConfigs((prev) => ({
          ...prev,
          [versionKey]: {
            timeframes: version.config.timeframes ?? null,
            minQualityScore: version.config.risk?.minQualityScore ?? null,
            minRr: version.config.risk?.minRr ?? null,
          },
        }));
      })
      .catch(() => {
        /* the form still submits; the server is authoritative */
      });
    return () => {
      cancelled = true;
    };
  }, [state.strategyId, state.versionId, versionKey, versionConfigs]);

  const onSubmit = async () => {
    const nowMs = Date.now();
    const built = buildBacktestRequest(state, nowMs);
    if (!built.ok) {
      setErrors(built.errors);
      setSubmitError(null);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const res = await api.createBacktest(built.body);
      setResult(res);
    } catch (err) {
      // A 400 from the API carries per-field messages: show them on the fields.
      const fieldErrors = fieldErrorsFromApiError(err);
      setErrors(fieldErrors as BacktestFormErrors);
      setSubmitError(
        describeApiError(
          err,
          'The backtest could not be run. Nothing was saved for this attempt.',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingOptions && strategies.length === 0 && instruments.length === 0) {
    return <Spinner />;
  }

  return (
    <div className="space-y-5">
      <BacktestForm
        state={state}
        onChange={patch}
        errors={errors}
        submitting={submitting}
        onSubmit={() => void onSubmit()}
        strategies={strategies}
        instruments={instruments}
        versionConfig={versionConfigs[versionKey] ?? null}
        loadingOptions={loadingOptions}
        optionsError={optionsError}
        submitError={submitError}
        onPreset={(presetId) => patch(applyRangePreset(state, presetId, Date.now()))}
      />

      {submitting && (
        <Card>
          <CardHeader title="Running replay" subtitle="Evaluating each setup close in the selected range" />
          <Spinner />
        </Card>
      )}

      {result && (
        <div className="space-y-5">
          <Alert tone={result.created ? 'success' : 'info'} title={result.created ? 'Backtest completed' : 'Identical run replayed'}>
            {result.created
              ? 'A new run was recorded with these exact inputs.'
              : 'This exact configuration was already backtested, so the stored deterministic result was returned — nothing new was created.'}{' '}
            <Link href={`/backtests/${result.run.id}`} className="underline">
              Open the saved run
            </Link>
          </Alert>
          <BacktestRunSummary run={result.run} created={result.created} />
          <BacktestMetricsGrid
            metrics={result.run.metrics}
            showsCurrency={result.run.costPolicy.riskPerTrade !== undefined}
          />
          <BacktestNotesList notes={result.run.notes} />
          <BacktestTradesTable trades={result.trades} truncated={result.truncated} />
        </div>
      )}
    </div>
  );
}

