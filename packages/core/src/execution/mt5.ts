import {
  ExecutionProviderError,
  MT5_EXECUTION_PROVIDER_ID,
  type AssetClass,
  type ExecutionAccountInfo,
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

export function normalizeMT5Error(error: unknown, operation: string): ExecutionProviderError {
  if (error instanceof ExecutionProviderError) return error;
  const e = error as MT5TransportError | null;
  const code = String(e?.code ?? '').toLowerCase();
  const message = String(e?.message ?? '').toLowerCase();
  if (e?.responseLost) return new ExecutionProviderError('uncertain', `${operation} outcome is uncertain; reconciliation is required`, { cause: error, uncertain: true });
  if (/auth|login|credential|10017/.test(`${code} ${message}`)) return new ExecutionProviderError('authentication', 'Broker authentication failed', { cause: error });
  if (/timeout|timedout/.test(`${code} ${message}`)) return new ExecutionProviderError('timeout', `${operation} timed out before submission was confirmed`, { cause: error });
  if (/connect|network|socket/.test(`${code} ${message}`)) return new ExecutionProviderError('connection', 'Broker connection failed', { cause: error });
  if (/symbol/.test(`${code} ${message}`)) return new ExecutionProviderError('invalid_symbol', 'Broker rejected the instrument', { cause: error });
  if (/volume|lot/.test(`${code} ${message}`)) return new ExecutionProviderError('invalid_volume', 'Broker rejected the volume', { cause: error });
  if (/margin|fund/.test(`${code} ${message}`)) return new ExecutionProviderError('insufficient_funds', 'Broker reported insufficient margin', { cause: error });
  if (/market.closed|trade.disabled/.test(`${code} ${message}`)) return new ExecutionProviderError('market_closed', 'Broker market is closed or trading is disabled', { cause: error });
  if (operation === 'order submission') {
    return new ExecutionProviderError('uncertain', 'Order submission returned an unrecognized broker state; reconciliation is required', { cause: error, uncertain: true });
  }
  return new ExecutionProviderError('unknown', `${operation} failed with an unrecognized broker response`, { cause: error });
}

export function normalizeMT5Order(row: MT5OrderSnapshot): ExecutionProviderOrderState {
  return {
    providerOrderId: row.ticket,
    status: statusMap[row.status.toLowerCase()] ?? 'failed',
    filledQuantity: row.filledVolume ?? 0,
    averagePrice: row.averagePrice ?? null,
    raw: { retcode: row.retcode ?? null, message: row.message?.slice(0, 256) ?? null, timestampMs: row.timestampMs },
  };
}

function normalizePosition(row: MT5PositionSnapshot, canonical: string): ExecutionProviderPositionState {
  return {
    providerPositionId: row.ticket, assetClass: 'other', symbol: canonical,
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
        const available = h.configured && h.authenticated && h.connected;
        return { configured: h.configured, authenticated: h.authenticated, connected: h.connected, available, healthy: available && h.healthy, state: available && h.healthy ? 'healthy' : available ? 'degraded' : 'unavailable', reason: h.reason, checkedAt };
      } catch (e) {
        const err = normalizeMT5Error(e, 'health check');
        return { configured: transport.configured, authenticated: false, connected: false, available: false, healthy: false, state: 'unavailable', reason: err.category, checkedAt };
      }
    },
    async getAccountInfo(): Promise<ExecutionAccountInfo | null> {
      await requireAvailable();
      try { const a = await transport.account(); return { accountRef: config.accountRef ?? a.login, broker: a.broker, server: a.server, environment: 'demo', currency: a.currency ?? null, balance: a.balance ?? null, equity: a.equity ?? null, marginFree: a.marginFree ?? null }; }
      catch (e) { throw normalizeMT5Error(e, 'account lookup'); }
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
