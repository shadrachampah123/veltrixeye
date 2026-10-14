# Overnight completion evidence

This file is the chronological evidence trail for the security and FX-validation work requested on 2026-10-14 (UTC). It records facts observed from Git, GitHub, npm, and local verification; it is not an approval to change billing, FX, provider mappings, or production state.

## Initial state (before repository edits)

- Repository: `shadrachampah123/veltrixeye`; origin: `https://github.com/shadrachampah123/veltrixeye.git`.
- Session branch: `arena/688edbe9-veltrixeye`.
- Initial `HEAD`: `bf526bb071eb0267e32e9e9173ae55443f86238a` (the working tree was clean).
- Initial remote `main`: `bf526bb071eb0267e32e9e9173ae55443f86238a` (equal to initial `HEAD`).
- The requested FX implementation could not be located in this checkout or on GitHub: `refs/heads/arena/d645ef89-veltrixeye` is absent from `git ls-remote`; `bb95260bf611de08010464400f4ef6d0acb4f710` is absent from local objects, remote heads, and GitHub's commit lookup (HTTP 422, no commit found); no PR exists with that head branch or commit. Therefore there is no implementation or test evidence at that identifier to preserve or finalize. No replacement FX CLI has been written, and no rate, source, capture time, approval, or publication has been invented.
- Open PRs observed: #103 (`chore(diagnostics): read-only Production Gold ...`) and draft #104 (`fix(diagnostics): safety fixes ...`). Both concern the paused Gold diagnostic; neither was changed, reopened, or used as a dependency for this task.
- Latest `main` CI run at start: run `38485120861`, commit `bf526bb071eb0267e32e9e9173ae55443f86238a`, result `success` (Node 22 / embedded-Postgres CI).
- Deployment configuration observed: `.github/workflows/ci.yml` is the only GitHub Actions workflow; `render.yaml` configures the `veltrixeye-api` Render Docker service on `main`, readiness path `/api/health/ready`; `apps/web/vercel.json` configures the Next.js app for Vercel. No repository workflow authorizes a separate/manual production deployment.
- Toolchain: Node `v22.22.3`, npm `10.9.8`. Initial `npm ci` succeeded.

### Baseline npm audit

Commands run against the committed lockfile before dependency changes:

- `npm audit --json`: **10** affected package findings — 3 moderate, 5 high, 2 critical.
- `npm audit --omit=dev --json`: **7** production-tree findings — 3 moderate, 4 high, 0 critical.

| Finding | Initial locked version(s) and dependency path | Initial exposure assessment |
|---|---|---|
| `concurrently` / `shell-quote` | `concurrently@9.2.4` (root direct dev dependency) → `shell-quote@1.9.0` | Dev-only command runner; critical shell-quoting injection advisory. Root `dev` script runs fixed workspace scripts, not user-supplied commands. |
| `brace-expansion` | `1.1.18` and `5.0.9`, via ESLint / `@typescript-eslint` / `minimatch` | Development/test tooling only; not imported by application code. |
| `fast-uri` | `3.1.7` and `4.1.4`, via Fastify's AJV and `fast-json-stringify` tree | Production dependency of the HTTP API's Fastify stack; transitive URI validation/serialization code. |
| `fastify` | `5.12.4`, direct production dependency of `apps/api` | Production HTTP framework; audit advisory covers HTTP/2 trailer handling. App construction does not enable HTTP/2 by default. |
| `next` / nested `postcss` | `next@15.5.25` direct production dependency; nested `next/node_modules/postcss@8.4.31`; separate root `postcss@8.5.28` is dev-only | Next handles production web rendering and image routes. Next's pinned nested PostCSS remained vulnerable even though the separate dev PostCSS was patched. |
| `nodemailer` | `9.1.1`, direct production dependency of `packages/core`; used by `src/notifications/email.ts` for SMTP delivery | Production-relevant when SMTP is configured; the adapter calls `createTransport()` and `sendMail()`. |
| `sharp` and `@img/sharp-libvips-*` | `sharp@0.35.4` optional dependency of Next; `@img/sharp-libvips-*@1.3.3` | Optional production image-processing path through Next's optimizer; advisory identifies a bundled `librsvg` issue. |
| `source-map-js` | `1.2.1`, used by nested Next PostCSS and Tailwind/PostCSS | Present in both a production Next dependency path and dev CSS tooling; advisory covers indexed source-map parsing. |

Detailed initial transitive paths were captured with `npm explain` after installing the lockfile exactly. These paths, audits, and the initial SHA are the baseline against which the remaining entries will be recorded.

## Security remediation and dependency decisions

All updates were compatible within the existing major versions except the deliberate Nodemailer 9 → 10 migration. No `--force`, downgrade, blanket override, advisory suppression, or removed test was used. The only npm override is narrowly scoped to the vulnerable PostCSS copy under the updated Next.js range.

| Dependency path / finding | Remediation in the final lockfile |
|---|---|
| `concurrently` → `shell-quote` (critical; line terminator after comment-token injection) | `concurrently` 9.2.4 → 9.2.5; `shell-quote` 1.9.0 → 1.12.0. Added a regression test for LF, CR, U+2028 and U+2029 after a comment token. The test exercises quoting only and never launches a shell. |
| `brace-expansion` (two affected major-version paths) | 1.1.18 → 1.1.21 and 5.0.9 → 5.0.12. |
| `fast-uri` (Fastify/AJV and serializer paths) | 3.1.7 → 3.1.8 and 4.1.4 → 4.2.2. |
| Fastify production API | 5.12.4 → 5.12.7; `apps/api` range updated. Root `fastify: ^5.12.7` is also a dev dependency to ensure npm hoists the same Fastify instance to the workspace root so Fastify plugin type augmentation resolves consistently. |
| Next.js and nested PostCSS | Next.js 15.5.25 → 15.5.27. The vulnerable nested PostCSS 8.4.31 is replaced by the scoped override `next@^15.5.27 → postcss:^8.5.23`; the lock resolves PostCSS 8.5.30. This is not a global override. |
| Nodemailer production email adapter | 9.1.1 → 10.1.0 (major migration; details below). Removed obsolete `@types/nodemailer` 8.0.2 because Nodemailer 10 provides its own declarations. |
| Next image-processing dependencies | Sharp 0.35.4 → 0.35.5 and `@img/sharp-libvips-*` 1.3.3 → 1.3.4. Added an SVG-to-PNG runtime regression test. |
| `source-map-js` | 1.2.1 → 1.2.2. |
| Compatible related lock refresh | `nanoid` 3.3.19 → 3.3.20. |

Nodemailer 10's declared Node floor is 20; this repository and its production Docker base use Node 22. The SMTP regression tests pin STARTTLS on port 587, configured TLS/auth/timeouts, headers, stable retry `Message-ID`, provider response handling, and credential redaction. A clean production-workspace install exposed a packaging regression that would otherwise have been missed: npm places Nodemailer under `packages/core/node_modules`, while the API Docker runtime previously copied only root `node_modules`. The Dockerfile now copies that workspace-local production dependency directory, and an API regression test checks that each runtime workspace with locked nested dependencies is copied. A temporary `npm ci --omit=dev --workspace @veltrixeye/api` install added 107 packages, audited 113 with **0 vulnerabilities**, and confirmed Nodemailer 10.1.0 resolves from `packages/core/node_modules`. The Docker CLI is not installed in this environment, so an actual `docker build` was not run.

The first typecheck after the Fastify upgrade exposed a module-resolution/type-augmentation mismatch while Fastify was nested under `apps/api/node_modules`; changing the nested 5.12.x patch alone did not resolve it. Hoisting Fastify through the root dev dependency did. A clean `npm ci` then reported **0 vulnerabilities**, and the full workspace typecheck passed; final typecheck passed again.

## Final local verification (2026-10-14, before opening a PR)

- `npm run lint`: **PASS**.
- `npm run typecheck`: **PASS** across contracts, core, both provider workspaces, API and web.
- `npm test`: **3,189 passed, 0 failed** — contracts 349; core 1,822; Twelve Data provider 36; Paystack provider 189; API 493; web 300.
- `npm run build`: **PASS** (API TypeScript build and Next.js 15.5.27 production build; 22 static pages generated). Build emitted the existing local-only `API_INTERNAL_BASE` fallback notice and a non-failing warning that the Next.js ESLint plugin was not detected.
- `npm audit --audit-level=low`: **0 vulnerabilities**.
- `npm audit --omit=dev --audit-level=low`: **0 vulnerabilities**.
- `git diff --check`: **PASS**.
- Updated API security/Docker tests: **493/493 pass**; updated recursive web cache-boundary test and full web workspace: **300/300 pass**.

The web regression scans every non-legal Next app `page.tsx`, requires client-route status and rejects static/ISR directives, then confirms browser API calls remain same-origin with same-origin credentials. The production build's static output is client shells; authenticated data is fetched from same-origin APIs in the browser.

## FX CLI and financial-data boundary

A safe probe of `npm run billing:fx:validate -- --dry-run` returned `npm error Missing script: "billing:fx:validate"` (exit 1); no CLI ran and no database/service was contacted. The requested ref/commit remains unavailable as recorded above, so no replacement CLI was written. Its acceptance criteria remain unverified and blocked, including exact-decimal evidence, timezone-bearing timestamps, source/freshness/provenance validation, approval/publication-flag rejection, dry-run side-effect absence, and documented effective-time conflict limitations.

No rate, provenance, capture/effective time, approval, FX publication, provider-plan registration, production subscription, database record, or Paystack operation was created or changed. The user-provided **11.58 GHS/USD remains historical-only** and was not used as a rate. No file under billing, pricing, Paystack, migrations, execution, broker, or automation was changed. The four required GHS price points (Pro monthly GH₵451.62; Pro annual GH₵4,516.20; Elite monthly GH₵1,146.42; Elite annual GH₵11,464.20) were not edited or recalculated by this patch. Production Paystack plan mappings and customer/subscription records were not queried, so their external state is not independently verified. No live trade/order was placed; paper-only behavior and Automation OFF were untouched.

## GitHub, CI, deployment, and roadmap evidence before PR

- `origin/main` still equals the initial SHA `bf526bb071eb0267e32e9e9173ae55443f86238a`; no merge or deployment of this work has happened at this pre-PR snapshot.
- Latest `main` CI run observed: `38485120861`, success, on that SHA. The PR CI result is pending until the changes are pushed/opened.
- GitHub records deployment `7052722208` for that same SHA/environment `Production`, state `success`, created 2026-10-13T23:35:43Z, target `https://veltrixeye-iszocb9v2-shadrachampah123s-projects.vercel.app`. This is GitHub/Vercel deployment metadata only; no direct live health/smoke request was made, and no Render deployment status was available in the queried GitHub deployment list. Thus production health is not independently verified.
- Branch metadata reports `main` as `protected: false`. The branch-protection and repository-ruleset detail endpoints returned HTTP 403 (`Resource not accessible by integration`), so repository rulesets/review requirements could not be enumerated here; any merge must use the normal PR path and obey GitHub's own mergeability/check enforcement.
- Existing open PRs #103 and #104 concern the paused Gold diagnostic. They were not edited, reopened, or used; this investigation was not resumed.

Roadmap finding: the earliest unfinished documented billing step is Billing Step 9b (customer-facing self-serve management), but its scope doc says cancellation/invoices require unresolved decisions C-1/R-1. Current source and merged PR #65 already implement exact documented subscription reads and a non-immediate cancellation provider operation that obtains `email_token` transiently inside the client; PR #65 explicitly added no self-serve route/UI and did not change C-1/R-1 product decisions. Parts of the Step 9b prose still incorrectly say `findSubscription` is unimplemented. Therefore the next safe action is **reconcile that stale decision/scope text against current code and ask for the explicit product decision before any customer-facing billing action**: authorize (or reject) self-serve cancellation using the existing transient-credential adapter, and decide whether invoices require a verified provider invoice source or whether a separately labelled local payment-history surface is acceptable. Step 4 sandbox provisioning also remains an explicit operator action blocked on approved FX evidence/source/time and real provider plan codes; none may be guessed or substituted with 11.58 GHS/USD. This is a decision/evidence plan, not authorization to publish a rate, register plans, or change production.
