/**
 * Regression tests for lib/checkout-test.ts — the YEAHDOGS shared
 * test-mode checkout contract. Fixtures only: no keys, no network.
 * Run: bun test lib/checkout-test.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  TEST_MODE,
  PRODUCTS,
  TEST_CARD,
  ERROR_CODES,
  assertTestMode,
  getProduct,
  createTestCheckout,
  confirmTestPayment,
  isValidTestReceipt,
  confirmTestSubscription,
  isValidTestSubscription,
} from "./checkout-test";

describe("test-mode guard", () => {
  test("TEST_MODE is hard-coded true", () => {
    expect(TEST_MODE).toBe(true);
  });

  test("live mode flags throw TEST_MODE_VIOLATION", () => {
    for (const options of [
      { live: true },
      { mode: "live" },
      { mode: "production" },
    ]) {
      expect(() => assertTestMode(options)).toThrow(
        expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
      );
    }
  });

  test("benign options pass", () => {
    expect(assertTestMode()).toBe(true);
    expect(assertTestMode({ anything: "goes" })).toBe(true);
  });
});

describe("product catalog", () => {
  test("divorce packet is $30 one-time", () => {
    const p = getProduct("uncontested_packet");
    expect(p.amountCents).toBe(3000);
    expect(p.billing).toBe("one_time");
    expect(PRODUCTS).toBeFrozen;
  });

  test("wax subscription is $10/mo recurring", () => {
    const p = getProduct("wax_subscription");
    expect(p.amountCents).toBe(1000);
    expect(p.billing).toBe("recurring");
    expect(p.interval).toBe("month");
  });

  test("unknown product throws UNKNOWN_PRODUCT", () => {
    expect(() => getProduct("nope")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_PRODUCT })
    );
  });
});

describe("divorce one-time checkout ($30)", () => {
  test("create → confirm produces a valid test receipt", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(session.id.startsWith("cs_test_")).toBe(true);
    expect(session.testMode).toBe(true);

    const receipt = confirmTestPayment(session.id, session);
    expect(isValidTestReceipt(receipt)).toBe(true);
    expect(receipt.amountCents).toBe(3000);
    expect(receipt.cardLast4).toBe(TEST_CARD.last4);
    expect(receipt.id.startsWith("rcpt_test_")).toBe(true);
  });

  test("fixture ids are unique across sessions", () => {
    const a = createTestCheckout("uncontested_packet");
    const b = createTestCheckout("uncontested_packet");
    expect(a.id).not.toBe(b.id);
  });

  test("wrong amount throws INVALID_AMOUNT (fixture integrity)", () => {
    expect(() => createTestCheckout("uncontested_packet", 2999)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_AMOUNT })
    );
  });

  test("non-fixture session id throws UNKNOWN_SESSION", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(() => confirmTestPayment("cs_live_000001", session)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_SESSION })
    );
  });

  test("decline test card throws DECLINED", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(() =>
      confirmTestPayment(session.id, session, { last4: "0002" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
  });

  test("recurring session rejects payment (use subscription)", () => {
    const session = createTestCheckout("wax_subscription");
    expect(() => confirmTestPayment(session.id, session)).toThrow();
  });

  test("receipt from wrong product fails validation", () => {
    expect(isValidTestReceipt(null)).toBe(false);
    expect(
      isValidTestReceipt({
        id: "rcpt_test_000001",
        testMode: true,
        status: "succeeded",
        productId: "uncontested_packet",
        amountCents: 1, // wrong price — tampered
      })
    ).toBe(false);
  });
});

describe("wax recurring checkout ($10/mo)", () => {
  test("create → subscribe produces a valid test subscription", () => {
    const session = createTestCheckout("wax_subscription");
    const sub = confirmTestSubscription(session.id, session);
    expect(isValidTestSubscription(sub)).toBe(true);
    expect(sub.amountCents).toBe(1000);
    expect(sub.interval).toBe("month");
    expect(sub.status).toBe("active");
    expect(sub.id.startsWith("sub_test_")).toBe(true);
  });

  test("one-time session rejects subscription", () => {
    const session = createTestCheckout("uncontested_packet");
    expect(() => confirmTestSubscription(session.id, session)).toThrow();
  });

  test("decline card throws DECLINED on subscription", () => {
    const session = createTestCheckout("wax_subscription");
    expect(() =>
      confirmTestSubscription(session.id, session, { last4: "0002" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
  });

  test("tampered subscription fails validation", () => {
    expect(isValidTestSubscription(undefined)).toBe(false);
    expect(
      isValidTestSubscription({
        id: "sub_test_000001",
        testMode: true,
        status: "active",
        productId: "wax_subscription",
        amountCents: 10000, // wrong price — tampered
      })
    ).toBe(false);
  });
});

describe("no live surface", () => {
  test("module source contains no key fields (code lines only, docs excluded)", async () => {
    const src = await Bun.file(import.meta.dir + "/checkout-test.ts").text();
    const codeLines = src
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("//")
      )
      .join("\n")
      .toLowerCase();
    for (const banned of [
      "secret",
      "publishable",
      "api_key",
      "apikey",
      "sk_live",
      "pk_live",
    ]) {
      expect(codeLines.includes(banned)).toBe(false);
    }
  });

  test("fixtures never carry key-like fields", () => {
    const session = createTestCheckout("uncontested_packet");
    const receipt = confirmTestPayment(session.id, session);
    const sub = confirmTestSubscription(
      createTestCheckout("wax_subscription").id,
      createTestCheckout("wax_subscription")
    );
    for (const fixture of [session, receipt, sub]) {
      for (const key of Object.keys(fixture)) {
        expect(key.toLowerCase()).not.toMatch(/secret|publishable|token/);
      }
    }
  });
});
