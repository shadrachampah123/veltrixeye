/**
 * Billing Portal v1 — read-side invariants of the overview.
 *
 * Two properties this milestone must not break, pinned without a database:
 *
 *  1. THE ENTITLEMENT MATRIX STAYS THE AUTHORITY. The overview decides whether
 *     a row may be DESCRIBED as carrying a paid period from a small status list
 *     of its own (`BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES`), and that list is
 *     pinned here against `getEntitlements()` itself: `active`, `trialing` and
 *     `past_due` are exactly the statuses that resolve to a paid tier, so the
 *     display rule and the enforcement rule cannot drift apart. The list grants
 *     nothing — `readBillingPortalFacts()` never resolves, widens or writes an
 *     entitlement, and `canAccessAutomation` stays false in every one of them.
 *
 *  2. THE READ IS ANONYMOUS, READ-ONLY AND PROVIDER-FREE. The reader takes its
 *     subject as an argument the API derived from the authenticated session
 *     (never from a request), issues parameterized `SELECT`s against exactly the
 *     columns the overview publishes, and contains no write, no provider call,
 *     no credential, no id/reference/hash column and no `SELECT *`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_PLANS,
  subscriptionStatusSchema,
  type UserPlan,
} from '@veltrixeye/contracts';
import {
  BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES,
  FREE_ENTITLEMENTS,
  billingPortalLifecycleLive,
  getEntitlements,
  readBillingPortalFacts,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.resolve(HERE, '..', relative), 'utf8');

/** Code only: drops full-line comments so prose cannot satisfy (or trip) a check. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

const PORTAL_READ = codeOnly(read('src/billing/portal.ts'));
const ALL_STATUSES = subscriptionStatusSchema.options;

test('the live-status list is exactly the entitlement matrix’s paid set', () => {
  // The equivalence is asserted per plan, so the list is pinned to the matrix
  // itself rather than to a restatement of it.
  for (const plan of USER_PLANS as readonly UserPlan[]) {
    for (const status of ALL_STATUSES) {
      const paidByMatrix = getEntitlements(plan, status) !== FREE_ENTITLEMENTS;
      const describedAsPaid = billingPortalLifecycleLive(status);
      if (plan === 'free') {
        // A free plan can never be described as carrying a paid period.
        assert.equal(describedAsPaid && paidByMatrix, false, `free/${status}`);
        continue;
      }
      assert.equal(describedAsPaid, paidByMatrix, `${plan}/${status}: display and enforcement agree`);
    }
  }
  const liveByMatrix = ALL_STATUSES.filter((status) => getEntitlements('premium', status) !== FREE_ENTITLEMENTS);
  assert.deepEqual([...BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES], liveByMatrix);
  assert.deepEqual([...BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES], ['active', 'trialing', 'past_due']);
});

test('the live lifecycle can never grant automation or execution', () => {
  for (const status of BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES) {
    for (const plan of USER_PLANS as readonly UserPlan[]) {
      const entitlements = getEntitlements(plan, status);
      assert.equal(entitlements.canAccessAutomation, false, `${plan}/${status}: automation stays off`);
    }
  }
  // A terminal lifecycle is never described as paid.
  for (const status of ['canceled', 'expired'] as const) {
    assert.equal(billingPortalLifecycleLive(status), false, `${status} is not a paid period`);
  }
});

test('the reader takes its subject as an argument and reads nothing from a request', () => {
  assert.match(
    PORTAL_READ,
    /export async function readBillingPortalFacts\(db: Pool, userId: string\): Promise<BillingPortalFacts>/,
    'the subject is a plain user id argument the API derived from the session',
  );
  assert.equal(typeof readBillingPortalFacts, 'function');
  for (const forbidden of [
    /from 'fastify'/,
    /\breq\b|\brequest\b|\bbody\b|\bcookies?\b|\bheaders?\b/,
    /z\.string\(\)\.uuid\(\)/,
  ]) {
    assert.doesNotMatch(PORTAL_READ, forbidden, `the read has no request input (${forbidden})`);
  }
});

test('the reader writes nothing, calls no provider and cannot leak a sensitive column', () => {
  for (const forbidden of [
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|GRANT)\b/,
    /paystack|provider-paystack|billingProviders|fetch\s*\(|https?:\/\//i,
    /sk_test|sk_live|Bearer|email_token|authorization_code/i,
    /SELECT \*/,
    /provider_reference|provider_customer|provider_subscription|provider_plan_id|last_event_idempotency_key|locked_pricing_snapshot_id|pricing|evidence_hash|idempotency_key/i,
    /\$[2-9]/, // exactly one bound parameter: the caller's own user id
  ]) {
    assert.doesNotMatch(PORTAL_READ, forbidden, `the portal read must stay read-only (${forbidden})`);
  }
  assert.match(PORTAL_READ, /WHERE s\.user_id = \$1/, 'the only bound parameter is the session user id');
  assert.match(PORTAL_READ, /EXISTS \(/, 'the activation fact and evidence are read as existence checks');
});

test('the reader resolves no entitlement and never touches users.plan', () => {
  assert.doesNotMatch(PORTAL_READ, /resolveEntitlements\s*\(/, 'no entitlement gate is invoked here');
  assert.doesNotMatch(PORTAL_READ, /getEntitlements\s*\(/, 'and the matrix is not read directly either');
  assert.doesNotMatch(PORTAL_READ, /users\.plan|UPDATE users|FROM users/, 'the account plan is not a billing fact');
});
