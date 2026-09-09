/**
 * Regression tests for lib/webhook-server.ts — the server-side
 * webhook signature verifier (Stripe-compatible scheme).
 * No network, no real secrets: the "secret" is a throwaway unit-test
 * string that never leaves this process.
 * Run: bun test lib/webhook-server.test.ts
 */
import { describe, expect, test } from "bun:test";
import { TEST_WEBHOOK_SECRET } from "./webhook-test";
import {
  SERVER_WEBHOOK_ERROR_CODES,
  SERVER_WEBHOOK_TOLERANCE_SECONDS,
  assertServerWebhookSecret,
  parseServerWebhookHeader,
  signServerWebhookPayload,
  verifyServerWebhookSignature,
} from "./webhook-server";

/** Throwaway secret for these tests — never a fixture dummy, never real. */
const UNIT_SECRET = "unit_test_server_webhook_secret_01";

const NOW = 1_800_000_000; // fixed "now" for determinism
const BODY = '{"id":"evt_123","type":"checkout.session.completed"}';

function goodHeader(body = BODY, secret = UNIT_SECRET, ts = NOW): string {
  return signServerWebhookPayload(body, secret, ts);
}

describe("assertServerWebhookSecret", () => {
  test("accepts an explicit server secret and returns it unchanged", () => {
    expect(assertServerWebhookSecret(UNIT_SECRET)).toBe(UNIT_SECRET);
  });

  test("rejects missing / empty / non-string secrets", () => {
    for (const bad of [undefined, null, "", 42, {}]) {
      expect(() => assertServerWebhookSecret(bad)).toThrow(
        expect.objectContaining({
          code: SERVER_WEBHOOK_ERROR_CODES.MISSING_SECRET,
        })
      );
    }
  });

  test("refuses the test-fixture dummy secret", () => {
    expect(() => assertServerWebhookSecret(TEST_WEBHOOK_SECRET)).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.FIXTURE_SECRET,
      })
    );
    // boundary check: any whsec_test_fixture_* prefix is refused
    expect(() =>
      assertServerWebhookSecret("whsec_test_fixture_whatever")
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.FIXTURE_SECRET,
      })
    );
  });
});

describe("parseServerWebhookHeader", () => {
  test("parses t= and multiple v1= segments", () => {
    const header = `t=${NOW},v1=aaaabbbbccccdddd,v0=zzz,v1=1111`;
    const parsed = parseServerWebhookHeader(header);
    expect(parsed.timestamp).toBe(NOW);
    expect(parsed.signatures).toEqual([
      { scheme: "v1", value: "aaaabbbbccccdddd" },
      { scheme: "v0", value: "zzz" },
      { scheme: "v1", value: "1111" },
    ]);
  });

  test("missing / empty / non-string header throws BAD_HEADER", () => {
    for (const bad of [undefined, null, "", 0, {}]) {
      expect(() => parseServerWebhookHeader(bad)).toThrow(
        expect.objectContaining({
          code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
        })
      );
    }
  });

  test("no t= segment throws BAD_HEADER", () => {
    expect(() => parseServerWebhookHeader("v1=abc")).toThrow(
      expect.objectContaining({ code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER })
    );
  });

  test("duplicate or non-numeric t= throws BAD_HEADER", () => {
    expect(() => parseServerWebhookHeader(`t=${NOW},t=${NOW},v1=abc`)).toThrow(
      expect.objectContaining({ code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER })
    );
    expect(() => parseServerWebhookHeader("t=abc,v1=abc")).toThrow(
      expect.objectContaining({ code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER })
    );
  });
});

describe("verifyServerWebhookSignature", () => {
  test("happy path verifies and returns the event timestamp", () => {
    const ts = verifyServerWebhookSignature(BODY, goodHeader(), UNIT_SECRET, {
      nowSeconds: NOW,
    });
    expect(ts).toBe(NOW);
  });

  test("tampered body throws BAD_SIGNATURE", () => {
    const header = goodHeader();
    expect(() =>
      verifyServerWebhookSignature(BODY + "x", header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      })
    );
  });

  test("wrong secret throws BAD_SIGNATURE (no info leak)", () => {
    const header = goodHeader();
    try {
      verifyServerWebhookSignature(BODY, header, "totally_wrong_secret", {
        nowSeconds: NOW,
      });
      expect("should have thrown").toBe("did not throw");
    } catch (e) {
      const err = e as Error & { code: string };
      expect(err.code).toBe(SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE);
      // the error must not echo the secret or the expected MAC
      expect(err.message).not.toContain("totally_wrong_secret");
    }
  });

  test("forged header on a different payload throws BAD_SIGNATURE", () => {
    const other = signServerWebhookPayload('{"id":"evt_999"}', UNIT_SECRET, NOW);
    expect(() =>
      verifyServerWebhookSignature(BODY, other, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      })
    );
  });

  test("rolled secrets: header with two v1 values, one valid", () => {
    const stale = signServerWebhookPayload(BODY, "old_rotated_secret", NOW);
    const fresh = goodHeader();
    const combined = `t=${NOW},${stale.split(",")[1]},${fresh.split(",")[1]}`;
    const ts = verifyServerWebhookSignature(BODY, combined, UNIT_SECRET, {
      nowSeconds: NOW,
    });
    expect(ts).toBe(NOW);
  });

  test("unknown schemes alone (no v1) throw BAD_HEADER", () => {
    expect(() =>
      verifyServerWebhookSignature(BODY, `t=${NOW},v0=deadbeef`, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER })
    );
  });

  test("stale event (older than tolerance) throws EXPIRED_EVENT", () => {
    const oldTs = NOW - SERVER_WEBHOOK_TOLERANCE_SECONDS - 1;
    const header = goodHeader(BODY, UNIT_SECRET, oldTs);
    expect(() =>
      verifyServerWebhookSignature(BODY, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.EXPIRED_EVENT,
      })
    );
  });

  test("event at the tolerance edge is still accepted", () => {
    const edgeTs = NOW - SERVER_WEBHOOK_TOLERANCE_SECONDS;
    const header = goodHeader(BODY, UNIT_SECRET, edgeTs);
    expect(
      verifyServerWebhookSignature(BODY, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toBe(edgeTs);
  });

  test("future event beyond tolerance throws FUTURE_EVENT", () => {
    const futureTs = NOW + SERVER_WEBHOOK_TOLERANCE_SECONDS + 1;
    const header = goodHeader(BODY, UNIT_SECRET, futureTs);
    expect(() =>
      verifyServerWebhookSignature(BODY, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.FUTURE_EVENT,
      })
    );
  });

  test("missing signature header throws BAD_HEADER", () => {
    expect(() =>
      verifyServerWebhookSignature(BODY, undefined, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER })
    );
  });

  test("missing secret throws MISSING_SECRET, fixture secret throws FIXTURE_SECRET", () => {
    const header = goodHeader();
    expect(() =>
      verifyServerWebhookSignature(BODY, header, "", { nowSeconds: NOW })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.MISSING_SECRET,
      })
    );
    expect(() =>
      verifyServerWebhookSignature(BODY, header, TEST_WEBHOOK_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.FIXTURE_SECRET,
      })
    );
  });

  test("custom tolerance is honored", () => {
    const header = goodHeader(BODY, UNIT_SECRET, NOW - 60);
    // 60s old, tolerance 30 → expired
    expect(() =>
      verifyServerWebhookSignature(BODY, header, UNIT_SECRET, {
        nowSeconds: NOW,
        toleranceSeconds: 30,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.EXPIRED_EVENT,
      })
    );
    // same event, tolerance 120 → fine
    expect(
      verifyServerWebhookSignature(BODY, header, UNIT_SECRET, {
        nowSeconds: NOW,
        toleranceSeconds: 120,
      })
    ).toBe(NOW - 60);
  });

  test("non-string body throws BAD_SIGNATURE", () => {
    const header = goodHeader();
    expect(() =>
      verifyServerWebhookSignature({} as unknown as string, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      })
    );
  });
});

describe("no in-repo secrets", () => {
  test("module source has no default secret, no env read, no key material", async () => {
    const src = await Bun.file(import.meta.dir + "/webhook-server.ts").text();
    const codeLines = src
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("//")
      )
      .join("\n");
    const lower = codeLines.toLowerCase();
    // The fixture-prefix guard literal ("whsec_test_fixture_") is not
    // key material — it is the allow-list check that REJECTS fixture
    // keys. Strip that one literal, then ban anything secret-shaped.
    const scrubbed = lower.split('"whsec_test_fixture_"').join('""');
    for (const banned of [
      "process.env",
      "whsec_",
      "sk_live",
      "sk_test",
      "pk_live",
      "publishable",
      "apikey",
    ]) {
      expect(scrubbed.includes(banned)).toBe(false);
    }
  });
});
