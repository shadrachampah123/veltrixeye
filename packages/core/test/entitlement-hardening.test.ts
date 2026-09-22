/**
 * READ-SIDE ENTITLEMENT HARDENING — a provider-backed subscription fails closed.
 *
 * The gap this pins: `BillingCheckoutService` INSERTs a subscription row with
 * `provider='paystack'`, `status='active'` and `provider_state='pending'` at
 * checkout INITIALIZATION — before any money has moved. This build has no
 * payment-confirmation authority (no webhook receiver, no signature
 * verification, no transaction verification), so `plan='pro' + status='active'`
 * alone used to hand an unpaid checkout the full paid entitlement set.
 *
 * The fix is a single resolver beside the entitlement layer
 * (`src/billing/entitlement-resolution.ts`):
 *
 *   provider IS NULL      → getEntitlements(plan, status)   (history preserved)
 *   provider IS NOT NULL  → FREE_ENTITLEMENTS               (fail closed)
 *
 * What is asserted here:
 *  1. the resolver itself, over every plan × status × provider state;
 *  2. `getBillingState` — historical paid rows keep their entitlements, and
 *     provider-backed rows get the free tier for EVERY provider state;
 *  3. `AutomationService.readState` — `canAccessAutomation` stays false, and a
 *     provider-backed premium row resolves to the free tier;
 *  4. one real limit-enforcing reader (`StrategyService.createStrategy`) to
 *     prove the gate is wired into a transactional service, not just a helper;
 *  5. static boundaries — `entitlements.ts` stays provider-agnostic, the
 *     resolver introduces no second matrix, every production reader selects
 *     `provider`, no migration was added, and the checkout/pricing-lock shape
 *     is untouched.
 *
 * Nothing here invents a payment confirmation, and nothing here changes
 * checkout, pricing, the Paystack adapter or any execution safety gate.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  BILLING_LIFECYCLE_STATES,
  USER_PLANS,
  billingStateDtoSchema,
  type UserPlan,
} from '@veltrixeye/contracts';
import {
  AutomationService,
  AuditService,
  FREE_ENTITLEMENTS,
  KillSwitchService,
  MIGRATIONS_DIR,
  StrategyService,
  getBillingState,
  getEntitlements,
  resolveEntitlements,
} from '../src/index.js';
import { insertUser, startBillingTestDb } from './helpers/billing-checkout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, '..', 'src');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(...parts), 'utf8');

/** Code only: drops full-line comments so prose cannot satisfy (or trip) a check. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^(?:\s*)(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

function importsOf(source: string): string[] {
  return [...codeOnly(source).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]!);
}

/** Every canonical provider-reported lifecycle state, plus "never reported". */
const PROVIDER_STATES: (string | null)[] = [null, ...BILLING_LIFECYCLE_STATES];
/** The 0014 statuses `getEntitlements()` treats as live. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
/** The 0014 statuses that already fell back to free before this change. */
const LAPSED_STATUSES = ['canceled', 'expired'];
const PAID_PLANS: UserPlan[] = ['pro', 'premium'];
/** A state no provider vocabulary contains — proves the gate is not a whitelist. */
const IMPOSSIBLE_PROVIDER = 'some-future-provider';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(5493);
  pool = db.pool;
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });

/**
 * Write the subscription row under test. `provider_state` may only be set when
 * a provider is set (migration 0031 `subscriptions_provider_binding_check`), so
 * the two are always written together.
 */
async function seedSubscription(userId: string, args: {
  plan: UserPlan;
  status: string;
  provider?: string | null;
  providerState?: string | null;
}): Promise<void> {
  const provider = args.provider ?? null;
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, provider_state)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET plan = EXCLUDED.plan, status = EXCLUDED.status,
           provider = EXCLUDED.provider, provider_state = EXCLUDED.provider_state`,
    [userId, args.plan, args.status, provider, provider === null ? null : (args.providerState ?? null)],
  );
}

/** A user whose subscription row is exactly `args`, plus the user id. */
async function seededUser(args: Parameters<typeof seedSubscription>[1]): Promise<string> {
  const user = await insertUser(pool, false);
  await seedSubscription(user.id, args);
  return user.id;
}

/* -------------------------------------------------------------------------- */
/* 1. The resolver                                                            */
/* -------------------------------------------------------------------------- */

describe('resolveEntitlements — provider IS NULL preserves the existing matrix', () => {
  it('is byte-identical to getEntitlements for every plan and status', () => {
    for (const plan of USER_PLANS) {
      for (const status of [...LIVE_STATUSES, ...LAPSED_STATUSES, 'anything-else', '']) {
        assert.deepEqual(
          resolveEntitlements(plan, status, null),
          getEntitlements(plan, status),
          `${plan}/${status} with provider NULL must be unchanged`,
        );
      }
    }
  });

  it('keeps the paid tiers for historical live subscriptions', () => {
    for (const plan of PAID_PLANS) {
      for (const status of LIVE_STATUSES) {
        const entitlements = resolveEntitlements(plan, status, null);
        assert.equal(entitlements.canAccessScanner, true, `${plan}/${status} keeps scanner access`);
        assert.equal(entitlements.canAccessAdvancedStrategies, true);
        assert.equal(entitlements.canAccessAdvancedAlerts, true);
        assert.deepEqual(entitlements, getEntitlements(plan, status));
      }
    }
    assert.equal(resolveEntitlements('pro', 'active', null).maxStrategies, 500);
    assert.equal(resolveEntitlements('premium', 'active', null).maxStrategies, 1000);
  });

  it('keeps the existing free fallback for lapsed historical subscriptions', () => {
    for (const plan of PAID_PLANS) {
      for (const status of LAPSED_STATUSES) {
        assert.deepEqual(resolveEntitlements(plan, status, null), FREE_ENTITLEMENTS);
      }
    }
    assert.deepEqual(resolveEntitlements('free', 'active', null), FREE_ENTITLEMENTS);
  });
});

describe('resolveEntitlements — provider IS NOT NULL is fail-closed', () => {
  it('returns the very FREE_ENTITLEMENTS object, not a copy or a new matrix', () => {
    // Reference equality: there is exactly one definition of the free tier.
    assert.equal(resolveEntitlements('premium', 'active', 'paystack'), FREE_ENTITLEMENTS);
    assert.equal(FREE_ENTITLEMENTS, getEntitlements('free', 'active'));
  });

  it('grants nothing paid for any plan, status or provider state', () => {
    for (const plan of USER_PLANS) {
      for (const status of [...LIVE_STATUSES, ...LAPSED_STATUSES]) {
        for (const provider of ['paystack', IMPOSSIBLE_PROVIDER]) {
          const entitlements = resolveEntitlements(plan, status, provider);
          assert.equal(entitlements, FREE_ENTITLEMENTS, `${plan}/${status}/${provider}`);
          assert.equal(entitlements.canAccessScanner, false);
          assert.equal(entitlements.canAccessAdvancedStrategies, false);
          assert.equal(entitlements.canAccessAdvancedAlerts, false);
          assert.equal(entitlements.canAccessAutomation, false);
          assert.equal(entitlements.maxStrategies, 100);
          assert.equal(entitlements.maxBacktestsPerMonth, 100);
          assert.equal(entitlements.maxAlertsPerMonth, 1000);
          assert.equal(entitlements.maxSavedSetups, 1000);
        }
      }
    }
  });

  it('never reads provider_state: the gate is the provider column alone', () => {
    // The resolver takes exactly three arguments — there is no provider_state
    // parameter to misread as a confirmation.
    assert.equal(resolveEntitlements.length, 3);
  });

  it('fails closed when a reader forgets to select the provider column', () => {
    // `undefined` is `!== null`, so an unwired reader resolves to free rather
    // than silently escalating to a paid tier.
    const forgotten = undefined as unknown as string | null;
    assert.equal(resolveEntitlements('premium', 'active', forgotten), FREE_ENTITLEMENTS);
  });

  it('leaves canAccessAutomation false for every plan, status and provider', () => {
    for (const plan of USER_PLANS) {
      for (const status of [...LIVE_STATUSES, ...LAPSED_STATUSES]) {
        for (const provider of [null, 'paystack']) {
          assert.equal(
            resolveEntitlements(plan, status, provider).canAccessAutomation,
            false,
            `${plan}/${status}/${provider}`,
          );
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. getBillingState                                                         */
/* -------------------------------------------------------------------------- */

describe('getBillingState — historical (provider IS NULL) subscriptions are preserved', () => {
  it('treats a missing subscription row as free with no provider status', async () => {
    const user = await insertUser(pool, false);
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS);
    assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
    assert.equal(state.subscription.plan, 'free');
    assert.equal(state.subscription.id, '');
    assert.ok(billingStateDtoSchema.safeParse(state).success, 'the response still validates');
  });

  it('keeps an existing free subscription free', async () => {
    const userId = await seededUser({ plan: 'free', status: 'active' });
    const state = await getBillingState(pool, userId);
    assert.deepEqual(state.entitlements, getEntitlements('free', 'active'));
    assert.equal(state.entitlements.canAccessScanner, false);
    assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
    // A historical row publishes no provider at all.
    const row = await pool.query('SELECT provider, provider_state FROM subscriptions WHERE user_id=$1', [userId]);
    assert.equal(row.rows[0]!.provider, null);
    assert.equal(row.rows[0]!.provider_state, null);
  });

  it('preserves paid entitlements for pro and premium across active/trialing/past_due', async () => {
    for (const plan of PAID_PLANS) {
      for (const status of LIVE_STATUSES) {
        const userId = await seededUser({ plan, status });
        const state = await getBillingState(pool, userId);
        assert.deepEqual(state.entitlements, getEntitlements(plan, status), `${plan}/${status}`);
        assert.equal(state.entitlements.canAccessScanner, true, `${plan}/${status} keeps the scanner`);
        assert.equal(state.subscription.plan, plan);
        assert.equal(state.subscription.status, status);
        assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
      }
    }
    const premium = await getBillingState(pool, await seededUser({ plan: 'premium', status: 'active' }));
    assert.equal(premium.entitlements.maxStrategies, 1000);
    assert.equal(premium.entitlements.maxBacktestsPerMonth, 5000);
    assert.equal(premium.entitlements.maxAlertsPerMonth, 10000);
    assert.equal(premium.entitlements.maxSavedSetups, 10000);
  });

  it('still falls back to free for canceled/expired historical rows', async () => {
    for (const plan of PAID_PLANS) {
      for (const status of LAPSED_STATUSES) {
        const userId = await seededUser({ plan, status });
        const state = await getBillingState(pool, userId);
        assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, `${plan}/${status}`);
      }
    }
  });

  it('never touches users.plan', async () => {
    const user = await insertUser(pool, false);
    await seedSubscription(user.id, { plan: 'premium', status: 'active' });
    await getBillingState(pool, user.id);
    const row = await pool.query('SELECT plan FROM users WHERE id=$1', [user.id]);
    assert.equal(row.rows[0]!.plan, 'free', 'users.plan is not a billing output');
  });
});

describe('getBillingState — provider-backed subscriptions are fail-closed', () => {
  it('gives a pending paystack checkout the free tier, whatever the plan', async () => {
    for (const plan of PAID_PLANS) {
      const userId = await seededUser({
        plan, status: 'active', provider: 'paystack', providerState: 'pending',
      });
      const state = await getBillingState(pool, userId);
      assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, `${plan}/active/pending`);
      assert.equal(state.entitlements.canAccessScanner, false);
      assert.equal(state.entitlements.canAccessAutomation, false);
      // The stored authoritative values are reported honestly, not rewritten.
      assert.equal(state.subscription.plan, plan);
      assert.equal(state.subscription.status, 'active');
      assert.deepEqual(state.providerStatus, {
        provider: 'paystack', providerState: 'pending', paymentConfirmed: false,
      });
      assert.ok(billingStateDtoSchema.safeParse(state).success, 'the response still validates');
    }
  });

  it('stays free for EVERY provider state, including the ones that look paid', async () => {
    for (const plan of PAID_PLANS) {
      for (const status of LIVE_STATUSES) {
        for (const providerState of PROVIDER_STATES) {
          const userId = await seededUser({
            plan, status, provider: 'paystack', providerState,
          });
          const state = await getBillingState(pool, userId);
          assert.deepEqual(
            state.entitlements, FREE_ENTITLEMENTS,
            `${plan}/${status}/provider_state=${providerState ?? 'NULL'} must not escalate`,
          );
          assert.equal(state.entitlements.canAccessScanner, false);
          assert.equal(state.providerStatus.provider, 'paystack');
          assert.equal(state.providerStatus.providerState, providerState);
          assert.equal(state.providerStatus.paymentConfirmed, false);
        }
      }
    }
  });

  it('does not treat provider_state=active or trialing as payment confirmation', async () => {
    for (const providerState of ['active', 'trialing']) {
      const userId = await seededUser({
        plan: 'premium', status: 'active', provider: 'paystack', providerState,
      });
      const state = await getBillingState(pool, userId);
      assert.equal(state.providerStatus.paymentConfirmed, false);
      assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS);
      assert.notDeepEqual(state.entitlements, getEntitlements('premium', 'active'));
    }
  });

  it('fails closed for a provider value outside the modelled vocabulary', async () => {
    // `subscriptions_provider_check` pins provider to 'paystack'; the resolver
    // is still not a whitelist, so an unexpected value cannot escalate.
    const entitlements = resolveEntitlements('premium', 'active', IMPOSSIBLE_PROVIDER);
    assert.equal(entitlements, FREE_ENTITLEMENTS);
  });

  it('leaves the row itself untouched — reading entitlements writes nothing', async () => {
    const userId = await seededUser({
      plan: 'pro', status: 'active', provider: 'paystack', providerState: 'pending',
    });
    const before = await pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [userId]);
    await getBillingState(pool, userId);
    const after = await pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [userId]);
    assert.deepEqual(after.rows, before.rows);
  });
});

describe('billing-state DTO — a confirmed payment is unrepresentable', () => {
  it('rejects paymentConfirmed: true and any extra provider field', () => {
    const base = {
      subscription: {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        plan: 'pro' as const,
        status: 'active' as const,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
      entitlements: FREE_ENTITLEMENTS,
      providerStatus: { provider: 'paystack', providerState: 'pending', paymentConfirmed: false as const },
    };
    assert.ok(billingStateDtoSchema.safeParse(base).success);
    assert.ok(
      !billingStateDtoSchema.safeParse({
        ...base,
        providerStatus: { ...base.providerStatus, paymentConfirmed: true },
      }).success,
      'paymentConfirmed can never be reported as true in this build',
    );
    assert.ok(
      !billingStateDtoSchema.safeParse({
        ...base,
        providerStatus: { ...base.providerStatus, verified: true },
      }).success,
      'the provider status object is strict',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. AutomationService.readState                                             */
/* -------------------------------------------------------------------------- */

describe('AutomationService.readState — the execution gate reads the same resolver', () => {
  const automation = (): AutomationService =>
    new AutomationService(pool, new KillSwitchService(pool), new AuditService(pool));

  it('resolves historical premium rows to the premium tier, automation still off', async () => {
    const userId = await seededUser({ plan: 'premium', status: 'active' });
    const state = await automation().readState(userId);
    assert.deepEqual(state.entitlements, getEntitlements('premium', 'active'));
    assert.equal(state.entitlements.canAccessAutomation, false);
  });

  it('resolves provider-backed premium rows to the free tier, automation still off', async () => {
    for (const providerState of PROVIDER_STATES) {
      const userId = await seededUser({
        plan: 'premium', status: 'active', provider: 'paystack', providerState,
      });
      const state = await automation().readState(userId);
      assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, `provider_state=${providerState ?? 'NULL'}`);
      assert.equal(state.entitlements.canAccessAutomation, false);
    }
  });

  it('is unchanged for a user with no subscription row at all', async () => {
    const user = await insertUser(pool, false);
    const state = await automation().readState(user.id);
    assert.deepEqual(state.entitlements, getEntitlements('free', 'active'));
    assert.equal(state.entitlements.canAccessAutomation, false);
    assert.equal(state.automationEnabled, false);
  });

  it('still reports the users.automation_enabled switch verbatim', async () => {
    const userId = await seededUser({
      plan: 'premium', status: 'active', provider: 'paystack', providerState: 'active',
    });
    await pool.query('UPDATE users SET automation_enabled = true WHERE id = $1', [userId]);
    const state = await automation().readState(userId);
    assert.equal(state.automationEnabled, true, 'the switch is read, never rewritten');
    assert.equal(state.entitlements.canAccessAutomation, false, 'and it still grants nothing');
    // The public status therefore stays refused.
    const status = await automation().getStatus(userId);
    assert.equal(status.entitled, false);
    assert.equal(status.effective, false);
    assert.ok(status.reasons.includes('entitlement_not_granted'));
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A real transactional limit reader                                       */
/* -------------------------------------------------------------------------- */

describe('StrategyService.createStrategy — the atomic limit read is gated too', () => {
  const strategies = (): StrategyService => new StrategyService(pool, new AuditService(pool));

  async function fillToFreeLimit(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO strategies (user_id, name, description)
       SELECT $1, 'Seeded ' || i, 'fixture' FROM generate_series(1, 100) i`,
      [userId],
    );
  }

  it('lets a historical pro row past the free limit', async () => {
    const userId = await seededUser({ plan: 'pro', status: 'active' });
    await fillToFreeLimit(userId);
    const created = await strategies().createStrategy(userId, { name: 'Historical pro strategy' });
    assert.equal(created.name, 'Historical pro strategy');
    const count = await pool.query('SELECT count(*)::int AS c FROM strategies WHERE user_id=$1', [userId]);
    assert.equal(count.rows[0]!.c, 101);
  });

  it('stops a provider-backed pro row at the free limit', async () => {
    const userId = await seededUser({
      plan: 'pro', status: 'active', provider: 'paystack', providerState: 'pending',
    });
    await fillToFreeLimit(userId);
    await assert.rejects(
      strategies().createStrategy(userId, { name: 'Unpaid checkout strategy' }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /Strategy limit reached/);
        assert.match(message, /up to 100 strategies/, 'the FREE limit is quoted, not the pro limit of 500');
        return true;
      },
    );
    const count = await pool.query('SELECT count(*)::int AS c FROM strategies WHERE user_id=$1', [userId]);
    assert.equal(count.rows[0]!.c, 100, 'nothing was created');
  });

  it('stops a provider-backed premium row at the free limit even with provider_state=active', async () => {
    const userId = await seededUser({
      plan: 'premium', status: 'active', provider: 'paystack', providerState: 'active',
    });
    await fillToFreeLimit(userId);
    await assert.rejects(
      strategies().createStrategy(userId, { name: 'Unpaid elite strategy' }),
      /up to 100 strategies/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Static boundaries                                                       */
/* -------------------------------------------------------------------------- */

describe('static boundaries — the plan matrix stays provider-agnostic', () => {
  const ENTITLEMENTS = read(CORE_SRC, 'billing', 'entitlements.ts');
  const RESOLUTION = read(CORE_SRC, 'billing', 'entitlement-resolution.ts');

  it('entitlements.ts imports only the internal plan vocabulary', () => {
    assert.deepEqual(importsOf(ENTITLEMENTS), ['@veltrixeye/contracts']);
  });

  it('entitlements.ts contains no provider, catalogue or commercial logic', () => {
    assert.doesNotMatch(
      codeOnly(ENTITLEMENTS),
      /catalogue|provider|paystack|commercial|webhook|verify/i,
      'no provider or catalogue input reaches the plan matrix',
    );
  });

  it('getEntitlements keeps its exact provider-agnostic signature', () => {
    assert.match(
      ENTITLEMENTS,
      /export function getEntitlements\(plan: UserPlan, status: string\): Entitlements \{/,
    );
    assert.doesNotMatch(codeOnly(ENTITLEMENTS), /resolveEntitlements/);
  });

  it('the resolver is the only bridge, and it delegates rather than restating limits', () => {
    assert.deepEqual(importsOf(RESOLUTION).sort(), ['@veltrixeye/contracts', './entitlements.js'].sort());
    assert.match(codeOnly(RESOLUTION), /if \(provider !== null\) return FREE_ENTITLEMENTS;/);
    assert.match(codeOnly(RESOLUTION), /return getEntitlements\(plan, status\);/);
    // No second matrix: the resolver declares no limit of its own.
    assert.doesNotMatch(
      codeOnly(RESOLUTION),
      /maxStrategies|maxBacktestsPerMonth|maxAlertsPerMonth|maxSavedSetups|canAccess|\b\d+\b/,
      'the resolver must not restate a single entitlement value',
    );
    // No payment confirmation, no I/O, no provider adapter.
    assert.doesNotMatch(
      codeOnly(RESOLUTION),
      /paystack|fetch|http|query|INSERT|UPDATE|SELECT|confirmed|verified/i,
      'the resolver performs no I/O and confirms no payment',
    );
  });

  it('every production entitlement reader selects provider and uses the resolver', () => {
    const readers = [
      path.join(CORE_SRC, 'billing', 'subscriptions.ts'),
      path.join(CORE_SRC, 'strategies', 'strategies.ts'),
      path.join(CORE_SRC, 'setups', 'service.ts'),
      path.join(CORE_SRC, 'alerts', 'service.ts'),
      path.join(CORE_SRC, 'backtest', 'service.ts'),
      path.join(CORE_SRC, 'scanner', 'service.ts'),
      path.join(CORE_SRC, 'execution', 'automation.ts'),
      path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'scanner.ts'),
    ];
    for (const file of readers) {
      const code = codeOnly(read(file));
      assert.match(code, /resolveEntitlements\(/, `${path.relative(REPO_ROOT, file)} must use the resolver`);
      assert.match(code, /provider/, `${path.relative(REPO_ROOT, file)} must read the provider column`);
      assert.doesNotMatch(code, /getEntitlements\(/, `${path.relative(REPO_ROOT, file)} must not bypass the gate`);
    }
  });

  it('no production module outside the entitlement layer calls getEntitlements directly', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        const relative = path.relative(REPO_ROOT, full);
        if (relative.includes('billing/entitlements.ts') ||
            relative.includes('billing/entitlement-resolution.ts')) continue;
        if (/getEntitlements\s*\(/.test(codeOnly(read(full)))) offenders.push(relative);
      }
    };
    for (const root of [path.join(CORE_SRC), path.join(REPO_ROOT, 'apps', 'api', 'src'), path.join(REPO_ROOT, 'apps', 'web')]) {
      walk(root);
    }
    assert.deepEqual(offenders, [], 'every reader goes through resolveEntitlements');
  });

  it('adds no migration and leaves migrations 0001–0032 as the whole set', () => {
    const files = readdirSync(MIGRATIONS_DIR).sort();
    assert.equal(files.length, 32, `unexpected migration set: ${files.join(', ')}`);
    assert.equal(files[0], '0001_identity_and_audit.sql');
    assert.equal(files[files.length - 1], '0032_billing_fx_and_pricing.sql');
  });

  it('leaves the checkout INSERT shape and the pricing lock untouched', () => {
    const checkout = read(CORE_SRC, 'billing', 'checkout.ts');
    assert.match(checkout, /VALUES \(\$1,\$2,'active',\$3,\$4,'USD','paystack',\$5,'pending',\$6\)/);
    assert.match(checkout, /locked_pricing_snapshot_id/);
    assert.match(checkout, /ON CONFLICT \(user_id\) DO NOTHING/);
    assert.doesNotMatch(codeOnly(checkout), /resolveEntitlements|getEntitlements|FREE_ENTITLEMENTS/,
      'checkout still never resolves an entitlement');
  });

  it('adds no webhook, verification or confirmation surface', () => {
    const billingRoute = read(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'billing.ts');
    // Code only: the route legitimately *documents* that no confirmation
    // authority exists, and prose must not satisfy (or trip) the check.
    assert.doesNotMatch(codeOnly(billingRoute), /webhook|verify|confirm/i);
    const writes = [...billingRoute.matchAll(/app\.(post|put|patch|delete)\s*\(\s*'([^']+)'/g)]
      .map((match) => [match[1], match[2]]);
    assert.deepEqual(writes, [['post', '/api/billing/checkout']], 'no new billing write route');
    const paystackDir = path.join(REPO_ROOT, 'packages', 'providers', 'paystack', 'src');
    for (const entry of readdirSync(paystackDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      assert.doesNotMatch(read(paystackDir, entry.name), /resolveEntitlements|getEntitlements/,
        `${entry.name} must not touch entitlements`);
    }
  });
});
