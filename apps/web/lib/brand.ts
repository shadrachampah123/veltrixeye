/**
 * Single source of truth for the product brand in the UI.
 * The product name may change later — update it HERE only.
 *
 * Phase 3: centralized branding — all UI surfaces read from this file.
 * M8.7 execution-safety controls preserved; branding is presentation-only.
 */
export const BRAND = {
  name: 'VeltrixEye',
  short: 'VX',
  tagline: 'Deterministic strategy scanner & alerts',
  stage: 'M8.7 · Drawdown protection',
  description: 'Define your own deterministic trading strategies, scan markets, and receive explained, scored alerts — with execution-safety controls and drawdown protection.',
  version: 'M8.7',
  domain: 'veltrixeye',
  supportEmail: 'support@veltrixeye.com',
  links: {
    docs: '/workbench',
    markets: '/markets',
    scanner: '/scanner',
    strategies: '/strategies',
    settings: '/settings',
  },
  // Safety messaging — must remain consistent across UI
  safety: {
    automationDefault: 'OFF',
    executionNote: 'No live trading path — paper simulation only',
    riskNote: 'Risk ceilings enforced server-side',
  },
} as const;

export type Brand = typeof BRAND;
