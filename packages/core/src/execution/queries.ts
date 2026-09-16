import type pg from 'pg';
import {
  type ExecutionAuditEventDto,
  type ExecutionOrderDto,
  type ExecutionPositionDto,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type PositionStatus,
} from '@veltrixeye/contracts';

/**
 * M8.1 — owner-scoped read models for the execution domain.
 *
 * Every list is scoped by `user_id = caller`; there is no unscoped read path
 * in the API layer. M8.1 legitimately returns EMPTY lists for orders and
 * positions (no provider can trade yet) — the queries exist and are tested
 * so M8.2+ cannot accidentally regress owner scoping when rows appear.
 */
export class ExecutionQueryService {
  constructor(private readonly pool: pg.Pool) {}

  async listOrders(userId: string, limit: number): Promise<{ orders: ExecutionOrderDto[] }> {
    const res = await this.pool.query<OrderRow>(
      `SELECT * FROM execution_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return { orders: res.rows.map(toOrderDto) };
  }

  async listPositions(userId: string, limit: number): Promise<{ positions: ExecutionPositionDto[] }> {
    const res = await this.pool.query<PositionRow>(
      `SELECT * FROM execution_positions WHERE user_id = $1 ORDER BY opened_at DESC LIMIT $2`,
      [userId, limit],
    );
    return { positions: res.rows.map(toPositionDto) };
  }

  async listEvents(userId: string, limit: number): Promise<{ events: ExecutionAuditEventDto[] }> {
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM execution_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, limit],
    );
    return { events: res.rows.map(toEventDto) };
  }
}

interface OrderRow {
  id: string;
  execution_profile_id: string;
  execution_request_id: string | null;
  client_order_id: string;
  provider_slug: string;
  provider_order_id: string | null;
  asset_class: string;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  quantity: string;
  requested_price: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  status: OrderStatus;
  reject_reason: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  filled_at: Date | null;
}

function toOrderDto(row: OrderRow): ExecutionOrderDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    executionRequestId: row.execution_request_id,
    clientOrderId: row.client_order_id,
    providerSlug: row.provider_slug,
    providerOrderId: row.provider_order_id,
    assetClass: row.asset_class as ExecutionOrderDto['assetClass'],
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type,
    quantity: Number(row.quantity),
    requestedPrice: row.requested_price === null ? null : Number(row.requested_price),
    stopLossPrice: row.stop_loss_price === null ? null : Number(row.stop_loss_price),
    takeProfitPrice: row.take_profit_price === null ? null : Number(row.take_profit_price),
    status: row.status,
    rejectReason: row.reject_reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    filledAt: row.filled_at ? row.filled_at.toISOString() : null,
  };
}

interface PositionRow {
  id: string;
  execution_profile_id: string;
  provider_slug: string;
  provider_position_id: string | null;
  asset_class: string;
  symbol: string;
  direction: 'long' | 'short';
  quantity: string;
  average_entry_price: string;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  realized_pl: string | null;
  unrealized_pl: string | null;
  status: PositionStatus;
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
}

function toPositionDto(row: PositionRow): ExecutionPositionDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    providerSlug: row.provider_slug,
    providerPositionId: row.provider_position_id,
    assetClass: row.asset_class as ExecutionPositionDto['assetClass'],
    symbol: row.symbol,
    direction: row.direction,
    quantity: Number(row.quantity),
    averageEntryPrice: Number(row.average_entry_price),
    stopLossPrice: row.stop_loss_price === null ? null : Number(row.stop_loss_price),
    takeProfitPrice: row.take_profit_price === null ? null : Number(row.take_profit_price),
    realizedPl: row.realized_pl === null ? null : Number(row.realized_pl),
    unrealizedPl: row.unrealized_pl === null ? null : Number(row.unrealized_pl),
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

interface EventRow {
  id: string;
  execution_profile_id: string | null;
  order_id: string | null;
  position_id: string | null;
  setup_id: string | null;
  event: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toEventDto(row: EventRow): ExecutionAuditEventDto {
  const entityType = ((): ExecutionAuditEventDto['entityType'] => {
    if (row.order_id) return 'order';
    if (row.position_id) return 'position';
    if (row.event.startsWith('execution_')) return 'request';
    return 'request';
  })();
  return {
    id: String(row.id),
    entityType,
    orderId: row.order_id,
    positionId: row.position_id,
    executionProfileId: row.execution_profile_id,
    setupId: row.setup_id,
    event: row.event,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}
