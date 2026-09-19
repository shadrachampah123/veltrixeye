/** Credential-presence checks only. Values are never retained, returned or logged. */
export interface ExecutionTransportConfig {
  mode: 'disabled' | 'dry-run';
  live: false;
  timeoutMs: number;
}
export function validateExecutionTransportConfig(env: Record<string, string | undefined>): ExecutionTransportConfig {
  const mode = env.EXECUTION_TRANSPORT_MODE ?? 'disabled';
  if (!['disabled', 'dry-run', 'mt5-live'].includes(mode)) {
    throw new Error('Invalid EXECUTION_TRANSPORT_MODE');
  }
  const timeoutMs = Number(env.EXECUTION_TRANSPORT_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Invalid EXECUTION_TRANSPORT_TIMEOUT_MS');
  }
  if (mode === 'mt5-live') {
    const required = ['MT5_SERVER', 'MT5_LOGIN', 'MT5_PASSWORD', 'MT5_GATEWAY_URL'] as const;
    const missing = required.filter((key) => !env[key]?.trim());
    if (missing.length) throw new Error(`Live MT5 configuration missing: ${missing.join(', ')}`);
    // No gateway protocol, real terminal SDK, credential resolution or network client in M10.
    throw new Error('Live MT5 transport is prohibited in M10, even with complete configuration');
  }
  return Object.freeze({ mode: mode as 'disabled' | 'dry-run', live: false, timeoutMs });
}
