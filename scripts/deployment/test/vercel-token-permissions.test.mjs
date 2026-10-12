import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { diagnoseTokenPermissions } from '../vercel-token-permissions.mjs';
import { SETTINGS } from '../vercel-preview-validation.mjs';

const TOKEN = 'vcp_offline_fixture_not_a_credential';
const NOW = 1_800_000_000_000;
const privateMetadata = {
  id: 'private_token_id', name: 'private_token_name', prefix: 'private_prefix', suffix: 'private_suffix',
  bearerToken: TOKEN, leakedUrl: 'private_url', type: 'token', origin: 'manual', scopes: [],
};
const expectedTeam = { id: SETTINGS.teamId, slug: SETTINGS.teamSlug, limited: false,
  membership: { role: 'DEVELOPER', confirmed: true, teamPermissions: ['CreateProject'] },
  inviteCode: 'private_invite_code', creatorId: 'private_creator_id' };
const projects = [{ id: SETTINGS.existingProjectId, name: 'veltrixeye', accountId: SETTINGS.teamId,
  env: [{ key: 'PRIVATE_ENV', value: 'private_env_value' }], alias: [{ domain: 'private_other_domain' }] }];

function harness(options = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.equal(url.searchParams.has('teamId'), false);
    assert.equal(url.searchParams.has('slug'), false);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (options.networkError) throw new Error(`raw debug ${TOKEN}`);
    let status = 200;
    let body;
    if (url.pathname === '/v5/user/tokens/current') {
      body = { token: { ...privateMetadata, scopes: [{ type: 'team', teamId: SETTINGS.teamId }], ...options.metadata } };
      status = options.metadataStatus ?? 200;
    } else if (url.pathname === '/v10/projects') {
      body = options.projectShape === 'array' ? projects : { projects, pagination: { next: null } };
      status = options.projectsStatus ?? 200;
    } else if (url.pathname === '/v2/teams') {
      body = { teams: [expectedTeam], pagination: { next: null } };
      status = options.teamListStatus ?? 200;
    } else if (url.pathname === `/v2/teams/${SETTINGS.teamId}`) {
      body = { ...expectedTeam, ...options.team };
      status = options.teamStatus ?? 200;
    } else throw new Error(`Unexpected path ${url.pathname}`);
    if (options.allDenied) status = 403;
    if (options.rateLimited && calls.length === 1) status = 429;
    if (status >= 400) body = { error: { code: status === 429 ? 'rate_limit_exceeded' : 'forbidden',
      message: options.echoCredential ? `Not authorized ${TOKEN} ${Buffer.from(TOKEN).toString('base64')}` : 'Not authorized' } };
    return { status, ok: status >= 200 && status < 300, json: async () => {
      if (options.invalidJson) throw new Error('invalid');
      return globalThis.structuredClone(body);
    } };
  };
  return { calls, run: overrides => diagnoseTokenPermissions({ token: TOKEN, fetchImpl, now: () => NOW, ...overrides }) };
}

test('missing credential is zero-request and never asks for its value', async () => {
  const h = harness();
  const e = await h.run({ token: '' });
  assert.equal(e.blocker.code, 'NO_VERCEL_PREVIEW_TOKEN');
  assert.equal(h.calls.length, 0);
});

test('exactly four GETs diagnose scope; no implicit team query on current-token or inferred scope', async () => {
  const h = harness();
  const e = await h.run();
  assert.equal(h.calls.length, 4);
  assert.ok(e.probes.every(p => p.method === 'GET' && !p.query.includes('teamId')));
  assert.equal(e.diagnosis.code, 'EXPECTED_TEAM_READ_ACCESS_CONFIRMED');
  assert.equal(e.status, 'BLOCKED');
  assert.equal(e.blocker.code, 'DEPLOYMENT_WRITES_REMAIN_DISABLED');
  assert.equal(e.safety.firstDeploymentRiskSafelyAvoided, false);
  assert.equal(e.safety.deploymentWritesEnabled, false);
  assert.equal(e.safety.mutationsRequested, 0);
});

test('token id/name/prefix/suffix/value, team invite and raw project/env fields are never published', async () => {
  const h = harness();
  const e = await h.run();
  const output = JSON.stringify(e);
  for (const secret of [TOKEN, 'private_token_id', 'private_token_name', 'private_prefix', 'private_suffix',
    'private_url', 'private_invite_code', 'private_creator_id', 'private_env_value', 'private_other_domain'])
    assert.equal(output.includes(secret), false, `Must not publish ${secret}`);
});

test('403 on team and current metadata is not treated as invalid token when scoped projects are readable', async () => {
  const h = harness({ metadataStatus: 403, teamListStatus: 403, teamStatus: 403 });
  const e = await h.run();
  assert.equal(e.diagnosis.code, 'VALID_PROJECT_ACCESS_BUT_TEAM_RESOURCE_DENIED');
  assert.equal(e.diagnosis.projectReadAccessConfirmed, true);
  assert.equal(e.diagnosis.expectedExistingProjectVisible, true);
  assert.equal(e.diagnosis.prior403AloneProvesTokenInvalid, false);
});

test('explicit project binding plus team denial verifies project-scope boundary', async () => {
  const h = harness({ metadata: { projectId: SETTINGS.existingProjectId }, teamStatus: 403 });
  const e = await h.run();
  assert.equal(e.diagnosis.code, 'PROJECT_SCOPED_TOKEN_DENIES_TEAM_ENDPOINT');
  assert.equal(e.diagnosis.confidence, 'metadata-and-denial-verified');
  assert.equal(e.probes[0].selected.restrictionMatchesExistingProject, true);
});

test('scope naming another team does not imply permission for the required team', async () => {
  const h = harness({ metadata: { scopes: [{ type: 'team', teamId: 'team_PrivateOther' }] }, teamStatus: 403 });
  const e = await h.run();
  assert.equal(e.diagnosis.code, 'TOKEN_SCOPE_DOES_NOT_COVER_EXPECTED_TEAM');
  assert.equal(JSON.stringify(e).includes('team_PrivateOther'), false);
});

test('four generic 403s do not invent expiration, bad membership, or project binding', async () => {
  const h = harness({ allDenied: true });
  const e = await h.run();
  assert.equal(e.diagnosis.code, 'NO_READ_ACCESS_CONFIRMED');
  assert.equal(e.diagnosis.confidence, 'denials-verified-underlying-reason-unknown');
  assert.equal(e.diagnosis.projectReadAccessConfirmed, false);
});

test('verified expired token metadata is distinct from generic authorization denial', async () => {
  const h = harness({ metadata: { expiresAt: NOW - 1 }, teamStatus: 403 });
  const e = await h.run();
  assert.equal(e.diagnosis.code, 'TOKEN_OR_TEAM_SCOPE_INACTIVE');
  assert.equal(e.diagnosis.confidence, 'metadata-verified');
});

for (const limitedBy of ['scope', 'mfa', 'invalidated']) {
  test(`provider limitedBy=${limitedBy} is reported without guessing a generic 403 cause`, async () => {
    const h = harness({ team: { limited: true, limitedBy: [limitedBy] } });
    const e = await h.run();
    assert.equal(e.diagnosis.code, 'TEAM_AUTHENTICATION_LIMITED');
    assert.deepEqual(e.diagnosis.limitedBy, [limitedBy]);
  });
}

test('developer plus CreateProject is reported without demanding Owner privilege or trying creation', async () => {
  const h = harness();
  const e = await h.run();
  assert.equal(e.probes[3].selected.role, 'DEVELOPER');
  assert.deepEqual(e.probes[3].selected.relevantExtendedPermissions, ['CreateProject']);
  assert.equal(e.diagnosis.ownerRoleIsMandatory, false);
  assert.equal(e.diagnosis.creationOrDeploymentPermissionProvenByWrites, false);
});

test('array and paginated project responses are supported without copying raw responses', async () => {
  const h = harness({ projectShape: 'array' });
  const e = await h.run();
  assert.equal(e.diagnosis.projectReadAccessConfirmed, true);
});

test('leading/trailing whitespace and pasted Bearer label can be corrected inside the private job', async () => {
  const h = harness();
  const e = await h.run({ token: ` \nBearer ${TOKEN}\n ` });
  assert.equal(e.credentialHandling.whitespaceTrimmed, true);
  assert.equal(e.credentialHandling.duplicateBearerPrefixRemoved, true);
  assert.equal(e.diagnosis.requiredTeamReadAccessConfirmed, true);
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
});

test('internal whitespace causes a zero-request stop, never credential fragments in output', async () => {
  const h = harness();
  const e = await h.run({ token: 'never_print this_value' });
  assert.equal(e.blocker.code, 'CREDENTIAL_FORMAT_INVALID');
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(e).includes('never_print'), false);
});

test('echoes of raw/base64 credentials in provider errors are never published', async () => {
  const h = harness({ allDenied: true, echoCredential: true });
  const e = await h.run();
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
  assert.equal(JSON.stringify(e).includes(Buffer.from(TOKEN).toString('base64')), false);
});

test('429 stops the bounded diagnosis without retry or other probes', async () => {
  const h = harness({ rateLimited: true });
  const e = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(e.diagnosticCompleted, false);
});

test('invalid JSON/network exceptions never expose unfiltered debug details', async () => {
  for (const options of [{ invalidJson: true }, { networkError: true }]) {
    const h = harness(options);
    const e = await h.run();
    assert.equal(e.status, 'BLOCKED');
    assert.equal(JSON.stringify(e).includes(TOKEN), false);
  }
});
