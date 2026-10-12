# Vercel Preview replacement — safety audit and execution handoff

## Current permission investigation (from `a395d70`)

The previous suggestion to obtain an Owner management token was broader than
verified minimum requirements. **No manual troubleshooting or credential change
is requested yet.** A valid project-scoped token is documented to reject
team/user-resource requests, so the old GET-team 403 alone is inconclusive.

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
Runtime diagnosis is pending. Nothing in these tests proves the real token
scope or mutation permissions. The new-project first-Production risk has **not**
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

## Next action — wait for evidence

**No manual action is requested before the new read-only diagnosis completes.**
The earlier Owner-token replacement instruction is superseded pending evidence.
If it is only a request-target/header issue, the agent can correct the client
without revealing or replacing the stored value. A token cannot self-grant
missing membership/scope or mint a broader credential through these read-only
checks. The documented path to a different resource scope is replacement at
creation, not any scope-update endpoint enabled in this task.

Project creation requires Team -> All Projects scope and a principal with
Create Project and new-project configuration/Git/Preview permissions. Existing
project/deployment-log reads may use a narrower Project token and read-only
role. No Full Account/Owner/Billing/Full Production Deployment grant is presumed.
No creation or deployment will occur until the first-Production risk is proved
safely avoided. PR #104 and the Gold investigation remain untouched.
