/**
 * Billing page coordination — the TWO server-derived billing surfaces on
 * `/settings` may never contradict each other.
 *
 * REGRESSION PIN for a confirmed sandbox-flow defect (billing verification
 * pass): the page once re-read only `GET /api/billing/me` after a checkout and
 * only lifted the UI-local evidence fact after a successful verification. The
 * Billing Portal v1 card (`GET /api/billing/portal`) was left on its mount-time
 * answer, so the SAME page simultaneously showed:
 *
 *  - the portal stating `free` while the checkout/subscription panels already
 *    stated `awaiting verification` (the first checkout writes the
 *    subscription row and its pricing lock — the portal's server state moves);
 *  - the portal stating `awaiting payment verification` while the panels
 *    stated `evidence recorded · awaiting operator activation` (the recorded
 *    evidence row moves the portal's server state to
 *    `evidence_awaiting_activation`).
 *
 * Both transitions are orchestrated BY this page, so this page must re-read
 * both surfaces when they happen. These pins keep the two ends of the
 * coordination honest: the checkout panel must keep firing its callbacks, and
 * the page must keep answering them with a re-read of BOTH server surfaces —
 * never with a locally invented state.
 *
 * WHAT THIS CHANGES NOTHING ABOUT (the boundaries stay pinned elsewhere):
 *  - the portal panel itself remains prop-driven and strictly read-only
 *    (`billing-portal.test.ts`: no button, no link, no form, no API call);
 *  - the evidence fact stays UI-local display data, never an authority —
 *    `paymentConfirmed` is derived server-side from the activation fact;
 *  - the API surface stays the five documented calls (`billing-checkout.test.ts`
 *    pins the client: no callback, activation, cancellation, invoice,
 *    payment-method or refund endpoint exists).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pageSource = readFileSync(
  fileURLToPath(new URL('../app/settings/page.tsx', import.meta.url)),
  'utf8',
);
const checkoutPanelSource = readFileSync(
  fileURLToPath(new URL('../components/billing-checkout.tsx', import.meta.url)),
  'utf8',
);

/** Count non-overlapping occurrences of a pattern in the page source. */
function countMatches(source: string, pattern: RegExp): number {
  return (source.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

describe('Settings page — both server-derived billing surfaces re-read together', () => {
  test('the page reads exactly the two server billing surfaces, once each', () => {
    assert.equal(
      countMatches(pageSource, /api\s*\n?\s*\.getBillingState\(\)/),
      1,
      'exactly one billing-state read (GET /api/billing/me), inside loadBilling',
    );
    assert.equal(
      countMatches(pageSource, /api\s*\n?\s*\.getBillingPortalSummary\(\)/),
      1,
      'exactly one portal read (GET /api/billing/portal), inside loadPortal',
    );
    assert.match(
      pageSource,
      /const loadBilling = React\.useCallback\(\(\) => \{/,
      'the billing-state read is a stable callback',
    );
    assert.match(
      pageSource,
      /const loadPortal = React\.useCallback\(\(\) => \{/,
      'the portal read is a stable callback',
    );
  });

  test('the mount effect still loads sessions, billing state and the portal overview', () => {
    assert.match(
      pageSource,
      /React\.useEffect\(\(\) => \{\s*loadSessions\(\);\s*loadBilling\(\);\s*loadPortal\(\);\s*\}, \[loadSessions, loadBilling, loadPortal\]\);/,
      'all three reads happen on mount',
    );
  });

  test('a checkout attempt re-reads BOTH surfaces (reloadBillingSurfaces)', () => {
    // The combined handler: billing state AND portal overview, re-read together.
    assert.match(
      pageSource,
      /const reloadBillingSurfaces = React\.useCallback\(\(\) => \{\s*loadBilling\(\);\s*loadPortal\(\);\s*\}, \[loadBilling, loadPortal\]\);/,
      'reloadBillingSurfaces calls loadBilling() and loadPortal()',
    );
    // ...and it is the handler the checkout panel receives.
    assert.match(
      pageSource,
      /onBillingChange=\{reloadBillingSurfaces\}/,
      'BillingCheckoutPanel.onBillingChange is the combined re-read',
    );
    // The regression itself: the single-surface wiring must never return.
    assert.doesNotMatch(
      pageSource,
      /onBillingChange=\{loadBilling\}/,
      'the page must not re-read ONLY the billing state after a checkout',
    );
  });

  test('recorded evidence lifts the UI fact AND re-reads the portal overview', () => {
    assert.match(
      pageSource,
      /const handleEvidenceRecorded = React\.useCallback\(\(\) => \{\s*setEvidenceRecorded\(true\);\s*loadPortal\(\);\s*\}, \[loadPortal\]\);/,
      'handleEvidenceRecorded sets the lifted fact and re-reads the portal',
    );
    assert.match(
      pageSource,
      /onEvidenceRecorded=\{handleEvidenceRecorded\}/,
      'BillingCheckoutPanel.onEvidenceRecorded is the coordinated handler',
    );
    assert.doesNotMatch(
      pageSource,
      /onEvidenceRecorded=\{\(\) => setEvidenceRecorded\(true\)\}/,
      'the page must not lift the evidence fact WITHOUT re-reading the portal',
    );
  });

  test('the lifted evidence fact still reaches BOTH panels that display it', () => {
    assert.equal(
      countMatches(pageSource, /evidenceRecorded=\{evidenceRecorded\}/),
      2,
      'SubscriptionPanel and BillingCheckoutPanel receive the same lifted fact',
    );
    assert.match(
      pageSource,
      /<BillingPortalPanel portal=\{portal\} unavailable=\{portalUnavailable\} \/>/,
      'the portal panel stays prop-driven with its own failure flag',
    );
  });
});

describe('Checkout panel — the other end of the coordination stays intact', () => {
  test('a checkout attempt asks the page to re-read the server surfaces', () => {
    // Both the success and the failure path report the attempt: a first
    // checkout writes the subscription row, and even a refusal may have.
    assert.ok(
      countMatches(checkoutPanelSource, /onBillingChange\?\.\(\);/) >= 2,
      'onBillingChange fires on the checkout success AND failure paths',
    );
  });

  test('only a VERIFIED result lifts the evidence fact', () => {
    assert.match(
      checkoutPanelSource,
      /if \(summary\.verified\) onEvidenceRecorded\?\.\(\);/,
      'the evidence fact is lifted only when the server answered verified: true',
    );
  });

  test('verification stays explicit: no polling, no automatic re-check', () => {
    assert.doesNotMatch(
      checkoutPanelSource,
      /setInterval|setTimeout|requestAnimationFrame/,
      'the panel holds no timer of any kind',
    );
  });
});
