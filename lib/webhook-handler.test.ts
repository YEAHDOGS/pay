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
  signTestWebhookPayload,
  TEST_WEBHOOK_SECRET,
  type TestWebhookEvent,
} from "./webhook-test";
import {
  HANDLER_ERROR_CODES,
  BOUNDED_LEDGER_DEFAULTS,
  BoundedIdempotencyLedger,
  getAuditLog,
  getHandlerLedger,
  handleTestWebhookDelivery,
  handleTestWebhookEvent,
  resetWebhookHandler,
  setHandlerLedger,
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

describe("idempotency hardening — duplicates, out-of-order, conflicts", () => {
  test("duplicate event id is acknowledged but NEVER re-processed (ALREADY_HANDLED)", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    const first = handleTestWebhookDelivery(rawBody, signature);
    expect(first.effect).toBe("unlock_deliverable");

    // The parse-level replay gate would fire first — clear it so the
    // duplicate reaches the HANDLER ledger, the layer under test.
    resetWebhookFixtures();
    expect(() => handleTestWebhookDelivery(rawBody, signature)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
    // Still exactly one recorded id: no second effect was produced.
    expect(getHandlerLedger().size).toBe(1);
    // The audit trail shows the ack: received → produced → rejected.
    const trail = getAuditLog()
      .entries()
      .map((r) => `${r.kind}:${r.code ?? ""}`);
    expect(trail).toEqual([
      "webhook.received:",
      "effect.produced:",
      "webhook.received:",
      `delivery.rejected:${HANDLER_ERROR_CODES.ALREADY_HANDLED}`,
    ]);
  });

  test("out-of-order events settle correctly: each id earns exactly one effect", () => {
    const sub = activeSubscription();
    const now = Math.floor(Date.now() / 1000);
    // The LATER event (subscription.created) is delivered FIRST; the
    // EARLIER one (subscription.updated) arrives after — a classic
    // retry-storm ordering. Both must settle exactly once.
    const later = deliverTestWebhookEvent("customer.subscription.created", sub, { created: now });
    const earlier = deliverTestWebhookEvent("customer.subscription.updated", sub, { created: now - 60 });
    const fxFirst = handleTestWebhookDelivery(later.rawBody, later.signature);
    const fxSecond = handleTestWebhookDelivery(earlier.rawBody, earlier.signature);
    expect(fxFirst.effect).toBe("provision_subscription");
    expect(fxSecond.effect).toBe("sync_subscription");
    expect(getHandlerLedger().size).toBe(2);

    // Redelivery of either (parse gate cleared) is refused, not
    // re-processed — arrival order never changes the outcome.
    resetWebhookFixtures();
    expect(() => handleTestWebhookDelivery(later.rawBody, later.signature)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
    resetWebhookFixtures();
    expect(() => handleTestWebhookDelivery(earlier.rawBody, earlier.signature)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
    expect(getHandlerLedger().size).toBe(2);
  });

  test("same event id with a DIFFERENT payload → PAYLOAD_CONFLICT (never swallowed)", () => {
    const receipt = paidReceipt();
    const { rawBody, signature, event } = deliver("checkout.session.completed", receipt);
    handleTestWebhookDelivery(rawBody, signature);

    // Craft a byte-different body for the SAME event id: bump `created`
    // 30s (stays inside the 300s freshness window), then re-sign with
    // the fixture key — this is exactly what a tampered replay looks
    // like on the wire.
    const forged = { ...JSON.parse(rawBody), created: event.created + 30 };
    const forgedBody = JSON.stringify(forged);
    const forgedSignature = signTestWebhookPayload(
      forgedBody,
      TEST_WEBHOOK_SECRET,
      forged.created
    );
    resetWebhookFixtures(); // let it past the parse-level gate
    expect(() => handleTestWebhookDelivery(forgedBody, forgedSignature)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.PAYLOAD_CONFLICT })
    );
    // One id, one effect — the forged replay earned nothing.
    expect(getHandlerLedger().size).toBe(1);
    const rejected = getAuditLog()
      .entries()
      .filter((r) => r.kind === "delivery.rejected" && r.eventId === event.id)
      .map((r) => r.code);
    expect(rejected).toEqual([HANDLER_ERROR_CODES.PAYLOAD_CONFLICT]);
  });

  test("direct handler calls without a fingerprint fall back to ALREADY_HANDLED", () => {
    const receipt = paidReceipt();
    const { rawBody, signature } = deliver("checkout.session.completed", receipt);
    const event = parseTestWebhookEvent(rawBody, signature);
    handleTestWebhookEvent(event);
    // No fingerprint supplied: the handler can't judge payload sameness,
    // so a repeat is the classic acknowledged duplicate.
    expect(() => handleTestWebhookEvent(event)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
  });

  test("handler default ledger is bounded: 10k+ deliveries don't grow memory", () => {
    const ledger = getHandlerLedger();
    expect(ledger).toBeInstanceOf(BoundedIdempotencyLedger);
    expect((ledger as BoundedIdempotencyLedger).capacity).toBe(
      BOUNDED_LEDGER_DEFAULTS.MAX_ENTRIES
    );
    // Prove boundedness end-to-end through the intake with a small cap:
    // 60 distinct valid events, cap 50 → never more than 50 ids held,
    // and no delivery ever throws on capacity.
    setHandlerLedger(
      new BoundedIdempotencyLedger({ maxEntries: 50, ttlSeconds: 0 })
    );
    for (let i = 0; i < 60; i++) {
      const { rawBody, signature } = deliver(
        "payment_intent.succeeded",
        paidReceipt()
      );
      handleTestWebhookDelivery(rawBody, signature);
    }
    const small = getHandlerLedger() as BoundedIdempotencyLedger;
    expect(small.size).toBeLessThanOrEqual(50);
    // And the most recent deliveries still dedupe correctly.
    const last = deliver("payment_intent.succeeded", paidReceipt());
    handleTestWebhookDelivery(last.rawBody, last.signature);
    resetWebhookFixtures();
    expect(() => handleTestWebhookDelivery(last.rawBody, last.signature)).toThrow(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
  });
});
