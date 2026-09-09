/**
 * Regression tests for lib/webhook-test.ts — the test-mode webhook
 * fixtures divorce's checkout modal needs to unlock the packet.
 * Fixtures only: dummy keys, no network. Run: bun test lib/webhook-test.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  confirmTestPayment,
  createTestCheckout,
  isValidTestReceipt,
} from "./checkout-test";
import {
  WEBHOOK_ERROR_CODES,
  WEBHOOK_TOLERANCE_SECONDS,
  TEST_WEBHOOK_SECRET,
  deliverTestWebhookEvent,
  fixtureSha256,
  parseTestWebhookEvent,
  resetWebhookFixtures,
  signTestWebhookPayload,
  testEventId,
  verifyTestWebhookSignature,
} from "./webhook-test";

beforeEach(() => {
  resetWebhookFixtures();
});

describe("fixture secret guardrails", () => {
  test("dummy secret is unmistakably fixture-only", () => {
    expect(TEST_WEBHOOK_SECRET.startsWith("whsec_test_fixture_")).toBe(true);
    expect(TEST_WEBHOOK_SECRET).toContain("DO_NOT_USE_FOR_REAL_MONEY");
  });

  test("signing with a real-looking secret is refused", () => {
    expect(() =>
      signTestWebhookPayload("{}", "whsec_live_abc123real")
    ).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.BAD_SIGNATURE })
    );
  });

  test("verifying with a non-fixture secret returns false, never throws", () => {
    expect(
      verifyTestWebhookSignature("{}", "t=1,v1=deadbeef", "sk_live_xyz")
    ).toBe(false);
  });

  test("webhook tolerance is 5 minutes", () => {
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });
});

describe("deterministic fixture behavior", () => {
  test("same (type, object) always yields the same event id", () => {
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const a = deliverTestWebhookEvent("checkout.session.completed", receipt, {
      created: 1_000_000,
    });
    const b = deliverTestWebhookEvent("checkout.session.completed", receipt, {
      created: 1_000_000,
    });
    expect(a.event.id).toBe(b.event.id);
    expect(a.event.id.startsWith("evt_test_")).toBe(true);
    expect(a.rawBody).toBe(b.rawBody);
    expect(a.signature).toBe(b.signature);
  });

  test("event id helper matches delivered events", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(testEventId("checkout.session.completed", session.id)).toBe(
      deliverTestWebhookEvent("checkout.session.completed", session, {
        created: 1_000_000,
      }).event.id
    );
  });

  test("different objects get different event ids", () => {
    const s1 = createTestCheckout("uncontested_packet");
    const s2 = createTestCheckout("uncontested_packet");
    expect(testEventId("checkout.session.completed", s1.id)).not.toBe(
      testEventId("checkout.session.completed", s2.id)
    );
  });
});

describe("signature verification", () => {
  test("a freshly signed payload verifies", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    expect(verifyTestWebhookSignature(rawBody, signature)).toBe(true);
  });

  test("tampered body fails verification", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    const tampered = rawBody.replace("uncontested_packet", "premium_packet");
    expect(verifyTestWebhookSignature(tampered, signature)).toBe(false);
  });

  test("wrong secret fails verification", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    const forged = signTestWebhookPayload(
      rawBody,
      "whsec_test_fixture_attacker_key_DO_NOT_USE_FOR_REAL_MONEY",
      Math.floor(Date.now() / 1000)
    );
    expect(verifyTestWebhookSignature(rawBody, forged)).toBe(false);
  });

  test("malformed signatures fail without throwing", () => {
    expect(verifyTestWebhookSignature("{}", "")).toBe(false);
    expect(verifyTestWebhookSignature("{}", "garbage")).toBe(false);
    expect(verifyTestWebhookSignature("{}", "t=abc,v1=zzz")).toBe(false);
  });
});

describe("parseTestWebhookEvent — the modal unlock gate", () => {
  test("valid event parses and carries the receipt", () => {
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const { rawBody, signature } = deliverTestWebhookEvent(
      "payment_intent.succeeded",
      receipt
    );
    const event = parseTestWebhookEvent(rawBody, signature);
    expect(event.testMode).toBe(true);
    expect(event.type).toBe("payment_intent.succeeded");
    expect(isValidTestReceipt(event.data.object)).toBe(true);
  });

  test("end-to-end: divorce modal flow through the seam", () => {
    // session → confirm (test card) → signed webhook → verify → receipt
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt
    );
    const event = parseTestWebhookEvent(rawBody, signature);
    expect(isValidTestReceipt(event.data.object)).toBe(true);
  });

  test("forged signature throws BAD_SIGNATURE", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    expect(() => parseTestWebhookEvent(rawBody, "t=1,v1=" + "0".repeat(64))).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.BAD_SIGNATURE })
    );
  });

  test("stale event throws EXPIRED_EVENT", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session,
      { created: 1_000_000 }
    );
    expect(() =>
      parseTestWebhookEvent(rawBody, signature, { nowSeconds: 2_000_000 })
    ).toThrow(expect.objectContaining({ code: WEBHOOK_ERROR_CODES.EXPIRED_EVENT }));
  });

  test("signature header t= disagreeing with body created throws TIMESTAMP_MISMATCH", () => {
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const NOW = 1_700_000;
    // Normal delivery stamps header t= == body created. Re-sign the
    // same body with a DIFFERENT header timestamp: a hand-forged
    // signature for timing the freshness clock can't trust.
    const { rawBody } = deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt,
      { created: NOW }
    );
    const mismatched = signTestWebhookPayload(
      rawBody,
      TEST_WEBHOOK_SECRET,
      NOW + 3600
    );
    expect(() =>
      parseTestWebhookEvent(rawBody, mismatched, { nowSeconds: NOW })
    ).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.TIMESTAMP_MISMATCH })
    );
  });

  test("matching header t= and body created still parses", () => {
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const NOW = 1_700_000;
    const { rawBody } = deliverTestWebhookEvent(
      "checkout.session.completed",
      receipt,
      { created: NOW }
    );
    const matching = signTestWebhookPayload(rawBody, TEST_WEBHOOK_SECRET, NOW);
    const event = parseTestWebhookEvent(rawBody, matching, { nowSeconds: NOW });
    expect(event.created).toBe(NOW);
  });

  test("replayed event id throws REPLAYED_EVENT", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    parseTestWebhookEvent(rawBody, signature); // first delivery ok
    expect(() => parseTestWebhookEvent(rawBody, signature)).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.REPLAYED_EVENT })
    );
  });

  test("non-fixture payload throws BAD_EVENT", () => {
    const liveLooking = JSON.stringify({
      id: "evt_live_123",
      testMode: false,
      created: Math.floor(Date.now() / 1000),
    });
    const sig = signTestWebhookPayload(liveLooking);
    expect(() => parseTestWebhookEvent(liveLooking, sig)).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.BAD_EVENT })
    );
  });
});

describe("fixture shape pinning", () => {
  test("signature scheme is v1 and canonical body is stable", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session,
      { created: 1_000_000 }
    );
    expect(signature).toMatch(/^t=1000000,v1=[0-9a-f]{64}$/);
    // sha256 pins the canonical body shape; a field drift fails loudly
    expect(fixtureSha256(rawBody).length).toBe(64);
    expect(rawBody).toContain(`"id":"${session.id}"`);
  });
});

describe("parse-level replay ledger — bounded", () => {
  test("replay rejection survives the bounded-ledger swap", () => {
    const session = createTestCheckout("uncontested_packet");
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed",
      session
    );
    parseTestWebhookEvent(rawBody, signature);
    expect(() => parseTestWebhookEvent(rawBody, signature)).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.REPLAYED_EVENT })
    );
    // Reset still clears the gate — the harness keeps isolation.
    resetWebhookFixtures();
    expect(() =>
      parseTestWebhookEvent(rawBody, signature)
    ).not.toThrow();
  });
});
