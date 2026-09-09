/**
 * Regression tests for lib/subscription-plans.ts — the recurring-plan model.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/subscription-plans.test.ts
 */
import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "./checkout-test";
import {
  cancelSubscription,
  describePlan,
  isValidTestSubscription,
  nextRenewalDate,
  startWaxSubscription,
} from "./subscription-plans";

describe("plan descriptors", () => {
  test("wax plan matches the catalog price", () => {
    const plan = describePlan("wax_subscription");
    expect(plan.planId).toBe("wax_subscription_monthly");
    expect(plan.amountCents).toBe(1000);
    expect(plan.currency).toBe("usd");
    expect(plan.interval).toBe("month");
  });

  test("one-time product has no plan", () => {
    expect(() => describePlan("uncontested_packet")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_PRODUCT })
    );
  });

  test("unknown product id throws through describePlan", () => {
    expect(() => describePlan("nope")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_PRODUCT })
    );
  });
});

describe("wax subscription lifecycle", () => {
  test("startWaxSubscription returns plan + active subscription", () => {
    const { plan, subscription } = startWaxSubscription();
    expect(plan.productId).toBe("wax_subscription");
    expect(isValidTestSubscription(subscription)).toBe(true);
    expect(subscription.id.startsWith("sub_test_")).toBe(true);
  });

  test("decline test card throws DECLINED", () => {
    expect(() =>
      startWaxSubscription("wax_subscription", { last4: "0002" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
  });

  test("live options throw TEST_MODE_VIOLATION", () => {
    expect(() =>
      startWaxSubscription("wax_subscription", { last4: "4242" }, { live: true })
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
    );
  });

  test("nextRenewalDate is one month out from start", () => {
    const { subscription } = startWaxSubscription();
    const renewal = nextRenewalDate(subscription);
    const delta =
      new Date(renewal).getTime() - new Date(subscription.startedAt).getTime();
    expect(delta).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("cancel returns a period-end cancellation fixture", () => {
    const { subscription } = startWaxSubscription();
    const c = cancelSubscription(subscription);
    expect(c.status).toBe("canceled");
    expect(c.subscriptionId).toBe(subscription.id);
    expect(c.testMode).toBe(true);
    expect(c.effectiveAt).toBe(nextRenewalDate(subscription, 1));
  });

  test("cancel and renewal reject invalid subscriptions", () => {
    const { subscription } = startWaxSubscription();
    const broken = { ...subscription, id: "sub_fake_1" };
    expect(() => cancelSubscription(broken)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_SESSION })
    );
    expect(() => nextRenewalDate(broken)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_SESSION })
    );
  });
});
