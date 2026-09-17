-- 0018: paper execution simulator (M8.3)
--
-- M8.3 adds an INTERNAL paper execution simulator on top of the M8.1
-- execution schema. This migration is strictly ADDITIVE:
--
--   execution_orders      + paper provenance (setup, server-issued risk
--                           decision, frozen decision snapshot, simulated
--                           marker, simulator version, costs, reference price)
--   execution_positions   + exit price/reason, opening/closing order links,
--                           costs, mark price, simulated marker
--   execution_fills       NEW append-only fill ledger (exactly-once fills)
--   execution_reconciliations NEW append-only reconciliation trail (M8.5 base)
--
-- Hard safety properties encoded here:
--  - NO credentials, NO broker ids, NO live-execution fields. `provider_slug`
--    remains the only provider reference (paper), and the M8.1 CHECKs that make
--    `demo`/`live` profiles impossible are untouched.
--  - Every simulated row is marked `simulated = true` with an explicit
--    simulator version, so simulated state can never be mistaken for a real
--    broker position.
--  - Exactly-once fills: UNIQUE (order_id, sequence) + UNIQUE idempotency_key.
--  - Impossible position states are refused by CHECK: an open position cannot
--    carry exit data, a closed one cannot omit it.
--  - `execution_fills` and `execution_reconciliations` are append-only
--    (append_only_guard), and reconciliation NEVER mutates financial state.
--  - No existing constraint is altered and no existing column is dropped.

-- ---------------------------------------------------------------------------
-- Paper provenance + costs on orders
-- ---------------------------------------------------------------------------
ALTER TABLE execution_orders
  ADD COLUMN setup_id            uuid REFERENCES setups (id) ON DELETE SET NULL,
  ADD COLUMN risk_decision_id    uuid REFERENCES risk_decisions (id) ON DELETE SET NULL,
  -- Frozen server-built decision snapshot (same shape as execution_requests.decision).
  ADD COLUMN decision            jsonb,
  -- True for every order the M8.3 simulator creates; M8.1/M8.2 created none.
  ADD COLUMN simulated           boolean NOT NULL DEFAULT false,
  ADD COLUMN simulator_version   text,
  ADD COLUMN fees                numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN slippage            numeric(24, 10) NOT NULL DEFAULT 0,
  -- The server-provided market reference used for the fill (never client input).
  ADD COLUMN reference_price     numeric(24, 10),
  ADD COLUMN reference_price_ms  bigint;

ALTER TABLE execution_orders
  ADD CONSTRAINT execution_orders_costs_check
    CHECK (fees >= 0 AND slippage >= 0),
  ADD CONSTRAINT execution_orders_reference_price_check
    CHECK (reference_price IS NULL OR reference_price > 0),
  -- A simulated order must carry its simulator version AND decision snapshot:
  -- simulated rows are always fully traceable to a server-issued decision.
  ADD CONSTRAINT execution_orders_simulated_provenance_check
    CHECK (simulated = false OR (simulator_version IS NOT NULL AND decision IS NOT NULL));

CREATE INDEX execution_orders_setup_idx ON execution_orders (setup_id);
CREATE INDEX execution_orders_risk_decision_idx ON execution_orders (risk_decision_id);
CREATE INDEX execution_orders_simulated_idx ON execution_orders (execution_profile_id, simulated, created_at DESC);

-- ---------------------------------------------------------------------------
-- Paper position lifecycle + exit accounting
-- ---------------------------------------------------------------------------
ALTER TABLE execution_positions
  ADD COLUMN setup_id            uuid REFERENCES setups (id) ON DELETE SET NULL,
  ADD COLUMN opened_by_order_id  uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  ADD COLUMN closed_by_order_id  uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  ADD COLUMN exit_price          numeric(24, 10),
  ADD COLUMN exit_reason         text,
  ADD COLUMN fees                numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN slippage            numeric(24, 10) NOT NULL DEFAULT 0,
  ADD COLUMN mark_price          numeric(24, 10),
  ADD COLUMN mark_price_ms       bigint,
  ADD COLUMN simulated           boolean NOT NULL DEFAULT false,
  ADD COLUMN simulator_version   text;

ALTER TABLE execution_positions
  ADD CONSTRAINT execution_positions_exit_check
    CHECK (
      (status = 'open' AND exit_price IS NULL AND exit_reason IS NULL)
      OR (status = 'closed' AND exit_price IS NOT NULL AND exit_reason IS NOT NULL)
    ),
  ADD CONSTRAINT execution_positions_exit_reason_check
    CHECK (exit_reason IS NULL OR exit_reason IN ('stop_loss', 'take_profit', 'close')),
  ADD CONSTRAINT execution_positions_costs_check
    CHECK (fees >= 0 AND slippage >= 0),
  ADD CONSTRAINT execution_positions_mark_price_check
    CHECK (mark_price IS NULL OR mark_price > 0),
  ADD CONSTRAINT execution_positions_exit_price_check
    CHECK (exit_price IS NULL OR exit_price > 0);

CREATE INDEX execution_positions_setup_idx ON execution_positions (setup_id);
CREATE INDEX execution_positions_open_idx
  ON execution_positions (user_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Fill ledger (append-only, exactly-once)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_fills (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  order_id             uuid NOT NULL REFERENCES execution_orders (id) ON DELETE CASCADE,
  position_id          uuid REFERENCES execution_positions (id) ON DELETE SET NULL,
  setup_id             uuid REFERENCES setups (id) ON DELETE SET NULL,
  -- Monotonic within an order (the simulator always writes sequence 1).
  sequence             integer NOT NULL,
  fill_type            text NOT NULL,
  quantity             numeric(24, 10) NOT NULL,
  price                numeric(24, 10) NOT NULL,
  fees                 numeric(24, 10) NOT NULL DEFAULT 0,
  slippage             numeric(24, 10) NOT NULL DEFAULT 0,
  reference_price      numeric(24, 10),
  simulated            boolean NOT NULL DEFAULT false,
  -- sha256 of the deterministic fill identity; a repeated fill collapses here.
  idempotency_key      text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (sequence > 0),
  CHECK (fill_type IN ('entry', 'stop_loss', 'take_profit', 'close')),
  CHECK (quantity > 0),
  CHECK (price > 0),
  CHECK (fees >= 0 AND slippage >= 0),
  CHECK (reference_price IS NULL OR reference_price > 0),
  CHECK (char_length(idempotency_key) = 64)
);

CREATE UNIQUE INDEX execution_fills_idempotency_idx
  ON execution_fills (idempotency_key);
-- THE duplicate-fill guarantee: one fill per (order, sequence), forever.
CREATE UNIQUE INDEX execution_fills_order_sequence_idx
  ON execution_fills (order_id, sequence);
CREATE INDEX execution_fills_user_idx ON execution_fills (user_id, created_at DESC);
CREATE INDEX execution_fills_position_idx ON execution_fills (position_id);
CREATE INDEX execution_fills_order_idx ON execution_fills (order_id);

CREATE TRIGGER execution_fills_append_only
BEFORE UPDATE OR DELETE ON execution_fills
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------------------
-- Reconciliation trail (append-only; M8.5 foundation)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_reconciliations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  order_id             uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  position_id          uuid REFERENCES execution_positions (id) ON DELETE SET NULL,
  scope                text NOT NULL,
  outcome              text NOT NULL,
  -- Machine-readable finding codes (PAPER_RECONCILIATION_FINDINGS).
  findings             jsonb NOT NULL DEFAULT '[]',
  -- Expected vs. observed state, for auditors and the future M8.5 subsystem.
  expected             jsonb NOT NULL DEFAULT '{}',
  actual               jsonb NOT NULL DEFAULT '{}',
  simulator_version    text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (scope IN ('order', 'position')),
  CHECK (outcome IN ('ok', 'mismatch')),
  CHECK (jsonb_typeof(findings) = 'array'),
  CHECK (char_length(simulator_version) BETWEEN 1 AND 64)
);

CREATE INDEX execution_reconciliations_user_idx
  ON execution_reconciliations (user_id, created_at DESC);
CREATE INDEX execution_reconciliations_profile_idx
  ON execution_reconciliations (execution_profile_id, created_at DESC);
CREATE INDEX execution_reconciliations_position_idx
  ON execution_reconciliations (position_id);

CREATE TRIGGER execution_reconciliations_append_only
BEFORE UPDATE OR DELETE ON execution_reconciliations
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

COMMENT ON TABLE execution_orders IS
  'M8.1: order lifecycle rows. M8.3: the paper simulator creates them with simulated = true, a frozen server-issued decision snapshot and the originating risk_decision_id. No broker order exists anywhere.';
COMMENT ON TABLE execution_positions IS
  'M8.1/M8.3: position rows. Paper positions record entry/exit price, exit reason, costs and mark price; reconciliation-ready.';
COMMENT ON TABLE execution_fills IS
  'M8.3: append-only fill ledger. UNIQUE (order_id, sequence) + UNIQUE idempotency_key make duplicate fill processing impossible.';
COMMENT ON TABLE execution_reconciliations IS
  'M8.3: append-only reconciliation trail comparing expected vs. simulated order/position state. Mismatches fail closed and are never auto-corrected.';
COMMENT ON COLUMN execution_orders.decision IS
  'M8.3: frozen server-built execution decision snapshot (provenance: strategy, version, setup, levels, RR, quality, anchor). Never client-supplied.';
COMMENT ON COLUMN execution_orders.simulated IS
  'M8.3: true for every internally simulated paper order. A simulated row is never a broker order.';
