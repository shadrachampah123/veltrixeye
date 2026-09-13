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
} from '@veltrixeye/contracts';

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
      'Content-Type': 'application/json',
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
};

/** Summary row shape from the API list endpoint. */
export type StrategySummary = StrategySummaryDto;
