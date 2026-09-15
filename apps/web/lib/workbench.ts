import {
  SETUP_STATES,
  SETUP_TERMINAL_STATES,
  SETUP_TRANSITIONS,
  detectionRequestSchema,
  evaluationRequestSchema,
  setupTransitionRequestSchema,
  type DetectionItemDto,
  type DetectionRequestInput,
  type DetectionResponseDto,
  type DirectionEvaluation,
  type EvaluationOutcomeStatus,
  type EvaluationRequestInput,
  type EvaluationResultDto,
  type InstrumentEvaluation,
  type SetupDto,
  type SetupState,
  type SetupTransitionRequest,
  type StrategyDetailDto,
  type StrategyVersionDetailDto,
  type StrategyVersionSummaryDto,
} from '@veltrixeye/contracts';

/**
 * Core browser workflow helpers (M7.1, frontend only).
 *
 * The rules encoded here exist so the UI cannot describe the deterministic
 * engines as doing something they do not do:
 *  - the anchor is ALWAYS an explicit, visible epoch-ms value the user can
 *    read; nothing in this module reads the wall clock (the default value is
 *    passed in as `nowMs` by the caller);
 *  - request bodies are validated with the SHARED contract schemas, so the
 *    payload that leaves the browser is exactly the payload the route accepts
 *    (same convention as `lib/backtest-form.ts`);
 *  - a replayed detection (`created: false`) and a replayed score
 *    (`created: false`) are never described as new;
 *  - lifecycle options come from `SETUP_TRANSITIONS`; terminal states offer
 *    nothing at all.
 */

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

export const SETUP_STATE_LABELS: Record<SetupState, string> = {
  developing: 'Developing',
  watching: 'Watching',
  almost_ready: 'Almost ready',
  confirmed: 'Confirmed',
  triggered: 'Triggered',
  invalidated: 'Invalidated',
  expired: 'Expired',
  completed: 'Completed',
};

export function setupStateLabel(state: SetupState | string): string {
  return SETUP_STATE_LABELS[state as SetupState] ?? state;
}

export function setupStateTone(state: SetupState | string): 'success' | 'info' | 'warning' | 'neutral' {
  switch (state) {
    case 'confirmed':
    case 'triggered':
      return 'success';
    case 'almost_ready':
    case 'watching':
      return 'info';
    case 'developing':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function isTerminalSetupState(state: SetupState | string): boolean {
  return (SETUP_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Allowed outbound transitions for a state (empty for terminal states). */
export function allowedTransitions(state: SetupState | string): readonly SetupState[] {
  return SETUP_TRANSITIONS[state as SetupState] ?? [];
}

/** The transition choices the UI may offer for the setup's CURRENT state. */
export function transitionOptions(state: SetupState | string): SetupState[] {
  return [...allowedTransitions(state)];
}

export function terminalNote(state: SetupState | string): string {
  return `${setupStateLabel(state)} is a terminal state — the lifecycle has no further transitions from here.`;
}

// ---------------------------------------------------------------------------
// Deterministic anchor (the value every M3/M4/M5 write is pinned to)
// ---------------------------------------------------------------------------

/**
 * Anchor copy shown next to every anchor field. The engines never read the
 * clock: detection and transitions REQUIRE the caller's anchor, and evaluation
 * uses the API clock only when `asOf` is omitted — which this UI never does.
 */
export const ANCHOR_HELP =
  'Explicit anchor (UTC). The deterministic engines use this instant and never the wall clock, so repeating a run with the same anchor reproduces it exactly.';

/** Default anchor: the current minute. Deterministic within a minute, human-readable. */
export function defaultAnchorMs(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

/** Epoch-ms → `datetime-local` input value in the browser's local time. */
export function anchorInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `datetime-local` input value → epoch-ms.
 *
 * `new Date('YYYY-MM-DDTHH:mm')` is parsed as LOCAL time, which is what the
 * input shows the user; the epoch-ms readout below the field makes the exact
 * instant that will be sent unmistakable.
 */
export function parseAnchorValue(value: string): number | null {
  if (value.trim() === '') return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.trunc(ms);
}

/** The exact value that will be sent: ISO-8601 UTC plus raw epoch-ms. */
export function anchorReadout(ms: number): string {
  return `${new Date(ms).toISOString()} · ${ms} epoch ms`;
}

export function anchorValidationError(value: string, ms: number | null): string | null {
  if (ms !== null) return null;
  return value.trim() === '' ? 'Set an anchor date and time.' : 'That anchor is not a valid date and time.';
}

// ---------------------------------------------------------------------------
// Request bodies — validated with the shared contract schemas
// ---------------------------------------------------------------------------

export type BuildResult<T> = { ok: true; body: T } | { ok: false; error: string };

/** POST …/evaluate body. The UI always pins an explicit anchor. */
export function buildEvaluateBody(asOfMs: number | null): BuildResult<EvaluationRequestInput> {
  if (asOfMs === null) return { ok: false, error: 'Set a valid anchor before evaluating.' };
  const parsed = evaluationRequestSchema.safeParse({ asOf: asOfMs });
  if (!parsed.success) return { ok: false, error: 'The anchor must be a positive epoch-ms instant.' };
  return { ok: true, body: parsed.data };
}

export interface DetectFormInput {
  assetClass: string;
  symbol: string;
  /** `''` means "both directions" — the API default; the key is then omitted. */
  direction: '' | 'long' | 'short';
  asOfMs: number | null;
}

/** POST …/detect body: `{ instrument, asOf, direction? }` exactly. */
export function buildDetectBody(form: DetectFormInput): BuildResult<DetectionRequestInput> {
  if (form.symbol.trim() === '') {
    return { ok: false, error: 'Choose an instrument from the version’s market scope.' };
  }
  if (form.asOfMs === null) {
    return { ok: false, error: 'Detection needs an explicit anchor — set a valid date and time.' };
  }
  const candidate = {
    instrument: { assetClass: form.assetClass, symbol: form.symbol },
    ...(form.direction === '' ? {} : { direction: form.direction }),
    asOf: form.asOfMs,
  };
  const parsed = detectionRequestSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: 'That instrument or anchor is not accepted by the API.' };
  return { ok: true, body: parsed.data };
}

export interface TransitionFormInput {
  toState: SetupState | '';
  asOfMs: number | null;
  reason: string;
}

/** POST /api/setups/:id/transitions body: `{ toState, asOf, reason? }`. */
export function buildTransitionBody(form: TransitionFormInput): BuildResult<SetupTransitionRequest> {
  if (form.toState === '') return { ok: false, error: 'Choose the state to transition to.' };
  if (form.asOfMs === null) {
    return { ok: false, error: 'A transition needs an explicit anchor — set a valid date and time.' };
  }
  const reason = form.reason.trim();
  const candidate = {
    toState: form.toState,
    ...(reason === '' ? {} : { reason }),
    asOf: form.asOfMs,
  };
  const parsed = setupTransitionRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: 'The state machine rejects that transition request — check the chosen state.' };
  }
  return { ok: true, body: parsed.data };
}

// ---------------------------------------------------------------------------
// Version selection / instrument scope
// ---------------------------------------------------------------------------

/** Versions the engines accept: published or deprecated — never a draft. */
export function evaluableVersions(strategy: StrategyDetailDto): StrategyVersionSummaryDto[] {
  return strategy.versions.filter((v) => v.status !== 'draft');
}

export function draftVersion(strategy: StrategyDetailDto): StrategyVersionSummaryDto | null {
  return strategy.versions.find((v) => v.status === 'draft') ?? null;
}

export function versionLabel(version: StrategyVersionSummaryDto): string {
  const parts = [`v${version.versionNumber}`, version.status];
  if (version.isCurrent) parts.push('current');
  return parts.join(' · ');
}

export interface InstrumentOption {
  assetClass: string;
  symbol: string;
}

export function instrumentKey(instrument: InstrumentOption): string {
  return `${instrument.assetClass}/${instrument.symbol}`;
}

export function parseInstrumentKey(key: string): InstrumentOption | null {
  const [assetClass, symbol] = key.split('/', 2);
  if (!assetClass || !symbol) return null;
  return { assetClass, symbol };
}

export function instrumentLabel(instrument: InstrumentOption): string {
  return `${instrument.symbol} · ${instrument.assetClass}`;
}

export interface DetectInstrumentChoices {
  options: InstrumentOption[];
  source: 'scope' | 'evaluated' | 'platform' | 'none';
  note: string;
}

/**
 * Which instruments the detection select may offer.
 *
 * Detection is only accepted for instruments inside the version's market
 * scope, so the UI prefers, in order:
 *  1. the instruments the version explicitly declares;
 *  2. the instruments the M3 evaluation at this anchor actually covered
 *     (scope "all" — capped, and therefore the authoritative set);
 *  3. the platform instrument list, as a pre-evaluation fallback, with a note
 *     that the API rejects anything outside the evaluated set.
 */
export function detectInstrumentChoices(args: {
  version: StrategyVersionDetailDto;
  evaluation: EvaluationResultDto | null;
  platformInstruments: readonly InstrumentOption[];
}): DetectInstrumentChoices {
  const scope = args.version.config.marketScope;
  const declared = scope?.mode === 'instruments' ? (scope.instruments ?? []) : [];
  if (declared.length > 0) {
    return {
      options: declared.map((i) => ({ assetClass: i.assetClass, symbol: i.symbol })),
      source: 'scope',
      note: `This version's market scope lists ${declared.length} instrument${declared.length === 1 ? '' : 's'}; detection accepts only those.`,
    };
  }
  if (args.evaluation) {
    const options = args.evaluation.instruments.map((i) => ({ assetClass: i.assetClass, symbol: i.symbol }));
    return {
      options,
      source: 'evaluated',
      note: args.evaluation.truncated
        ? `Market scope “all”: the evaluation covered the first ${options.length} instruments (the API caps a run at ${options.length} when the scope is larger); detection accepts only that set.`
        : `Market scope “all”: the evaluation covered ${options.length} instrument${options.length === 1 ? '' : 's'} at this anchor; detection accepts only that set.`,
    };
  }
  if (args.platformInstruments.length > 0) {
    return {
      options: [...args.platformInstruments],
      source: 'platform',
      note: 'Market scope “all” — every instrument the platform knows about. An instrument outside the set the API actually evaluated is rejected, so evaluate at this anchor first.',
    };
  }
  return {
    options: [],
    source: 'none',
    note: 'No instruments are stored yet. Ingest candles under Markets (or run a backfill), then evaluate this version.',
  };
}

// ---------------------------------------------------------------------------
// Evaluation result presentation
// ---------------------------------------------------------------------------

export interface DirectionSummary {
  direction: 'long' | 'short';
  passed: boolean;
  satisfied: number;
  unsatisfied: number;
  insufficientData: number;
  unsupported: number;
}

export function summariseDirection(evaluation: DirectionEvaluation): DirectionSummary {
  const summary: DirectionSummary = {
    direction: evaluation.direction,
    passed: evaluation.passed,
    satisfied: 0,
    unsatisfied: 0,
    insufficientData: 0,
    unsupported: 0,
  };
  for (const group of evaluation.groups) {
    for (const condition of group.conditions) {
      if (condition.status === 'satisfied') summary.satisfied += 1;
      else if (condition.status === 'unsatisfied') summary.unsatisfied += 1;
      else if (condition.status === 'insufficient_data') summary.insufficientData += 1;
      else summary.unsupported += 1;
    }
  }
  return summary;
}

export function directionSummaryText(summary: DirectionSummary): string {
  return [
    `${summary.passed ? 'passed' : 'failed'}`,
    `${summary.satisfied} satisfied`,
    `${summary.unsatisfied} not satisfied`,
    `${summary.insufficientData} insufficient data`,
    `${summary.unsupported} unsupported`,
  ].join(' · ');
}

export function instrumentOutcomeText(instrument: InstrumentEvaluation): string {
  const long = instrument.directions.long.passed ? 'long passed' : 'long failed';
  const short = instrument.directions.short.passed ? 'short passed' : 'short failed';
  return `${long} · ${short}`;
}

export function conditionStatusLabel(status: EvaluationOutcomeStatus | string): string {
  switch (status) {
    case 'satisfied':
      return 'Satisfied';
    case 'unsatisfied':
      return 'Not satisfied';
    case 'insufficient_data':
      return 'Insufficient data';
    case 'unsupported':
      return 'Unsupported';
    default:
      return status;
  }
}

export function conditionStatusTone(status: EvaluationOutcomeStatus | string): 'success' | 'danger' | 'warning' | 'neutral' {
  switch (status) {
    case 'satisfied':
      return 'success';
    case 'unsatisfied':
      return 'danger';
    case 'insufficient_data':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function timeframeRoleLabel(role: string): string {
  switch (role) {
    case 'htf_bias':
      return 'Higher-timeframe bias';
    case 'setup':
      return 'Setup timeframe';
    case 'entry':
      return 'Entry timeframe';
    default:
      return 'Any role';
  }
}

export function relevanceLabel(relevance: string): string {
  switch (relevance) {
    case 'pass':
      return 'Decides pass/fail';
    case 'veto':
      return 'Disqualifying';
    default:
      return 'Reported only';
  }
}

/** One-line summary of a run over its evaluated instruments. */
export function evaluationSummaryText(result: EvaluationResultDto): string {
  const passed = result.instruments.filter((i) => i.anyPassed).length;
  const failed = result.instruments.length - passed;
  return `${result.instruments.length} instrument${result.instruments.length === 1 ? '' : 's'} evaluated · ${passed} with a passing direction · ${failed} without`;
}

// ---------------------------------------------------------------------------
// Detection result presentation
// ---------------------------------------------------------------------------

export interface DetectionOutcomeCopy {
  tone: 'success' | 'info' | 'warning';
  title: string;
  detail: string;
}

/**
 * Exactly one outcome per detection item. The API distinguishes a NEW setup
 * (`created: true`) from a pre-existing one returned by an idempotent replay
 * (`created: false`) and from "nothing qualified"; the UI must never blur
 * those, and must never report a replay as newly created.
 */
export function describeDetectionItem(item: DetectionItemDto): DetectionOutcomeCopy {
  if (item.qualified && item.setup && item.created) {
    return {
      tone: 'success',
      title: 'Setup created',
      detail:
        'Every required/confirmation condition passed for this direction at the anchor, so a new setup was persisted in the confirmed state.',
    };
  }
  if (item.qualified && item.setup) {
    return {
      tone: 'info',
      title: 'Existing setup returned — no new setup',
      detail:
        'A setup already existed for this version, instrument, direction and anchor. Detection is idempotent, so the stored setup was returned unchanged and nothing was written.',
    };
  }
  return {
    tone: 'warning',
    title: 'No setup — this direction did not qualify',
    detail:
      'The M3 evaluation did not pass for this direction at the anchor, so no setup row exists for it. The evaluation’s failure reasons are listed below.',
  };
}

export interface DetectionTally {
  created: number;
  existing: number;
  none: number;
}

export function tallyDetections(result: DetectionResponseDto): DetectionTally {
  const tally: DetectionTally = { created: 0, existing: 0, none: 0 };
  for (const item of result.detections) {
    if (item.setup && item.created) tally.created += 1;
    else if (item.setup) tally.existing += 1;
    else tally.none += 1;
  }
  return tally;
}

export function detectionSummaryText(result: DetectionResponseDto): string {
  const tally = tallyDetections(result);
  return `${tally.created} created · ${tally.existing} already existing · ${tally.none} without a setup`;
}

export const DETECTION_IDEMPOTENCE_NOTE =
  'Detection writes at most one setup per (version, instrument, direction, anchor). Running it again with the same anchor returns the same setup instead of creating a second one, and it never scores or alerts by itself.';

// ---------------------------------------------------------------------------
// Scoring + transition presentation
// ---------------------------------------------------------------------------

export const SCORE_AUTHORITY_NOTE =
  'The M5 engine is authoritative: the total, grade, engine version and component points below are the values the API returned. Scoring records an append-only score row and never edits the strategy or the version.';

export function describeScoreOutcome(created: boolean): { tone: 'success' | 'info'; title: string; detail: string } {
  return created
    ? {
        tone: 'success',
        title: 'New score recorded',
        detail: 'This scoring context (setup, engine version and anchor) had no score yet, so a new score row was written.',
      }
    : {
        tone: 'info',
        title: 'Existing score returned — no new score row',
        detail:
          'A score already existed for this setup, engine version and anchor, so the stored score was returned unchanged. Scoring is idempotent per context.',
      };
}

export function describeTransitionOutcome(response: {
  transitioned: boolean;
  setup: SetupDto;
}): { tone: 'success' | 'info'; title: string; detail: string } {
  return response.transitioned
    ? {
        tone: 'success',
        title: `Setup moved to ${setupStateLabel(response.setup.state)}`,
        detail: 'The API recorded the transition event with the anchor you supplied.',
      }
    : {
        tone: 'info',
        title: `Already in ${setupStateLabel(response.setup.state)} — nothing changed`,
        detail:
          'This request repeated the setup’s current state, which the API treats as an idempotent no-op: no event was written.',
      };
}

// ---------------------------------------------------------------------------
// Setup facts
// ---------------------------------------------------------------------------

export function setupDetectorVersion(setup: SetupDto): string | null {
  const value = setup.metadata?.['detectorVersion'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface SetupLevelRow {
  label: string;
  value: number | null;
}

export function setupLevelRows(setup: SetupDto): SetupLevelRow[] {
  return [
    { label: 'Entry', value: setup.entryPrice },
    { label: 'Stop loss', value: setup.stopLossPrice },
    { label: 'Take profit 1', value: setup.tp1Price },
    { label: 'Take profit 2', value: setup.tp2Price },
    { label: 'Take profit 3', value: setup.tp3Price },
  ];
}

export function setupAnchorText(setup: SetupDto): string {
  return `${new Date(setup.asOfMs).toISOString()} · ${setup.asOfMs} epoch ms`;
}

// ---------------------------------------------------------------------------
// Setup list filters
// ---------------------------------------------------------------------------

export const SETUP_STATE_FILTERS: Array<{ value: '' | SetupState; label: string }> = [
  { value: '', label: 'All states' },
  ...SETUP_STATES.map((state) => ({ value: state, label: setupStateLabel(state) })),
];

export const SETUP_DIRECTION_FILTERS: Array<{ value: '' | 'long' | 'short'; label: string }> = [
  { value: '', label: 'Both directions' },
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
];

/** Page sizes the setups list offers (the API caps a page at 100). */
export const SETUP_PAGE_SIZES = [25, 50, 100] as const;
export type SetupPageSize = (typeof SETUP_PAGE_SIZES)[number];
export const DEFAULT_SETUPS_PAGE_SIZE: SetupPageSize = 50;

export const SETUP_LIST_NEVER_DETECTED =
  'No setups found. Setups are created only by running detection on a published strategy version — there is no background scanner, so nothing appears here on its own.';
