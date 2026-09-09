/**
 * Regression tests for lib/divorce-checkout.ts — the first seam consumer.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/divorce-checkout.test.ts
 */
import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "./checkout-test";
import {
  DIVORCE_PRICE_CENTS,
  DIVORCE_PRODUCT_ID,
  confirmDivorceCheckout,
  isValidTestReceipt,
  startDivorceCheckout,
} from "./divorce-checkout";

describe("divorce checkout consumer", () => {
  test("start returns an open session for the $30 packet", () => {
    const session = startDivorceCheckout();
    expect(session.productId).toBe(DIVORCE_PRODUCT_ID);
    expect(session.amountCents).toBe(DIVORCE_PRICE_CENTS);
    expect(session.billing).toBe("one_time");
    expect(session.status).toBe("open");
    expect(session.testMode).toBe(true);
  });

  test("full happy path unlocks a valid packet receipt", () => {
    const session = startDivorceCheckout();
    const receipt = confirmDivorceCheckout(session);
    expect(isValidTestReceipt(receipt)).toBe(true);
    expect(receipt.amountCents).toBe(3000);
  });

  test("decline test card throws DECLINED", () => {
    const session = startDivorceCheckout();
    expect(() =>
      confirmDivorceCheckout(session, { last4: "0002" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
  });

  test("live-mode options throw TEST_MODE_VIOLATION on both calls", () => {
    expect(() => startDivorceCheckout({ live: true })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
    );
    const session = startDivorceCheckout();
    expect(() =>
      confirmDivorceCheckout(session, { last4: "4242" }, { mode: "live" })
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
    );
  });

  test("bad receipt shape fails validation (never unlocks packet)", () => {
    const session = startDivorceCheckout();
    const receipt = confirmDivorceCheckout(session);
    expect(isValidTestReceipt({ ...receipt, amountCents: 1 })).toBe(false);
    expect(isValidTestReceipt(null)).toBe(false);
  });
});
