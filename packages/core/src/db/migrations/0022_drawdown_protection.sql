-- 0022: drawdown-based circuit breakers and equity protection (M8.7)
--
-- M8.7 adds drawdown protection on top of M8.6's safety controls.
-- All additions are additive — no existing constraint altered.
--
-- What this migration adds:
--   risk_policies.drawdown_* — configurable drawdown thresholds (warning + hard-stop)
--       for daily, weekly, and maximum drawdown. Defaults are safe and strictly
--       inside the platform ceilings. Hard-stops are platform-controlled.
--   risk_account_states.*_equity / *_drawdown — authoritative peak tracking and
--       current drawdown state, computed from immutable initial_equity + cumulative P&L.
--       Stale/missing data fails closed (equity data unavailable rejection).
--
-- Live execution remains impossible (0016 CHECK intact); no credentials added.

-- ---------------------------------------------------------------------------
-- Risk policies: drawdown threshold configuration
-- ---------------------------------------------------------------------------
ALTER TABLE risk_policies
  ADD COLUMN daily_drawdown_warning_pct  numeric(8,4) NOT NULL DEFAULT 2.0,
  ADD COLUMN daily_drawdown_limit_pct    numeric(8,4) NOT NULL DEFAULT 3.0,
  ADD COLUMN weekly_drawdown_warning_pct numeric(8,4) NOT NULL DEFAULT 4.0,
  ADD COLUMN weekly_drawdown_limit_pct   numeric(8,4) NOT NULL DEFAULT 6.0,
  ADD COLUMN max_drawdown_warning_pct    numeric(8,4) NOT NULL DEFAULT 8.0,
  ADD COLUMN max_drawdown_limit_pct      numeric(8,4) NOT NULL DEFAULT 10.0;

-- Ceiling CHECKs: drawdown thresholds must stay within platform limits.
ALTER TABLE risk_policies
  ADD CONSTRAINT risk_policies_daily_drawdown_warning_check
  CHECK (daily_drawdown_warning_pct > 0 AND daily_drawdown_warning_pct <= 10),
  ADD CONSTRAINT risk_policies_daily_drawdown_limit_check
  CHECK (daily_drawdown_limit_pct > 0 AND daily_drawdown_limit_pct <= 10),
  ADD CONSTRAINT risk_policies_weekly_drawdown_warning_check
  CHECK (weekly_drawdown_warning_pct > 0 AND weekly_drawdown_warning_pct <= 15),
  ADD CONSTRAINT risk_policies_weekly_drawdown_limit_check
  CHECK (weekly_drawdown_limit_pct > 0 AND weekly_drawdown_limit_pct <= 15),
  ADD CONSTRAINT risk_policies_max_drawdown_warning_check
  CHECK (max_drawdown_warning_pct > 0 AND max_drawdown_warning_pct <= 25),
  ADD CONSTRAINT risk_policies_max_drawdown_limit_check
  CHECK (max_drawdown_limit_pct > 0 AND max_drawdown_limit_pct <= 25);

-- Warning must be <= hard-stop for each drawdown type.
ALTER TABLE risk_policies
  ADD CONSTRAINT risk_policies_daily_drawdown_order_check
  CHECK (daily_drawdown_warning_pct <= daily_drawdown_limit_pct),
  ADD CONSTRAINT risk_policies_weekly_drawdown_order_check
  CHECK (weekly_drawdown_warning_pct <= weekly_drawdown_limit_pct),
  ADD CONSTRAINT risk_policies_max_drawdown_order_check
  CHECK (max_drawdown_warning_pct <= max_drawdown_limit_pct);

COMMENT ON COLUMN risk_policies.daily_drawdown_warning_pct IS
  'M8.7: daily drawdown warning threshold (% from daily high). Informational — does not trip breaker.';
COMMENT ON COLUMN risk_policies.daily_drawdown_limit_pct IS
  'M8.7: daily drawdown hard-stop threshold (% from daily high). Trips the circuit breaker.';
COMMENT ON COLUMN risk_policies.weekly_drawdown_warning_pct IS
  'M8.7: weekly drawdown warning threshold (% from weekly open). Informational.';
COMMENT ON COLUMN risk_policies.weekly_drawdown_limit_pct IS
  'M8.7: weekly drawdown hard-stop threshold (% from weekly open). Trips the circuit breaker.';
COMMENT ON COLUMN risk_policies.max_drawdown_warning_pct IS
  'M8.7: maximum drawdown warning threshold (% from peak equity). Informational.';
COMMENT ON COLUMN risk_policies.max_drawdown_limit_pct IS
  'M8.7: maximum drawdown hard-stop threshold (% from peak equity). Trips the circuit breaker.';

-- ---------------------------------------------------------------------------
-- Risk account states: drawdown tracking
-- ---------------------------------------------------------------------------
ALTER TABLE risk_account_states
  ADD COLUMN initial_equity        numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN peak_equity           numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN current_drawdown_pct  numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN daily_high_value      numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN daily_drawdown_pct    numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN weekly_open_value     numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN weekly_drawdown_pct   numeric(10,6) NOT NULL DEFAULT 0,
  -- Cumulative (all-time) realized P&L — not windowed, never reset.
  -- Used to compute current account value for drawdown calculations.
  ADD COLUMN cumulative_realized_pl numeric(18,4) NOT NULL DEFAULT 0,
  -- Track whether the equity baseline has been initialized
  -- (false = uninitialized; prevents false drawdown calculations on fresh accounts)
  ADD COLUMN equity_initialized    boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN risk_account_states.initial_equity IS
  'M8.7: immutable paper-equity baseline captured when risk tracking begins.';
COMMENT ON COLUMN risk_account_states.peak_equity IS
  'M8.7: highest account value ever recorded (initial_equity + cumulative P&L).';
COMMENT ON COLUMN risk_account_states.current_drawdown_pct IS
  'M8.7: current drawdown from peak (0–100+ %).';
COMMENT ON COLUMN risk_account_states.daily_high_value IS
  'M8.7: highest account value today (UTC). Reset on daily window rollover.';
COMMENT ON COLUMN risk_account_states.daily_drawdown_pct IS
  'M8.7: current drawdown from today''s high (0–100+ %).';
COMMENT ON COLUMN risk_account_states.weekly_open_value IS
  'M8.7: account value at the start of the UTC week.';
COMMENT ON COLUMN risk_account_states.weekly_drawdown_pct IS
  'M8.7: current drawdown from weekly open (0–100+ %).';
COMMENT ON COLUMN risk_account_states.equity_initialized IS
  'M8.7: false until the first evaluation populates drawdown baselines.';

-- ---------------------------------------------------------------------------
-- Existing-state initialization
-- ---------------------------------------------------------------------------
-- M8.1-M8.6 rows predate the drawdown columns. Initialize only from
-- server-owned values already present in the database:
--   * paper_equity is the existing policy baseline;
--   * closed simulated positions provide an exact historical realized sum;
--   * when no closed positions exist, known negative daily/weekly losses are
--     retained conservatively rather than inventing a favorable balance;
--   * rows with a closed position missing realized P&L still receive a
--     conservative baseline, but the runtime integrity check rejects them
--     until the authoritative ledger can be verified.
-- The peak is the greatest observed value from the closed-position equity
-- curve, never a user-supplied uplift.
WITH closed AS (
  SELECT
    p.execution_profile_id,
    SUM(p.realized_pl) AS closed_sum,
    COUNT(*) FILTER (WHERE p.realized_pl IS NULL) AS missing_realized_count
  FROM execution_positions p
  WHERE p.simulated = true AND p.status = 'closed'
  GROUP BY p.execution_profile_id
),
curve AS (
  SELECT
    p.execution_profile_id,
    TRUNC(rp.paper_equity, 4)
      + SUM(p.realized_pl) OVER (
          PARTITION BY p.execution_profile_id
          ORDER BY p.closed_at ASC, p.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS account_value
  FROM execution_positions p
  JOIN risk_account_states s ON s.execution_profile_id = p.execution_profile_id
  JOIN execution_profiles ep ON ep.id = p.execution_profile_id
  JOIN risk_policies rp ON rp.user_id = ep.user_id
  WHERE p.simulated = true AND p.status = 'closed' AND p.realized_pl IS NOT NULL
),
curve_peaks AS (
  SELECT execution_profile_id, MAX(account_value) AS observed_peak
  FROM curve
  GROUP BY execution_profile_id
),
prepared AS (
  SELECT
    s.id,
    TRUNC(rp.paper_equity, 4) AS initial_equity,
    ROUND(CASE
      WHEN c.closed_sum IS NOT NULL THEN c.closed_sum
      ELSE LEAST(0::numeric, s.daily_realized_pl, s.weekly_realized_pl)
    END, 4) AS cumulative_realized_pl,
    TRUNC(GREATEST(TRUNC(rp.paper_equity, 4), COALESCE(cp.observed_peak, TRUNC(rp.paper_equity, 4))), 4) AS peak_equity,
    COALESCE(c.missing_realized_count, 0) AS missing_realized_count
  FROM risk_account_states s
  JOIN execution_profiles ep ON ep.id = s.execution_profile_id
  JOIN risk_policies rp ON rp.user_id = ep.user_id
  LEFT JOIN closed c ON c.execution_profile_id = s.execution_profile_id
  LEFT JOIN curve_peaks cp ON cp.execution_profile_id = s.execution_profile_id
  WHERE s.equity_initialized = false
    AND rp.paper_equity >= 100
    AND rp.paper_equity <= 1000000
),
prepared_values AS (
  SELECT
    prepared.*,
    prepared.initial_equity + prepared.cumulative_realized_pl AS current_value
  FROM prepared
)
UPDATE risk_account_states s
SET initial_equity = v.initial_equity,
    cumulative_realized_pl = v.cumulative_realized_pl,
    peak_equity = v.peak_equity,
    daily_high_value = v.peak_equity,
    weekly_open_value = v.peak_equity,
    current_drawdown_pct = CASE
      WHEN v.peak_equity > 0
        THEN GREATEST(0::numeric, (v.peak_equity - v.current_value) * 100 / v.peak_equity)
      ELSE 0
    END,
    daily_drawdown_pct = CASE
      WHEN v.peak_equity > 0
        THEN GREATEST(0::numeric, (v.peak_equity - v.current_value) * 100 / v.peak_equity)
      ELSE 0
    END,
    weekly_drawdown_pct = CASE
      WHEN v.peak_equity > 0
        THEN GREATEST(0::numeric, (v.peak_equity - v.current_value) * 100 / v.peak_equity)
      ELSE 0
    END,
    equity_initialized = true
FROM prepared_values v
WHERE s.id = v.id;
