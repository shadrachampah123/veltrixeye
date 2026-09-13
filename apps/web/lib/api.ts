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
};

/** Summary row shape from the API list endpoint. */
export type StrategySummary = StrategySummaryDto;
