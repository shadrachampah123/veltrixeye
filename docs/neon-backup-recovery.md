# Neon backup and recovery assessment (VeltrixEye production database)

> **Status: assessment and recommendation only.** Nothing in this document was
> executed. No snapshot was created, no backup schedule was configured, no
> branch was protected, no restore was performed and no Neon setting was
> changed. Every item marked **owner action** requires explicit authorization
> and is listed here so it can be approved, scheduled and evidenced.

## 1. What was found

| Observation | Source | Status |
|---|---|---|
| No Neon **snapshots** exist for the production project | previous owner inspection of the Neon console | **not re-verified** here (this environment has no Neon console/API access and no production credentials) |
| No **automatic snapshot/backup schedule** is configured | previous owner inspection | **not re-verified** here |
| Production compute was reported **exhausted**, blocking any read-only production check | owner evidence recorded in [deployment.md](./deployment.md) | carried forward; no production probe was attempted |
| Migrations are **forward-only** and checksum-guarded (`schema_migrations` records version/name/checksum; a changed file fails the runner) | `packages/core/src/db/migrate.ts` | verified in code |
| Repository schema currently ships migrations `0001`–`0038` | `packages/core/src/db/migrations/` | verified in code |

Because the console state could not be independently read, the honest summary is:
**recovery capability is currently unverified, and the previously observed state
(no snapshots, no schedule) would leave the system with no restore point older
than the platform's rolling change history.**

## 2. What recovery options Neon actually provides

Neon does not use dump-style backups as its primary mechanism. Its storage layer
keeps a continuous change history per **branch**, so a branch can be restored to
any instant inside a *history window* ("instant restore" / point-in-time
recovery). Snapshots are an additional, longer-lived restore point.

| Capability | Detail | Cost / limit |
|---|---|---|
| **Instant restore (PITR)** | Restore the root branch to a chosen timestamp inside the history window. Built into the storage layer — no WAL archive or backup bucket to manage | Included; history storage billed on paid plans |
| **History window** | Free plan: 6 hours (capped at 1 GB of change history). Launch: 1 day by default, up to 7 days. Scale: up to 30 days | Longer windows retain more history |
| **Change-history storage** | Billed only on root branches | $0.20/GB-month (paid plans) |
| **Snapshots** | A fixed restore point that outlives the rolling window; can be restored onto the branch or into a new branch for inspection | $0.09/GB-month; Free plan includes 1 manual snapshot, paid plans 100 |
| **Scheduled backups** | Automated snapshot schedule (paid plans); does not consume the manual snapshot allowance | $0.09/GB-month |
| **Restore semantics** | A restore **overwrites** the whole branch (all databases) and drops writes after the target time; Neon keeps the pre-restore state as a backup branch so the restore can be undone; connections drop briefly | — |
| **Child branches** | Copy-on-write clones; reading a past point does not duplicate history (history is billed on root branches only) | Branch compute/storage while it runs |
| **Deleted project recovery** | A deleted project can be recovered for a short grace period | Plan-dependent |

Sources: Neon documentation/FAQs on history windows, instant restore, snapshots
and change-history pricing (`neon.com/faqs/managed-postgres-providers-point-in-time-recovery`,
`neon.com/faqs/postgres-tools-point-in-time-recovery`,
`neon.com/faqs/best-managed-postgres-services-risky-migration`). Values are as
published for 2026 and **must be re-confirmed in the console for this project's
plan** before being relied on.

## 3. Gap analysis

1. **RPO is unknown and probably poor.** Nothing in the repository evidences a
   snapshot schedule. If the project is on the Free plan, the maximum restore
   reach is the last 6 hours (and only 1 GB of change history); on a paid plan
   the default history window is 1 day unless it was raised. Any incident
   detected later than the window — a slow-burn data problem, a bad migration
   noticed the next morning, a corrupted entitlement table — is **unrecoverable
   from the platform**.
2. **No restore has ever been rehearsed.** A restore point that has never been
   used is an assumption, not a capability. Neon restores overwrite the branch
   and drop newer writes, so the first real use must not also be the first
   practice.
3. **Forward-only migrations widen the blast radius.** There are no down
   migrations; recovery from a destructive schema change is a restore, not a
   rollback. That raises the value of a pre-migration snapshot.
4. **Recovery is not part of the release gate.** [deployment.md](./deployment.md)
   blocks production verification while compute is exhausted, but nothing
   records *backup* status, so "no backups" is invisible to release readiness.
5. **Billing data is financial evidence.** `billing_verified_transactions`,
   `subscriptions` and `billing_pricing_snapshots` are the audit trail for money;
   losing them loses the ability to reconcile with Paystack.

## 4. Recommended plan (owner-authorized, in order)

### Phase 0 — establish facts (read-only, ~15 minutes)

1. In the Neon console, record for the production project: plan, project id,
   primary branch name, **history window**, retention of change history, list of
   snapshots (with ages) and whether a scheduled-backup policy exists.
2. Record the same via the API/CLI if the owner prefers (`neonctl projects list`,
   `neonctl branches list`, snapshot listing) — read-only calls only.
3. Publish the result in this document (or a linked evidence file) so the next
   audit does not have to re-discover it.

### Phase 1 — close the "no restore point" gap (owner action)

4. **Raise the history window** to a value consistent with the risk appetite
   (minimum 7 days; 30 days if the plan allows). This is a setting change with a
   cost implication — it needs explicit approval, not an agent decision.
5. **Enable a scheduled backup/snapshot policy** (daily at minimum) and keep one
   **pre-migration snapshot** as standard practice for every schema change. The
   sequence for any future migration becomes: snapshot → verify snapshot exists →
   migrate → verify `/api/health/ready` → keep the snapshot for the agreed
   period.
6. Agree the retention target: snapshots daily for 7 days, weekly for 4 weeks (or
   the plan's practical equivalent).

### Phase 2 — prove recovery works (non-production, owner action)

7. **Restore a snapshot into a NEW branch** (never the production branch) and
   verify: migrations report in sync (`npm run db:migrate -- --status` against the
   branch), the app boots against it, and row counts for the critical tables
   (`users`, `subscriptions`, `billing_verified_transactions`, `candles`,
   `scanner_runs`, `notification_outbox`) match the snapshot time within
   expectation.
8. **Rehearse a PITR restore into a branch** at a chosen timestamp and record the
   elapsed time — that measured duration is the real RTO.
9. Delete the rehearsal branch afterwards (it costs compute while it exists) and
   record the evidence in this file.

### Phase 3 — make recovery observable and durable

10. Add the snapshot age / schedule status to the release-readiness checklist so
    "no recent backup" is a visible blocker rather than a silent one.
11. Optional durability layer if the plan's window is insufficient: an encrypted,
    off-platform logical dump (`pg_dump --format=custom`) of the production
    database on a schedule, stored outside Neon with its own retention. This is
    the only option that survives losing the Neon project itself.
12. Document the exact restore runbook (commands, who may run them, what to
    announce) in this file before the first real incident.

## 5. Proposed targets (to be confirmed by the owner)

| Metric | Proposal | Rationale |
|---|---|---|
| RPO (max data loss) | ≤ 15 minutes for billing/schema-touching work; ≤ 24 h otherwise | Neon PITR granularity is second-level inside the window, so RPO is bounded by the window, not by snapshot cadence |
| RTO (time to a usable database) | ≤ 1 hour | A branch restore is copy-on-write; the dominant cost is verification |
| Restore rehearsal | quarterly, and before any migration that rewrites or deletes data | Untested recovery is not recovery |
| Snapshot retention | 7 daily + 4 weekly | Covers "noticed a week later" without unbounded history cost |

## 6. What was explicitly NOT done

- No snapshot created, no schedule configured, no history window changed.
- No branch protected, created or deleted.
- No restore attempted, no `pg_dump` taken.
- No production database, credential, secret, Render or Vercel value read or
  modified.

Any of the above requires the owner's explicit authorization; steps 1–3 are the
only read-only actions recommended for the next session, and they need console
or API access this environment does not have.
