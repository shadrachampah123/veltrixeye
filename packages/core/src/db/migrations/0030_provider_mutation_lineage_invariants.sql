-- 0030: M10 Gate 9 Step 3c (M3) — structural duplicate-mutation and retry
-- invariants for the provider-submit mutation ledger.
--
-- Defense-in-depth for the application-level checks performed inside the
-- `prepareSubmit` / `prepareRetry` transactions of `ProviderMutationLedger`
-- (advisory lock + read + write in ONE transaction). The database enforces the
-- same invariants so that no writer — concurrent, restarted, or one that skips
-- the lock — can persist a second live mutation for a managed order, a second
-- retry of one parent, or a duplicated attempt inside one lineage.
--
-- This migration is ADDITIVE ONLY: three partial UNIQUE indexes and a
-- pre-flight that refuses to apply on conflicting data. Migration 0029 is
-- byte-identical. No constraint, trigger, function, column or table created by
-- 0029 (or earlier) is dropped, replaced, rewritten or weakened, and the M2
-- barrier-consumption semantics (`state_version` CAS) are untouched.
--
-- Invariants encoded here (M3):
--
--   1. A parent intent may have at most one retry.
--        UNIQUE (parent_intent_id)                    WHERE parent_intent_id IS NOT NULL
--   2. A lineage may not contain duplicate attempts.
--        UNIQUE (root_intent_id, attempt)             WHERE root_intent_id IS NOT NULL
--   3. A managed order carries at most one LIVE submit mutation, where "live"
--      means unresolved (`prepared` / `submitting` / `uncertain`) OR
--      provider-accepted (`confirmed`, or `reconciled` with
--      `resolution = 'provider_accepted'`).
--        UNIQUE (execution_profile_id, order_id)      WHERE order_id IS NOT NULL
--                                                       AND mutation_kind = 'submit'
--                                                       AND idempotency_key IS NOT NULL
--                                                       AND <live predicate>
--      This subsumes "at most one unresolved mutation per managed order" and
--      additionally pins Gate 9 invariant 7 at the database level: once a
--      submit for an order is provider-accepted, neither a retry nor a
--      start-over may create another mutation for the SAME order identity —
--      a further order after confirmation must use a distinct logical order
--      identity. After an explicit `provider_absent` (or `provider_rejected` /
--      `rejected`) resolution the row leaves the predicate, so a subsequent
--      new mutation for that order may proceed.
--
-- Identity scoping (deliberate):
--   * NO global uniqueness on `client_order_id` is introduced or changed; the
--     per-profile mutation identity indexes from 0019/0029 stay as they are.
--   * The order-level index is keyed by (execution_profile_id, order_id): the
--     same per-profile scoping 0029 uses for every mutation identity index.
--     `order_id` references the `execution_orders` primary key, and the
--     composite (execution_profile_id, user_id) ownership FK from 0029 binds the
--     profile to its user, so the tenant/profile dimension is preserved without
--     assuming anything about `order_id` beyond the existing FK.
--   * Different orders, different execution profiles and different
--     provider/environment/account bindings therefore remain independent
--     wherever the existing identity model permits them.
--
-- Upgrade safety:
--   * Every index is partial. Legacy (pre-0029) rows carry no idempotency key,
--     no lineage (parent/root NULL) and attempt = 1, so they can never
--     participate in any of the three indexes.
--   * The pre-flight below inspects existing rows first. If Gate 9 rows already
--     violate an invariant, the migration RAISES and the whole migration
--     transaction rolls back: nothing is rewritten, deleted or "cleaned up".
--     The conflict must be reviewed and resolved by an operator before the
--     migration is re-run. (Note: `execution_provider_intents` has no production
--     writer other than the Gate 9 ledger, which nothing in `apps/` invokes.)
--
-- Nothing in this migration enables live MT5/Exness execution, wires a broker
-- transport, activates a provider, generates or approves a risk decision or
-- authorization, or performs automatic repair/retry/reconciliation.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse (never repair) if existing rows violate an invariant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  duplicate_parents     integer;
  duplicate_attempts    integer;
  duplicate_live_orders integer;
BEGIN
  SELECT count(*) INTO duplicate_parents FROM (
    SELECT parent_intent_id
      FROM execution_provider_intents
     WHERE parent_intent_id IS NOT NULL
     GROUP BY parent_intent_id
    HAVING count(*) > 1
  ) AS d;

  SELECT count(*) INTO duplicate_attempts FROM (
    SELECT root_intent_id, attempt
      FROM execution_provider_intents
     WHERE root_intent_id IS NOT NULL
     GROUP BY root_intent_id, attempt
    HAVING count(*) > 1
  ) AS d;

  SELECT count(*) INTO duplicate_live_orders FROM (
    SELECT execution_profile_id, order_id
      FROM execution_provider_intents
     WHERE order_id IS NOT NULL
       AND mutation_kind = 'submit'
       AND idempotency_key IS NOT NULL
       AND (
         status IN ('prepared', 'submitting', 'uncertain', 'confirmed')
         OR (status = 'reconciled' AND resolution = 'provider_accepted')
       )
     GROUP BY execution_profile_id, order_id
    HAVING count(*) > 1
  ) AS d;

  IF duplicate_parents > 0 OR duplicate_attempts > 0 OR duplicate_live_orders > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        '0030 refused: existing execution_provider_intents rows violate the Gate 9 M3 invariants '
        || '(%s parent intents with more than one retry, %s lineages with a duplicated attempt, '
        || '%s managed orders with more than one live submit mutation). No data was modified; '
        || 'review and resolve the conflicting rows before re-running this migration.',
        duplicate_parents, duplicate_attempts, duplicate_live_orders
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. A parent intent may have at most one retry.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_parent_uniq
  ON execution_provider_intents (parent_intent_id)
  WHERE parent_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A lineage may not contain duplicate attempts.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_lineage_attempt_uniq
  ON execution_provider_intents (root_intent_id, attempt)
  WHERE root_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. At most one LIVE (unresolved or provider-accepted) submit mutation per
--    managed order, scoped to the owning execution profile and to Gate 9 rows.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_order_live_uniq
  ON execution_provider_intents (execution_profile_id, order_id)
  WHERE order_id IS NOT NULL
    AND mutation_kind = 'submit'
    AND idempotency_key IS NOT NULL
    AND (
      status IN ('prepared', 'submitting', 'uncertain', 'confirmed')
      OR (status = 'reconciled' AND resolution = 'provider_accepted')
    );

COMMENT ON INDEX execution_provider_intents_parent_uniq IS
  'M10 Gate 9 M3: a parent intent may have at most one retry (no sibling retries).';
COMMENT ON INDEX execution_provider_intents_lineage_attempt_uniq IS
  'M10 Gate 9 M3: a retry lineage may not contain duplicate attempt numbers.';
COMMENT ON INDEX execution_provider_intents_order_live_uniq IS
  'M10 Gate 9 M3: at most one live (unresolved or provider-accepted) submit mutation per managed order within its execution profile. Rows leave the predicate only through rejected / provider_rejected / provider_absent resolution.';
