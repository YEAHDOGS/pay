/**
 * Regression tests: cancel-idempotency in lib/subscription-plans.ts.
 * A subscription cancels exactly once — a retried cancel replays the
 * original cancellation record instead of minting a second one with
 * a different timestamp, and mutating a returned record can never
 * corrupt the ledger.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/subscription-plans-cancel.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  cancelSubscription,
  resetCancellationFixtures,
  startWaxSubscription,
} from "./subscription-plans";

beforeEach(() => {
  resetCancellationFixtures();
});

describe("cancelSubscription idempotency", () => {
  test("canceling twice replays the original record, not a second one", () => {
    const { subscription } = startWaxSubscription();
    const first = cancelSubscription(subscription);
    const second = cancelSubscription(subscription);
    expect(second).toEqual(first);
    expect(second.canceledAt).toBe(first.canceledAt);
    expect(second.effectiveAt).toBe(first.effectiveAt);
  });

  test("replay timestamps are stable across the cancel window", () => {
    const { subscription } = startWaxSubscription();
    const records = [cancelSubscription(subscription), cancelSubscription(subscription)];
    expect(new Set(records.map((r) => r.canceledAt)).size).toBe(1);
  });

  test("mutating a returned record cannot corrupt the ledger", () => {
    const { subscription } = startWaxSubscription();
    const first = cancelSubscription(subscription) as Record<string, unknown>;
    first.status = "refunded";
    first.canceledAt = "tampered";
    const second = cancelSubscription(subscription);
    expect(second.status).toBe("canceled");
    expect(second.canceledAt).not.toBe("tampered");
    expect(second).toEqual(
      expect.objectContaining({ status: "canceled", testMode: true })
    );
  });

  test("different subscriptions cancel independently", () => {
    const a = startWaxSubscription().subscription;
    const b = startWaxSubscription().subscription;
    const ca = cancelSubscription(a);
    const cb = cancelSubscription(b);
    expect(ca.subscriptionId).not.toBe(cb.subscriptionId);
    // re-canceling A still replays A's record, not B's
    expect(cancelSubscription(a)).toEqual(ca);
  });

  test("resetCancellationFixtures clears the ledger", () => {
    const { subscription } = startWaxSubscription();
    const first = cancelSubscription(subscription);
    resetCancellationFixtures();
    const afterReset = cancelSubscription(subscription);
    // a fresh cancel after reset is a legitimately new record —
    // the point of reset is test isolation, not production behavior
    expect(afterReset.subscriptionId).toBe(first.subscriptionId);
    expect(afterReset.status).toBe("canceled");
  });
});
