# Vercel Preview replacement — safety audit and execution handoff

## Current safe Preview route — no token replacement requested

**The prior token-replacement next action is superseded by the current request.**
Deployment writes remain disabled. The safe route identified now is **build-only
Preview validation**, not creation of a hosted Vercel deployment. No new build
or deployment result is claimed by this investigation.

### Verified no-deployment test route

Vercel's [official build documentation](https://vercel.com/docs/cli/build), updated
2026-10-07, states that `vercel build` builds locally/in CI, writes local
`.vercel/output` artifacts, and defaults to Preview variables. A deployment is
created only by a separate deploy command. The intended command is:

```text
vercel build --target=preview --non-interactive
```

This is safe **only with fail-closed setup**, not as an unguarded one-liner:

- Pin the reviewed CLI version and use isolated copies of the two exact SHAs.
- Use reviewed local/repository-derived build settings and an allowlisted,
  non-secret Preview environment. Do not pull/copy production environment data.
- Require the local settings cache before invoking the CLI. Cache absence must
  stop the check, not trigger setup, linking, importing, or automatic pulls.
- Do not use `--yes`, `--prod`, `--id`, `--project`, interactive setup, or any
  deploy/pull/link/create/promote/alias command. Never run bare `vercel`.
- Use a credential-cleared environment and isolated local/global-config paths;
  telemetry disabled; reserved `API_INTERNAL_BASE=https://preview-api.invalid`.
  No Vercel credential is needed by the cached local-build path.
- Do not follow CLI-generated "next: deploy" suggestions. Save only local build
  status, exact SHA, `target: preview`, and filtered build/artifact evidence.
- Outputs remain in excluded scratch storage, never in Git. The working
  checkout must not be linked to the existing live Vercel project.

The official [CLI source at `c628be7`](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/build/index.ts)
(package version **59.11.7**) was inspected read-only. It defaults target to
Preview; cached settings skip its pull/setup branch; non-interactive/no-`--yes`
returns an error if settings are missing; no `--id` uses a local Preview env
file rather than fetching deployment env data; the build path writes local
output and returns instead of creating a deployment. The
[entrypoint](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/index.ts)
explicitly permits `build` without an auth token.

**Availability/provenance caveat:** there is no `.vercel/project.json`, repo
link, or Preview env cache in this checkout. Do not imply cloud settings were
successfully fetched. The agent must prepare and validate isolated, repo-derived
local test inputs, or stop if the pinned CLI cannot use them without remote
setup. Such inputs are local test configuration, not verified cloud project
configuration. The CLI build route is verified from official documentation and
source; it has **not yet been executed** for this task.

Both exact commits already passed `npm ci`, `next build`, web typecheck and
272 web tests each in the previous session. A Vercel Build Output check is an
additional packaging/Preview-build test. **Neither local check exercises
Vercel's server-side Git information retrieval or provides a hosted Preview URL.**

### Hosted Preview route — conditional, not currently available

The [official environment documentation](https://vercel.com/docs/deployments/environments#first-deployment)
says that after a project's first Production deployment already exists, later
non-production-branch/Preview deployments follow the normal Preview rules.
Thus an **already-initialized, separate non-live project** is a documented route
that avoids making this task the project's first deployment. Before enabling
any future write, read-only checks must establish its identity, existing
initialization, root `apps/web`, repository link, isolation, no live domains or
production secrets, and explicit Preview targeting. Never fall back to the live
`veltrixeye` project.

No such isolated initialized candidate has been verified. The last actual
inferred-scope project-list response (2026-10-12 20:42 UTC) contained **zero
projects**, and the token could not access the existing project's team. This
is a timestamped observation, not proof that no other account has a suitable
project. No project lookup/create/deployment is attempted to fill the gap.

### Routes not accepted as Production-safe workarounds

- A new/empty project, even with no `--prod`, a non-production branch, omitted
  REST target, or Preview-only variables: the documented first-Production rule
  still applies. No supported first-deployment override was verified.
- `--skip-domain`: [official deploy docs](https://vercel.com/docs/cli/deploy#skip-domain)
  require `--prod`; it skips promotion/domain assignment, **not** Production
  deployment classification. Staged Production is also still Production.
- Static/placeholder bootstrap, no-Git initial upload, prebuilt upload, or
  connect/disconnect tricks: no verified exception to first-Production behavior.
- Anonymous/temporary deployment: the reviewed
  [deploy source](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/deploy/index.ts)
  explicitly sets `target = 'production'` when an anonymous link is created.
- Custom/staging environment: a different environment and possibly a paid-plan
  feature, not proof that a new project's first deployment can be Preview-only.
- `vercel deploy --dry`: the reviewed source requires an existing link and
  exits before creating a deployment, but this is only an upload/packaging
  inspection, not a build test, Git retrieval test, or hosted Preview. It is not
  used to avoid cached-build prerequisites or to create/link a project.
- `build --yes` / `pull --yes`: [build](https://vercel.com/docs/cli/build#yes) and
  [pull](https://vercel.com/docs/cli/pull#yes) can enter automatic project setup.
  They are excluded even though build itself is a local operation.

### One safe next action for the user

**Approve build-only Preview validation of the two exact SHAs, with no project
creation, upload, deployment, automatic setup/pull/link, or token change.**

- Baseline: `d4c33301add7d8ecd8bf45c359a7bad4795acb9f`
- PR #104 head: `3b0e26409c7ea2159292c33b38ff09decf7da47d`

The agent handles implementation and reports whether each local build/output
check actually passes. This approval is **not** permission to deploy, initialize
Production, promote, or merge. All deployment writes stay disabled. PR #104
remains open/draft and Gold debugging remains paused.

## Current permission investigation (from `a395d70`)

The previous suggestion to obtain an Owner management token was broader than
verified minimum requirements. **The read-only diagnosis is now complete.** A valid project-scoped token is
documented to reject team/user-resource requests, so the old GET-team 403 alone
was inconclusive. The new metadata checks have proved a different-team scope
mismatch for this particular token; no Owner/full-account grant is necessary
merely because a team endpoint was denied.

The canonical existing-project team was revalidated from Vercel's fresh GitHub
bot metadata: `shadrachampah123s-projects`, `team_Mzs68E6FMzdUnXcEbaQ52LuK`,
project `prj_Rg2CpBEW2UAL99WMYOqugtEOWGwn`.

Official sources checked:

- [Access-token scope levels](https://vercel.com/docs/accounts/access-tokens):
  Full Account, Team, and Project are different resource scopes. Selecting a team
  then **All Projects** produces Team scope; selecting one project does not.
- [Read-only API getting started](https://vercel.com/docs/rest-api/getting-started):
  `GET /v10/projects` works in the token's own scope without forcing a team ID.
- [Current-token metadata](https://vercel.com/docs/rest-api/authentication/get-auth-token-metadata):
  `GET /v5/user/tokens/current` is supported. This user-level request may itself
  be denied to a valid project-scoped token; denial is not a validity test.
- [Extended RBAC permissions](https://vercel.com/docs/rbac/access-roles/extended-permissions):
  Developer + **Create Project** is narrower than Owner. Member includes
  creation rights, but is broader. **Full Production Deployment** is distinct
  and not required/requested for Preview work.

The agent has prepared exactly four independent GET-only probes. Current-token
metadata, inferred-scope project listing, team discovery, and the exact expected
team are queried **without an automatically appended `teamId` or `slug`**.
Only known enums, booleans, counts and the already-known expected team identity
are published. Token IDs/names/prefixes/suffixes, unknown team/project identities,
private user data, env arrays, and raw responses are omitted. Minor pasted
Bearer-prefix/whitespace issues can be normalized inside the private job;
privilege/scope escalation and token creation/modification are not attempted.

Both the prior safety suite and new scope suite pass: **40/40 offline tests**.
The live diagnosis below is independent evidence of the token's scope.
Nothing in the offline tests or read checks proves future mutation permissions. The new-project first-Production risk has **not**
been safely avoided; all project/deployment writes stay disabled.

## Previous audit decision (historical)

**BLOCKED: the supplied token cannot access the expected Vercel team.**
The GET-only [audit run 38300476511](https://github.com/shadrachampah123/veltrixeye/actions/runs/38300476511)
ran on `6006435c0d49b81524b00a14767ddda505198dbc`. The private secret was present,
but the very first request returned **HTTP 403**, code **`forbidden`**, message
**`Not authorized`**. The runner made exactly one Vercel request, then stopped.

The original unsafe mutating bootstrap remains disabled. No project/deployment,
domain/alias/secret write, merge, or Gold execution occurred. No Production
deployment is authorized, including in a new project.

The original five files were recovered on `arena/5648e2f6-veltrixeye`, and their
three recorded workflow/helper/test hashes matched. The previously reported
local commit object did not survive the workspace snapshot; the files did.
Before this continuation, the session branch and bootstrap workflow were **not
on GitHub**. GitHub's workflow registry contained CI and the Gold diagnostic
workflow (not run), and `main/.github/workflows` contained only CI.

Full evidence: [vercel-preview-evidence.json](./vercel-preview-evidence.json).

## Newly verified safety blocker

Current [Vercel environment documentation](https://vercel.com/docs/deployments/environments#first-deployment),
retrieved on 2026-10-12, explicitly states:

> The first deployment of a new project is always a production deployment.

It applies even to a deployment from a non-production branch. Preview rules
only apply **after** that initial Production deployment exists. The official
[Terraform provider source](https://github.com/vercel/terraform-provider-vercel/blob/ebf7a2a04771ae3446c53905d5d35b1f4d304ced/vercel/resource_deployment.go#L359-L367)
still contains the same warning, corroborating the current docs. The
[maintainer's historical confirmation](https://github.com/vercel/terraform-provider-vercel/issues/82)
is background evidence, not a new live reproduction.

**Correction to the previous plan:** creating an empty project through the API
is not an initial deployment, but it does **not** make that project's subsequent
first deployment safely Preview-only. A nonexistent Production branch, omitted
`target`, and checking `target` after the deployment POST do not prevent the
initial Production write. The 18 offline mocks only simulated Preview responses.
They passed again, but did not establish this external service invariant.

A new-project first deployment is therefore incompatible with the current
"no Production deployment" instruction. No permission to initialize it in
Production is inferred from a valid token or from general implementation/merge
authorization. No first deployment is attempted merely to test this behavior.

## Safe workflow now prepared

`.github/workflows/vercel-preview-validation.yml` is now named **Isolated Vercel
Preview safety audit**. It exists on GitHub on this session branch (not `main`),
workflow ID `382510867`. Future executions require an explicit
`[vercel-safety-audit]` code-changing commit marker on this branch, so evidence
and housekeeping pushes do not retry a rejected credential. It has
`contents: read`, no PR trigger, and no Gold trigger. The Vercel credential is
available only in the audit step, never in checkout, setup, offline tests, or
publication steps. The helper's HTTP transport is hardcoded **GET only** and
has no mutation method/body argument.

The audit:

1. Verifies the credential can access the exact expected team and reports only
   its ID, slug, and membership role. It never requests token values/metadata,
   prints the credential, or asserts unexercised creation/deploy permissions.
2. Looks up the proposed isolated project name without creating or changing it.
   Raw project/environment fields are not published.
3. Reads the two **existing Preview** deployments listed below. It refuses
   unknown/Production targets, wrong projects/URLs, missing or conflicting full
   SHA metadata, and invalid deployment IDs before fetching build logs.
4. Reads each validated deployment's build events through the Vercel API.
   Only structured, allowlisted build milestones are published; historical raw
   log text and arbitrary error messages are withheld to avoid leaking env data.
5. Publishes filtered evidence as a Checks notice and a seven-day artifact.
   A success in reading old metadata/logs is **not** a new deployment success.
   Exit code 2 deliberately keeps the mutating bootstrap blocked.

No alias/domain, environment/secret, promotion, project creation/update, or
Vercel deployment-write endpoint is called. No application Preview URL, live
app API, production database, or Gold diagnostic is contacted/executed.

### Preventing side effects from pushing this branch

A necessary branch-only guard was added to **this branch's** `apps/web/vercel.json`:

```json
"git": {
  "deploymentEnabled": {
    "arena/5648e2f6-veltrixeye": false
  }
}
```

[Current Vercel Git configuration documentation](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled)
confirms this disables automatic Git deployments for the matching branch;
unlisted branches default to enabled. It prevents the workflow push from
creating a Preview/branch alias in the existing project. `main` and its deployed
configuration are unchanged. **This branch must not be merged as part of this task.**

## Exact existing deployments to audit (not redeploy)

| Role | Full intended SHA | Existing deployment lookup | GitHub's last recorded outcome |
|---|---|---|---|
| Known good | `d4c33301add7d8ecd8bf45c359a7bad4795acb9f` | `veltrixeye-l4jpdxldc-shadrachampah123s-projects.vercel.app` | Preview success, 2026-10-12 15:06:38 UTC |
| Failing | `3b0e26409c7ea2159292c33b38ff09decf7da47d` | `dpl_41zQipvnddHe9imqFozKkJMPKYEu` | Preview failure, 2026-10-12 13:08:48 UTC |

The earlier failing attempt was `dpl_Fyh5eLWbzmGGL2Cp1nWJCFHa8YhW` at 12:03:56
UTC. Both failures occurred within 3–4 seconds. The exact handoff-reported error
is `Git information retrieval failed for this deployment`; it is not treated as
independently verified until the current read-only Vercel response/log evidence
confirms it.

PR #104 remains **open/draft**, head `3b0e26409c7ea2159292c33b38ff09decf7da47d`.
Its two CI runs passed. The latest bot Ready link belongs to baseline `d4c3330`,
not the PR head. No edit, merge, promotion, or Gold follow-up is performed.

The prior session's fresh clean-export checks passed for **both exact SHAs**:
`npm ci`, `next build`, web typecheck, and 272 web tests each, with credential
variables excluded and a reserved `.invalid` API placeholder. The identical
web/package/lockfile tree hash and actual previous logs remain in the evidence.
Those are local build results, not new Vercel deployment results.

## Access and verification provenance

- The Vercel connector is still unsupported. Local Vercel API access is not used.
- GitHub secret **name metadata** access still returns 403; values were never
  requested. This does not prove the newly added secret is absent. Runtime
  presence/scope is checked privately in the Actions runner instead.
- The original 18 tests passed on the recovered files. The new read-only policy
  suite has **22 passing tests**, including valid-owner-but-no-creation,
  first-Production rejection, metadata/log SHA conflicts, credential echoes,
  raw-log suppression, and the exact branch-only Git deployment guard.
- Read-only workflow YAML, shell blocks, secret scope, publication step, and
  helper syntax are checked locally before push. Offline fixtures are clearly
  distinguished from real API results. Actionlint/live API acceptance are not
  assumed from offline tests.

## Actual runtime results (not offline mocks)

- Workflow: **present on GitHub**, push-triggered on this branch.
- Run: `38300476511`, completed 2026-10-12 19:52:17 UTC, conclusion **failure**.
  The helper deliberately exits 2 for a blocker; this is not a web build failure.
- Checkout, Node setup, **22 offline tests**, filtered publication, and artifact
  upload succeeded in Actions.
- Secret runtime presence: **verified true**. Its value was never returned to
  the agent, printed, exposed, or committed. It was used privately only in the
  HTTPS Authorization header to the Vercel API.
- Exact request: **GET `/v2/teams/team_Mzs68E6FMzdUnXcEbaQ52LuK`**.
  Response: **403 / `forbidden` / `Not authorized`**, observed at
  2026-10-12 19:52:13 UTC.
- Team scope/role and creation/deploy/log permissions: **not verified**.
  This response does not prove the token is absent or identify its actual scope.
- Isolated-project lookup: **not attempted** after authorization failed.
  Project existence is unknown; **no project was created by this task**.
- Both exact-SHA new Preview deployments: **not attempted**.
- Existing deployment metadata/build logs: **not retrieved from Vercel** in this
  run because the team-read check failed first. The historical outcomes/URLs in
  the table remain GitHub evidence, not new Vercel audit results.
- Mutation requests: **zero**; no automatic retry of the rejected credential.

The filtered live result was recovered from Checks annotation
`114981905252` through `api.github.com`, rather than requiring dashboard or
external artifact-storage troubleshooting. It is saved in the evidence file.

## Verified live scope diagnosis — no guesses

[Run 38305897863](https://github.com/shadrachampah123/veltrixeye/actions/runs/38305897863)
executed commit `2141c3622d134f3d375be30d7b12b3d4072d5965` at 2026-10-12
20:42 UTC. **40/40 safeguards passed in Actions**; the credential step exits 2
because all deployment writes remain disabled, not because the diagnosis failed.

| Read-only request | Actual status | Whitelisted finding |
|---|---|---|
| `GET /v5/user/tokens/current` (no team query) | **200** | Manual token; unexpired; Team scope; **requested team absent from granted scopes** |
| `GET /v10/projects?limit=100` (inferred scope) | **200** | Credential accepted; zero projects visible in its scope |
| `GET /v2/teams?limit=100` | **200** | One visible team; requested team not returned |
| `GET /v2/teams/team_Mzs68E6FMzdUnXcEbaQ52LuK` (no extra query) | **403** | `forbidden` / `Not authorized` |

**Verified cause:** the token is accepted, but its granted Team scope does not
cover the requested team. This is not an invalid/expired credential diagnosis,
a missing GitHub secret, a query-string formatting problem, or proof that its
creator needs Owner access. The token creator's membership/RBAC in the denied
team is **unknown**, not presumed absent. The target team ID/slug was revalidated
from the Vercel bot's project association; it is not invented from the token.

No leading/trailing whitespace or pasted Bearer prefix was present. Those
formatting mistakes could have been corrected privately by the client, but are
**not** the cause here. Scope cannot be added by any enabled GET request. The
current Team-only credential cannot mint a broader token; Vercel documents that
programmatic token creation needs full-account scope. **No such broader token,
minting operation, scope edit, role grant, or secret value is requested here.**

No token ID/name/prefix/suffix, unknown team/project identity, private user data,
raw response or env field was published or saved. The filtered actual result is
retained in the evidence JSON. Four GET requests; **zero Vercel writes**.

## Minimum access — distinguish current reads from future provisioning

| Phase | Narrowest relevant resource scope | Required capabilities |
|---|---|---|
| Existing Preview metadata/build-log investigation | Project -> existing `veltrixeye`, in `shadrachampah123s-projects` | Read project/deployment metadata and build logs; verify the applicable plan/role actually includes logs. Team/user metadata may legitimately be denied. |
| Separately creating/configuring a new project (still disabled) | Team -> **All Projects** in the same team | Create Project plus new-project configuration/Git-link/Preview deployment and log access. Developer + Create Project is narrower than Owner; Member includes creation but is broader. |
| Operating only the eventual initialized isolated project | Project -> that isolated project | Its needed Preview/configuration/log capabilities only, after a safe first-deployment path exists. |

Full Account and Owner are **not blanket minimums**. Full Production Deployment,
production secrets, billing, DNS/alias writes, and token-minting authority are
not requested for this task. Token resource scope does not itself change the
principal's RBAC permissions. A Project token for the old live project cannot
create a new sibling project. A project scope is suitable for the current
read-only evidence phase, but not for the original separate-project bootstrap.

## Previous token next action (superseded — do not act on it now)

**Replace the existing private Actions secret `VERCEL_PREVIEW_TOKEN_5648E2F6`
with an unexpired Vercel token explicitly scoped to
`shadrachampah123s-projects` / `team_Mzs68E6FMzdUnXcEbaQ52LuK`.**
For the originally intended separate-project provisioning, the verified scope
selector is **that team -> All Projects**, not an individual existing project
and not Full Account. Its creator needs the stated Create Project and
new-project configuration/Git/Preview capabilities; an Owner token is not
mandatory. For continuing only old-project read/log work, a Project token for
`veltrixeye` is sufficient where its principal has the required read/log access.
Do not expand RBAC privileges solely to make a diagnostic team endpoint pass.

Use the [existing secret's private GitHub UI](https://github.com/shadrachampah123/veltrixeye/settings/secrets/actions/VERCEL_PREVIEW_TOKEN_5648E2F6)
without pasting any value in chat. This is one specific authorization correction,
not a dashboard troubleshooting checklist. A missing membership or MFA/SAML
requirement must not be assumed from the old generic 403.

**This repairs authentication only.** The first deployment of a new project is
still documented as Production; no safe bypass has been proved. All project and
deployment writes remain disabled. No Production exception is sought or assumed,
no project/deployment/alias/secret/role change is made, PR #104 is not merged,
and Gold debugging remains paused.
