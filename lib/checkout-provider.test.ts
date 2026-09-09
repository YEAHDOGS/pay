/**
 * Regression tests for lib/checkout-provider.ts — the swappable
 * checkout-provider seam. Fixtures only: no keys, no network.
 * Run: bun test lib/checkout-provider.test.ts
 */
import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "./checkout-test";
import {
  TEST_PROVIDER_ID,
  TestCheckoutProvider,
  getProvider,
  isValidTestReceipt,
  isValidTestSubscription,
} from "./checkout-provider";

describe("provider factory", () => {
  test("default provider is the test fixture, never live", () => {
    const provider = getProvider();
    expect(provider.providerId).toBe(TEST_PROVIDER_ID);
    expect(provider.isLive).toBe(false);
    expect(provider).toBeInstanceOf(TestCheckoutProvider);
  });

  test("live provider ids throw TEST_MODE_VIOLATION", () => {
    for (const id of ["stripe", "live", "production", "square"]) {
      expect(() => getProvider(id)).toThrow(
        expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
      );
    }
  });

  test("live options still throw through the factory", () => {
    expect(() => getProvider(TEST_PROVIDER_ID, { live: true })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEST_MODE_VIOLATION })
    );
  });

  test("provider id constant is 'test-fixture'", () => {
    expect(TEST_PROVIDER_ID).toBe("test-fixture");
  });
});

describe("divorce $30 one-time flow through the provider seam", () => {
  test("full happy path produces a valid receipt", () => {
    const provider = getProvider();
    const product = provider.product("uncontested_packet");
    expect(product.amountCents).toBe(3000);
    const session = provider.createSession("uncontested_packet");
    expect(session.id.startsWith("cs_test_")).toBe(true);
    const receipt = provider.confirmPayment(session.id, session);
    expect(isValidTestReceipt(receipt)).toBe(true);
    expect(receipt.amountCents).toBe(3000);
  });

  test("unknown product throws UNKNOWN_PRODUCT", () => {
    const provider = getProvider();
    expect(() => provider.createSession("nope")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNKNOWN_PRODUCT })
    );
  });

  test("decline card throws DECLINED through the seam", () => {
    const provider = getProvider();
    const session = provider.createSession("uncontested_packet");
    expect(() =>
      provider.confirmPayment(session.id, session, { last4: "0002" })
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.DECLINED }));
  });

  test("recurring product rejected by confirmPayment", () => {
    const provider = getProvider();
    const session = provider.createSession("wax_subscription");
    expect(() => provider.confirmPayment(session.id, session)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_AMOUNT })
    );
  });
});

describe("wax $10/mo subscription flow through the provider seam", () => {
  test("full happy path produces a valid subscription", () => {
    const provider = getProvider();
    const product = provider.product("wax_subscription");
    expect(product.amountCents).toBe(1000);
    const session = provider.createSession("wax_subscription");
    const sub = provider.confirmSubscription(session.id, session);
    expect(isValidTestSubscription(sub)).toBe(true);
    expect(sub.id.startsWith("sub_test_")).toBe(true);
  });

  test("one-time product rejected by confirmSubscription", () => {
    const provider = getProvider();
    const session = provider.createSession("uncontested_packet");
    expect(() => provider.confirmSubscription(session.id, session)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_AMOUNT })
    );
  });
});

describe("no live surface", () => {
  test("provider source contains no key fields (code lines only, docs excluded)", async () => {
    const src = await Bun.file(import.meta.dir + "/checkout-provider.ts").text();
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

  test("fixtures handed out through the seam carry no key-like fields", () => {
    const provider = getProvider();
    const session = provider.createSession("uncontested_packet");
    const receipt = provider.confirmPayment(session.id, session);
    const sub = provider.confirmSubscription(
      provider.createSession("wax_subscription").id,
      provider.createSession("wax_subscription")
    );
    for (const fixture of [session, receipt, sub]) {
      for (const key of Object.keys(fixture)) {
        expect(key.toLowerCase()).not.toMatch(/secret|publishable|token/);
      }
    }
  });
});
