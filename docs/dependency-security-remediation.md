# Runtime dependency security remediation

Review target: `a5a36fd4e9df53056e991311d1ccbbfbf91ddd22`  
Remediation: M8.7 dependency-security follow-up on `arena/f03d1cd8-veltrixeye`.

## Changes

- Next.js updated from `15.5.27` to patched `15.5.28` (still the Next.js 15 line; no App Router major migration). The existing PostCSS override is scoped to that Next 15 range and resolves PostCSS to `8.5.30`.
- Zod updated from 3.x to `4.6.7`, the first patched version reported by the package advisory. This is a major upgrade, so schemas were migrated for Zod 4's changed behavior/API: object defaults use `.prefault({})` to preserve Zod 3's parsed defaults; one-argument records now declare the string key schema; UUID checks use `guid()` to retain the repository's former permissive UUID-shaped validation; a web error helper accepts Zod 4's `PropertyKey` paths.
- Nodemailer updated to `10.3.1`, beyond the vulnerable `10.1.3` range.
- `npm audit fix` refreshed vulnerable `fast-uri` instances to `3.1.9` / `4.2.3`.
- Docker runtime stage now copies the nested dependency directories for each runtime workspace, which the lockfile now records after Zod 4 workspace resolution.

No application credentials, payment settings, production records, migrations, or infrastructure were changed. No automation or trading capability was changed.

## Validation evidence

- `npm audit --omit=dev` — **PASS, 0 vulnerabilities** (exit 0 after remediation).
- `npm test` — **PASS**, all workspace suites: contracts 349/349, core 1,944/1,944, Twelve Data 36/36, Paystack 189/189, Bank of Ghana 30/30, API 501/501, web 300/300; no failures (exit 0).
- `npm run typecheck` — **PASS** all workspaces (exit 0).
- `npm run lint` — **PASS** (exit 0).
- `npm run build` — **PASS**, API TypeScript build and Next.js production build completed using Next.js 15.5.28 (exit 0).

## Remaining audit findings

A full `npm audit` (including development dependencies) reports **11 moderate findings and no high/critical findings**. They form a development-tool dependency chain involving ESLint / `@typescript-eslint` and `minimatch` (`minimatch <11.0.1`). `npm audit --omit=dev`, which evaluates the production dependency tree, reports zero. The remaining dev-tree findings were not force-upgraded because npm's proposed forced remediation selects ESLint 4, a breaking downgrade. Follow up separately with a compatible ESLint / typescript-eslint toolchain update or a narrowly tested dev-only override.

## Compatibility review notes

The full workspace test suite, typecheck, lint and production build passed against Zod 4.6.7. The compatibility edits preserve existing object-default and UUID-shape semantics intentionally; re-review the `.guid()` boundaries before merging because Zod 4's `.uuid()` now enforces RFC version/variant bits more strictly than Zod 3 did. Do not deploy based solely on these local checks; standard owner review and CI remain required.
