# Vercel replacement plan (separate Preview project)

Status: **planning only.** No Vercel project was created, changed, or deleted.
No domains, secrets, PRs, or production deployments were touched.

## 1. Commits

| Role | Commit | Why |
|---|---|---|
| Baseline | `c16155c` (`origin/main`, merged PR #102) | Last merged state of the web app. |
| Test afterward | `3b0e264` (tip of open draft PR #104, branch `arena/33fb2786-veltrixeye`) | Includes `d4c3330`, its parent. |

- `d4c3330` and `3b0e264` are **not on `main`**. They are diagnostics-only changes: `.github/workflows/production-gold-diagnostics.yml`, `.gitignore`, root `package.json`, and `scripts/diagnostics/*`.
- Neither commit touches `apps/`, `packages/`, `vercel.json`, or `package-lock.json`, so the web build should be identical to baseline. A preview of them proves the Vercel wiring, not the diagnostics code.
- `d4c3330` is not a branch tip, so it can't be previewed from the Vercel dashboard without a temporary branch. That is optional and not needed for the comparison.
- Confirm the baseline first: in the **existing** project, read the commit SHA of the current Production deployment (read-only). If it differs from `c16155c`, use that SHA as the baseline.
- PR #104 is a draft and not approved for merge. Nothing from it should go to production.

## 2. Vercel project settings (new project only)

| Setting | Value | Notes |
|---|---|---|
| Git repository | `shadrachampah123/veltrixeye` | Import as a **new** project. |
| Framework Preset | Next.js | Matches `apps/web/vercel.json`. |
| Root Directory | `apps/web` | Required. |
| Include source files outside Root Directory | **On** | Required: the install command runs `cd ../.. && npm ci`. |
| Install Command | leave empty (use `vercel.json`) | `cd ../.. && npm ci` |
| Build Command | leave empty (use `vercel.json`) | `next build` |
| Output Directory | leave default | `.next` |
| Node.js Version | **22.x** | Root `engines` is `>=22`; CI uses Node 22. |
| Production Branch | a name that does not exist (e.g. `no-production-branch`) | Stops pushes to `main` from promoting to production. Everything stays Preview. |
| Domains | **none** | Do not attach any production domain. |

## 3. Environment variables

| Name | Environment | Value | Notes |
|---|---|---|---|
| `API_INTERNAL_BASE` | Preview only | a **staging** API origin (`https://…`), or leave unset | Preview builds without it fall back to `127.0.0.1:4000` with a warning. The build still succeeds, but API calls will fail. |

- That is the **only** variable the web app reads. `VERCEL_ENV` is set by Vercel automatically. Do not set `NODE_ENV`.
- **Do not** point `API_INTERNAL_BASE` at the production API (`veltrixeye-api` on Render). Preview users would reach production data through the proxy.
- **Do not** copy any API secret into this project (`DATABASE_URL`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `PAYSTACK_*`, `SMTP_*`, `TWELVE_DATA_API_KEY`, `NOTIFICATION_WORKER_TOKEN`, `SCANNER_WORKER_TOKEN`, and so on). The web build needs none of them.

## 4. Local verification (done, outside Vercel)

Each commit was exported with `git archive` to `/tmp`, then built with the same commands Vercel will use (`npm ci` at the repo root, then `next build` in `apps/web`, with a placeholder non-secret `API_INTERNAL_BASE`).

| Commit | `npm ci` | `next build` |
|---|---|---|
| `c16155c` (baseline) | exit 0 | exit 0, all routes compiled |
| `3b0e264` (test) | exit 0 | exit 0, all routes compiled |

- The `next` binary is hoisted to the root `node_modules/.bin`, so the bare `next build` resolves from the Root Directory.
- Web-relevant paths are identical between `c16155c` and `3b0e264`.

## 5. Access status

- Arena's Vercel connector is **unsupported** in this session. There is no authorized tool to create or configure a Vercel project.
- The sandbox has no Vercel CLI and no Vercel-related environment variables.
- So **no Vercel project was created**. Setup has to be done by you in the Vercel dashboard (section 6).

## 6. Manual steps for you (minimum)

1. Open Vercel → **Add New… → Project** → import `shadrachampah123/veltrixeye`. This creates a **new** project. Do not edit the existing one.
2. Name it something clear, e.g. `veltrixeye-web-preview`.
3. Apply the settings in section 2. Enable **Include source files outside Root Directory**.
4. Add `API_INTERNAL_BASE` for **Preview only**, or leave it unset.
5. Deploy `main` (baseline preview), then deploy branch `arena/33fb2786-veltrixeye` (the `3b0e264` test).
6. Confirm the new project has **no domains**, and that the existing project's production domain still points to it.

## 7. Success checks

- Baseline and test preview builds both show **Ready**.
- Neither preview is promoted to production.
- The existing production project and its domains are unchanged.

## 8. Rollback

- The new project has no domains and no production role. If it is no longer needed, delete **only** the new project. The existing project is never touched by this plan.

## 9. Safety notes

- Do not merge PR #104 or PR #103 as part of this work.
- PR #104's diagnostics workflow reads a production `DATABASE_URL` through GitHub Actions. Keep that secret out of Vercel entirely.
