-- 0040: Billing FX source approvals — database-enforced, append-only,
-- single-use, and bound to the exact proposed rate.
--
-- Billing Step 4 remediation (PR #150 review, findings H2, H3, H4).
--
-- WHAT THIS MIGRATION ESTABLISHES
--
--   * An approval is a row in `billing_fx_source_approvals`. It can be created
--     only by `billing_record_fx_source_approval()`, a SECURITY DEFINER function
--     that refuses any session whose login is not a member of the
--     `veltrixeye_fx_approver` role. The approver recorded is the session login
--     (`session_user`), never a free-text name.
--   * An approval binds a FINGERPRINT (SHA-256) of the exact source, source
--     reference, currency pair, rate value, rate scale, rounding mode, effective
--     instant and capture instant. Publication recomputes the fingerprint from
--     its own inputs and refuses any difference, so changing ANY bound field
--     after approval is a refusal, not a silent re-authorization.
--   * An approval expires one hour after it is recorded.
--   * An approval is SINGLE-USE. Consumption is a row in
--     `billing_fx_source_approval_consumptions` keyed by the approval id (the
--     primary key makes a second consumption impossible), written in the same
--     transaction as the published rate version and its audit event.
--   * Separation of duties: the publisher login must differ from the approver
--     login. This is enforced both by `billing_publish_fx_rate_version()` and by
--     a CHECK constraint on the consumption table.
--   * Approval and consumption rows are append-only: UPDATE, DELETE and TRUNCATE
--     are refused by trigger for every role, and no ordinary role holds INSERT
--     on them (only the SECURITY DEFINER functions write them).
--   * No ordinary role can insert into `billing_fx_rate_versions` any more: the
--     public INSERT privilege is revoked, and publication goes through the
--     function. Migrations do NOT create login or group roles; they only grant
--     EXECUTE to roles that already exist (see the DBA script
--     `scripts/billing/fx-approval-roles.sql`). Until a DBA provisions the roles
--     every approval and publication is refused — the fail-closed default.
--
-- HONEST LIMITATION (stated here and in docs/billing.md): the table OWNER can
-- still `ALTER TABLE … DISABLE TRIGGER` or drop the functions. Database-level
-- append-only protection therefore holds against every role that does not own
-- these objects. The application login that runs migrations owns them unless
-- the deployment separates object ownership — a prerequisite the operator must
-- meet before relying on these controls against a privileged database user.

-- ---------------------------------------------------------------------------
-- The fingerprint: one canonical, deterministic digest of every bound field.
-- Timestamps are bound at microsecond precision as integers, so the digest is
-- independent of session time zone and display format.
-- ---------------------------------------------------------------------------
CREATE FUNCTION billing_fx_approval_fingerprint(
  p_source text,
  p_source_reference text,
  p_base_currency text,
  p_quote_currency text,
  p_fx_rate_scaled bigint,
  p_fx_rate_scale integer,
  p_rounding_mode text,
  p_effective_from timestamptz,
  p_captured_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT encode(
    sha256(convert_to(
      concat_ws(
        E'\x1f',
        'billing-fx-approval-v1',
        p_source,
        p_source_reference,
        p_base_currency,
        p_quote_currency,
        p_fx_rate_scaled::text,
        p_fx_rate_scale::text,
        p_rounding_mode,
        ((extract(epoch FROM p_effective_from) * 1000000)::bigint)::text,
        ((extract(epoch FROM p_captured_at) * 1000000)::bigint)::text
      ),
      'UTF8'
    )),
    'hex'
  )
$$;

-- Role membership of the session login. Returns false (never errors) when the
-- role does not exist, so a missing role is a plain refusal.
CREATE FUNCTION billing_fx_principal_has_role(p_role text) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF to_regrole(p_role) IS NULL THEN
    RETURN false;
  END IF;
  RETURN pg_has_role(session_user, p_role::name, 'MEMBER');
END
$$;

-- ---------------------------------------------------------------------------
-- Approval records
-- ---------------------------------------------------------------------------
CREATE TABLE billing_fx_source_approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  source text NOT NULL,
  source_reference text NOT NULL,
  base_currency text NOT NULL,
  quote_currency text NOT NULL,
  fx_rate_scaled bigint NOT NULL,
  fx_rate_scale integer NOT NULL,
  rounding_mode text NOT NULL,
  effective_from timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,

  fingerprint text NOT NULL,
  reason text NOT NULL,
  approver_principal text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,

  CONSTRAINT billing_fx_source_approvals_source_check
    CHECK (source IN ('ops', 'import')),
  CONSTRAINT billing_fx_source_approvals_reference_check
    CHECK (char_length(source_reference) BETWEEN 1 AND 190 AND source_reference !~ '[[:cntrl:]]'),
  CONSTRAINT billing_fx_source_approvals_pair_check
    CHECK (base_currency = 'USD' AND quote_currency = 'GHS'),
  CONSTRAINT billing_fx_source_approvals_rate_check
    CHECK (fx_rate_scaled > 0 AND fx_rate_scale BETWEEN 1 AND 18),
  CONSTRAINT billing_fx_source_approvals_rounding_check
    CHECK (rounding_mode = 'half_up'),
  CONSTRAINT billing_fx_source_approvals_captured_check
    CHECK (captured_at <= effective_from),
  CONSTRAINT billing_fx_source_approvals_expiry_check
    CHECK (expires_at = approved_at + interval '1 hour'),
  CONSTRAINT billing_fx_source_approvals_reason_check
    CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT billing_fx_source_approvals_principal_check
    CHECK (char_length(approver_principal) BETWEEN 1 AND 190),
  -- A row whose fingerprint does not describe its own fields cannot exist, even
  -- for a direct insert by a privileged role.
  CONSTRAINT billing_fx_source_approvals_fingerprint_check
    CHECK (fingerprint = billing_fx_approval_fingerprint(
      source, source_reference, base_currency, quote_currency,
      fx_rate_scaled, fx_rate_scale, rounding_mode, effective_from, captured_at
    ))
);

-- ---------------------------------------------------------------------------
-- Consumption records: at most one per approval, written with the publication.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_fx_source_approval_consumptions (
  approval_id bigint PRIMARY KEY REFERENCES billing_fx_source_approvals (id),
  fx_rate_version_id uuid NOT NULL UNIQUE REFERENCES billing_fx_rate_versions (id),
  approver_principal text NOT NULL,
  publisher_principal text NOT NULL,
  consumed_at timestamptz NOT NULL,

  -- Separation of duties, enforced by the schema as well as the function.
  CONSTRAINT billing_fx_source_approval_consumptions_sod_check
    CHECK (approver_principal <> publisher_principal)
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. The triggers fire for EVERY role, including the table
-- owner; only an explicit `ALTER TABLE … DISABLE TRIGGER` by the owner, or a
-- superuser session, bypasses them (see the HONEST LIMITATION above).
-- ---------------------------------------------------------------------------
CREATE FUNCTION billing_fx_approval_records_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing FX approval records are append-only: an approval or its consumption is never changed or removed'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER billing_fx_source_approvals_append_only
  BEFORE UPDATE OR DELETE ON billing_fx_source_approvals
  FOR EACH ROW EXECUTE FUNCTION billing_fx_approval_records_append_only();
CREATE TRIGGER billing_fx_source_approvals_no_truncate
  BEFORE TRUNCATE ON billing_fx_source_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION billing_fx_approval_records_append_only();

CREATE TRIGGER billing_fx_source_approval_consumptions_append_only
  BEFORE UPDATE OR DELETE ON billing_fx_source_approval_consumptions
  FOR EACH ROW EXECUTE FUNCTION billing_fx_approval_records_append_only();
CREATE TRIGGER billing_fx_source_approval_consumptions_no_truncate
  BEFORE TRUNCATE ON billing_fx_source_approval_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION billing_fx_approval_records_append_only();

-- ---------------------------------------------------------------------------
-- The only writers. SECURITY DEFINER runs as the owner, so ordinary roles need
-- no direct privilege on the tables; the membership check inside each function
-- is the authorization. `session_user` is the authenticated login.
-- ---------------------------------------------------------------------------
CREATE FUNCTION billing_record_fx_source_approval(
  p_source text,
  p_source_reference text,
  p_base_currency text,
  p_quote_currency text,
  p_fx_rate_scaled bigint,
  p_fx_rate_scale integer,
  p_rounding_mode text,
  p_effective_from timestamptz,
  p_captured_at timestamptz,
  p_reason text
) RETURNS TABLE (
  out_approval_id bigint,
  out_approver_principal text,
  out_expires_at timestamptz,
  out_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_id bigint;
  v_principal text := session_user::text;
  v_fingerprint text;
  v_expires timestamptz := now() + interval '1 hour';
BEGIN
  IF NOT billing_fx_principal_has_role('veltrixeye_fx_approver') THEN
    RAISE EXCEPTION 'billing_fx_principal_unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('ops', 'import') THEN
    RAISE EXCEPTION 'source_not_permitted' USING ERRCODE = 'P0001';
  END IF;

  v_fingerprint := billing_fx_approval_fingerprint(
    p_source, p_source_reference, p_base_currency, p_quote_currency,
    p_fx_rate_scaled, p_fx_rate_scale, p_rounding_mode, p_effective_from, p_captured_at
  );

  INSERT INTO billing_fx_source_approvals (
    source, source_reference, base_currency, quote_currency,
    fx_rate_scaled, fx_rate_scale, rounding_mode, effective_from, captured_at,
    fingerprint, reason, approver_principal, approved_at, expires_at
  ) VALUES (
    p_source, p_source_reference, p_base_currency, p_quote_currency,
    p_fx_rate_scaled, p_fx_rate_scale, p_rounding_mode, p_effective_from, p_captured_at,
    v_fingerprint, p_reason, v_principal, v_now, v_expires
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (user_id, action, entity_type, entity_id, metadata)
  VALUES (
    NULL,
    'billing.fx_source_approved',
    'billing_fx_source_approval',
    v_id::text,
    jsonb_build_object(
      'approvalId', v_id::text,
      'decision', 'approved',
      'source', p_source,
      'sourceReference', p_source_reference,
      'baseCurrency', p_base_currency,
      'quoteCurrency', p_quote_currency,
      'fxRateScaled', p_fx_rate_scaled::text,
      'fxRateScale', p_fx_rate_scale,
      'roundingMode', p_rounding_mode,
      'effectiveFrom', to_char(p_effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'capturedAt', to_char(p_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'fingerprint', v_fingerprint,
      'approverPrincipal', v_principal,
      'expiresAt', to_char(v_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'reason', p_reason
    )
  );

  RETURN QUERY
    SELECT a.id, a.approver_principal, a.expires_at, a.fingerprint
      FROM billing_fx_source_approvals a
     WHERE a.id = v_id;
END
$$;

CREATE FUNCTION billing_publish_fx_rate_version(
  p_approval_id bigint,
  p_source text,
  p_source_reference text,
  p_base_currency text,
  p_quote_currency text,
  p_fx_rate_scaled bigint,
  p_fx_rate_scale integer,
  p_rounding_mode text,
  p_effective_from timestamptz,
  p_captured_at timestamptz
) RETURNS billing_fx_rate_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  a billing_fx_source_approvals%ROWTYPE;
  v_principal text := session_user::text;
  v_fingerprint text;
  v_row billing_fx_rate_versions%ROWTYPE;
  v_version_id uuid;
BEGIN
  IF NOT billing_fx_principal_has_role('veltrixeye_fx_publisher') THEN
    RAISE EXCEPTION 'billing_fx_principal_unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('ops', 'import') THEN
    RAISE EXCEPTION 'source_not_permitted' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize publications that cite the same approval: the second caller
  -- waits here, then sees the first caller's consumption below.
  SELECT * INTO a FROM billing_fx_source_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_fx_source_approval_consumptions c WHERE c.approval_id = a.id) THEN
    RAISE EXCEPTION 'approval_consumed' USING ERRCODE = 'P0001';
  END IF;
  IF a.approver_principal = v_principal THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'P0001';
  END IF;
  IF now() >= a.expires_at THEN
    RAISE EXCEPTION 'approval_expired' USING ERRCODE = 'P0001';
  END IF;

  v_fingerprint := billing_fx_approval_fingerprint(
    p_source, p_source_reference, p_base_currency, p_quote_currency,
    p_fx_rate_scaled, p_fx_rate_scale, p_rounding_mode, p_effective_from, p_captured_at
  );
  IF v_fingerprint <> a.fingerprint THEN
    RAISE EXCEPTION 'approval_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO billing_fx_rate_versions (
    base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
    source, source_reference, created_by, effective_from, captured_at, published_at
  ) VALUES (
    p_base_currency, p_quote_currency, p_fx_rate_scaled, p_fx_rate_scale, p_rounding_mode,
    p_source, p_source_reference, v_principal, p_effective_from, p_captured_at, now()
  )
  RETURNING * INTO v_row;
  v_version_id := v_row.id;

  INSERT INTO billing_fx_source_approval_consumptions (
    approval_id, fx_rate_version_id, approver_principal, publisher_principal, consumed_at
  ) VALUES (a.id, v_version_id, a.approver_principal, v_principal, now());

  INSERT INTO audit_events (user_id, action, entity_type, entity_id, metadata)
  VALUES (
    NULL,
    'billing.fx_rate_published',
    'billing_fx_rate_version',
    v_version_id::text,
    jsonb_build_object(
      'fxRateVersionId', v_version_id::text,
      'approvalId', a.id::text,
      'approvalFingerprint', a.fingerprint,
      'approverPrincipal', a.approver_principal,
      'publisherPrincipal', v_principal,
      'source', p_source,
      'sourceReference', p_source_reference,
      'baseCurrency', p_base_currency,
      'quoteCurrency', p_quote_currency,
      'fxRateScaled', p_fx_rate_scaled::text,
      'fxRateScale', p_fx_rate_scale
    )
  );

  -- The caller receives the row the function itself wrote: a publisher needs
  -- no SELECT privilege on the rate table to read back its own publication.
  RETURN v_row;
END
$$;

-- ---------------------------------------------------------------------------
-- Least privilege: nothing is callable or writable by PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON billing_fx_source_approvals FROM PUBLIC;
REVOKE ALL ON billing_fx_source_approval_consumptions FROM PUBLIC;
REVOKE INSERT ON billing_fx_rate_versions FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_fx_approval_fingerprint(text, text, text, text, bigint, integer, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_fx_principal_has_role(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_record_fx_source_approval(text, text, text, text, bigint, integer, text, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_publish_fx_rate_version(bigint, text, text, text, text, bigint, integer, text, timestamptz, timestamptz) FROM PUBLIC;

COMMENT ON TABLE billing_fx_source_approvals IS
  'Billing FX source approvals: append-only, single-use records bound to the exact proposed rate. Written only by billing_record_fx_source_approval() for members of veltrixeye_fx_approver; the approver is the authenticated database login.';
COMMENT ON TABLE billing_fx_source_approval_consumptions IS
  'Billing FX approval consumptions: one row per approval, written in the same transaction as the published rate version it authorized. Append-only.';
