/**
 * Regression tests: idempotency keys on the confirm step
 * (lib/checkout-test.ts). A double-submitted confirm must never mint
 * a second receipt — replay hardening for the charge path.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/checkout-test-idempotency.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  ERROR_CODES,
  assertIdempotencyKey,
  confirmTestPayment,
  confirmTestSubscription,
  createTestCheckout,
  isValidTestReceipt,
  isValidTestSubscription,
  resetCheckoutIdempotency,
} from "./checkout-test";

const KEY = "idem-pay-001";

beforeEach(() => {
  resetCheckoutIdempotency();
});

describe("confirmTestPayment idempotency keys", () => {
  test("retry with same key+session returns the original receipt, not a new charge", () => {
    const session = createTestCheckout("uncontested_packet");
    const first = confirmTestPayment(session.id, session, undefined, {
      idempotencyKey: KEY,
    });
    const second = confirmTestPayment(session.id, session, undefined, {
      idempotencyKey: KEY,
    });
    expect(second).toEqual(first);
    expect(second.id).toBe(first.id);
    expect(isValidTestReceipt(second)).toBe(true);
  });

  test("same key without prior charge issues exactly one receipt across double-submit", () => {
    const session = createTestCheckout("uncontested_packet");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      ids.add(
        confirmTestPayment(session.id, session, undefined, {
          idempotencyKey: "idem-triple",
        }).id
      );
    }
    expect(ids.size).toBe(1);
  });

  test("key reused for a DIFFERENT session throws IDEMPOTENCY_KEY_CONFLICT", () => {
    const s1 = createTestCheckout("uncontested_packet");
    const s2 = createTestCheckout("uncontested_packet");
    confirmTestPayment(s1.id, s1, undefined, { idempotencyKey: "idem-x" });
    const e = (() => {
      try {
        confirmTestPayment(s2.id, s2, undefined, { idempotencyKey: "idem-x" });
      } catch (err) {
        return err as Error & { code?: string };
      }
      throw new Error("did not throw");
    })();
    expect(e.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);
  });

  test("a declined attempt never records the key — retry after decline re-attempts", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(() =>
      confirmTestPayment(session.id, session, { last4: "0002" }, { idempotencyKey: "idem-decline" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
    // Same key after the decline: a fresh attempt, not a conflict or a replay.
    const retry = confirmTestPayment(session.id, session, undefined, {
      idempotencyKey: "idem-decline",
    });
    expect(isValidTestReceipt(retry)).toBe(true);
    // And now the key IS bound: a different session with it conflicts.
    const other = createTestCheckout("uncontested_packet");
    expect(() =>
      confirmTestPayment(other.id, other, undefined, { idempotencyKey: "idem-decline" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT }));
  });

  test("malformed keys throw INVALID_IDEMPOTENCY_KEY", () => {
    const session = createTestCheckout("uncontested_packet");
    const opts = { idempotencyKey: "" };
    expect(() =>
      confirmTestPayment(session.id, session, undefined, opts)
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY }));
    expect(() =>
      assertIdempotencyKey({ idempotencyKey: 123 })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY }));
    expect(() =>
      assertIdempotencyKey({ idempotencyKey: "k".repeat(129) })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY }));
  });

  test("no key: each confirm mints a fresh receipt (legacy behavior)", () => {
    const s1 = createTestCheckout("uncontested_packet");
    const s2 = createTestCheckout("uncontested_packet");
    const r1 = confirmTestPayment(s1.id, s1);
    const r2 = confirmTestPayment(s2.id, s2);
    expect(r1.id).not.toBe(r2.id);
  });

  test("key + live-mode flag still throws TEST_MODE_VIOLATION first", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(() =>
      confirmTestPayment(session.id, session, undefined, {
        idempotencyKey: "idem-live",
        live: true,
      })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION }));
  });

  test("idempotent receipt yields the same derived webhook event id", async () => {
    // The same receipt derives the same deterministic evt_test_* id, so a
    // double-confirmed charge can never double-unlock downstream.
    const { deliverTestWebhookEvent } = await import("./webhook-test");
    const session = createTestCheckout("uncontested_packet");
    const opts = { idempotencyKey: "idem-event" };
    const first = confirmTestPayment(session.id, session, undefined, opts);
    const second = confirmTestPayment(session.id, session, undefined, opts);
    const d1 = deliverTestWebhookEvent("checkout.session.completed", first);
    const d2 = deliverTestWebhookEvent("checkout.session.completed", second);
    expect(d2.event.id).toBe(d1.event.id);
  });
});

describe("confirmTestSubscription idempotency keys", () => {
  const wax = () => createTestCheckout("wax_subscription");

  test("retry with same key+session returns the original subscription, no double-provision", () => {
    const session = wax();
    const opts = { idempotencyKey: "idem-sub-001" };
    const first = confirmTestSubscription(session.id, session, undefined, opts);
    const second = confirmTestSubscription(session.id, session, undefined, opts);
    expect(second).toEqual(first);
    expect(second.id).toBe(first.id);
    expect(isValidTestSubscription(second)).toBe(true);
  });

  test("key reused for a DIFFERENT session throws IDEMPOTENCY_KEY_CONFLICT", () => {
    const s1 = wax();
    const s2 = wax();
    confirmTestSubscription(s1.id, s1, undefined, { idempotencyKey: "idem-sub-x" });
    expect(() =>
      confirmTestSubscription(s2.id, s2, undefined, { idempotencyKey: "idem-sub-x" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT }));
  });

  test("a declined attempt never records the key — retry after decline re-attempts", () => {
    const session = wax();
    expect(() =>
      confirmTestSubscription(session.id, session, { last4: "0002" }, { idempotencyKey: "idem-sub-decline" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
    const retry = confirmTestSubscription(session.id, session, undefined, {
      idempotencyKey: "idem-sub-decline",
    });
    expect(isValidTestSubscription(retry)).toBe(true);
  });

  test("malformed keys throw INVALID_IDEMPOTENCY_KEY", () => {
    const session = wax();
    expect(() =>
      confirmTestSubscription(session.id, session, undefined, { idempotencyKey: "" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY }));
  });

  test("no key: each subscribe mints a fresh subscription (legacy behavior)", () => {
    const s1 = wax();
    const s2 = wax();
    expect(confirmTestSubscription(s1.id, s1).id).not.toBe(
      confirmTestSubscription(s2.id, s2).id
    );
  });

  test("payment and subscription ledgers are independent — same key name, no cross-contamination", () => {
    const paySession = createTestCheckout("uncontested_packet");
    const subSession = wax();
    const opts = { idempotencyKey: "idem-shared-name" };
    const receipt = confirmTestPayment(paySession.id, paySession, undefined, opts);
    const sub = confirmTestSubscription(subSession.id, subSession, undefined, opts);
    expect(receipt.id.startsWith("rcpt_test_")).toBe(true);
    expect(sub.id.startsWith("sub_test_")).toBe(true);
    // Replays still hit their own ledger.
    expect(confirmTestPayment(paySession.id, paySession, undefined, opts).id).toBe(receipt.id);
    expect(confirmTestSubscription(subSession.id, subSession, undefined, opts).id).toBe(sub.id);
  });
});
