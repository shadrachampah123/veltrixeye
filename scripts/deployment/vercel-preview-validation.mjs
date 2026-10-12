#!/usr/bin/env node
/**
 * READ-ONLY Vercel authorization/deployment audit.
 *
 * The former bootstrap is deliberately disabled: Vercel documents that the
 * first deployment of any new project is Production, even from a non-production
 * branch. Checking target AFTER POST /deployments cannot prevent that write.
 * No POST, PATCH, PUT, DELETE, promotion, alias, domain or env operation exists here.
 */
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';

export const SETTINGS = Object.freeze({
  repository: 'shadrachampah123/veltrixeye',
  repositoryId: 1368661677,
  teamId: 'team_Mzs68E6FMzdUnXcEbaQ52LuK',
  teamSlug: 'shadrachampah123s-projects',
  name: 'veltrixeye-preview-validation-5648e2f6',
  existingProjectId: 'prj_Rg2CpBEW2UAL99WMYOqugtEOWGwn',
  firstDeploymentDocumentation: 'https://vercel.com/docs/deployments/environments#first-deployment',
  commits: Object.freeze([
    Object.freeze({ role: 'known-good', sha: 'd4c33301add7d8ecd8bf45c359a7bad4795acb9f',
      lookup: 'veltrixeye-l4jpdxldc-shadrachampah123s-projects.vercel.app',
      hostname: 'veltrixeye-l4jpdxldc-shadrachampah123s-projects.vercel.app' }),
    Object.freeze({ role: 'failing', sha: '3b0e26409c7ea2159292c33b38ff09decf7da47d',
      lookup: 'dpl_41zQipvnddHe9imqFozKkJMPKYEu',
      hostname: 'veltrixeye-okpig0jf5-shadrachampah123s-projects.vercel.app' }),
  ]),
});

class Blocked extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function requireSafe(condition, code) {
  if (!condition) throw new Blocked(code, `Safety check refused: ${code}`);
}

function errorMessageForEvidence(message, redact) {
  // Known provider Git error can be published verbatim. Do not publish arbitrary
  // application error messages, which could contain historical env/row values.
  const exact = 'Git information retrieval failed for this deployment';
  return message === exact ? exact : message ? redact('[Provider error message withheld; not the expected Git retrieval error]') : null;
}

function selectBuildMilestones(events, sha) {
  const milestones = [];
  for (const event of events) {
    const text = typeof event.text === 'string' ? event.text : event.payload?.text;
    if (typeof text !== 'string') continue;
    const at = Number.isFinite(event.created) ? event.created : Number.isFinite(event.date) ? event.date : null;
    const commit = text.match(/\bCommit:\s*([a-f0-9]{7,40})\b/i);
    if (commit) {
      requireSafe(sha.startsWith(commit[1].toLowerCase()), 'BUILD_LOG_SHA_MISMATCH');
      milestones.push({ eventTimestamp: at, signal: 'git-commit', shaPrefix: commit[1].toLowerCase() });
    }
    // Reconstruct allowlisted messages, rather than copying historical raw logs.
    // This avoids publishing any unrelated env values or credentials in logs.
    if (/Running ["']?vercel build["']?/i.test(text))
      milestones.push({ eventTimestamp: at, signal: 'build-start', text: 'Running vercel build' });
    if (/Compiled successfully/i.test(text))
      milestones.push({ eventTimestamp: at, signal: 'compile-success', text: 'Compiled successfully' });
    const pages = text.match(/Generating static pages\s*\((\d+)\/(\d+)\)/i);
    if (pages && pages[1] === pages[2])
      milestones.push({ eventTimestamp: at, signal: 'static-pages-complete', completed: Number(pages[1]), total: Number(pages[2]) });
    if (/Build Completed in \/vercel\/output/i.test(text))
      milestones.push({ eventTimestamp: at, signal: 'build-completed', text: 'Build Completed in /vercel/output' });
    if (text.includes('Git information retrieval failed for this deployment'))
      milestones.push({ eventTimestamp: at, signal: 'git-retrieval-error', text: 'Git information retrieval failed for this deployment' });
  }
  return milestones;
}

export async function auditExistingPreviews({ token, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const secrets = typeof token === 'string' && token ? [token, encodeURIComponent(token), Buffer.from(token).toString('base64')] : [];
  const redact = value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.slice(0, 4000);
  };
  const evidence = {
    verifiedAtUtc: new Date(now()).toISOString(), status: 'BLOCKED', mode: 'READ_ONLY',
    repository: SETTINGS.repository, projectName: SETTINGS.name, teamId: SETTINGS.teamId,
    authorization: { tokenPresent: Boolean(token), teamAccessVerified: false,
      creationPermissionExercised: false, previewDeploymentPermissionExercised: false },
    project: null, isolatedProjectExists: null, projectCreated: false, deployments: [], requests: [],
    safety: { mutationsRequested: 0, readOnlyTransport: true, productionRequested: false,
      domainsOrAliasesWritten: false, environmentOrSecretEndpointsAccessed: false,
      rawHistoricalLogsPublished: false, goldDiagnosticRun: false, merged: false },
  };

  // The transport has no method parameter. Its only possible method is GET.
  // No URLs provided by a provider response are followed; logs use validated IDs.
  const get = async (path, { allowMissing = false } = {}) => {
    const url = new URL(path, 'https://api.vercel.com');
    requireSafe(url.origin === 'https://api.vercel.com', 'API_ORIGIN_MISMATCH');
    requireSafe(
      url.pathname === `/v2/teams/${SETTINGS.teamId}` ||
      url.pathname === `/v9/projects/${SETTINGS.name}` ||
      /^\/v13\/deployments\/[A-Za-z0-9.\-_/]+$/.test(url.pathname) ||
      /^\/v3\/deployments\/dpl_[A-Za-z0-9]+\/events$/.test(url.pathname),
      'READ_ONLY_ENDPOINT_NOT_ALLOWED',
    );
    url.searchParams.set('teamId', SETTINGS.teamId);
    const request = { method: 'GET', path: url.pathname, httpStatus: null };
    evidence.requests.push(request);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: globalThis.AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      throw new Blocked('VERCEL_CONNECTION_FAILED', 'Vercel read request failed.');
    }
    request.httpStatus = response.status;
    if (response.status === 404 && allowMissing) return null;
    let data;
    try { data = await response.json(); } catch {
      throw new Blocked('INVALID_VERCEL_RESPONSE', 'Vercel returned a non-JSON response.', response.status);
    }
    if (!response.ok) {
      throw new Blocked(redact(data.error?.code || 'VERCEL_API_ERROR'),
        redact(data.error?.message || `Vercel HTTP ${response.status}`), response.status);
    }
    return data;
  };

  try {
    requireSafe(typeof token === 'string' && token.trim().length > 0, 'NO_VERCEL_PREVIEW_TOKEN');
    const team = await get(`/v2/teams/${SETTINGS.teamId}`);
    requireSafe(team.id === SETTINGS.teamId && team.slug === SETTINGS.teamSlug, 'TOKEN_TEAM_SCOPE_MISMATCH');
    evidence.authorization = {
      ...evidence.authorization, teamAccessVerified: true, teamId: team.id, teamSlug: team.slug,
      membershipRole: typeof team.membership?.role === 'string' ? team.membership.role : null,
      ownerRoleVerified: team.membership?.role === 'OWNER',
    };
    const project = await get(`/v9/projects/${SETTINGS.name}`, { allowMissing: true });
    evidence.isolatedProjectExists = Boolean(project);
    if (project) {
      // Metadata only; do not publish .env or any other raw project fields.
      evidence.project = { id: project.id, name: project.name, accountId: project.accountId,
        rootDirectory: project.rootDirectory ?? null,
        productionTargetPresent: Boolean(project.targets?.production) };
    }

    for (const commit of SETTINGS.commits) {
      const record = { role: commit.role, expectedSha: commit.sha, requestedSha: commit.sha,
        source: 'Existing deployment; read-only audit, NOT a redeployment',
        observedSha: null, commitVerified: false, id: null, state: null, target: null, url: null };
      evidence.deployments.push(record);
      const d = await get(`/v13/deployments/${commit.lookup}`);
      record.id = d.id;
      record.state = d.readyState;
      record.target = d.target;
      record.projectId = d.projectId;
      record.createdAt = d.createdAt ?? null;
      record.readyAt = d.ready ?? d.readyAt ?? null;
      record.errorCode = redact(d.errorCode) || null;
      record.errorMessage = errorMessageForEvidence(d.errorMessage, redact);
      const candidates = [
        ['gitSource.sha', d.gitSource?.sha], ['meta.githubCommitSha', d.meta?.githubCommitSha],
        ['meta.gitCommitSha', d.meta?.gitCommitSha],
      ].filter(([, value]) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value));
      record.commitEvidence = candidates.map(([field, sha]) => ({ field, sha }));
      record.observedSha = candidates[0]?.[1] ?? null;
      requireSafe(d.projectId === SETTINGS.existingProjectId, 'EXISTING_PREVIEW_PROJECT_MISMATCH');
      requireSafe(/^dpl_[A-Za-z0-9]+$/.test(d.id ?? ''), 'INVALID_DEPLOYMENT_ID');
      requireSafe(Object.hasOwn(d, 'target') && (d.target === null || d.target === 'preview'), 'NON_PREVIEW_OR_UNKNOWN_TARGET');
      requireSafe(candidates.length > 0, 'NO_COMMIT_EVIDENCE');
      requireSafe(candidates.every(([, sha]) => sha === commit.sha), 'DEPLOYMENT_SHA_MISMATCH');
      record.commitVerified = true;
      requireSafe(d.url === commit.hostname, 'PREVIEW_URL_MISMATCH');
      record.url = `https://${d.url}`;
      const events = await get(`/v3/deployments/${d.id}/events?builds=1&follow=0&direction=forward&limit=1000`);
      requireSafe(Array.isArray(events), 'BUILD_EVENTS_RESPONSE_NOT_ARRAY');
      requireSafe(events.every(event => !event.deploymentId || event.deploymentId === d.id), 'BUILD_EVENTS_DEPLOYMENT_MISMATCH');
      record.buildLogs = {
        retrieved: true, eventCount: events.length, limit: 1000, possiblyTruncated: events.length >= 1000,
        sourceEndpoint: `/v3/deployments/${d.id}/events`,
        rawLogsPublished: false, milestones: selectBuildMilestones(events, commit.sha),
      };
    }
    evidence.existingDeploymentAuditCompleted = true;
    // Deliberately stop, even with a valid token. No first Production deployment
    // is authorized. A valid credential is not permission to cross that boundary.
    evidence.blocker = {
      code: 'FIRST_DEPLOYMENT_REQUIRES_PRODUCTION_INITIALIZATION',
      message: 'Vercel documents that a new project first deploys to Production. No initialization or new deployment was attempted.',
      documentation: SETTINGS.firstDeploymentDocumentation,
    };
  } catch (error) {
    evidence.blocker = {
      code: redact(error.code || 'AUDIT_FAILED'),
      message: error instanceof Blocked ? redact(error.message) : 'Read-only audit failed.',
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    };
  }
  evidence.completedAtUtc = new Date(now()).toISOString();
  return JSON.parse(JSON.stringify(evidence, (_key, value) => typeof value === 'string' ? redact(value) : value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await auditExistingPreviews({ token: process.env.VERCEL_PREVIEW_TOKEN });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 2; // the mutating bootstrap remains blocked; never label this a deployment success
}
