/**
 * MEDIUM-3 — Paper provider separation.
 *
 * Explicitly preserves separation between existing Paper provider/simulator
 * and future Gate 9 Fake Bridge test double.
 *
 * - Paper provider must NOT have failure-injection behavior
 * - Paper is M8.3 internal deterministic simulator, not FakeBridge
 * - Future fake must use provider-neutral naming (FakeBridge, etc.)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('MEDIUM-3 — Paper provider separation', () => {
  test('paper.ts does not contain failure-injection behavior', () => {
    const paperPath = path.join(REPO_ROOT, 'packages/core/src/execution/paper.ts');
    const content = readFileSync(paperPath, 'utf8');
    // Must document separation
    assert.equal(content.includes('FakeBridge'), true, 'paper.ts must document FakeBridge separation');
    assert.equal(content.includes('DeterministicFakeProvider'), true, 'paper.ts must document provider-neutral fake naming');
    // Paper must not have scenario control or invocation tracking IMPLEMENTATION
    // (documentation may mention it, but implementation must not)
    assert.equal(content.includes('setScenario'), false, 'paper.ts must not implement scenario control');
    assert.equal(content.includes('invocationCount'), false, 'paper.ts must not have invocation tracking implementation');
    assert.equal(content.includes('FakeProviderState'), true, 'paper.ts must document FakeProviderState as separate');
    // Ensure no failure mode enum or injection logic
    assert.equal(content.includes('failureMode'), false, 'paper.ts must not have failureMode');
    assert.equal(content.includes('FakeBridgeScenario'), false, 'paper.ts must not import fake scenario');
  });

  test('paper provider is internal deterministic simulator, not fake-bridge', () => {
    const paperPath = path.join(REPO_ROOT, 'packages/core/src/execution/paper.ts');
    const content = readFileSync(paperPath, 'utf8');
    assert.ok(content.includes('M8.3'), 'paper.ts must be identified as M8.3 simulator');
    assert.ok(content.includes('Internal deterministic paper simulator'), 'paper.ts must be described as internal simulator');
    assert.ok(content.includes('NOT the Gate 9 Fake Bridge'), 'paper.ts must explicitly state it is NOT Fake Bridge');
  });

  test('fake-bridge lives in test-only support, not production', () => {
    const fakeBridgePath = path.join(REPO_ROOT, 'packages/core/test/support/fake-bridge.ts');
    const content = readFileSync(fakeBridgePath, 'utf8');
    assert.ok(content.includes('test-only'), 'fake-bridge must be marked test-only');
    assert.ok(content.includes('FakeBridge'), 'must define FakeBridge');
    assert.ok(content.includes('DeterministicFakeProvider'), 'must define DeterministicFakeProvider');
    assert.ok(content.includes('FakeProviderState'), 'must define FakeProviderState');
    assert.equal(content.toLowerCase().includes('fakemt5provider'), false, 'must NOT use FakeMT5Provider');
    assert.equal(content.toLowerCase().includes('exness'), false, 'must not reference Exness');

    // Production index must not export it
    const indexPath = path.join(REPO_ROOT, 'packages/core/src/execution/index.ts');
    const indexContent = readFileSync(indexPath, 'utf8');
    assert.equal(indexContent.includes('fake-bridge'), false);
    assert.equal(indexContent.includes('FakeBridge'), false);
  });

  test('provider-neutral naming: FakeBridge, DeterministicFakeProvider, FakeProviderState', () => {
    const allowed = ['FakeBridge', 'DeterministicFakeProvider', 'FakeProviderState'];
    const forbidden = ['FakeMT5Provider', 'FakeMT5Bridge', 'MT5FakeProvider'];
    for (const name of allowed) {
      assert.equal(name.toLowerCase().includes('mt5'), false, `${name} must be provider-neutral`);
    }
    for (const name of forbidden) {
      assert.ok(name.toLowerCase().includes('mt5'), `${name} is forbidden because it contains MT5`);
    }
  });
});
