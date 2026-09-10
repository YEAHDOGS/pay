/**
 * subscription-plans.ts — the recurring-plan model behind the provider seam.
 *
 * TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 *
 * Wax's $10/mo vinyl drop alerts are sold through these plan descriptors,
 * which hang off the same CheckoutProvider seam divorce uses. The plan
 * model is the lifecycle layer subscriptions need beyond a single
 * confirm call:
 *
 *   - what the plan costs and bills (descriptor off the catalog product)
 *   - starting a subscription (delegates to the provider)
 *   - renewal dates (pure date math, so wax's alert engine can schedule
 *     renewals/reminders without touching money fixtures directly)
 *   - cancellation (a pure fixture record — end-of-period access, no
 *     real billing state anywhere)
 *
 * Everything stays fixture-only: ids are `sub_test_*`, TEST_MODE is
 * hard-coded, and there is NO key material anywhere in this file.
 */

import {
  ERROR_CODES,
  type Subscription,
} from "./checkout-test";
import {
  getProvider,
  isValidTestSubscription,
} from "./checkout-provider";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** Millis in a (calendar-fixed) month for renewal math. */
export const MONTH_MILLIS = 30 * 24 * 60 * 60 * 1000;

/**
 * Plan descriptor: the recurring terms behind one catalog product.
 * Derived from `PRODUCTS` so price drift throws instead of selling
 * the wrong amount.
 */
export interface SubscriptionPlan {
  readonly planId: string;
  readonly productId: string;
  readonly name: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly interval: "month";
  /** Free trial days before the first bill. 0 = bill immediately. */
  readonly trialDays: number;
  /** Whether a canceled subscriber keeps access to period end. */
  readonly keepAccessToPeriodEnd: boolean;
}

/**
 * Cancellation fixture record. Pure data: canceling a test subscription
 * never touches real billing — there is none.
 */
export interface SubscriptionCancellation {
  readonly subscriptionId: string;
  readonly canceledAt: string;
  readonly effectiveAt: string;
  readonly status: "canceled";
  readonly testMode: true;
}

/**
 * Cancellation ledger: subscription id → the cancellation record the
 * first cancel minted. Canceling twice is not a bug in a retrying
 * client — it is a retried cancel, so the second call replays the
 * original record instead of minting a second one with a different
 * timestamp. Callers always receive a fresh copy; the stored record is
 * frozen and can never be corrupted by a mutating caller.
 */
const cancellationLedger = new Map<string, SubscriptionCancellation>();

/**
 * Reset the cancellation ledger. For tests only — mirrors
 * `resetCheckoutIdempotency()` / `resetRefundFixtures()` in
 * checkout-test.ts.
 */
export function resetCancellationFixtures(): void {
  cancellationLedger.clear();
}

/* ── Plan descriptors ────────────────────────────────────────────── */

/**
 * Look up the recurring plan for a catalog product.
 * @throws {Error} code UNKNOWN_PRODUCT when the id is not a recurring product
 */
export function describePlan(productId: string): SubscriptionPlan {
  const provider = getProvider();
  const product = provider.product(productId);
  if (product.billing !== "recurring") {
    const err = new Error(
      `subscription-plans: "${productId}" is not a recurring product — plans only describe subscriptions.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_PRODUCT;
    throw err;
  }
  return {
    planId: `${product.id}_monthly`,
    productId: product.id,
    name: product.name,
    amountCents: product.amountCents,
    currency: product.currency,
    interval: "month",
    trialDays: 0,
    keepAccessToPeriodEnd: true,
  };
}

/* ── Lifecycle helpers ───────────────────────────────────────────── */

/**
 * Start a wax subscription through the seam: describe the plan, open a
 * session, confirm with the test card, return the plan + subscription.
 * @throws {Error} code UNKNOWN_PRODUCT | DECLINED | TEST_MODE_VIOLATION
 */
export function startWaxSubscription(
  productId: string = "wax_subscription",
  card: { last4?: string } = { last4: "4242" },
  options: Record<string, unknown> = {}
): { plan: SubscriptionPlan; subscription: Subscription } {
  const provider = getProvider("test-fixture", options);
  const plan = describePlan(productId);
  const session = provider.createSession(productId, options);
  const subscription = provider.confirmSubscription(
    session.id,
    session,
    card,
    options
  );
  return { plan, subscription };
}

/**
 * Compute the nth renewal date after the subscription started.
 * Pure date math for wax's alert/renewal scheduler.
 */
export function nextRenewalDate(
  subscription: Subscription,
  periods: number = 1
): string {
  if (!isValidTestSubscription(subscription)) {
    const err = new Error(
      "subscription-plans: cannot schedule renewals on an invalid subscription."
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_SESSION;
    throw err;
  }
  const start = new Date(subscription.startedAt).getTime();
  return new Date(start + MONTH_MILLIS * periods).toISOString();
}

/**
 * Cancel a subscription at period end. Returns a pure fixture record;
 * access runs until `effectiveAt` when the plan allows it.
 *
 * Idempotent: a subscription cancels exactly once. A second call with
 * the same subscription replays the original cancellation record —
 * a retried cancel must not mint a second record with a different
 * timestamp, or the ledger drifts on exactly the retries checkout
 * clients are expected to do.
 */
export function cancelSubscription(
  subscription: Subscription
): SubscriptionCancellation {
  if (!isValidTestSubscription(subscription)) {
    const err = new Error(
      "subscription-plans: cannot cancel an invalid subscription."
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_SESSION;
    throw err;
  }
  const stored = cancellationLedger.get(subscription.id);
  if (stored !== undefined) {
    // Replay: hand out a copy so the caller's mutations can never
    // corrupt the ledger's record of the cancel.
    return { ...stored };
  }
  const plan = describePlan(subscription.productId);
  const canceledAt = new Date().toISOString();
  const effectiveAt = plan.keepAccessToPeriodEnd
    ? nextRenewalDate(subscription, 1)
    : canceledAt;
  const cancellation = Object.freeze({
    subscriptionId: subscription.id,
    canceledAt,
    effectiveAt,
    status: "canceled",
    testMode: true,
  }) as SubscriptionCancellation;
  cancellationLedger.set(subscription.id, cancellation);
  return { ...cancellation };
}

export { isValidTestSubscription };
