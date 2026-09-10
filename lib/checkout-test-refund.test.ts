/**
 * Regression tests for the test-mode refund path in lib/checkout-test.ts.
 * The refund is the merchant's money-out trust boundary: this suite
 * proves a forged receipt can't be refunded, a settled receipt can
 * never be refunded twice, and retried issues replay instead of
 * double-spending. Fixtures only: no keys, no network.
 * Run: bun test lib/checkout-test-refund.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  ERROR_CODES,
  createTestCheckout,
  confirmTestPayment,
  confirmTestSubscription,
  issueTestRefund,
  isValidTestRefund,
  resetCheckoutIdempotency,
  resetRefundFixtures,
  type Receipt,
} from "./checkout-test";

function settledReceipt(): Receipt {
  const session = createTestCheckout("uncontested_packet");
  return confirmTestPayment(session.id, session);
}

beforeEach(() => {
  resetCheckoutIdempotency();
  resetRefundFixtures();
});

describe("issueTestRefund", () => {
  test("issues a full refund fixture for a valid receipt", () => {
    const receipt = settledReceipt();
    const refund = issueTestRefund(receipt);
    expect(refund.id.startsWith("rfnd_test_")).toBe(true);
    expect(refund.receiptId).toBe(receipt.id);
    expect(refund.amountCents).toBe(3000);
    expect(refund.currency).toBe("usd");
    expect(refund.status).toBe("succeeded");
    expect(refund.testMode).toBe(true);
    expect(isValidTestRefund(refund)).toBe(true);
  });

  test("rejects a forged receipt with INVALID_RECEIPT", () => {
    const forged = {
      id: "rcpt_live_999",
      testMode: false,
      status: "succeeded",
      productId: "uncontested_packet",
      amountCents: 3000,
    } as unknown as Receipt;
    expect(() => issueTestRefund(forged)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_RECEIPT })
    );
  });

  test("rejects an amount-tampered receipt with INVALID_RECEIPT", () => {
    const receipt = settledReceipt();
    const tampered = { ...receipt, amountCents: 1 } as Receipt;
    expect(() => issueTestRefund(tampered)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_RECEIPT })
    );
  });

  test("rejects a subscription fixture with INVALID_RECEIPT (no subscription refunds)", () => {
    const session = createTestCheckout("wax_subscription");
    const sub = confirmTestSubscription(session.id, session);
    expect(() => issueTestRefund(sub as unknown as Receipt)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_RECEIPT })
    );
  });

  test("double refund throws ALREADY_REFUNDED and mints nothing new", () => {
    const receipt = settledReceipt();
    issueTestRefund(receipt);
    expect(() => issueTestRefund(receipt)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.ALREADY_REFUNDED })
    );
    // even a retried issue with a fresh idempotency key fails closed:
    // there is no "new attempt" path for a refund that already exists.
    expect(() =>
      issueTestRefund(receipt, { idempotencyKey: "retry-after-double" })
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.ALREADY_REFUNDED })
    );
  });

  test("same idempotency key + same receipt replays the original refund", () => {
    const receipt = settledReceipt();
    const first = issueTestRefund(receipt, { idempotencyKey: "refund-retry-1" });
    const replay = issueTestRefund(receipt, { idempotencyKey: "refund-retry-1" });
    expect(replay).toEqual(first);
  });

  test("same idempotency key on a different receipt throws IDEMPOTENCY_KEY_CONFLICT", () => {
    const a = settledReceipt();
    const b = settledReceipt();
    issueTestRefund(a, { idempotencyKey: "shared-key" });
    expect(() => issueTestRefund(b, { idempotencyKey: "shared-key" })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT })
    );
  });

  test("malformed idempotency keys throw INVALID_IDEMPOTENCY_KEY", () => {
    const receipt = settledReceipt();
    for (const key of ["", 42, "x".repeat(129)] as unknown[]) {
      expect(() =>
        issueTestRefund(receipt, { idempotencyKey: key })
      ).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY })
      );
    }
  });

  test("live mode flag throws TEST_MODE_VIOLATION", () => {
    const receipt = settledReceipt();
    expect(() => issueTestRefund(receipt, { live: true })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
    );
  });
});

describe("isValidTestRefund", () => {
  test("rejects live-looking and forged refunds", () => {
    const receipt = settledReceipt();
    const good = issueTestRefund(receipt);
    expect(isValidTestRefund({ ...good, testMode: false })).toBe(false);
    expect(isValidTestRefund({ ...good, id: "rfnd_live_1" })).toBe(false);
    expect(isValidTestRefund({ ...good, amountCents: 1 })).toBe(false);
    expect(isValidTestRefund({ ...good, status: "pending" })).toBe(false);
    expect(isValidTestRefund(null)).toBe(false);
    expect(isValidTestRefund({})).toBe(false);
  });
});
