#!/usr/bin/env node
/**
 * Bounded GET-only token-scope diagnosis. This module cannot create, deploy,
 * promote, update permissions, mint tokens, or access environment/secret APIs.
 * Official references are retained in docs/vercel-preview-evidence.json.
 */
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { SETTINGS } from './vercel-preview-validation.mjs';

const ROLES = new Set(['OWNER', 'MEMBER', 'DEVELOPER', 'VIEWER', 'VIEWER_FOR_PLUS', 'BILLING', 'SECURITY', 'CONTRIBUTOR']);
const LIMITATIONS = new Set(['scope', 'mfa', 'invalidated']);
const RELEVANT_PERMISSIONS = new Set(['CreateProject', 'IntegrationManager', 'EnvVariableManager', 'EnvironmentManager', 'FullProductionDeployment']);
const TOKEN_TYPES = new Set(['token', 'oauth2-token', 'support-token', 'user', 'personal-access-token']);
const ORIGINS = new Set(['manual', 'github', 'gitlab', 'bitbucket', 'email', 'app', 'chatgpt', 'saml', 'token-exchange-oidc']);

function membership(team) {
  return {
    expectedIdMatches: team?.id === SETTINGS.teamId,
    expectedSlugMatches: team?.slug === SETTINGS.teamSlug,
    limited: typeof team?.limited === 'boolean' ? team.limited : null,
    limitedBy: Array.isArray(team?.limitedBy) ? team.limitedBy.filter(v => LIMITATIONS.has(v)) : [],
    role: ROLES.has(team?.membership?.role) ? team.membership.role : null,
    confirmedMember: typeof team?.membership?.confirmed === 'boolean' ? team.membership.confirmed : null,
    relevantExtendedPermissions: Array.isArray(team?.membership?.teamPermissions)
      ? team.membership.teamPermissions.filter(p => RELEVANT_PERMISSIONS.has(p)) : [],
  };
}

function tokenMetadata(data, now) {
  const token = data?.token;
  if (!token || typeof token !== 'object') return { responseShapeVerified: false };
  const scopes = Array.isArray(token.scopes) ? token.scopes : null;
  const projectIds = [token.projectId, ...(scopes ?? []).map(s => s.projectId)].filter(v => typeof v === 'string' && /^prj_[A-Za-z0-9]+$/.test(v));
  return {
    responseShapeVerified: true,
    // Never copy id, name, prefix, suffix, bearerToken, or raw scopes/PII.
    tokenType: TOKEN_TYPES.has(token.type) ? token.type : 'other-or-unspecified',
    origin: ORIGINS.has(token.origin) ? token.origin : 'other-or-unspecified',
    expired: Number.isFinite(token.expiresAt) ? token.expiresAt <= now : null,
    revoked: Number.isFinite(token.revokedAt) ? token.revokedAt > 0 : null,
    markedLeaked: Number.isFinite(token.leakedAt) ? token.leakedAt > 0 : null,
    scopeMetadataPresent: scopes !== null,
    scopeKinds: [...new Set((scopes ?? []).map(s => s.type).filter(t => t === 'user' || t === 'team' || t === 'project'))],
    expectedTeamScopePresent: scopes ? scopes.some(s => s.type === 'team' && s.teamId === SETTINGS.teamId) : null,
    expectedTeamScopeExpired: scopes?.some(s => s.teamId === SETTINGS.teamId && Number.isFinite(s.expiresAt) && s.expiresAt <= now) ?? null,
    explicitProjectRestrictionPresent: projectIds.length > 0 || scopes?.some(s => s.type === 'project') === true,
    restrictionMatchesExistingProject: projectIds.includes(SETTINGS.existingProjectId),
  };
}

function projectVisibility(data) {
  const projects = Array.isArray(data) ? data : data?.projects;
  if (!Array.isArray(projects)) return { responseShapeVerified: false };
  return {
    responseShapeVerified: true, returnedCount: projects.length,
    pageMayBeIncomplete: Boolean(data?.pagination?.next),
    existingProjectVisible: projects.some(p => p.id === SETTINGS.existingProjectId),
    existingProjectOwningTeamMatches: projects.some(p => p.id === SETTINGS.existingProjectId && p.accountId === SETTINGS.teamId),
    anyExpectedTeamProjectVisible: projects.some(p => p.accountId === SETTINGS.teamId),
    proposedIsolatedNameVisible: projects.some(p => p.name === SETTINGS.name),
    // Raw project names, IDs, env arrays, aliases and nested deployments are omitted.
  };
}

function teamVisibility(data) {
  const teams = Array.isArray(data) ? data : data?.teams;
  if (!Array.isArray(teams)) return { responseShapeVerified: false };
  const expected = teams.find(t => t.id === SETTINGS.teamId);
  return { responseShapeVerified: true, returnedCount: teams.length,
    pageMayBeIncomplete: Boolean(data?.pagination?.next),
    expectedTeamReturned: Boolean(expected),
    expectedTeam: expected ? membership(expected) : null };
}

function reasonClass(data) {
  const message = typeof data?.error?.message === 'string' ? data.error.message : '';
  if (/expir/i.test(message)) return 'expiration-mentioned-by-provider';
  if (/revok|invalidat/i.test(message)) return 'revocation-or-invalidation-mentioned-by-provider';
  if (/saml|single.sign.on|\bsso\b/i.test(message)) return 'sso-mentioned-by-provider';
  if (/\bmfa\b|two.factor|2fa/i.test(message)) return 'mfa-mentioned-by-provider';
  if (/scope|permission|project.scoped/i.test(message)) return 'scope-or-permission-mentioned-by-provider';
  if (message === 'Not authorized') return 'generic-not-authorized';
  return 'unspecified-provider-denial';
}

export async function diagnoseTokenPermissions({ token, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const original = typeof token === 'string' ? token : '';
  const trimmed = original.trim();
  const normalized = trimmed.replace(/^Bearer\s+/i, '').trim();
  const secrets = [...new Set([original, trimmed, normalized].filter(Boolean).flatMap(s => [s, encodeURIComponent(s), Buffer.from(s).toString('base64')]))];
  const scrub = value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  const e = {
    verifiedAtUtc: new Date(now()).toISOString(), status: 'BLOCKED', mode: 'TOKEN_PERMISSIONS_GET_ONLY',
    repository: SETTINGS.repository, expectedTeam: { id: SETTINGS.teamId, slug: SETTINGS.teamSlug },
    projectName: SETTINGS.name, deployments: [], projectCreated: false,
    credentialHandling: { present: normalized.length > 0, whitespaceTrimmed: original !== trimmed,
      duplicateBearerPrefixRemoved: /^Bearer\s+/i.test(trimmed),
      containsRemainingWhitespace: /\s/.test(normalized), tokenIdentifiersOrFragmentsPublished: false },
    probes: [], safety: { mutationsRequested: 0, projectCreationEnabled: false,
      deploymentWritesEnabled: false, tokenCreationOrModificationEnabled: false,
      secretOrEnvironmentEndpointsAccessed: false, rawResponsesPublished: false,
      firstDeploymentRiskSafelyAvoided: false, goldDiagnosticRun: false, merged: false },
  };
  if (!normalized || /\s/.test(normalized)) {
    e.blocker = { code: !normalized ? 'NO_VERCEL_PREVIEW_TOKEN' : 'CREDENTIAL_FORMAT_INVALID',
      message: 'Credential absent or contains internal whitespace; no credential value is published.' };
    e.completedAtUtc = new Date(now()).toISOString();
    return e;
  }

  const definitions = [
    { label: 'current-token-metadata', path: '/v5/user/tokens/current', select: data => tokenMetadata(data, now()) },
    { label: 'projects-in-inferred-token-scope', path: '/v10/projects?limit=100', select: projectVisibility },
    { label: 'team-membership-discovery', path: '/v2/teams?limit=100', select: teamVisibility },
    { label: 'expected-team-without-redundant-query', path: `/v2/teams/${SETTINGS.teamId}`, select: membership },
  ];
  // Exactly four documented GETs, no pagination/mutation retries, no inferred
  // query teamId on account/current-token or team/project-scoped requests.
  for (const d of definitions) {
    const url = new URL(d.path, 'https://api.vercel.com');
    const p = { label: d.label, method: 'GET', path: url.pathname, query: url.search,
      httpStatus: null, selected: null };
    e.probes.push(p);
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: globalThis.AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${normalized}`, Accept: 'application/json' },
      });
      p.httpStatus = response.status;
      let data;
      try { data = await response.json(); } catch {
        p.error = { code: 'NON_JSON_RESPONSE' };
        continue;
      }
      if (response.ok) p.selected = d.select(data);
      else {
        const providerCode = data?.error?.code;
        const allowedCodes = new Set(['forbidden', 'unauthorized', 'not_found', 'invalid_token', 'token_expired', 'rate_limit_exceeded']);
        p.error = { code: allowedCodes.has(providerCode) ? providerCode : 'OTHER_PROVIDER_ERROR',
          reasonClass: reasonClass(data),
          // Only this fixed generic message is safe to copy, never raw errors.
          exactGenericMessage: data?.error?.message === 'Not authorized' ? 'Not authorized' : null };
      }
      if (response.status === 429) break; // no retry or probing around rate limits
    } catch {
      p.error = { code: 'READ_CONNECTION_FAILED', message: 'Read request failed; details withheld.' };
    }
  }

  const meta = e.probes.find(p => p.label === 'current-token-metadata')?.selected;
  const ownProjects = e.probes.find(p => p.label === 'projects-in-inferred-token-scope');
  const teamList = e.probes.find(p => p.label === 'team-membership-discovery');
  const team = e.probes.find(p => p.label === 'expected-team-without-redundant-query');
  const limitedBy = [...new Set([...(team?.selected?.limitedBy ?? []), ...(teamList?.selected?.expectedTeam?.limitedBy ?? [])])];
  let code = 'CAUSE_NOT_PROVEN';
  let confidence = 'unresolved';
  if (meta?.expired || meta?.expectedTeamScopeExpired || meta?.revoked || meta?.markedLeaked) {
    code = 'TOKEN_OR_TEAM_SCOPE_INACTIVE'; confidence = 'metadata-verified';
  } else if (limitedBy.length) {
    code = 'TEAM_AUTHENTICATION_LIMITED'; confidence = 'provider-limitation-verified';
  } else if (meta?.explicitProjectRestrictionPresent && team?.httpStatus === 403) {
    code = 'PROJECT_SCOPED_TOKEN_DENIES_TEAM_ENDPOINT'; confidence = 'metadata-and-denial-verified';
  } else if (ownProjects?.httpStatus === 200 && team?.httpStatus === 403 &&
    meta?.scopeMetadataPresent && !meta.scopeKinds.includes('user') && meta.expectedTeamScopePresent === false) {
    code = 'TOKEN_SCOPE_DOES_NOT_COVER_EXPECTED_TEAM'; confidence = 'metadata-and-denial-verified';
  } else if (ownProjects?.httpStatus === 200 && team?.httpStatus === 403 && teamList?.httpStatus === 403) {
    code = 'VALID_PROJECT_ACCESS_BUT_TEAM_RESOURCE_DENIED'; confidence = 'read-access-verified-scope-type-not-proven';
  } else if (team?.httpStatus === 200 && team.selected?.expectedIdMatches && team.selected?.expectedSlugMatches) {
    code = 'EXPECTED_TEAM_READ_ACCESS_CONFIRMED'; confidence = 'read-access-verified';
  } else if (e.probes.every(p => p.httpStatus === 401 || p.httpStatus === 403)) {
    code = 'NO_READ_ACCESS_CONFIRMED'; confidence = 'denials-verified-underlying-reason-unknown';
  }
  e.diagnosis = { code, confidence, limitedBy,
    projectReadAccessConfirmed: ownProjects?.httpStatus === 200 && ownProjects.selected?.responseShapeVerified === true,
    expectedExistingProjectVisible: ownProjects?.selected?.existingProjectVisible ?? null,
    requiredTeamReadAccessConfirmed: team?.httpStatus === 200 && team.selected?.expectedIdMatches === true && team.selected?.expectedSlugMatches === true,
    creationOrDeploymentPermissionProvenByWrites: false,
    prior403AloneProvesTokenInvalid: false, ownerRoleIsMandatory: false,
  };
  e.blocker = { code: 'DEPLOYMENT_WRITES_REMAIN_DISABLED',
    message: 'Read-only diagnosis only; the new-project first Production risk has not been safely avoided.' };
  e.diagnosticCompleted = e.probes.length === definitions.length;
  e.completedAtUtc = new Date(now()).toISOString();
  return JSON.parse(JSON.stringify(e, (_key, value) => typeof value === 'string' ? scrub(value) : value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await diagnoseTokenPermissions({ token: process.env.VERCEL_PREVIEW_TOKEN });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 2; // never indicate that a deployment or project bootstrap succeeded
}
