import { describe, test, expect } from "bun:test";
import {
  runDivorceStagingDrill,
  runDivorceDeclineDrill,
  runWaxStagingDrill,
  runWaxCancelStagingDrill,
  verifyThenDispatch,
  resetStagingDrill,
  DRILL_ERROR_CODES,
} from "./staging-drill";
import { getProvider } from "./checkout-provider";
import {
  isValidTestReceipt,
  isValidTestSubscription,
} from "./checkout-test";
import {
  deliverTestWebhookEvent,
  parseTestWebhookEvent,
  resetWebhookFixtures,
  WEBHOOK_ERROR_CODES,
} from "./webhook-test";
import { HANDLER_ERROR_CODES, handleTestWebhookEvent } from "./webhook-handler";
import { MONTH_MILLIS } from "./subscription-plans";

describe("divorce staging drill — the $30 milestone", () => {
  test("full loop yields unlock_deliverable for the $30 packet", () => {
    const { effect, receipt } = runDivorceStagingDrill();
    expect(effect.effect).toBe("unlock_deliverable");
    expect(effect.eventType).toBe("checkout.session.completed");
    expect(effect.testMode).toBe(true);
    expect(effect.eventId.startsWith("evt_test_")).toBe(true);
    expect(receipt!.amountCents).toBe(3000);
    expect(receipt!.productId).toBe("uncontested_packet");
    // The effect carries the VERIFIED PARSED receipt (it round-tripped
    // through JSON sign/verify), so the unlock came from verified data —
    // never from the in-process object alone.
    expect(effect.object).toEqual(receipt);
    expect((effect.object as Receipt).id).toBe(receipt!.id);
    expect(isValidTestReceipt(effect.object)).toBe(true);
  });

  test("drills are isolated: back-to-back runs never replay-collide", () => {
    const first = runDivorceStagingDrill();
    const second = runDivorceStagingDrill();
    expect(first.effect.effect).toBe("unlock_deliverable");
    expect(second.effect.effect).toBe("unlock_deliverable");
    // Event ids derive from (type, receipt id); each drill mints a new
    // receipt, so ids differ — but the ledger resets mean neither run
    // sees the other's id as a replay.
    expect(first.effect.eventId.startsWith("evt_test_")).toBe(true);
    expect(second.effect.eventId.startsWith("evt_test_")).toBe(true);
    expect(first.effect.eventId).not.toBe(second.effect.eventId);
  });
});

describe("decline path — nothing can unlock", () => {
  test("decline card 0002 aborts with a structured failure", () => {
    const result = runDivorceDeclineDrill();
    expect(result.ok).toBe(false);
    expect(result.code).toBe(DRILL_ERROR_CODES.DRILL_DECLINED);
    expect("effect" in result).toBe(false);
    expect("receipt" in result).toBe(false);
  });

  test("a non-decline card in the decline drill is itself a failure", () => {
    expect(() => runDivorceDeclineDrill("4242")).toThrow();
  });
});

describe("wax staging drill — the $10/mo milestone", () => {
  test("full loop yields provision_subscription for $10/mo", () => {
    const { effect, subscription } = runWaxStagingDrill();
    expect(effect.effect).toBe("provision_subscription");
    expect(effect.eventType).toBe("customer.subscription.created");
    expect(subscription!.amountCents).toBe(1000);
    expect(subscription!.interval).toBe("month");
    expect(isValidTestSubscription(effect.object)).toBe(true);
  });

  test("cancel drill grants access to period end on a non-active fixture", () => {
    const { effect, subscription } = runWaxCancelStagingDrill();
    expect(effect.effect).toBe("grant_access_to_period_end");
    expect(effect.eventType).toBe("customer.subscription.canceled");
    // accessUntil = startedAt + one calendar-fixed month.
    const expected = new Date(
      new Date(subscription!.startedAt).getTime() + MONTH_MILLIS
    ).toISOString();
    expect(effect.accessUntil).toBe(expected);
  });
});

describe("verify-then-dispatch — the server-route shape", () => {
  test("tampered payload throws BAD_SIGNATURE before any dispatch", () => {
    resetStagingDrill();
    const provider = getProvider();
    const session = provider.createSession("uncontested_packet");
    const receipt = provider.confirmPayment(session.id, session);
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const tampered = rawBody.replace("3000", "3001");
    expect(tampered).not.toBe(rawBody);
    try {
      verifyThenDispatch(tampered, signature);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        WEBHOOK_ERROR_CODES.BAD_SIGNATURE
      );
    }
  });

  test("redelivered webhook is rejected: replay ledger, then handler ledger", () => {
    resetStagingDrill();
    const provider = getProvider();
    const session = provider.createSession("uncontested_packet");
    const receipt = provider.confirmPayment(session.id, session);
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const effect = verifyThenDispatch(rawBody, signature);
    expect(effect.effect).toBe("unlock_deliverable");
    // Second delivery of the SAME event: the parse replay ledger
    // rejects first (REPLAYED_EVENT). The handler ledger is defense
    // in depth — never reached here, still asserted below.
    try {
      verifyThenDispatch(rawBody, signature);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        WEBHOOK_ERROR_CODES.REPLAYED_EVENT
      );
    }
    // Handler ledger independently refuses a redispatch even when the
    // parse ledger is cleared (simulating a verify-path bypass).
    resetWebhookFixtures();
    const event = parseTestWebhookEvent(rawBody, signature);
    try {
      handleTestWebhookEvent(event);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        HANDLER_ERROR_CODES.ALREADY_HANDLED
      );
    }
  });
});
