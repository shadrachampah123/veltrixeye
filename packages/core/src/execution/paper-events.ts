import type { OrderStatus } from '@veltrixeye/contracts';

/**
 * M8.3 — deterministic execution-event collection for the paper simulator.
 *
 * Events are the append-only trail of a simulation attempt. They are
 * accumulated in memory and written once, in order, inside the same
 * transaction as the state they describe — so an event can never exist
 * without its state transition, and a rolled-back attempt leaves no event.
 *
 * Vocabulary (M8.1-documented names + M8.3 additions):
 *   order_validating, order_submitted, order_accepted, order_filled,
 *   order_failed, order_rejected, position_opened, position_modified,
 *   position_closed, paper_execution_rejected, paper_order_replayed,
 *   paper_fill_duplicate_ignored, paper_sl_tp_conflict, paper_position_missing,
 *   paper_exit_failed, paper_result_recorded, reconciliation_passed,
 *   reconciliation_mismatch.
 *
 * Never contains credentials (there are none), and every metadata payload is
 * JSON-serializable by construction.
 */

export interface PaperEventLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface PaperEventEntry {
  event: string;
  fromStatus?: OrderStatus | null;
  toStatus?: OrderStatus | null;
  reason?: string | null;
  metadata: Record<string, unknown>;
}

export class AuditCollector {
  private readonly list: PaperEventEntry[] = [];

  add(
    event: string,
    metadata: Record<string, unknown> = {},
    statuses?: { fromStatus?: OrderStatus | null; toStatus?: OrderStatus | null; reason?: string | null },
  ): void {
    this.list.push({
      event,
      metadata,
      fromStatus: statuses?.fromStatus ?? null,
      toStatus: statuses?.toStatus ?? null,
      reason: statuses?.reason ?? null,
    });
  }

  entries(): PaperEventEntry[] {
    return this.list;
  }

  names(): string[] {
    return this.list.map((e) => e.event);
  }
}
