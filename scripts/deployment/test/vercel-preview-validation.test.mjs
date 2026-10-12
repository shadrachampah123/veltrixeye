import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SETTINGS, auditExistingPreviews } from '../vercel-preview-validation.mjs';

const TOKEN = 'offline_preview_token_not_a_credential';
const IDs = ['dpl_OfflineBaseline', SETTINGS.commits[1].lookup];

function harness(options = {}) {
  const calls = [];
  const reply = (body, status = 200) => ({ status, ok: status >= 200 && status < 300,
    json: async () => globalThis.structuredClone(body) });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, ...init });
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.equal(url.searchParams.get('teamId'), SETTINGS.teamId);
    if (options.networkError) throw new Error(`network detail ${TOKEN}`);
    if (options.forbidden) return reply({ error: { code: 'forbidden', message: `Denied ${TOKEN}` } }, 403);
    if (options.invalidJson) return { status: 200, ok: true, json: async () => { throw new Error('invalid'); } };
    if (url.pathname === `/v2/teams/${SETTINGS.teamId}`) return reply({
      id: SETTINGS.teamId, slug: SETTINGS.teamSlug, membership: { role: 'OWNER' },
      inviteCode: 'unrelated_private_team_value', ...options.team,
    });
    if (url.pathname === `/v9/projects/${SETTINGS.name}`)
      return options.existing ? reply(options.existing) : reply({}, 404);
    for (const [i, commit] of SETTINGS.commits.entries()) {
      if (url.pathname === `/v13/deployments/${commit.lookup}`) {
        return reply({
          id: IDs[i], projectId: SETTINGS.existingProjectId, target: null,
          readyState: i === 0 ? 'READY' : 'ERROR', url: commit.hostname,
          gitSource: { sha: commit.sha }, meta: { githubCommitSha: commit.sha },
          errorCode: i === 0 ? null : 'GIT_INFORMATION_RETRIEVAL_FAILED',
          errorMessage: i === 0 ? null : 'Git information retrieval failed for this deployment',
          ...(options.deployment?.(i) ?? {}),
        });
      }
      if (url.pathname === `/v3/deployments/${IDs[i]}/events`) {
        assert.equal(url.searchParams.get('builds'), '1');
        assert.equal(url.searchParams.get('follow'), '0');
        assert.equal(url.searchParams.get('direction'), 'forward');
        if (options.logsDenied) return reply({ error: { code: 'forbidden', message: 'Build log access denied' } }, 403);
        return reply(options.events ?? (i === 0 ? [
          { deploymentId: IDs[i], text: `Cloning github.com/${SETTINGS.repository} (Commit: ${commit.sha.slice(0, 7)})` },
          { deploymentId: IDs[i], text: 'Running vercel build' },
          { deploymentId: IDs[i], text: 'Compiled successfully in 10s' },
          { deploymentId: IDs[i], text: 'Generating static pages (18/18)' },
          { deploymentId: IDs[i], text: 'Build Completed in /vercel/output' },
        ] : []));
      }
    }
    throw new Error(`Unexpected offline request: ${url.pathname}`);
  };
  return { calls, run: overrides => auditExistingPreviews({ token: TOKEN, fetchImpl, now: () => 0, ...overrides }) };
}

const expectedSafetyBlocker = 'FIRST_DEPLOYMENT_REQUIRES_PRODUCTION_INITIALIZATION';

test('no credential means zero network requests', async () => {
  const h = harness();
  const e = await h.run({ token: '' });
  assert.equal(e.blocker.code, 'NO_VERCEL_PREVIEW_TOKEN');
  assert.equal(h.calls.length, 0);
});

test('valid owner token audits both existing exact commits, but never bootstraps a new project', async () => {
  const h = harness();
  const e = await h.run();
  assert.equal(e.status, 'BLOCKED');
  assert.equal(e.blocker.code, expectedSafetyBlocker);
  assert.equal(e.authorization.ownerRoleVerified, true);
  assert.equal(e.isolatedProjectExists, false);
  assert.equal(e.projectCreated, false);
  assert.equal(e.safety.mutationsRequested, 0);
  assert.ok(h.calls.every(c => c.method === 'GET' && c.body === undefined));
  assert.deepEqual(e.deployments.map(d => [d.observedSha, d.state, d.commitVerified]),
    [[SETTINGS.commits[0].sha, 'READY', true], [SETTINGS.commits[1].sha, 'ERROR', true]]);
});

test('a first Production response is not treated as a successful Preview', async () => {
  const h = harness({ deployment: () => ({ target: 'production' }) });
  const e = await h.run();
  assert.equal(e.blocker.code, 'NON_PREVIEW_OR_UNKNOWN_TARGET');
  assert.equal(h.calls.filter(c => c.url.pathname.endsWith('/events')).length, 0);
});

test('token scope/403 stops all later reads and every mutation; token echo is scrubbed', async () => {
  const h = harness({ forbidden: true });
  const e = await h.run();
  assert.equal(e.blocker.httpStatus, 403);
  assert.equal(e.authorization.teamAccessVerified, false);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(e).includes(TOKEN), false);
});

for (const [title, team] of [
  ['wrong team ID', { id: 'team_OfflineOther' }],
  ['wrong team slug', { slug: 'other-team' }],
]) {
  test(`${title} cannot pass authorization`, async () => {
    const h = harness({ team });
    const e = await h.run();
    assert.equal(e.blocker.code, 'TOKEN_TEAM_SCOPE_MISMATCH');
    assert.equal(h.calls.length, 1);
  });
}

test('non-owner/missing role is never asserted to have project creation permission', async () => {
  for (const membership of [{ role: 'VIEWER' }, {}]) {
    const h = harness({ team: { membership } });
    const e = await h.run();
    assert.equal(e.authorization.ownerRoleVerified, false);
    assert.equal(e.authorization.creationPermissionExercised, false);
    assert.equal(e.projectCreated, false);
    assert.ok(h.calls.every(c => c.method === 'GET'));
  }
});

test('existing name collision is read only; no project/env values are published or changed', async () => {
  const h = harness({ existing: { id: 'prj_OfflineCollision', name: SETTINGS.name,
    accountId: SETTINGS.teamId, rootDirectory: '.', env: [{ value: 'private_unrelated_env_value' }] } });
  const e = await h.run();
  assert.equal(e.isolatedProjectExists, true);
  assert.equal(e.projectCreated, false);
  assert.equal(JSON.stringify(e).includes('private_unrelated_env_value'), false);
  assert.equal(JSON.stringify(e).includes('unrelated_private_team_value'), false);
  assert.ok(h.calls.every(c => c.method === 'GET'));
});

for (const [title, override, code] of [
  ['wrong project', { projectId: 'prj_OfflineOther' }, 'EXISTING_PREVIEW_PROJECT_MISMATCH'],
  ['invalid deployment ID', { id: '../secrets' }, 'INVALID_DEPLOYMENT_ID'],
  ['unknown target', { target: undefined }, 'NON_PREVIEW_OR_UNKNOWN_TARGET'],
  ['wrong source SHA', { gitSource: { sha: '0'.repeat(40) } }, 'DEPLOYMENT_SHA_MISMATCH'],
  ['conflicting metadata SHA', { meta: { githubCommitSha: '0'.repeat(40) } }, 'DEPLOYMENT_SHA_MISMATCH'],
  ['missing SHA evidence', { gitSource: {}, meta: {} }, 'NO_COMMIT_EVIDENCE'],
  ['live domain instead of Preview URL', { url: 'veltrixeye-liard.vercel.app' }, 'PREVIEW_URL_MISMATCH'],
]) {
  test(`refuses ${title} without retrieving its logs or writing anything`, async () => {
    const h = harness({ deployment: () => override });
    const e = await h.run();
    assert.equal(e.blocker.code, code);
    assert.equal(h.calls.filter(c => c.url.pathname.endsWith('/events')).length, 0);
    assert.ok(h.calls.every(c => c.method === 'GET'));
  });
}

test('log permission failure is explicit, not a fabricated build result', async () => {
  const h = harness({ logsDenied: true });
  const e = await h.run();
  assert.equal(e.blocker.httpStatus, 403);
  assert.equal(e.deployments[0].buildLogs, undefined);
});

test('logs for a different deployment are refused', async () => {
  const h = harness({ events: [{ deploymentId: 'dpl_OfflineOther', text: 'Compiled successfully' }] });
  const e = await h.run();
  assert.equal(e.blocker.code, 'BUILD_EVENTS_DEPLOYMENT_MISMATCH');
});

test('a build-log SHA conflict is not hidden by matching API metadata', async () => {
  const h = harness({ events: [{ text: 'Cloning repository (Commit: 0000000)' }] });
  const e = await h.run();
  assert.equal(e.blocker.code, 'BUILD_LOG_SHA_MISMATCH');
});

test('only structured milestones are published; arbitrary historical secrets/log text are omitted', async () => {
  const h = harness({ events: [
    { text: 'private_historical_secret' },
    { text: `${TOKEN} private_historical_secret Compiled successfully` },
  ], deployment: () => ({ errorMessage: 'private_historical_secret' }) });
  const e = await h.run();
  const text = JSON.stringify(e);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('private_historical_secret'), false);
  assert.ok(e.deployments[0].buildLogs.milestones.some(m => m.signal === 'compile-success'));
});

test('empty successful events response is recorded as zero events, not missing log permission', async () => {
  const h = harness();
  const e = await h.run();
  assert.equal(e.deployments[1].buildLogs.retrieved, true);
  assert.equal(e.deployments[1].buildLogs.eventCount, 0);
  assert.equal(e.deployments[1].errorMessage, 'Git information retrieval failed for this deployment');
});

test('invalid JSON/network error blocks without echoing response/network details', async () => {
  for (const options of [{ invalidJson: true }, { networkError: true }]) {
    const h = harness(options);
    const e = await h.run();
    assert.equal(e.status, 'BLOCKED');
    assert.equal(e.projectCreated, false);
    assert.equal(JSON.stringify(e).includes(TOKEN), false);
  }
});

test('session-branch Vercel automatic deployment suppression leaves other branches unmodified', () => {
  const config = JSON.parse(readFileSync(new URL('../../../apps/web/vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.git.deploymentEnabled, { 'arena/5648e2f6-veltrixeye': false });
  assert.equal(config.framework, 'nextjs');
  assert.equal(config.installCommand, 'cd ../.. && npm ci');
  assert.equal(config.buildCommand, 'next build');
});
