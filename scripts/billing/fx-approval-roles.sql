-- BILLING FX APPROVAL — DBA-ONLY PROVISIONING. NOT RUN BY MIGRATIONS OR BY THE APPLICATION.
--
-- Migration 0040 creates the approval machinery and grants NOTHING, so every FX
-- approval and publication is refused until a privileged database operator runs
-- this script. It is idempotent and safe to re-run.
--
-- What it does:
--   1. creates the two NOLOGIN group roles if they do not exist;
--   2. grants EXECUTE on the approval function to the approver role and on the
--      publication function to the publisher role.
--
-- What it deliberately does NOT do: it does not create any login, password or
-- membership. Membership is granted one named login at a time by the DBA, e.g.
--     GRANT veltrixeye_fx_approver TO <named_login>;
-- A login is an approver only if the DBA has granted it that membership, and the
-- approver recorded on an approval is that login — so accountability is only as
-- strong as having one login per named human. The application's shared
-- DATABASE_URL login must NOT be made a member of either role.
--
-- Separation of duties: give the approver role and the publisher role to
-- DIFFERENT logins. The database refuses a publication whose login recorded the
-- approval, but it cannot detect one human holding two logins.

DO $$
BEGIN
  IF to_regrole('veltrixeye_fx_approver') IS NULL THEN
    CREATE ROLE veltrixeye_fx_approver NOLOGIN;
  END IF;
  IF to_regrole('veltrixeye_fx_publisher') IS NULL THEN
    CREATE ROLE veltrixeye_fx_publisher NOLOGIN;
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION billing_record_fx_source_approval(text, text, text, text, bigint, integer, text, timestamptz, timestamptz, text)
  TO veltrixeye_fx_approver;
GRANT EXECUTE ON FUNCTION billing_publish_fx_rate_version(bigint, text, text, text, text, bigint, integer, text, timestamptz, timestamptz)
  TO veltrixeye_fx_publisher;
