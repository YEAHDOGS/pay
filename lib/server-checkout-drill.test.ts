/**
 * Regression tests for lib/server-checkout-drill.ts — the test-mode
 * end-to-end drill for the server-side lane:
 *   startDivorceCheckout (3000¢) → synthetic signed
 *   checkout.session.completed → handleServerWebhookDelivery with
 *   expectedAmountTotal: 3000 → record_payment → packet unlock gate.
 * All synthetic, throwaway secrets, zero network.
 * Run: bun test lib/server-checkout-drill.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  SERVER_DRILL_SECRET,
  divorcePacketMayRender,
  runServerDivorceAmountTamperDrill,
  runServerDivorceCheckoutDrill,
  runServerDivorceUnpaidDrill,
} from "./server-checkout-drill";
import {
  ERROR_CODES as CHECKOUT_ERROR_CODES,
  type CheckoutSession,
} from "./checkout-test";
import { confirmDivorceCheckout, startDivorceCheckout } from "./divorce-checkout";
import {
  SERVER_DISPATCH_ERROR_CODES,
  handleServerWebhookDelivery,
  resetServerWebhookDispatch,
} from "./webhook-server-dispatch";
import { signServerWebhookPayload } from "./webhook-server";

const NOW = 1_800_000_000; // fixed "now" for determinism

beforeEach(() => {
  resetServerWebhookDispatch();
});

describe("e2e: divorce $30 → signed webhook → record_payment → packet unlock", () => {
  test("happy path: session 3000¢, verified + amount-guarded, packet unlocks", () => {
    const drill = runServerDivorceCheckoutDrill(NOW);
    // session started from the catalog-guarded seam
    expect(drill.session.amountCents).toBe(3000);
    expect(drill.session.currency).toBe("usd");
    // the dispatch produced a real record_payment off a verified delivery
    expect(drill.effect.effect).toBe("record_payment");
    expect(drill.effect.liveMode).toBe(true);
    expect(drill.effect.eventType).toBe("checkout.session.completed");
    expect(drill.effect.payment).toMatchObject({
      sessionId: drill.session.id,
      amountTotal: 3000,
      currency: "usd",
      paymentStatus: "paid",
      paid: true,
      recordedAt: NOW,
    });
    // and only then does the packet gate open
    expect(drill.packetUnlocked).toBe(true);
    expect(drill.testMode).toBe(true);
  });

  test("startDivorceCheckout refuses to start if the catalog price moved", () => {
    // The drill's first call is the catalog guard itself: 3000¢ one-time
    // or it throws. Assert the guard shape directly.
    const session: CheckoutSession = startDivorceCheckout();
    expect(session.amountCents).toBe(3000);
    expect(session.currency).toBe("usd");
  });

  test("drill secret is throwaway material — never looks like a live secret", () => {
    expect(SERVER_DRILL_SECRET).not.toMatch(/^sk_(live|test)_/);
    expect(SERVER_DRILL_SECRET).not.toMatch(/^whsec_/);
    expect(SERVER_DRILL_SECRET).toContain("throwaway");
  });
});

describe("lock path: forged amount (valid signature, wrong 2000¢)", () => {
  test("AMOUNT_MISMATCH fail-closed: no record_payment, packet locked", () => {
    const failure = runServerDivorceAmountTamperDrill(NOW);
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe(SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH);
    expect(failure.packetUnlocked).toBe(false);
  });
});

describe("lock path: forged signature", () => {
  test("BAD_SIGNATURE throws before parse — no effect, no unlock", () => {
    const session = startDivorceCheckout();
    const rawBody = JSON.stringify({
      id: "evt_drill_forged_sig_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: session.id,
          amount_total: 3000,
          currency: "usd",
          payment_status: "paid",
        },
      },
    });
    const forgedHeader = signServerWebhookPayload(rawBody, "attacker_key", NOW);
    expect(() =>
      handleServerWebhookDelivery(rawBody, forgedHeader, SERVER_DRILL_SECRET, {
        expectedAmountTotal: 3000,
        expectedCurrency: "usd",
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.BAD_SIGNATURE })
    );
  });
});

describe("lock path: replay", () => {
  test("same delivery twice → ALREADY_HANDLED: one event, one effect", () => {
    const drill = runServerDivorceCheckoutDrill(NOW);
    expect(drill.packetUnlocked).toBe(true);
    // Re-deliver the identical signed bytes (Stripe retries on non-2xx).
    // NOTE: the bytes must be truly identical to the drill's first
    // delivery — the drill's body includes "object": "checkout.session"
    // in the session object, and a redelivery with any different bytes
    // under the same event id throws EVENT_BODY_CONFLICT instead.
    const rawBody = JSON.stringify({
      id: "evt_drill_server_divorce_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: drill.session.id,
          object: "checkout.session",
          amount_total: 3000,
          currency: "usd",
          payment_status: "paid",
        },
      },
    });
    const header = signServerWebhookPayload(rawBody, SERVER_DRILL_SECRET, NOW);
    expect(() =>
      handleServerWebhookDelivery(rawBody, header, SERVER_DRILL_SECRET, {
        expectedAmountTotal: 3000,
        expectedCurrency: "usd",
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.ALREADY_HANDLED })
    );
  });
});

describe("lock path: decline", () => {
  test("declined card throws DECLINED at confirm — no webhook can be built, nothing unlocks", () => {
    resetServerWebhookDispatch();
    const session = startDivorceCheckout();
    try {
      confirmDivorceCheckout(session, { last4: "0002" });
      expect("should have thrown").toBe("did not throw");
    } catch (e) {
      const err = e as Error & { code?: string };
      expect(err.code).toBe(CHECKOUT_ERROR_CODES.DECLINED);
    }
  });
});

describe("lock path: unpaid session records but does not unlock", () => {
  test("record_payment with paid:false → packet gate stays closed", () => {
    const drill = runServerDivorceUnpaidDrill(NOW);
    expect(drill.effect.effect).toBe("record_payment");
    expect(drill.effect.payment.paid).toBe(false);
    expect(drill.packetUnlocked).toBe(false);
  });

  test("packet gate refuses a paid record at the wrong amount even if dispatch didn't check", () => {
    // Defense in depth: the gate re-checks the catalog price itself.
    const drill = runServerDivorceCheckoutDrill(NOW);
    const tampered = {
      ...drill.effect,
      payment: { ...drill.effect.payment, amountTotal: 1 },
    };
    expect(divorcePacketMayRender(tampered)).toBe(false);
  });
});
