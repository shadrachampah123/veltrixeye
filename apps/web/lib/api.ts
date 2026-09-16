import type {
  StrategyDetailDto,
  StrategySummaryDto,
  StrategyVersionDetailDto,
  UserDto,
  SessionDto,
  RegisterInput,
  LoginInput,
  ChangePasswordInput,
  UpdateProfileInput,
  StrategyCreateInput,
  StrategyUpdateInput,
  StrategyVersionCreateInput,
  StrategyVersionUpdateInput,
  CandlesResponseDto,
  CoverageResponseDto,
  BackfillRequest,
  BackfillResponseDto,
  ProviderCapabilities,
  // M6 Phase 4 — backtest + alert surfaces
  AlertDetailDto,
  AlertDto,
  AlertGenerateResponse,
  AlertStatus,
  AlertTriggerState,
  BacktestCostPolicyInput,
  BacktestDirection,
  BacktestExitPolicyInput,
  BacktestRunDetailDto,
  BacktestRunDto,
  BacktestTrade,
  SetupDto,
  // M7.1 — core browser workflow (evaluate → detect → score → transition)
  DetectionRequestInput,
  DetectionResponseDto,
  EvaluationRequestInput,
  EvaluationResultDto,
  SetupDetailDto,
  SetupScoreHistoryResponseDto,
  SetupScoreRequestInput,
  SetupScoreResponseDto,
  SetupTransitionRequest,
  SetupTransitionResponseDto,
  BillingStateDto,
  // M7.5 — live scanner
  ScannerHealthDto,
  ScannerRunDto,
  ScannerTriggerRequestInput,
  ScannerTriggerResponse,
  // M8.1 — execution architecture (read/status surface only)
  AutomationStatusDto,
  ExecutionStatusDto,
  ExecutionProfileDto,
  ExecutionOrderDto,
  ExecutionPositionDto,
  ExecutionAuditEventDto,
} from '@veltrixeye/contracts';
import {
  MAX_ALERTS_LIMIT,
  MAX_BACKTESTS_LIMIT,
  MAX_BACKTEST_TRADES,
  MAX_SCORE_HISTORY_LIMIT,
  MAX_SETUPS_LIMIT,
} from '@veltrixeye/contracts';

/** Registered provider row from GET /api/market-data/providers. */
export interface RegisteredProvider {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
}

/** Normalized instrument row from GET /api/markets/instruments. */
export interface MarketInstrument {
  assetClass: string;
  symbol: string;
  displayName: string | null;
}

/** Query-string params for GET /api/market-data/candles (all strings over HTTP). */
export interface CandleQueryParams {
  assetClass: string;
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  limit?: string;
}

// ---------------------------------------------------------------------------
// M6 Phase 4 — backtests, setups (read-only) and alerts
// ---------------------------------------------------------------------------

/** Body for POST /api/backtests (mirrors the route's strict body schema). */
export interface BacktestCreateInput {
  strategyId: string;
  versionId: string;
  instrument: { assetClass: string; symbol: string };
  direction?: BacktestDirection;
  /** Epoch-ms, UTC; inclusive. */
  from: number;
  /** Epoch-ms, UTC; exclusive. Must not be in the future. */
  to: number;
  exitPolicy?: BacktestExitPolicyInput;
  costPolicy?: BacktestCostPolicyInput;
}

/** POST /api/backtests response: the run detail plus the replay indicator. */
export interface BacktestCreateResponseDto extends BacktestRunDetailDto {
  /** False when an identical run already existed (deterministic replay). */
  created: boolean;
}

/** GET /api/backtests response. */
export interface BacktestListResponseDto {
  runs: BacktestRunDto[];
}

/** GET /api/backtests/:id/trades response. */
export interface BacktestTradesResponseDto {
  runId: string;
  trades: BacktestTrade[];
  truncated: boolean;
}

/** Query params for GET /api/backtests (all optional). */
export interface BacktestListParams {
  strategyId?: string;
  versionId?: string;
  limit?: number;
}

/** Query params for GET /api/setups (all optional). */
export interface SetupListParams {
  strategyId?: string;
  versionId?: string;
  state?: string;
  direction?: string;
  limit?: number;
}

/** GET /api/setups response. */
export interface SetupListResponseDto {
  setups: SetupDto[];
}

/** Query params for GET /api/alerts (all optional). */
export interface AlertListParams {
  strategyId?: string;
  status?: AlertStatus;
  limit?: number;
}

/** GET /api/alerts response. */
export interface AlertListResponseDto {
  alerts: AlertDto[];
}

/** Clamp a caller-supplied page size to the contract's maximum. */
function clampLimit(limit: number | undefined, max: number): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

/** Build a query string from defined params only (stable insertion order). */
function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const s = qs.toString();
  return s === '' ? '' : `?${s}`;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string[]>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string[]>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      // Only declare a JSON body when we actually send one: Fastify rejects
      // an empty body with `Content-Type: application/json` (400,
      // FST_ERR_CTP_EMPTY_JSON_BODY), which silently broke the body-less
      // logout and session-revoke calls. See test/api-client.test.ts.
      ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string; fields?: Record<string, string[]> } })
    | null;
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? `Request failed (${res.status})`, err?.fields);
  }
  return body as T;
}

export const api = {
  // auth
  register: (input: RegisterInput) => request<{ user: UserDto }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  login: (input: LoginInput) => request<{ user: UserDto }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: UserDto; sessions: SessionDto[] }>('/users/me'),
  getBillingState: () => request<BillingStateDto>('/billing/me'),

  // profile
  updateProfile: (input: UpdateProfileInput) =>
    request<{ user: UserDto }>('/users/me', { method: 'PATCH', body: JSON.stringify(input) }),
  changePassword: (input: ChangePasswordInput) =>
    request<{ ok: boolean }>('/users/me/password', { method: 'POST', body: JSON.stringify(input) }),
  deleteSession: (sessionId: string) => request<{ ok: boolean }>(`/users/me/sessions/${sessionId}`, { method: 'DELETE' }),

  // strategies
  listStrategies: () => request<{ strategies: StrategySummary[] }>('/strategies'),
  createStrategy: (input: StrategyCreateInput) => request<{ strategy: StrategyDetailDto }>('/strategies', { method: 'POST', body: JSON.stringify(input) }),
  getStrategy: (id: string) => request<{ strategy: StrategyDetailDto }>(`/strategies/${id}`),
  updateStrategy: (id: string, input: StrategyUpdateInput) =>
    request<{ strategy: StrategyDetailDto }>(`/strategies/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteStrategy: (id: string) => request<void>(`/strategies/${id}`, { method: 'DELETE' }),

  createVersion: (strategyId: string, input: StrategyVersionCreateInput) =>
    request<{ version: StrategyVersionDetailDto }>(`/strategies/${strategyId}/versions`, { method: 'POST', body: JSON.stringify(input) }),
  getVersion: (strategyId: string, versionId: string) =>
    request<{ version: StrategyVersionDetailDto }>(`/strategies/${strategyId}/versions/${versionId}`),
  updateVersion: (strategyId: string, versionId: string, input: StrategyVersionUpdateInput) =>
    request<{ version: StrategyVersionDetailDto }>(`/strategies/${strategyId}/versions/${versionId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  publishVersion: (strategyId: string, versionId: string) =>
    request<{ version: StrategyVersionDetailDto }>(`/strategies/${strategyId}/versions/${versionId}/publish`, { method: 'POST' }),
  deprecateVersion: (strategyId: string, versionId: string) =>
    request<{ version: StrategyVersionDetailDto }>(`/strategies/${strategyId}/versions/${versionId}/deprecate`, { method: 'POST' }),

  // market data (M2: historical ingestion over the shared candle store)
  listProviders: () => request<{ providers: RegisteredProvider[]; note?: string }>('/market-data/providers'),
  listInstruments: () => request<{ instruments: MarketInstrument[] }>('/markets/instruments'),
  getCandles: (params: CandleQueryParams) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) qs.set(key, value);
    }
    return request<CandlesResponseDto>(`/market-data/candles?${qs.toString()}`);
  },
  getCoverage: () => request<CoverageResponseDto>('/market-data/coverage'),
  backfill: (input: BackfillRequest) =>
    request<BackfillResponseDto>('/market-data/backfill', { method: 'POST', body: JSON.stringify(input) }),

  // -------------------------------------------------------------------------
  // Backtests (M6 Phase 2 API, Phase 4 UI)
  // -------------------------------------------------------------------------

  /** GET /api/backtests — the caller's runs, newest first (owner-scoped). */
  listBacktests: (params: BacktestListParams = {}) =>
    request<BacktestListResponseDto>(
      `/backtests${toQueryString({
        strategyId: params.strategyId,
        versionId: params.versionId,
        limit: clampLimit(params.limit, MAX_BACKTESTS_LIMIT),
      })}`,
    ),

  /** POST /api/backtests — create a run, or replay an identical existing one. */
  createBacktest: (input: BacktestCreateInput) =>
    request<BacktestCreateResponseDto>('/backtests', { method: 'POST', body: JSON.stringify(input) }),

  /** GET /api/backtests/:id — one owned run with its stored trades. */
  getBacktest: (id: string) => request<BacktestRunDetailDto>(`/backtests/${encodeURIComponent(id)}`),

  /** GET /api/backtests/:id/trades — paginated trades for one owned run. */
  getBacktestTrades: (id: string, limit?: number) =>
    request<BacktestTradesResponseDto>(
      `/backtests/${encodeURIComponent(id)}/trades${toQueryString({ limit: clampLimit(limit, MAX_BACKTEST_TRADES) })}`,
    ),

  // -------------------------------------------------------------------------
  // Setups (M4 API — read + lifecycle)
  // -------------------------------------------------------------------------

  /** GET /api/setups — the caller's setups, newest first (owner-scoped). */
  listSetups: (params: SetupListParams = {}) =>
    request<SetupListResponseDto>(
      `/setups${toQueryString({
        strategyId: params.strategyId,
        versionId: params.versionId,
        state: params.state,
        direction: params.direction,
        limit: clampLimit(params.limit, MAX_SETUPS_LIMIT),
      })}`,
    ),

  /** GET /api/setups/:id — one owned setup plus its lifecycle event history. */
  getSetup: (id: string) => request<SetupDetailDto>(`/setups/${encodeURIComponent(id)}`),

  // -------------------------------------------------------------------------
  // M7.1 — deterministic evaluation (M3), detection (M4) and scoring (M5)
  // -------------------------------------------------------------------------

  /**
   * POST /api/strategies/:strategyId/versions/:versionId/evaluate — run the
   * deterministic M3 engine over stored candles at an explicit anchor.
   *
   * The body is exactly the contract's `{ asOf? }`: the evaluated instruments
   * come from the version's own market scope, so the client never sends an
   * instrument. The UI always supplies `asOf` so the anchor — and therefore the
   * result — is reproducible; omitting it would pin the API to the wall clock.
   * Store-only: this can never trigger a provider fetch.
   */
  evaluateVersion: (strategyId: string, versionId: string, input: EvaluationRequestInput = {}) =>
    request<EvaluationResultDto>(
      `/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/evaluate`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  /**
   * POST /api/strategies/:strategyId/versions/:versionId/detect — persist one
   * setup per qualifying direction at the explicit anchor.
   *
   * `created: false` means the (version, instrument, direction, anchor) setup
   * already existed and was returned unchanged — a replay, never a second setup.
   */
  detectSetup: (strategyId: string, versionId: string, input: DetectionRequestInput) =>
    request<DetectionResponseDto>(
      `/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/detect`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  /**
   * POST /api/setups/:setupId/score — score one owned setup with the M5 engine.
   *
   * `asOf` omitted means "the setup's own detection anchor"; `created: false`
   * is an idempotent replay of an existing (setup, engine, anchor) score.
   * Scoring never changes the setup's lifecycle and never edits the strategy.
   */
  scoreSetup: (setupId: string, input: SetupScoreRequestInput = {}) =>
    request<SetupScoreResponseDto>(`/setups/${encodeURIComponent(setupId)}/score`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** GET /api/setups/:setupId/scores — the append-only score history, newest anchor first. */
  listSetupScores: (setupId: string, limit?: number) =>
    request<SetupScoreHistoryResponseDto>(
      `/setups/${encodeURIComponent(setupId)}/scores${toQueryString({
        limit: clampLimit(limit, MAX_SCORE_HISTORY_LIMIT),
      })}`,
    ),

  /**
   * POST /api/setups/:setupId/transitions — request one M4 lifecycle
   * transition. `asOf` is required and becomes the event timestamp; a repeat
   * of the current state is an idempotent no-op (`transitioned: false`).
   */
  transitionSetup: (setupId: string, input: SetupTransitionRequest) =>
    request<SetupTransitionResponseDto>(`/setups/${encodeURIComponent(setupId)}/transitions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // -------------------------------------------------------------------------
  // Alerts (M6 Phase 2–3 API, Phase 4 UI)
  // -------------------------------------------------------------------------

  /** GET /api/alerts — the caller's alerts, newest first (owner-scoped). */
  listAlerts: (params: AlertListParams = {}) =>
    request<AlertListResponseDto>(
      `/alerts${toQueryString({
        strategyId: params.strategyId,
        status: params.status,
        limit: clampLimit(params.limit, MAX_ALERTS_LIMIT),
      })}`,
    ),

  /** GET /api/alerts/:id — one owned alert plus its stub delivery ledger. */
  getAlert: (id: string) => request<AlertDetailDto>(`/alerts/${encodeURIComponent(id)}`),

  /**
   * POST /api/alerts/:id/acknowledge — idempotent acknowledgement.
   *
   * The body is an explicit empty JSON object: the route parses the body with
   * a strict empty schema, and Fastify rejects a body-less request that
   * declares `Content-Type: application/json` — so the client always sends
   * `{}` (see test/api-client.test.ts for the body-less counterpart).
   */
  acknowledgeAlert: (id: string) =>
    request<AlertDetailDto>(`/alerts/${encodeURIComponent(id)}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /**
   * POST /api/setups/:setupId/alerts — generate an alert from an owned setup.
   * `created: false` with an alert is a dedup replay; `alert: null` means the
   * quality gate skipped generation (never an error).
   */
  generateAlert: (setupId: string, triggerState?: AlertTriggerState) =>
    request<AlertGenerateResponse>(`/setups/${encodeURIComponent(setupId)}/alerts`, {
      method: 'POST',
      body: JSON.stringify(triggerState ? { triggerState } : {}),
    }),

  // -------------------------------------------------------------------------
  // Scanner (M7.5 — live scanner / production market flow)
  // -------------------------------------------------------------------------

  /** GET /api/scanner/health — real production scanner health/status. */
  getScannerHealth: () => request<ScannerHealthDto>('/scanner/health'),

  /** GET /api/scanner/runs — recent scanner runs. */
  listScannerRuns: (params: { status?: string; limit?: number } = {}) =>
    request<{ runs: ScannerRunDto[] }>(
      `/scanner/runs${toQueryString({
        status: params.status,
        limit: params.limit,
      })}`,
    ),

  /** POST /api/scanner/trigger — manual scan trigger. */
  triggerScanner: (input: ScannerTriggerRequestInput = {}) =>
    request<ScannerTriggerResponse>('/scanner/trigger', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // -------------------------------------------------------------------------
  // M8.1 — execution architecture (read/status surface only; no order
  // submission exists or is exposed)
  // -------------------------------------------------------------------------

  /** GET /api/execution/automation — server-authoritative automation state. */
  getAutomationStatus: () => request<AutomationStatusDto>('/execution/automation'),

  /** GET /api/execution/status — execution readiness snapshot. */
  getExecutionStatus: () => request<ExecutionStatusDto>('/execution/status'),

  /** GET /api/execution/profiles — the caller's execution profiles. */
  listExecutionProfiles: () => request<{ profiles: ExecutionProfileDto[] }>('/execution/profiles'),

  /** GET /api/execution/orders — owner-scoped orders (empty in M8.1). */
  listExecutionOrders: (params: { limit?: number } = {}) =>
    request<{ orders: ExecutionOrderDto[] }>(`/execution/orders${toQueryString({ limit: params.limit })}`),

  /** GET /api/execution/positions — owner-scoped positions (empty in M8.1). */
  listExecutionPositions: (params: { limit?: number } = {}) =>
    request<{ positions: ExecutionPositionDto[] }>(`/execution/positions${toQueryString({ limit: params.limit })}`),

  /** GET /api/execution/events — owner-scoped execution audit trail. */
  listExecutionEvents: (params: { limit?: number } = {}) =>
    request<{ events: ExecutionAuditEventDto[] }>(`/execution/events${toQueryString({ limit: params.limit })}`),
};

/** Summary row shape from the API list endpoint. */
export type StrategySummary = StrategySummaryDto;
