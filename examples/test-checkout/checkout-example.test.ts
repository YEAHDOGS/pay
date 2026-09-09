/**
 * checkout-example.test.ts — regression tests for the browser example.
 *
 * These drive the EXACT module the example page imports
 * (examples/test-checkout/example-logic.js) so the in-browser loop
 * and the test suite can never drift apart: if the example's guards
 * break, these tests go red.
 *
 * TEST MODE ONLY. No network, no real money, fixture keys only.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
} from "bun:test";
import {
  ERROR_CODES,
  EXAMPLE_WEBHOOK_SECRET,
  PRODUCTS,
  WEBHOOK_TOLERANCE_SECONDS,
  assertFixtureSecret,
  confirmTestPayment,
  createTestSession,
  deliverTestWebhookEvent,
  isValidTestReceipt,
  parseTestWebhookEvent,
  resetExampleFixtures,
  verifyTestWebhookSignature,
} from "./example-logic.js";

beforeEach(() => {
  resetExampleFixtures();
});

/* ── Helpers ─────────────────────────────────────────────────────── */

async function paidReceipt() {
  const session = createTestSession("uncontested_packet");
  return confirmTestPayment(session.id, session);
}

/* ── The full loop the example's "Pay $30 (test)" button runs ────── */

describe("example full loop (what index.html drives)", () => {
  test("session → confirm → signed webhook → verified → fulfilled receipt", async () => {
    const product = PRODUCTS.uncontested_packet;
    const session = createTestSession(product.id);
    expect(session.id.startsWith("cs_test_")).toBe(true);
    expect(session.amountCents).toBe(3000);
    expect(session.testMode).toBe(true);

    const receipt = await confirmTestPayment(session.id, session);
    expect(receipt.id.startsWith("rcpt_test_")).toBe(true);
    expect(receipt.status).toBe("succeeded");
    expect(isValidTestReceipt(receipt)).toBe(true);

    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const event = await parseTestWebhookEvent(rawBody, signature);
    expect(event.id.startsWith("evt_test_")).toBe(true);
    expect(event.type).toBe("checkout.session.completed");
    expect(event.testMode).toBe(true);
    expect(isValidTestReceipt(event.data.object)).toBe(true);
  });

  test("receipt shape contract: catalog-priced, test-mode, prefixed ids", async () => {
    const receipt = await paidReceipt();
    const { event } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const o = event.data.object as Record<string, unknown>;
    expect(o.id).toMatch(/^rcpt_test_/);
    expect(o.amountCents).toBe(PRODUCTS.uncontested_packet.amountCents);
    expect(o.currency).toBe("usd");
    expect(o.testMode).toBe(true);
    expect(o.status).toBe("succeeded");
  });
});

/* ── The guards the example's demo buttons exercise ───────────────── */

describe("example guards (replay / tamper / decline)", () => {
  test("tampered payload fails signature verification → BAD_SIGNATURE", async () => {
    const receipt = await paidReceipt();
    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const tampered = rawBody.replace("3000", "2999");
    expect(
      await verifyTestWebhookSignature(tampered, signature, EXAMPLE_WEBHOOK_SECRET)
    ).toBe(false);
    const e = await parseTestWebhookEvent(tampered, signature).catch((x) => x);
    expect(e.code).toBe(ERROR_CODES.BAD_SIGNATURE);
  });

  test("replayed webhook is rejected → REPLAYED_EVENT", async () => {
    const receipt = await paidReceipt();
    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    await parseTestWebhookEvent(rawBody, signature); // accepted once
    const e = await parseTestWebhookEvent(rawBody, signature).catch((x) => x);
    expect(e.code).toBe(ERROR_CODES.REPLAYED_EVENT);
  });

  test("stale event is rejected → EXPIRED_EVENT", async () => {
    const receipt = await paidReceipt();
    const stale = Math.floor(Date.now() / 1000) - (WEBHOOK_TOLERANCE_SECONDS + 60);
    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt,
      { created: stale }
    );
    const e = await parseTestWebhookEvent(rawBody, signature).catch((x) => x);
    expect(e.code).toBe(ERROR_CODES.EXPIRED_EVENT);
  });

  test("decline card (last4 0002) → DECLINED", async () => {
    const session = createTestSession("uncontested_packet");
    const e = await confirmTestPayment(session.id, session, { last4: "0002" }).catch(
      (x) => x
    );
    expect(e.code).toBe(ERROR_CODES.DECLINED);
  });

  test("non-fixture event shape → BAD_EVENT", async () => {
    // sign a body that claims testMode:false with the fixture key —
    // the signature verifies, but the shape check must still refuse it
    const receipt = await paidReceipt();
    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const spoofed = rawBody.replace('"testMode":true', '"testMode":false');
    // re-sign the spoofed body so the failure is the shape gate, not the sig gate
    const { signTestWebhookPayload } = await import("./example-logic.js");
    const created = JSON.parse(spoofed).created;
    const spoofedSig = await signTestWebhookPayload(
      spoofed,
      EXAMPLE_WEBHOOK_SECRET,
      created
    );
    const e = await parseTestWebhookEvent(spoofed, spoofedSig).catch((x) => x);
    expect(e.code).toBe(ERROR_CODES.BAD_EVENT);
  });
});

/* ── Session/payment input guards ─────────────────────────────────── */

describe("example input guards", () => {
  test("unknown product → UNKNOWN_PRODUCT", () => {
    const e = (() => {
      try {
        createTestSession("nope");
      } catch (x) {
        return x as { code: string };
      }
    })();
    expect(e?.code).toBe(ERROR_CODES.UNKNOWN_PRODUCT);
  });

  test("wrong amount → INVALID_AMOUNT (fixture price integrity)", () => {
    const e = (() => {
      try {
        createTestSession("uncontested_packet", 2999);
      } catch (x) {
        return x as { code: string };
      }
    })();
    expect(e?.code).toBe(ERROR_CODES.INVALID_AMOUNT);
  });

  test("live-mode flags → TEST_MODE_VIOLATION", () => {
    for (const options of [
      { live: true },
      { mode: "live" },
      { mode: "production" },
    ]) {
      expect(() => createTestSession("uncontested_packet", undefined, options)).toThrow();
    }
  });
});

/* ── Fixture-key gate ─────────────────────────────────────────────── */

describe("example fixture-key gate", () => {
  test("live-looking secrets are refused", () => {
    for (const bad of [
      "whsec_live_abc123",
      "sk_test_anything",
      "",
    ]) {
      expect(() => assertFixtureSecret(bad)).toThrow();
    }
  });

  test("verify with a non-fixture secret returns false (never throws)", async () => {
    const receipt = await paidReceipt();
    const { rawBody, signature } = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    expect(
      await verifyTestWebhookSignature(rawBody, signature, "whsec_live_abc123")
    ).toBe(false);
  });

  test("sign with a non-fixture secret throws BAD_SIGNATURE", async () => {
    const receipt = await paidReceipt();
    const e = await deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt,
      { secret: "whsec_live_abc123" }
    ).catch((x) => x);
    expect(e.code).toBe(ERROR_CODES.BAD_SIGNATURE);
  });
});
