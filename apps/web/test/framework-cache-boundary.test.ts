import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appDirectory = fileURLToPath(new URL('../app', import.meta.url));

function applicationPageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return applicationPageFiles(absolute);
    if (!entry.isFile() || entry.name !== 'page.tsx') return [];
    return absolute.split(sep).includes('legal') ? [] : [absolute];
  });
}

test('session-bearing Next routes keep personalized reads out of statically cached server pages', () => {
  const routes = applicationPageFiles(appDirectory);
  assert.ok(routes.length > 0, 'the authenticated route inventory is present');

  for (const route of routes) {
    const source = readFileSync(route, 'utf8');
    assert.match(source, /^['"]use client['"];?\s/, `${route} remains a client route`);
    assert.doesNotMatch(source, /export\s+const\s+revalidate\s*=/, `${route} does not opt into ISR`);
    assert.doesNotMatch(source, /export\s+const\s+dynamic\s*=\s*['"]force-static['"]/, `${route} is not forced static`);
  }

  const apiSource = readFileSync(fileURLToPath(new URL('../lib/api.ts', import.meta.url)), 'utf8');
  assert.match(apiSource, /fetch\(`\/api\$\{path\}`/, 'browser requests stay on the same-origin API route');
  assert.match(apiSource, /credentials:\s*['"]same-origin['"]/, 'session credentials are sent only same-origin');
});
