import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const concurrentlyEntry = require.resolve('concurrently');
const shellQuoteEntry = require.resolve('shell-quote', {
  paths: [dirname(concurrentlyEntry)],
});

type ShellQuoteApi = {
  quote(tokens: readonly (string | { comment: string })[]): string;
};

const shellQuote = require(shellQuoteEntry) as ShellQuoteApi;

test('API production image copies nested dependencies for runtime workspaces', () => {
  const lock = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, unknown> };
  const dockerfile = readFileSync(resolve(repositoryRoot, 'Dockerfile'), 'utf8');
  const runtimeWorkspaces = [
    'apps/api',
    'packages/contracts',
    'packages/core',
    'packages/providers/twelve-data',
    'packages/providers/paystack',
  ];
  const workspacesWithNestedDependencies = runtimeWorkspaces.filter((workspace) =>
    Object.keys(lock.packages).some((path) => path.startsWith(`${workspace}/node_modules/`)),
  );

  assert.ok(
    workspacesWithNestedDependencies.length > 0,
    'the production workspace lock should exercise nested dependency copying',
  );
  for (const workspace of workspacesWithNestedDependencies) {
    const copyInstruction = `COPY --from=deps --chown=node:node /app/${workspace}/node_modules ./${workspace}/node_modules`;
    assert.ok(
      dockerfile.split(/\r?\n/).includes(copyInstruction),
      `Dockerfile must copy nested production dependencies from ${workspace}`,
    );
  }
});

test('shell quoting rejects line terminators after comment tokens (GHSA-pqg4-j6r4-53mv)', () => {
  // This reproduces the shape of the published command-injection advisory.
  // It only exercises the quoting function; it never launches a shell/process.
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(
      () => shellQuote.quote(['echo', 'ok', { comment: 'x' }, `a${terminator}id;#`]),
      TypeError,
      `line terminator ${JSON.stringify(terminator)} after a comment must be rejected`,
    );
  }
});

test('Fastify URI validation rejects malformed escapes and preserves valid encoded hosts', async (t) => {
  const app = Fastify({ logger: false });
  t.after(async () => app.close());

  let handlerCalls = 0;
  app.post<{ Body: { uri: string }; Reply: { uri: string } }>(
    '/uri-check',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['uri'],
          properties: { uri: { type: 'string', format: 'uri' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['uri'],
            properties: { uri: { type: 'string', format: 'uri' } },
          },
        },
      },
    },
    async (request) => {
      handlerCalls++;
      return { uri: request.body.uri };
    },
  );

  await app.ready();

  const encodedHost = 'https://%65xample.com/path?q=1';
  const valid = await app.inject({
    method: 'POST',
    url: '/uri-check',
    payload: { uri: encodedHost },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { uri: encodedHost });
  assert.equal(handlerCalls, 1);

  const invalid = await app.inject({
    method: 'POST',
    url: '/uri-check',
    payload: { uri: 'http://%zz/' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(handlerCalls, 1, 'invalid URI input is rejected before the route handler');
});
