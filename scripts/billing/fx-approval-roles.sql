-- BILLING FX APPROVAL — DBA-ONLY PROVISIONING. NOT RUN BY MIGRATIONS OR BY THE APPLICATION.
--
-- Migration 0040 creates the approval machinery and grants NOTHING, so every FX
-- approval and publication is refused until a privileged database operator runs
-- this script. It is idempotent and safe to re-run.
--
-- WHAT IT DOES (H-B: database ownership separation)
--
--   1. creates THREE NOLOGIN group roles if they do not exist:
--        - veltrixeye_fx_approval_owner  (owns the protected approval objects)
--        - veltrixeye_fx_approver        (members may record an approval)
--        - veltrixeye_fx_publisher       (members may publish a rate)
--   2. transfers OWNERSHIP of every protected object to veltrixeye_fx_approval_owner:
--        - the approval and consumption tables (and their append-only triggers),
--        - the writer / helper / assertion functions,
--        - billing_fx_rate_versions, so the APPLICATION login cannot INSERT a
--          rate version directly and bypass approval.
--   3. grants the owner role the one privilege it does not hold by ownership:
--        INSERT on audit_events (the writers write the approval/publication audit
--        events; the owner role is deliberately NOT the owner of audit_events).
--   4. grants SELECT on billing_fx_rate_versions to PUBLIC so the application
--      login can READ published rates (INSERT stays revoked; publication goes
--      only through billing_publish_fx_rate_version()).
--   5. grants EXECUTE on each writer to exactly its own role.
--   6. runs billing_assert_fx_approval_ownership() — a fail-closed assertion
--      that raises if any protected object is NOT owned by the owner role, so a
--      failed ownership transfer cannot be mistaken for success.
--
-- WHAT IT DELIBERATELY DOES NOT DO: it creates no LOGIN, no password and no
-- membership. Membership is granted one named login at a time by the DBA, e.g.
--     GRANT veltrixeye_fx_approver TO <named_login>;
-- A login is an approver only if the DBA has granted it that membership, and the
-- approver recorded on an approval is that login — so accountability is only as
-- strong as having one login per named human. The application's shared
-- DATABASE_URL login must NOT be a member of either role.
--
-- SEPARATION OF DUTIES: give the approver role and the publisher role to
-- DIFFERENT logins. The database refuses a publication whose login recorded the
-- approval, but it cannot detect one human holding two logins.
--
-- TRUST BOUNDARY (stated plainly): the object owner
-- (veltrixeye_fx_approval_owner) and any superuser can still
-- `ALTER TABLE … DISABLE TRIGGER`, drop a function or insert rows directly. That
-- is the unavoidable DBA/superuser trust boundary. The guarantee this script
-- establishes is that the APPLICATION login — which is neither the owner nor a
-- superuser — owns none of these objects and holds no privilege that would let
-- it alter the triggers, disable the protections, forge approval evidence, or
-- insert an FX version directly. The owner role is NOLOGIN, so no session can
-- log in as it; it exists only to own the objects and run the SECURITY DEFINER
-- writers.
--
-- PRECONDITION: run this as a privileged operator (a superuser, or a role that
-- is a member of veltrixeye_fx_approval_owner). ALTER ... OWNER requires that
-- privilege. Run it only on a disposable local test database unless the
-- deployment has been explicitly reviewed for this ownership change.

DO $$
BEGIN
  IF to_regrole('veltrixeye_fx_approval_owner') IS NULL THEN
    CREATE ROLE veltrixeye_fx_approval_owner NOLOGIN;
  END IF;
  IF to_regrole('veltrixeye_fx_approver') IS NULL THEN
    CREATE ROLE veltrixeye_fx_approver NOLOGIN;
  END IF;
  IF to_regrole('veltrixeye_fx_publisher') IS NULL THEN
    CREATE ROLE veltrixeye_fx_publisher NOLOGIN;
  END IF;
END
$$;

-- --- Ownership of the protected approval objects -------------------------------
ALTER TABLE billing_fx_source_approvals              OWNER TO veltrixeye_fx_approval_owner;
ALTER TABLE billing_fx_source_approval_consumptions  OWNER TO veltrixeye_fx_approval_owner;
ALTER TABLE billing_fx_rate_versions                 OWNER TO veltrixeye_fx_approval_owner;

ALTER FUNCTION billing_fx_approval_fingerprint(text, text, text, text, bigint, integer, text, timestamptz, timestamptz)
  OWNER TO veltrixeye_fx_approval_owner;
ALTER FUNCTION billing_fx_principal_has_role(text)
  OWNER TO veltrixeye_fx_approval_owner;
ALTER FUNCTION billing_fx_approval_records_append_only()
  OWNER TO veltrixeye_fx_approval_owner;
ALTER FUNCTION billing_record_fx_source_approval(text, text, text, text, bigint, integer, text, timestamptz, timestamptz, text)
  OWNER TO veltrixeye_fx_approval_owner;
ALTER FUNCTION billing_publish_fx_rate_version(bigint, text, text, text, text, bigint, integer, text, timestamptz, timestamptz)
  OWNER TO veltrixeye_fx_approval_owner;
ALTER FUNCTION billing_assert_fx_approval_ownership()
  OWNER TO veltrixeye_fx_approval_owner;

-- The append-only TRIGGERS need no separate ALTER: a trigger is owned by its
-- table's owner, so the ALTER TABLE ... OWNER statements above already moved
-- them to the owner role. (PostgreSQL has no ALTER TRIGGER ... OWNER TO form.)

-- --- The privileges the SECURITY DEFINER writers need but do not own ---------
-- The owner role owns the approval tables and billing_fx_rate_versions, so it
-- already holds every privilege on them. It does NOT own audit_events, so it
-- needs an explicit INSERT to write the approval/publication audit events.
GRANT INSERT ON audit_events TO veltrixeye_fx_approval_owner;

-- The application login (and every other login) may READ published rates, but
-- may never INSERT one: publication goes only through the function.
GRANT SELECT ON billing_fx_rate_versions TO PUBLIC;

-- --- EXECUTE: each writer is callable by exactly its own role ----------------
GRANT EXECUTE ON FUNCTION billing_record_fx_source_approval(text, text, text, text, bigint, integer, text, timestamptz, timestamptz, text)
  TO veltrixeye_fx_approver;
GRANT EXECUTE ON FUNCTION billing_publish_fx_rate_version(bigint, text, text, text, text, bigint, integer, text, timestamptz, timestamptz)
  TO veltrixeye_fx_publisher;

-- --- Fail-closed ownership assertion -----------------------------------------
-- Raises (P0001) if any protected object is not owned by the owner role. A
-- successful provisioning run leaves this silent.
SELECT billing_assert_fx_approval_ownership();
