/**
 * Regression tests for lib/webhook-handler.ts — the webhook dispatch
 * skeleton divorce and wax consume through the provider seam.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/webhook-handler.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  createTestCheckout,
  confirmTestPayment,
  confirmTestSubscription,
  type TestWebhookEvent,
} from "./checkout-test";
import {
  deliverTestWebhookEvent,
  parseTestWebhookEvent,
  resetWebhookFixtures,
  type TestWebhookEvent,
} from "./webhook-test";
import {
  HANDLER_ERROR_CODES,
  handleTestWebhookDelivery,
  handleTestWebhookEvent,
  resetWebhookHandler,
} from "./webhook-handler";

/* ── Test harness: fresh ledgers + fresh fixture objects every test ─ */

beforeEach(() => {
  resetWebhookFixtures();
  resetWebhookHandler();
});

function paidReceipt() {
  const session = createTestCheckout("uncontested_packet");
  return confirmTestPayment(session.id, session);
}

function activeSubscription() {
  const session = createTestCheckout("wax_subscription");
  return confirmTestSubscription(session.id, session);
}

function deliver(type: Parameters<typeof deliverTestWebhookEvent>[0], obj: unknown) {
  return deliverTestWebhookEvent(
    type,
    obj as Parameters<typeof deliverTestWebhookEvent>[1]
  );
}

describe("handleTestWebhookDelivery — verify-before-dispatch", () => {
  test("divorce: checkout.session.completed with a valid receipt unlocks the packet", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    const fx = handleTestWebhookDelivery(rawBody, signature);
    expect(fx.effect).toBe("unlock_deliverable");
    expect(fx.testMode).toBe(true);
    expect(fx.eventId.startsWith("evt_test_")).toBe(true);
    expect(fx.object).toEqual(receipt);
    expect(fx.accessUntil).toBeUndefined();
  });

  test("payment_intent.succeeded records the payment", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("payment_intent.succeeded", receipt);
    const fx = handleTestWebhookDelivery(rawBody, signature);
    expect(fx.effect).toBe("record_payment");
    expect(fx.object).toEqual(receipt);
  });

  test("wax: subscription.created provisions access", () => {
    const sub = activeSubscription();
    const { rawBody, signature } = deliver("customer.subscription.created", sub);
    const fx = handleTestWebhookDelivery(rawBody, signature);
    expect(fx.effect).toBe("provision_subscription");
    expect(fx.object).toEqual(sub);
  });

  test("wax: subscription.updated syncs the subscription", () => {
    const sub = activeSubscription();
    const { rawBody, signature } = deliver("customer.subscription.updated", sub);
    const fx = handleTestWebhookDelivery(rawBody, signature);
    expect(fx.effect).toBe("sync_subscription");
  });

  test("wax: subscription.canceled grants access to period end", () => {
    const sub = activeSubscription();
    const { rawBody, signature } = deliver("customer.subscription.canceled", sub);
    const fx = handleTestWebhookDelivery(rawBody, signature);
    expect(fx.effect).toBe("grant_access_to_period_end");
    expect(typeof fx.accessUntil).toBe("string");
    // access runs one billing month past the subscription start
    const start = new Date(sub.startedAt).getTime();
    const until = new Date(fx.accessUntil as string).getTime();
    expect(until).toBeGreaterThan(start);
    expect(until - start).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("tampered signature never reaches a handler (BAD_SIGNATURE)", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    expect(() =>
      handleTestWebhookDelivery(rawBody, signature + "tampered")
    ).toThrow(expect.objectContaining({ code: "BAD_SIGNATURE" }));
  });

  test("replayed delivery is rejected at the verify gate (REPLAYED_EVENT)", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    handleTestWebhookDelivery(rawBody, signature);
    expect(() => handleTestWebhookDelivery(rawBody, signature)).toThrow(
      expect.objectContaining({ code: "REPLAYED_EVENT" })
    );
  });
});

describe("handleTestWebhookEvent — dispatch guards", () => {
  test("handler-level idempotency: same verified event handled once (ALREADY_HANDLED)", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    const event = parseTestWebhookEvent(rawBody, signature);
    const first = handleTestWebhookEvent(event);
    expect(first.effect).toBe("unlock_deliverable");
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
  });

  test("checkout.session.completed never unlocks on a raw session fixture", () => {
    const session = createTestCheckout("uncontested_packet");
    const { event } = deliver("checkout.session.completed", session);
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT })
    );
  });

  test("completed with a wrong-price receipt fixture throws INVALID_OBJECT", () => {
    const receipt = { ...paidReceipt(), amountCents: 9999 };
    const { event } = deliver("checkout.session.completed", receipt);
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT })
    );
  });

  test("subscription.created on a one-time product receipt throws INVALID_OBJECT", () => {
    const receipt = paidReceipt();
    const { event } = deliver("customer.subscription.created", receipt);
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT })
    );
  });

  test("canceled event on a non-fixture payload throws INVALID_OBJECT", () => {
    const junk = { id: "sub_live_123", testMode: false };
    const { event } = deliver("customer.subscription.canceled", junk);
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT })
    );
  });

  test("unknown event type throws UNKNOWN_EVENT_TYPE", () => {
    const receipt = paidReceipt();
    const { event } = deliver("checkout.session.completed", receipt);
    const forged = { ...event, type: "invoice.paid" };
    expect(() => handleTestWebhookEvent(forged as TestWebhookEvent)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.UNKNOWN_EVENT_TYPE })
    );
  });

  test("non-test-mode event object throws INVALID_OBJECT before dispatch", () => {
    expect(() =>
      handleTestWebhookEvent({
        id: "evt_live_1",
        type: "checkout.session.completed",
        testMode: false,
      } as unknown as TestWebhookEvent)
    ).toThrow(expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT }));
  });

  test("resetWebhookHandler lets a handler accept an event again", () => {
    const receipt = paidReceipt();
    const { event } = deliver("checkout.session.completed", receipt);
    handleTestWebhookEvent(event);
    resetWebhookHandler();
    const again = handleTestWebhookEvent(event);
    expect(again.effect).toBe("unlock_deliverable");
  });
});
