import {
  EXECUTION_FAILURE_CATEGORIES,
  ExecutionProviderError,
  MT5_EXECUTION_PROVIDER_ID,
  type AssetClass,
  type ExecutionAccountInfo,
  type ExecutionFailureCategory,
  type ExecutionInstrumentMetadata,
  type ExecutionProvider,
  type ExecutionProviderCapabilities,
  type ExecutionProviderHealth,
  type ExecutionProviderOrderState,
  type ExecutionProviderPositionState,
  type ExecutionSubmitOrderOutcome,
  type ExecutionSubmitOrderRequest,
  type OrderStatus,
  type OrderType,
} from '@veltrixeye/contracts';

/** Vendor-neutral records returned by an MT5 terminal/gateway transport. */
export interface MT5AccountSnapshot {
  login: string;
  broker: string;
  server: string;
  currency?: string;
  balance?: number;
  equity?: number;
  marginFree?: number;
}
export interface MT5SymbolSnapshot {
  symbol: string;
  assetClass: AssetClass;
  bid?: number;
  ask?: number;
  quoteTimestampMs?: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  digits: number;
  tickSize: number;
  orderTypes: readonly OrderType[];
  tradeMode: 'open' | 'closed' | 'disabled' | 'unknown';
}
export interface MT5OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: OrderType;
  volume: number;
  price: number | null;
  stopLoss: number;
  takeProfit: number;
}
export interface MT5OrderSnapshot {
  ticket: string;
  clientOrderId?: string;
  symbol: string;
  status: string;
  volume: number;
  filledVolume?: number;
  averagePrice?: number;
  retcode?: number;
  message?: string;
  timestampMs: number;
}
export interface MT5PositionSnapshot {
  ticket: string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  priceOpen: number;
  stopLoss?: number;
  takeProfit?: number;
  profit?: number;
}
export interface MT5TransportHealth {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  healthy: boolean;
  reason?: string;
}
export interface MT5TransportError extends Error {
  code?: string | number;
  responseLost?: boolean;
}

/**
 * The sole network/vendor boundary. Core code never assumes HTTP, sockets,
 * terminal APIs, hosting topology, or a particular broker (Exness included).
 */
export interface MT5Transport {
  readonly configured: boolean;
  health(): Promise<MT5TransportHealth>;
  account(): Promise<MT5AccountSnapshot>;
  symbol(symbol: string): Promise<MT5SymbolSnapshot | null>;
  submitOrder(order: MT5OrderRequest): Promise<MT5OrderSnapshot>;
  findOrderByClientId(clientOrderId: string): Promise<MT5OrderSnapshot | null>;
  cancelOrder(ticket: string): Promise<void>;
  modifyOrder(ticket: string, changes: { stopLoss?: number | null; takeProfit?: number | null }): Promise<void>;
  order(ticket: string): Promise<MT5OrderSnapshot | null>;
  orders(): Promise<MT5OrderSnapshot[]>;
  position(ticket: string): Promise<MT5PositionSnapshot | null>;
  positions(): Promise<MT5PositionSnapshot[]>;
  closePosition(ticket: string): Promise<void>;
}

/** Honest production default: no protocol is invented and every operation fails closed. */
export class DisabledMT5Transport implements MT5Transport {
  readonly configured = false;
  async health(): Promise<MT5TransportHealth> {
    return { configured: false, authenticated: false, connected: false, healthy: false, reason: 'mt5_transport_unconfigured' };
  }
  private unavailable(): never {
    throw new ExecutionProviderError('unavailable', 'MT5 transport is not configured; no broker communication was attempted');
  }
  async account(): Promise<MT5AccountSnapshot> { return this.unavailable(); }
  async symbol(): Promise<MT5SymbolSnapshot | null> { return this.unavailable(); }
  async submitOrder(): Promise<MT5OrderSnapshot> { return this.unavailable(); }
  async findOrderByClientId(): Promise<MT5OrderSnapshot | null> { return this.unavailable(); }
  async cancelOrder(): Promise<void> { return this.unavailable(); }
  async modifyOrder(): Promise<void> { return this.unavailable(); }
  async order(): Promise<MT5OrderSnapshot | null> { return this.unavailable(); }
  async orders(): Promise<MT5OrderSnapshot[]> { return this.unavailable(); }
  async position(): Promise<MT5PositionSnapshot | null> { return this.unavailable(); }
  async positions(): Promise<MT5PositionSnapshot[]> { return this.unavailable(); }
  async closePosition(): Promise<void> { return this.unavailable(); }
}

export interface MT5ProviderConfig {
  /** Must remain false in the deployed M8.4 composition. */
  enabled: boolean;
  environment: 'demo' | 'live';
  broker: string | null;
  server: string | null;
  accountRef: string | null;
  /** Explicit canonical -> broker mapping. Never accepted on an order request. */
  symbols: ReadonlyMap<string, string>;
  maxQuoteAgeMs?: number;
  now?: () => number;
}

const statusMap: Record<string, OrderStatus> = {
  requested: 'submitted', placed: 'accepted', accepted: 'accepted', partial: 'partially_filled',
  filled: 'filled', rejected: 'rejected', cancelled: 'cancelled', canceled: 'cancelled', expired: 'expired',
};

/* -------------------------------------------------------------------------- */
/* Redaction boundary (Gate 10)                                                */
/*                                                                            */
/* Everything a transport hands back — error objects, messages, codes, order   */
/* free text, health reasons, account identifiers — is provider-controlled.    */
/* Nothing below copies such a value into an error, a receipt, a health        */
/* record or an account record: outputs are closed tokens, fixed literals and  */
/* bounded structured numbers only.                                            */
/* -------------------------------------------------------------------------- */

/** Fixed reason emitted whenever a transport reports an unhealthy state with a non-allowlisted reason. */
export const MT5_TRANSPORT_UNHEALTHY_REASON = 'mt5_transport_reported_unhealthy';
/** The only transport health reasons the provider repeats. Anything else collapses to the constant above. */
const SAFE_TRANSPORT_HEALTH_REASONS: ReadonlySet<string> = new Set(['mt5_transport_unconfigured', MT5_TRANSPORT_UNHEALTHY_REASON]);
/**
 * Categories whose outcome is ambiguous when they occur during order
 * submission: the venue may already have accepted the order, so they are
 * always `uncertain` there (fail-closed; reconciliation resolves them).
 */
const AMBIGUOUS_SUBMISSION_CATEGORIES: ReadonlySet<ExecutionFailureCategory> = new Set(['timeout', 'connection', 'uncertain', 'unknown']);
/** Provider code/message characters consulted for classification. Never retained. */
const CLASSIFICATION_TEXT_LIMIT = 2048;
/** Broker order/position identifiers must be short opaque tokens before they may reach persistence (DTO cap is 128). */
const PROVIDER_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RETCODE = 999_999;
const MAX_EPOCH_MS = 9_999_999_999_999;
/** Account currency codes are short alphabetic tokens; anything else is withheld. */
const CURRENCY_PATTERN = /^[A-Za-z]{3,6}$/;

/** Fixed, user-safe message per category. Used to rebuild pass-through errors without their upstream text. */
const SAFE_MESSAGES: Record<ExecutionFailureCategory, (operation: string) => string> = {
  authentication: () => 'Broker authentication failed',
  validation: (operation) => `${operation} failed broker validation`,
  insufficient_funds: () => 'Broker reported insufficient margin',
  market_closed: () => 'Broker market is closed or trading is disabled',
  rate_limited: () => 'Broker rate limit reached',
  timeout: (operation) => `${operation} timed out before submission was confirmed`,
  unavailable: () => 'MT5 provider is unavailable',
  rejected: () => 'Broker rejected the request',
  connection: () => 'Broker connection failed',
  invalid_symbol: () => 'Broker rejected the instrument',
  invalid_volume: () => 'Broker rejected the volume',
  invalid_price: () => 'Broker rejected the price',
  invalid_protection: () => 'Broker rejected the protective levels',
  duplicate: () => 'Broker reported a duplicate order',
  uncertain: (operation) => `${operation} outcome is uncertain; reconciliation is required`,
  unknown: (operation) => `${operation} failed with an unrecognized broker response`,
};

/**
 * Reads only the primitive classification hints from a thrown value. Non-objects,
 * non-primitive fields, proxies and throwing getters all yield nothing, so a
 * hostile transport error can neither escape the normalizer nor steer it.
 */
function transportErrorHints(error: unknown): { text: string; responseLost: boolean } {
  const none = { text: '', responseLost: false };
  if (typeof error !== 'object' || error === null) return none;
  try {
    const e = error as MT5TransportError;
    const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';
    const message = typeof e.message === 'string' ? e.message : '';
    return { text: `${code} ${message}`.slice(0, CLASSIFICATION_TEXT_LIMIT).toLowerCase(), responseLost: e.responseLost === true };
  } catch {
    return none;
  }
}

/** Broker tickets are identities: a value that is not a short opaque token is refused, never truncated or persisted. */
function requireProviderTicket(ticket: unknown, kind: 'order' | 'position'): string {
  if (typeof ticket === 'string' && PROVIDER_TICKET_PATTERN.test(ticket)) return ticket;
  throw new ExecutionProviderError('uncertain', `Broker ${kind} identifier failed validation; reconciliation is required`, { uncertain: true });
}
function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Maps any failure raised by a transport onto the closed `ExecutionProviderError`
 * contract. The result carries a category, a fixed message and the
 * `uncertain`/`retryable` flags — and nothing else: no `cause`, no upstream
 * stack, message, request, header or payload.
 *
 * `responseLost` takes precedence over every other signal. During order
 * submission an ambiguous signal (timeout/connection) takes precedence over
 * every "certain rejection" signal, and an unrecognized failure is uncertain,
 * so provider text can never turn a possibly-accepted order into a certain
 * rejection.
 */
export function normalizeMT5Error(error: unknown, operation: string): ExecutionProviderError {
  const submission = operation === 'order submission';
  const build = (category: ExecutionFailureCategory, message: string, flags: { uncertain?: boolean; retryable?: boolean } = {}) =>
    new ExecutionProviderError(category, message, {
      uncertain: flags.uncertain === true || category === 'uncertain' || (submission && AMBIGUOUS_SUBMISSION_CATEGORIES.has(category)),
      retryable: flags.retryable === true,
    });
  if (error instanceof ExecutionProviderError) {
    // Rebuild from the contract fields only; the upstream instance may carry an
    // arbitrary message, a `cause`, a stack and enumerable provider properties.
    // A category outside the closed set (only reachable through a cast) is `unknown`.
    const category = (EXECUTION_FAILURE_CATEGORIES as readonly string[]).includes(error.category) ? error.category : 'unknown';
    return build(category, SAFE_MESSAGES[category](operation), { uncertain: error.uncertain === true, retryable: error.retryable === true });
  }
  const { text, responseLost } = transportErrorHints(error);
  if (responseLost) return build('uncertain', SAFE_MESSAGES.uncertain(operation), { uncertain: true });
  const ambiguous = /timeout|timed.?out/.test(text) ? 'timeout' : /connect|network|socket/.test(text) ? 'connection' : null;
  if (submission && ambiguous) return build(ambiguous, SAFE_MESSAGES[ambiguous](operation));
  if (/auth|login|credential|10017/.test(text)) return build('authentication', SAFE_MESSAGES.authentication(operation));
  if (ambiguous) return build(ambiguous, SAFE_MESSAGES[ambiguous](operation));
  if (/symbol/.test(text)) return build('invalid_symbol', SAFE_MESSAGES.invalid_symbol(operation));
  if (/volume|lot/.test(text)) return build('invalid_volume', SAFE_MESSAGES.invalid_volume(operation));
  if (/margin|fund/.test(text)) return build('insufficient_funds', SAFE_MESSAGES.insufficient_funds(operation));
  if (/market.closed|trade.disabled/.test(text)) return build('market_closed', SAFE_MESSAGES.market_closed(operation));
  if (submission) return build('uncertain', 'Order submission returned an unrecognized broker state; reconciliation is required', { uncertain: true });
  return build('unknown', SAFE_MESSAGES.unknown(operation));
}

/**
 * Normalizes a broker order record. The receipt keeps bounded structured data
 * only (retcode, timestamp); the broker's free-text message is never retained.
 * A ticket that is not a short opaque token is refused as `uncertain` rather
 * than persisted, because a mangled identity could match the wrong order later.
 */
export function normalizeMT5Order(row: MT5OrderSnapshot): ExecutionProviderOrderState {
  return {
    providerOrderId: requireProviderTicket(row.ticket, 'order'),
    status: statusMap[row.status.toLowerCase()] ?? 'failed',
    filledQuantity: row.filledVolume ?? 0,
    averagePrice: row.averagePrice ?? null,
    raw: { retcode: boundedInteger(row.retcode, 0, MAX_RETCODE), timestampMs: boundedInteger(row.timestampMs, 0, MAX_EPOCH_MS) },
  };
}

function normalizePosition(row: MT5PositionSnapshot, canonical: string): ExecutionProviderPositionState {
  return {
    providerPositionId: requireProviderTicket(row.ticket, 'position'), assetClass: 'other', symbol: canonical,
    direction: row.side === 'buy' ? 'long' : 'short', quantity: row.volume,
    averageEntryPrice: row.priceOpen, stopLossPrice: row.stopLoss ?? null,
    takeProfitPrice: row.takeProfit ?? null, unrealizedPl: row.profit ?? null,
  };
}

export function createMT5ExecutionProvider(transport: MT5Transport, config: MT5ProviderConfig): ExecutionProvider {
  const capabilities: ExecutionProviderCapabilities = { modes: ['demo'], orderTypes: ['market', 'limit', 'stop'] };
  const now = config.now ?? Date.now;
  const canonicalFor = (providerSymbol: string) => [...config.symbols].find(([, value]) => value === providerSymbol)?.[0] ?? providerSymbol;
  const requireAvailable = async (): Promise<void> => {
    if (config.environment === 'live') throw new ExecutionProviderError('validation', 'Live MT5 execution is prohibited in M8.4');
    if (!config.enabled) throw new ExecutionProviderError('unavailable', 'MT5 provider is disabled');
    const health = await transport.health().catch((e) => { throw normalizeMT5Error(e, 'health check'); });
    if (!health.configured || !health.authenticated || !health.connected || !health.healthy) {
      throw new ExecutionProviderError(health.authenticated ? 'unavailable' : 'authentication', 'MT5 provider is not ready');
    }
  };
  const metadata = (canonical: string, row: MT5SymbolSnapshot): ExecutionInstrumentMetadata => {
    const quote = row.bid && row.ask && row.quoteTimestampMs ? {
      bid: row.bid, ask: row.ask, spread: row.ask - row.bid, timestampMs: row.quoteTimestampMs,
    } : null;
    return {
      assetClass: row.assetClass, canonicalSymbol: canonical, providerSymbol: row.symbol,
      contractSize: row.contractSize, minVolume: row.volumeMin, maxVolume: row.volumeMax,
      volumeStep: row.volumeStep, priceDigits: row.digits, tickSize: row.tickSize,
      orderTypes: row.orderTypes, tradingStatus: row.tradeMode, quote,
    };
  };
  return {
    id: MT5_EXECUTION_PROVIDER_ID,
    name: 'MetaTrader 5',
    capabilities,
    configured: transport.configured && Boolean(config.server && config.accountRef),
    describe: () => ({ id: MT5_EXECUTION_PROVIDER_ID, configured: transport.configured && Boolean(config.server && config.accountRef), enabled: config.enabled, environment: config.environment, broker: config.broker, server: config.server, accountRef: config.accountRef, transportPolicy: 'external-management-required', liveExecutionAvailable: false }),
    async health(): Promise<ExecutionProviderHealth> {
      const checkedAt = new Date(now()).toISOString();
      if (!config.enabled) return { configured: transport.configured && Boolean(config.server && config.accountRef), authenticated: false, connected: false, available: false, healthy: false, state: 'disabled', reason: transport.configured ? 'mt5_provider_disabled' : 'mt5_transport_unconfigured', checkedAt };
      if (config.environment === 'live') return { configured: transport.configured, authenticated: false, connected: false, available: false, healthy: false, state: 'disabled', reason: 'live_execution_prohibited_m8_4', checkedAt };
      try {
        const h = await transport.health();
        // Flags are re-derived as strict booleans and the reason is an
        // allowlisted token: a transport's free-text `reason` (or any extra
        // property such as `detail`) never reaches the health record.
        const configured = h.configured === true, authenticated = h.authenticated === true, connected = h.connected === true;
        const available = configured && authenticated && connected;
        const healthy = available && h.healthy === true;
        const reason = healthy ? undefined : typeof h.reason === 'string' && SAFE_TRANSPORT_HEALTH_REASONS.has(h.reason) ? h.reason : MT5_TRANSPORT_UNHEALTHY_REASON;
        return { configured, authenticated, connected, available, healthy, state: healthy ? 'healthy' : available ? 'degraded' : 'unavailable', ...(reason ? { reason } : {}), checkedAt };
      } catch (e) {
        const err = normalizeMT5Error(e, 'health check');
        return { configured: transport.configured, authenticated: false, connected: false, available: false, healthy: false, state: 'unavailable', reason: err.category, checkedAt };
      }
    },
    async getAccountInfo(): Promise<ExecutionAccountInfo | null> {
      await requireAvailable();
      // Only operator-configured identifiers are exposed. The broker login and
      // the transport's broker/server strings are provider-controlled and are
      // never used as an account reference, not even as a fallback.
      if (!config.accountRef || !config.server) throw new ExecutionProviderError('unavailable', 'MT5 account reference is not configured');
      try {
        const a = await transport.account();
        return {
          accountRef: config.accountRef, broker: config.broker ?? config.server, server: config.server, environment: 'demo',
          currency: typeof a.currency === 'string' && CURRENCY_PATTERN.test(a.currency) ? a.currency : null,
          balance: finiteOrNull(a.balance), equity: finiteOrNull(a.equity), marginFree: finiteOrNull(a.marginFree),
        };
      } catch (e) { throw normalizeMT5Error(e, 'account lookup'); }
    },
    async getInstrument(canonical: string) {
      await requireAvailable();
      const mapped = config.symbols.get(canonical);
      if (!mapped) throw new ExecutionProviderError('invalid_symbol', `No explicit MT5 symbol mapping exists for ${canonical}`);
      try { const row = await transport.symbol(mapped); return row ? metadata(canonical, row) : null; }
      catch (e) { throw normalizeMT5Error(e, 'instrument lookup'); }
    },
    async listInstruments() {
      const rows: ExecutionInstrumentMetadata[] = [];
      for (const canonical of config.symbols.keys()) { const item = await this.getInstrument(canonical); if (item) rows.push(item); }
      return rows;
    },
    async submitOrder(request: ExecutionSubmitOrderRequest): Promise<ExecutionSubmitOrderOutcome> {
      await requireAvailable();
      if (!request.authorizationId) throw new ExecutionProviderError('validation', 'MT5 orders require a server-issued execution authorization');
      const brokerSymbol = config.symbols.get(request.symbol);
      if (!brokerSymbol) throw new ExecutionProviderError('invalid_symbol', `No explicit MT5 symbol mapping exists for ${request.symbol}`);
      const row = await transport.symbol(brokerSymbol).catch((e) => { throw normalizeMT5Error(e, 'instrument lookup'); });
      if (!row || row.assetClass !== request.assetClass) throw new ExecutionProviderError('invalid_symbol', 'Broker instrument metadata does not match the canonical instrument');
      if (!row.orderTypes.includes(request.orderType) || row.tradeMode !== 'open') throw new ExecutionProviderError('validation', 'Order type or trading status is not supported');
      const steps = (request.quantity - row.volumeMin) / row.volumeStep;
      if (request.quantity < row.volumeMin || request.quantity > row.volumeMax || Math.abs(steps - Math.round(steps)) > 1e-8) throw new ExecutionProviderError('invalid_volume', 'Risk-safe quantity does not satisfy broker volume constraints');
      if (!(request.stopLossPrice && request.takeProfitPrice)) throw new ExecutionProviderError('invalid_protection', 'Stop loss and take profit are mandatory');
      if (request.orderType === 'market') {
        if (!(row.bid && row.ask && row.bid > 0 && row.ask >= row.bid && row.quoteTimestampMs)) throw new ExecutionProviderError('invalid_price', 'Broker quote is missing or contradictory');
        if (now() - row.quoteTimestampMs > (config.maxQuoteAgeMs ?? 15_000)) throw new ExecutionProviderError('invalid_price', 'Broker quote is stale');
      }
      const existing = await transport.findOrderByClientId(request.clientOrderId).catch((e) => { throw normalizeMT5Error(e, 'idempotency lookup'); });
      if (existing) {
        if (!statusMap[existing.status.toLowerCase()]) throw new ExecutionProviderError('uncertain', 'Existing broker order has an unknown state; reconciliation is required', { uncertain: true });
        const normalized = normalizeMT5Order(existing);
        return { providerOrderId: normalized.providerOrderId, status: normalized.status === 'rejected' ? 'rejected' : 'accepted', filledQuantity: normalized.filledQuantity, averagePrice: normalized.averagePrice, receipt: normalized.raw };
      }
      try {
        const submitted = await transport.submitOrder({ clientOrderId: request.clientOrderId, symbol: brokerSymbol, side: request.side, orderType: request.orderType, volume: request.quantity, price: request.requestedPrice, stopLoss: request.stopLossPrice, takeProfit: request.takeProfitPrice });
        if (!statusMap[submitted.status.toLowerCase()]) throw new ExecutionProviderError('uncertain', 'Broker returned an unknown order state; reconciliation is required', { uncertain: true });
        const normalized = normalizeMT5Order(submitted);
        return { providerOrderId: normalized.providerOrderId, status: normalized.status === 'rejected' ? 'rejected' : 'accepted', filledQuantity: normalized.filledQuantity, averagePrice: normalized.averagePrice, receipt: normalized.raw };
      } catch (e) { throw normalizeMT5Error(e, 'order submission'); }
    },
    async cancelOrder(id) { await requireAvailable(); try { await transport.cancelOrder(id); } catch (e) { throw normalizeMT5Error(e, 'order cancellation'); } },
    async modifyOrder(id, c) { await requireAvailable(); try { await transport.modifyOrder(id, { stopLoss: c.stopLossPrice, takeProfit: c.takeProfitPrice }); } catch (e) { throw normalizeMT5Error(e, 'order modification'); } },
    async getOrder(id) { await requireAvailable(); try { const row = await transport.order(id); return row ? normalizeMT5Order(row) : null; } catch (e) { throw normalizeMT5Error(e, 'order lookup'); } },
    async listOrders() { await requireAvailable(); try { return (await transport.orders()).map(normalizeMT5Order); } catch (e) { throw normalizeMT5Error(e, 'order listing'); } },
    async getPosition(id) { await requireAvailable(); try { const row = await transport.position(id); return row ? normalizePosition(row, canonicalFor(row.symbol)) : null; } catch (e) { throw normalizeMT5Error(e, 'position lookup'); } },
    async listPositions() { await requireAvailable(); try { return (await transport.positions()).map((p) => normalizePosition(p, canonicalFor(p.symbol))); } catch (e) { throw normalizeMT5Error(e, 'position listing'); } },
    async closePosition(id) { await requireAvailable(); try { await transport.closePosition(id); } catch (e) { throw normalizeMT5Error(e, 'position close'); } },
  };
}
