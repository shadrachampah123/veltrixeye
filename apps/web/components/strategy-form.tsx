'use client';

import * as React from 'react';
import {
  strategyCreateSchema,
  strategyVersionUpdateSchema,
  riskConfigurationSchema,
  type StrategyVersionConfig,
  type StrategyVersionDetailDto,
  type StrategyDetailDto,
  type NormalizedInstrument,
  type ConditionTimeframeRole,
  type StrategyRuleGroup,
  type StrategyFilter,
  type SessionFilter,
} from '@veltrixeye/contracts';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, TextArea } from '@/components/ui';
import { descriptorsFor, defaultParamsFor, type ParamDescriptor } from '@/lib/condition-params';

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface ConditionState {
  key: string;
  conditionType: string;
  classification: 'required' | 'optional' | 'confirmation' | 'disqualifying';
  timeframeRole: ConditionTimeframeRole;
  params: Record<string, unknown>;
  description: string;
}

interface GroupState {
  key: string;
  name: string;
  logic: 'AND' | 'OR';
  conditions: ConditionState[];
}

interface FilterState {
  key: string;
  type: 'news' | 'volatility' | 'spread';
  enabled: boolean;
  params: Record<string, unknown>;
}

interface SessionState {
  key: string;
  session: 'asia' | 'london' | 'new_york' | 'sydney';
  mode: 'include' | 'exclude';
  timezone: 'utc' | 'exchange';
}

interface RiskState {
  minRr: string;
  stopLossMethod: 'structure' | 'fixed' | 'atr';
  stopLossBuffer: string;
  stopLossBufferUnit: 'pips' | 'pct';
  takeProfitMethod: 'rr' | 'structure' | 'manual';
  tp1Rr: string;
  tp2Rr: string;
  tp3Rr: string;
  minQualityScore: string;
}

interface Meta {
  timeframes: string[];
  assetClasses: { value: string; label: string }[];
  conditionTypes: { type: string; label: string; description: string; defaultTimeframeRole: string }[];
  risk: {
    defaultMinRr: number;
    defaultMinQualityScore: number;
    stopLossMethods: { value: string; label: string }[];
    takeProfitMethods: { value: string; label: string }[];
  };
}

let keyCounter = 0;
const newKey = () => `k${++keyCounter}_${Date.now().toString(36)}`;

interface Props {
  mode: 'create' | 'edit';
  strategyId?: string;
  strategy?: StrategyDetailDto | null;
  initialVersion?: StrategyVersionDetailDto | null;
  onDone: () => void;
}

export function StrategyForm({ mode, strategyId, strategy, initialVersion, onDone }: Props) {
  const [meta, setMeta] = React.useState<Meta | null>(null);
  const [instruments, setInstruments] = React.useState<NormalizedInstrument[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // form state
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [htfBias, setHtfBias] = React.useState('1d');
  const [setupTf, setSetupTf] = React.useState('1h');
  const [entryTf, setEntryTf] = React.useState('15m');
  const [scopeMode, setScopeMode] = React.useState<'all' | 'instruments'>('all');
  const [selectedInstruments, setSelectedInstruments] = React.useState<string[]>([]);
  const [sessionFilters, setSessionFilters] = React.useState<SessionState[]>([]);
  const [risk, setRisk] = React.useState<RiskState>({
    minRr: '2',
    stopLossMethod: 'structure',
    stopLossBuffer: '1',
    stopLossBufferUnit: 'pips',
    takeProfitMethod: 'rr',
    tp1Rr: '1',
    tp2Rr: '2',
    tp3Rr: '3',
    minQualityScore: '65',
  });
  const [filters, setFilters] = React.useState<FilterState[]>([]);
  const [groups, setGroups] = React.useState<GroupState[]>([]);

  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  // load meta + instruments
  React.useEffect(() => {
    Promise.all([
      fetch('/api/strategies/meta', { credentials: 'same-origin' }).then((r) => r.json()),
      fetch('/api/markets/instruments', { credentials: 'same-origin' }).then((r) => r.json()),
    ])
      .then(([m, i]) => {
        setMeta(m as Meta);
        setInstruments((i as { instruments: NormalizedInstrument[] }).instruments);
      })
      .catch(() => setLoadError('Failed to load strategy vocabulary.'));
  }, []);

  // populate from existing strategy + draft
  React.useEffect(() => {
    if (mode !== 'edit' || !initialVersion || !strategy) return;
    setName(strategy.name);
    setDescription(strategy.description ?? '');
    const c = initialVersion.config;
    if (c.timeframes) {
      setHtfBias(c.timeframes.htf_bias);
      setSetupTf(c.timeframes.setup);
      setEntryTf(c.timeframes.entry);
    }
    if (c.marketScope) {
      setScopeMode(c.marketScope.mode);
      if (c.marketScope.instruments) {
        setSelectedInstruments(c.marketScope.instruments.map((i) => `${i.assetClass}:${i.symbol}`));
      }
    }
    if (c.sessionFilters?.length) {
      setSessionFilters(c.sessionFilters.map((s: SessionFilter) => ({ key: newKey(), ...s })));
    }
    if (c.risk) {
      setRisk({
        minRr: String(c.risk.minRr),
        stopLossMethod: c.risk.stopLossMethod,
        stopLossBuffer: String(c.risk.stopLossBuffer),
        stopLossBufferUnit: c.risk.stopLossBufferUnit,
        takeProfitMethod: c.risk.takeProfitMethod,
        tp1Rr: String(c.risk.tp1Rr),
        tp2Rr: String(c.risk.tp2Rr),
        tp3Rr: String(c.risk.tp3Rr),
        minQualityScore: String(c.risk.minQualityScore),
      });
    }
    if (c.filters?.length) {
      setFilters(c.filters.map((f: StrategyFilter) => ({ key: newKey(), ...f })));
    }
    if (c.ruleGroups?.length) {
      setGroups(
        c.ruleGroups.map((g: StrategyRuleGroup) => ({
          key: newKey(),
          name: g.name,
          logic: g.logic,
          conditions: g.conditions.map((cd) => ({
            key: newKey(),
            conditionType: cd.conditionType,
            classification: cd.classification,
            timeframeRole: cd.timeframeRole,
            params: cd.params ?? {},
            description: cd.description ?? '',
          })),
        })),
      );
    }
  }, [mode, initialVersion, strategy]);

  // ------------------------------------------------------------------
  // Build config payload
  // ------------------------------------------------------------------

  const buildConfig = (): StrategyVersionConfig => {
    const config: StrategyVersionConfig = {
      timeframes: { htf_bias: htfBias, setup: setupTf, entry: entryTf } as StrategyVersionConfig['timeframes'],
      sessionFilters: sessionFilters.map(({ key: _k, ...s }) => s),
      filters: filters.map(({ key: _k, ...f }) => f),
      ruleGroups: groups.map((g, gi) => ({
        name: g.name || `Stage ${gi + 1}`,
        logic: g.logic,
        position: gi,
        conditions: g.conditions.map((cd, ci) => ({
          conditionType: cd.conditionType,
          classification: cd.classification,
          timeframeRole: cd.timeframeRole,
          params: cd.params,
          description: cd.description || undefined,
          position: ci,
        })),
      })),
    };
    config.marketScope =
      scopeMode === 'all'
        ? { mode: 'all' }
        : {
            mode: 'instruments',
            instruments: instruments
              .filter((i) => selectedInstruments.includes(`${i.assetClass}:${i.symbol}`))
              .map((i) => ({ assetClass: i.assetClass, symbol: i.symbol, displayName: i.displayName })),
          };
    config.risk = parseRisk(risk);
    return config;
  };

  const parseRisk = (r: RiskState) => {
    const num = (s: string, fallback: number) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      minRr: num(r.minRr, 2),
      stopLossMethod: r.stopLossMethod,
      stopLossBuffer: num(r.stopLossBuffer, 1),
      stopLossBufferUnit: r.stopLossBufferUnit,
      takeProfitMethod: r.takeProfitMethod,
      tp1Rr: num(r.tp1Rr, 1),
      tp2Rr: num(r.tp2Rr, 2),
      tp3Rr: num(r.tp3Rr, 3),
      minQualityScore: Math.round(num(r.minQualityScore, 65)),
    };
  };

  const submit = async () => {
    setError(null);
    setFieldErrors({});

    // Pre-flight: validate the config locally against the shared schemas.
    const config = buildConfig();
    if (scopeMode === 'instruments' && config.marketScope?.instruments && config.marketScope.instruments.length === 0) {
      setFieldErrors({ instruments: 'Select at least one instrument' });
      return;
    }
    const riskCheck = riskConfigurationSchema.safeParse(config.risk);
    if (!riskCheck.success) {
      setFieldErrors({ risk: riskCheck.error.issues.map((i) => i.message).join('; ') });
      return;
    }

    setBusy(true);
    try {
      if (mode === 'create' || !strategyId || !initialVersion) {
        const createCheck = strategyCreateSchema.safeParse({
          name,
          description: description || undefined,
          version: config,
        });
        if (!createCheck.success) throw new ApiError(400, 'invalid_input', 'Invalid input', flattenIssues(createCheck.error));
        await api.createStrategy(createCheck.data);
      } else {
        const updateCheck = strategyVersionUpdateSchema.safeParse({ config });
        if (!updateCheck.success) throw new ApiError(400, 'invalid_input', 'Invalid input', flattenIssues(updateCheck.error));
        // Update the parent metadata and the draft config.
        if (strategyId) {
          await api.updateStrategy(strategyId, {
            name,
            description: description || undefined,
          });
        }
        await api.updateVersion(strategyId, initialVersion.id, updateCheck.data);
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) {
          setFieldErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v[0] ?? ''])));
          setError('Please fix the highlighted fields.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  if (loadError || (!meta && !error)) {
    return loadError ? (
      <Alert tone="danger">{loadError}</Alert>
    ) : (
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-signal-500" />
      </div>
    );
  }
  const m = meta!;

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}

      {/* Basics */}
      <Card>
        <CardHeader title="Basics" subtitle="What this strategy is" />
        <div className="grid gap-4 px-5 py-4">
          <Field label="Strategy name" error={fieldErrors.name}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Liquidity Sweep Reversal"
              minLength={2}
              maxLength={80}
              required
            />
          </Field>
          <Field label="Description" hint="Optional">
            <TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this strategy looks for, where, and why"
              maxLength={500}
              rows={2}
            />
          </Field>
        </div>
      </Card>

      {/* Timeframes */}
      <Card>
        <CardHeader
          title="Timeframes"
          subtitle="Independent per role — pick any combination"
        />
        <div className="grid grid-cols-3 gap-4 px-5 py-4">
          <Field label="Higher-timeframe bias">
            <Select value={htfBias} onChange={(e) => setHtfBias(e.target.value)}>
              {m.timeframes.map((tf) => (
                <option key={tf} value={tf}>
                  {tf.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Setup timeframe">
            <Select value={setupTf} onChange={(e) => setSetupTf(e.target.value)}>
              {m.timeframes.map((tf) => (
                <option key={tf} value={tf}>
                  {tf.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Entry timeframe">
            <Select value={entryTf} onChange={(e) => setEntryTf(e.target.value)}>
              {m.timeframes.map((tf) => (
                <option key={tf} value={tf}>
                  {tf.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {/* Market scope */}
      <Card>
        <CardHeader title="Market scope" subtitle="Which instruments this strategy scans" />
        <div className="space-y-4 px-5 py-4">
          <div className="flex gap-4">
            {(
              [
                ['all', 'All instruments'],
                ['instruments', 'Specific instruments'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
                <input
                  type="radio"
                  name="scopeMode"
                  checked={scopeMode === value}
                  onChange={() => setScopeMode(value)}
                  className="accent-signal-500"
                />
                {label}
              </label>
            ))}
          </div>
          {scopeMode === 'instruments' && (
            <div>
              {fieldErrors.instruments && (
                <p className="mb-2 text-xs text-danger-450">{fieldErrors.instruments}</p>
              )}
              <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
                {instruments.map((i) => {
                  const id = `${i.assetClass}:${i.symbol}`;
                  const checked = selectedInstruments.includes(id);
                  return (
                    <label
                      key={id}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                        checked ? 'border-signal-500/50 bg-signal-500/10' : 'border-ink-600 bg-ink-850 hover:border-ink-400'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedInstruments((prev) =>
                            checked ? prev.filter((x) => x !== id) : [...prev, id],
                          )
                        }
                        className="accent-signal-500"
                      />
                      <span className="font-mono text-xs">{i.symbol}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-400">{i.assetClass}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Session filters */}
      <Card>
        <CardHeader title="Session filters" subtitle="Restrict or avoid specific trading sessions" />
        <div className="space-y-2 px-5 py-4">
          {sessionFilters.length === 0 && (
            <p className="text-sm text-ink-400">No session filters — the strategy is not restricted by session.</p>
          )}
          {sessionFilters.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <Select
                value={s.session}
                onChange={(e) =>
                  setSessionFilters((prev) =>
                    prev.map((x) => (x.key === s.key ? { ...x, session: e.target.value as SessionState['session'] } : x)),
                  )
                }
                className="max-w-40"
              >
                {['asia', 'london', 'new_york', 'sydney'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
              <Select
                value={s.mode}
                onChange={(e) =>
                  setSessionFilters((prev) =>
                    prev.map((x) => (x.key === s.key ? { ...x, mode: e.target.value as SessionState['mode'] } : x)),
                  )
                }
                className="max-w-32"
              >
                <option value="include">include</option>
                <option value="exclude">exclude</option>
              </Select>
              <Select
                value={s.timezone}
                onChange={(e) =>
                  setSessionFilters((prev) =>
                    prev.map((x) => (x.key === s.key ? { ...x, timezone: e.target.value as SessionState['timezone'] } : x)),
                  )
                }
                className="max-w-36"
              >
                <option value="exchange">exchange tz</option>
                <option value="utc">UTC</option>
              </Select>
              <Button
                variant="ghost"
                onClick={() => setSessionFilters((prev) => prev.filter((x) => x.key !== s.key))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setSessionFilters((prev) =>
                prev.length >= 16
                  ? prev
                  : [...prev, { key: newKey(), session: 'london', mode: 'include', timezone: 'exchange' }],
              )
            }
          >
            + Add session filter
          </Button>
        </div>
      </Card>

      {/* Risk */}
      <Card>
        <CardHeader title="Risk configuration" subtitle="Stop-loss, take-profit and quality threshold" />
        <div className="space-y-4 px-5 py-4">
          {fieldErrors.risk && <Alert tone="danger">{fieldErrors.risk}</Alert>}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Minimum R:R" hint="e.g. 2 = 1:2">
              <Input type="number" step="0.1" min="0" value={risk.minRr} onChange={(e) => setRisk({ ...risk, minRr: e.target.value })} />
            </Field>
            <Field label="Stop-loss method">
              <Select value={risk.stopLossMethod} onChange={(e) => setRisk({ ...risk, stopLossMethod: e.target.value as RiskState['stopLossMethod'] })}>
                {m.risk.stopLossMethods.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stop-loss buffer">
              <div className="flex gap-2">
                <Input type="number" step="0.5" min="0" value={risk.stopLossBuffer} onChange={(e) => setRisk({ ...risk, stopLossBuffer: e.target.value })} />
                <Select
                  value={risk.stopLossBufferUnit}
                  onChange={(e) => setRisk({ ...risk, stopLossBufferUnit: e.target.value as RiskState['stopLossBufferUnit'] })}
                  className="max-w-24"
                >
                  <option value="pips">pips</option>
                  <option value="pct">%</option>
                </Select>
              </div>
            </Field>
            <Field label="Take-profit method">
              <Select value={risk.takeProfitMethod} onChange={(e) => setRisk({ ...risk, takeProfitMethod: e.target.value as RiskState['takeProfitMethod'] })}>
                {m.risk.takeProfitMethods.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {risk.takeProfitMethod === 'rr' && (
            <div className="grid grid-cols-3 gap-4">
              <Field label="TP1 (R:R)">
                <Input type="number" step="0.1" min="0" value={risk.tp1Rr} onChange={(e) => setRisk({ ...risk, tp1Rr: e.target.value })} />
              </Field>
              <Field label="TP2 (R:R)">
                <Input type="number" step="0.1" min="0" value={risk.tp2Rr} onChange={(e) => setRisk({ ...risk, tp2Rr: e.target.value })} />
              </Field>
              <Field label="TP3 (R:R)">
                <Input type="number" step="0.1" min="0" value={risk.tp3Rr} onChange={(e) => setRisk({ ...risk, tp3Rr: e.target.value })} />
              </Field>
            </div>
          )}
          <Field label="Minimum quality score (0–100)" hint="Setups scoring below this are not alerted">
            <Input
              type="number"
              step="1"
              min="0"
              max="100"
              value={risk.minQualityScore}
              onChange={(e) => setRisk({ ...risk, minQualityScore: e.target.value })}
              className="max-w-32"
            />
          </Field>
        </div>
      </Card>

      {/* Strategy-level filters */}
      <Card>
        <CardHeader title="Filters" subtitle="Global guards applied to every setup" />
        <div className="space-y-2 px-5 py-4">
          {filters.length === 0 && (
            <p className="text-sm text-ink-400">No global filters (news, volatility, spread).</p>
          )}
          {filters.map((f) => (
            <div key={f.key} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2">
              <Badge tone="info">{f.type}</Badge>
              <label className="flex items-center gap-1.5 text-xs text-ink-300">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={() => setFilters((prev) => prev.map((x) => (x.key === f.key ? { ...x, enabled: !x.enabled } : x)))}
                  className="accent-signal-500"
                />
                enabled
              </label>
              <FilterParamsEditor type={f.type} params={f.params} onChange={(params) => setFilters((prev) => prev.map((x) => (x.key === f.key ? { ...x, params } : x)))} />
              <Button variant="ghost" onClick={() => setFilters((prev) => prev.filter((x) => x.key !== f.key))}>
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setFilters((prev) =>
                prev.some((x) => x.type === 'news') ? prev : [...prev, { key: newKey(), type: 'news', enabled: true, params: { maxImportance: 'high', beforeMinutes: 30, afterMinutes: 30 } }],
              )
            }
            disabled={filters.some((x) => x.type === 'news')}
          >
            + Add news filter
          </Button>{' '}
          <Button
            variant="secondary"
            onClick={() =>
              setFilters((prev) =>
                prev.some((x) => x.type === 'volatility') ? prev : [...prev, { key: newKey(), type: 'volatility', enabled: true, params: { metric: 'atr', period: 14, min: 0 } }],
              )
            }
            disabled={filters.some((x) => x.type === 'volatility')}
          >
            + Add volatility filter
          </Button>{' '}
          <Button
            variant="secondary"
            onClick={() =>
              setFilters((prev) =>
                prev.some((x) => x.type === 'spread') ? prev : [...prev, { key: newKey(), type: 'spread', enabled: true, params: { max: 2, unit: 'pips' } }],
              )
            }
            disabled={filters.some((x) => x.type === 'spread')}
          >
            + Add spread filter
          </Button>
        </div>
      </Card>

      {/* Rule groups + conditions */}
      <Card>
        <CardHeader
          title="Rules & conditions"
          subtitle="Stages are combined with AND; conditions within a stage use the stage logic. Publish requires at least one required/confirmation condition."
        />
        <div className="space-y-4 px-5 py-4">
          {groups.length === 0 && (
            <p className="text-sm text-ink-400">No rule stages yet. Add your first stage (e.g. “HTF Bias”, “Structure”, “Entry”).</p>
          )}
          {groups.map((g, gi) => (
            <div key={g.key} className="rounded-md border border-ink-600 bg-ink-850 p-3">
              <div className="mb-3 flex items-center gap-2">
                <Input
                  value={g.name}
                  onChange={(e) => setGroups((prev) => prev.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)))}
                  placeholder={`Stage ${gi + 1}`}
                  className="max-w-60"
                  maxLength={80}
                />
                <Select
                  value={g.logic}
                  onChange={(e) => setGroups((prev) => prev.map((x) => (x.key === g.key ? { ...x, logic: e.target.value as 'AND' | 'OR' } : x)))}
                  className="max-w-32"
                >
                  <option value="AND">all (AND)</option>
                  <option value="OR">any (OR)</option>
                </Select>
                <span className="ml-auto" />
                <Button variant="ghost" onClick={() => setGroups((prev) => prev.filter((x) => x.key !== g.key))}>
                  Remove stage
                </Button>
              </div>

              <div className="space-y-2">
                {g.conditions.map((cd) => (
                  <ConditionRow
                    key={cd.key}
                    condition={cd}
                    conditionTypes={m.conditionTypes}
                    onChange={(next) =>
                      setGroups((prev) =>
                        prev.map((x) => (x.key === g.key ? { ...x, conditions: x.conditions.map((y) => (y.key === cd.key ? next : y)) } : x)),
                      )
                    }
                    onRemove={() =>
                      setGroups((prev) =>
                        prev.map((x) => (x.key === g.key ? { ...x, conditions: x.conditions.filter((y) => y.key !== cd.key) } : x)),
                      )
                    }
                  />
                ))}
                <Button
                  variant="secondary"
                  onClick={() => {
                    const type = m.conditionTypes[0]?.type ?? 'bos';
                    setGroups((prev) =>
                      prev.map((x) =>
                        x.key === g.key
                          ? {
                              ...x,
                              conditions: [
                                ...x.conditions,
                                {
                                  key: newKey(),
                                  conditionType: type,
                                  classification: 'required',
                                  timeframeRole: (m.conditionTypes.find((t) => t.type === type)?.defaultTimeframeRole ?? 'setup') as ConditionTimeframeRole,
                                  params: defaultParamsFor(type),
                                  description: '',
                                },
                              ],
                            }
                          : x,
                      ),
                    );
                  }}
                >
                  + Add condition
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setGroups((prev) =>
                prev.length >= 50
                  ? prev
                  : [...prev, { key: newKey(), name: `Stage ${prev.length + 1}`, logic: 'AND', conditions: [] }],
              )
            }
          >
            + Add rule stage
          </Button>
        </div>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create strategy' : 'Save draft'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Condition row
// ---------------------------------------------------------------------------

function ConditionRow({
  condition,
  conditionTypes,
  onChange,
  onRemove,
}: {
  condition: ConditionState;
  conditionTypes: Meta['conditionTypes'];
  onChange: (next: ConditionState) => void;
  onRemove: () => void;
}) {
  const def = conditionTypes.find((t) => t.type === condition.conditionType);
  return (
    <div className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={condition.conditionType}
          onChange={(e) => {
            const type = e.target.value;
            const nextDef = conditionTypes.find((t) => t.type === type);
            onChange({
              ...condition,
              conditionType: type,
              timeframeRole: (nextDef?.defaultTimeframeRole ?? condition.timeframeRole) as ConditionTimeframeRole,
              params: defaultParamsFor(type),
            });
          }}
          className="max-w-56"
        >
          {conditionTypes.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Select>
        <Select
          value={condition.classification}
          onChange={(e) => onChange({ ...condition, classification: e.target.value as ConditionState['classification'] })}
          className="max-w-40"
        >
          <option value="required">required</option>
          <option value="optional">optional</option>
          <option value="confirmation">confirmation</option>
          <option value="disqualifying">disqualifying</option>
        </Select>
        <Select
          value={condition.timeframeRole}
          onChange={(e) => onChange({ ...condition, timeframeRole: e.target.value as ConditionTimeframeRole })}
          className="max-w-44"
        >
          <option value="htf_bias">HTF bias</option>
          <option value="setup">Setup TF</option>
          <option value="entry">Entry TF</option>
          <option value="any">Any / time-independent</option>
        </Select>
        <Button variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {def && (
        <p className="mt-1.5 text-xs text-ink-400">{def.description}</p>
      )}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {descriptorsFor(condition.conditionType).map((d) => (
          <ConditionParamInput
            key={d.key}
            descriptor={d}
            value={condition.params[d.key]}
            onChange={(v) => onChange({ ...condition, params: { ...condition.params, [d.key]: v } })}
          />
        ))}
        <div className="min-w-52 flex-1">
          <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-ink-400">Note (optional)</span>
          <Input
            value={condition.description}
            onChange={(e) => onChange({ ...condition, description: e.target.value })}
            placeholder="e.g. only on London open"
            maxLength={280}
          />
        </div>
      </div>
    </div>
  );
}

function ConditionParamInput({
  descriptor,
  value,
  onChange,
}: {
  descriptor: ParamDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="w-36">
      <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-ink-400">{descriptor.label}</span>
      {descriptor.kind === 'select' ? (
        <Select value={String(value ?? descriptor.default ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(descriptor.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : descriptor.kind === 'boolean' ? (
        <label className="flex items-center gap-2 py-2 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={Boolean(value ?? descriptor.default ?? false)}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-signal-500"
          />
          yes
        </label>
      ) : descriptor.kind === 'sessions' ? (
        <div className="flex flex-col gap-1">
          {(descriptor.options ?? []).map((o) => {
            const current = Array.isArray(value) ? value : [];
            const checked = current.includes(o);
            return (
              <label key={o} className="flex items-center gap-1.5 text-xs text-ink-200">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked ? current.filter((x: string) => x !== o) : [...current, o];
                    onChange(next);
                  }}
                  className="accent-signal-500"
                />
                {o}
              </label>
            );
          })}
        </div>
      ) : (
        <Input
          type="number"
          step={descriptor.step ?? 1}
          min={descriptor.min}
          max={descriptor.max}
          value={value === undefined || value === null ? String(descriptor.default ?? '') : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(undefined);
              return;
            }
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : raw);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strategy-level filter params
// ---------------------------------------------------------------------------

function FilterParamsEditor({
  type,
  params,
  onChange,
}: {
  type: 'news' | 'volatility' | 'spread';
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const set = (key: string, v: unknown) => onChange({ ...params, [key]: v });
  if (type === 'news') {
    return (
      <>
        <Select value={String(params.maxImportance ?? 'high')} onChange={(e) => set('maxImportance', e.target.value)} className="max-w-32">
          <option value="low">≤ low</option>
          <option value="medium">≤ medium</option>
          <option value="high">all</option>
        </Select>
        <div className="w-24">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">Before (min)</span>
          <Input type="number" value={String(params.beforeMinutes ?? 30)} onChange={(e) => set('beforeMinutes', Number(e.target.value) || 0)} />
        </div>
        <div className="w-24">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">After (min)</span>
          <Input type="number" value={String(params.afterMinutes ?? 30)} onChange={(e) => set('afterMinutes', Number(e.target.value) || 0)} />
        </div>
      </>
    );
  }
  if (type === 'volatility') {
    return (
      <>
        <Select value={String(params.metric ?? 'atr')} onChange={(e) => set('metric', e.target.value)} className="max-w-32">
          <option value="atr">ATR</option>
          <option value="body_range">Body range</option>
        </Select>
        <div className="w-20">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">Period</span>
          <Input type="number" value={String(params.period ?? 14)} onChange={(e) => set('period', Number(e.target.value) || 14)} />
        </div>
        <div className="w-20">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">Min</span>
          <Input type="number" step="0.1" value={String(params.min ?? 0)} onChange={(e) => set('min', Number(e.target.value) || 0)} />
        </div>
        <div className="w-20">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">Max</span>
          <Input type="number" step="0.1" value={String(params.max ?? '')} onChange={(e) => set('max', e.target.value === '' ? undefined : Number(e.target.value))} />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="w-24">
        <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-400">Max spread</span>
        <Input type="number" step="0.1" value={String(params.max ?? 2)} onChange={(e) => set('max', Number(e.target.value) || 0)} />
      </div>
      <Select value={String(params.unit ?? 'pips')} onChange={(e) => set('unit', e.target.value)} className="max-w-24">
        <option value="pips">pips</option>
        <option value="pct">%</option>
      </Select>
    </>
  );
}

function flattenIssues(error: { issues: { path: (string | number)[]; message: string }[] }): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '(body)';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}
