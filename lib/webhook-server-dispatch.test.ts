/**
 * Regression tests for lib/webhook-server-dispatch.ts — the
 * server-side webhook event dispatch (verify → parse → idempotent
 * dispatch → checkout.session.completed → record_payment).
 * No network, no real secrets: the secret is a throwaway unit-test
 * string that never leaves this process.
 * Run: bun test lib/webhook-server-dispatch.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { signServerWebhookPayload } from "./webhook-server";
import {
  SERVER_DISPATCH_ERROR_CODES,
  assertServerPaymentSettled,
  handleServerWebhookDelivery,
  handleServerWebhookEvent,
  parseServerWebhookEvent,
  resetServerWebhookDispatch,
} from "./webhook-server-dispatch";

/** Throwaway secret for these tests — never a fixture dummy, never real. */
const UNIT_SECRET = "unit_test_server_dispatch_secret_01";

const NOW = 1_800_000_000; // fixed "now" for determinism

function sessionBody(eventId = "evt_completed_1"): string {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        object: "checkout.session",
        amount_total: 3000,
        currency: "usd",
        payment_status: "paid",
      },
    },
  });
}

function deliver(
  body: string,
  opts: { secret?: unknown; ts?: number } = {}
): ReturnType<typeof handleServerWebhookDelivery> {
  const header = signServerWebhookPayload(
    body,
    (opts.secret ?? UNIT_SECRET) as string,
    opts.ts ?? NOW
  );
  return handleServerWebhookDelivery(body, header, opts.secret ?? UNIT_SECRET, {
    nowSeconds: NOW,
  });
}

function deliverRaw(body: string, header: string, secret: unknown = UNIT_SECRET) {
  return handleServerWebhookDelivery(body, header, secret, { nowSeconds: NOW });
}

beforeEach(() => {
  resetServerWebhookDispatch();
});

describe("happy path: checkout.session.completed records the payment", () => {
  test("valid signed delivery yields a record_payment effect", () => {
    const effect = deliver(sessionBody());
    expect(effect.effect).toBe("record_payment");
    expect(effect.eventId).toBe("evt_completed_1");
    expect(effect.eventType).toBe("checkout.session.completed");
    expect(effect.liveMode).toBe(true);
    expect(effect.payment).toMatchObject({
      eventId: "evt_completed_1",
      sessionId: "cs_test_123",
      amountTotal: 3000,
      currency: "usd",
      paymentStatus: "paid",
      paid: true,
      recordedAt: NOW,
    });
  });

  test("unpaid session still records, with paid:false", () => {
    const body = JSON.stringify({
      id: "evt_unpaid_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_456",
          amount_total: 3000,
          currency: "usd",
          payment_status: "unpaid",
        },
      },
    });
    const effect = deliver(body);
    expect(effect.payment.paid).toBe(false);
    expect(effect.payment.paymentStatus).toBe("unpaid");
  });
});

describe("verify-before-dispatch (fail closed)", () => {
  test("tampered payload throws BAD_SIGNATURE, no effect produced", () => {
    const body = sessionBody("evt_tamper_1");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    const tampered = body.replace("3000", "1");
    expect(() => deliverRaw(tampered, header)).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.BAD_SIGNATURE,
      })
    );
  });

  test("stale timestamp throws EXPIRED_EVENT", () => {
    const body = sessionBody("evt_stale_1");
    const staleTs = NOW - 300 - 1;
    const header = signServerWebhookPayload(body, UNIT_SECRET, staleTs);
    expect(() => deliverRaw(body, header)).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.EXPIRED_EVENT,
      })
    );
  });

  test("missing secret throws MISSING_SECRET — refuses to start", () => {
    const body = sessionBody("evt_nosecret_1");
    for (const bad of [undefined, "", null]) {
      // NB: call the delivery fn directly — deliverRaw defaults undefined→UNIT_SECRET
      expect(() =>
        handleServerWebhookDelivery(
          body,
          signServerWebhookPayload(body, UNIT_SECRET, NOW),
          bad,
          { nowSeconds: NOW }
        )
      ).toThrow(
        expect.objectContaining({
          code: SERVER_DISPATCH_ERROR_CODES.MISSING_SECRET,
        })
      );
    }
  });

  test("fixture dummy secret throws FIXTURE_SECRET", () => {
    const body = sessionBody("evt_fixture_1");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    expect(() => deliverRaw(body, header, "whsec_test_fixture_whatever")).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.FIXTURE_SECRET,
      })
    );
  });

  test("wrong secret throws BAD_SIGNATURE (no info leak)", () => {
    const body = sessionBody("evt_wrongsec_1");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    try {
      deliverRaw(body, header, "some_other_secret");
      expect("should have thrown").toBe("did not throw");
    } catch (e) {
      const err = e as Error & { code: string };
      expect(err.code).toBe(SERVER_DISPATCH_ERROR_CODES.BAD_SIGNATURE);
      expect(err.message).not.toContain("some_other_secret");
    }
  });
});

describe("event idempotency", () => {
  test("a retried delivery throws ALREADY_HANDLED, effect produced once", () => {
    const body = sessionBody("evt_retry_1");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    const first = deliverRaw(body, header);
    expect(first.payment.eventId).toBe("evt_retry_1");
    // Stripe redelivers the same event when the route non-2xx'd…
    expect(() => deliverRaw(body, header)).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.ALREADY_HANDLED,
      })
    );
  });

  test("different event ids are independent", () => {
    const a = deliver(sessionBody("evt_a_1"));
    const b = deliver(sessionBody("evt_b_1"));
    expect(a.payment.eventId).toBe("evt_a_1");
    expect(b.payment.eventId).toBe("evt_b_1");
  });

  test("ledger does not mark ids that failed verification", () => {
    const body = sessionBody("evt_badthenfixed_1");
    const badHeader = signServerWebhookPayload(body, "wrong", NOW);
    expect(() => deliverRaw(body, badHeader)).toThrow();
    // the good delivery of the same event id must still work
    const good = deliverRaw(
      body,
      signServerWebhookPayload(body, UNIT_SECRET, NOW)
    );
    expect(good.payment.eventId).toBe("evt_badthenfixed_1");
  });

  test("resetServerWebhookDispatch clears the ledger (test isolation)", () => {
    const body = sessionBody("evt_reset_1");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    deliverRaw(body, header);
    resetServerWebhookDispatch();
    const again = deliverRaw(body, header);
    expect(again.payment.eventId).toBe("evt_reset_1");
  });
});

describe("parse AFTER verify", () => {
  function signedRaw(rawBody: string, eventIdNote = "x"): string {
    return signServerWebhookPayload(rawBody, UNIT_SECRET, NOW);
  }

  test("verified-but-not-JSON body throws BAD_EVENT", () => {
    const raw = "this is not json";
    expect(() => deliverRaw(raw, signedRaw(raw))).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.BAD_EVENT })
    );
  });

  test("event without id throws BAD_EVENT", () => {
    const raw = JSON.stringify({ type: "checkout.session.completed" });
    expect(() => deliverRaw(raw, signedRaw(raw))).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.BAD_EVENT })
    );
  });

  test("unknown event type throws UNKNOWN_EVENT_TYPE", () => {
    const raw = JSON.stringify({
      id: "evt_unknown_1",
      type: "invoice.paid",
      data: { object: {} },
    });
    expect(() => deliverRaw(raw, signedRaw(raw))).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      })
    );
  });

  test("session with invalid object throws INVALID_OBJECT", () => {
    const raw = JSON.stringify({
      id: "evt_badobj_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_nope" } }, // no amount_total / currency
    });
    expect(() => deliverRaw(raw, signedRaw(raw))).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.INVALID_OBJECT,
      })
    );
  });
});

describe("parseServerWebhookEvent + handleServerWebhookEvent contract", () => {
  test("parse returns id/type/object shape", () => {
    const body = sessionBody("evt_parse_1");
    const event = parseServerWebhookEvent(
      body,
      signServerWebhookPayload(body, UNIT_SECRET, NOW),
      UNIT_SECRET,
      { nowSeconds: NOW }
    );
    expect(event.id).toBe("evt_parse_1");
    expect(event.type).toBe("checkout.session.completed");
    expect((event.data.object as { id: string }).id).toBe("cs_test_123");
  });

  test("handleServerWebhookEvent refuses non-event input (BAD_EVENT)", () => {
    expect(() =>
      handleServerWebhookEvent(undefined as never)
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.BAD_EVENT })
    );
  });
});

describe("no in-repo secrets", () => {
  test("dispatch module source has no env reads, no key material", async () => {
    const src = await Bun.file(
      import.meta.dir + "/webhook-server-dispatch.ts"
    ).text();
    const codeLines = src
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("//")
      )
      .join("\n");
    const scrubbed = codeLines
      .toLowerCase()
      .split('"whsec_test_fixture_"')
      .join('""');
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

describe("server-side amount expectation (AMOUNT_MISMATCH)", () => {
  /** Deliver with an explicit server-side price expectation. */
  function deliverExpected(
    body: string,
    opts: {
      expectedAmountTotal?: number;
      expectedCurrency?: string;
      eventId?: string;
    }
  ) {
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    return handleServerWebhookDelivery(body, header, UNIT_SECRET, {
      nowSeconds: NOW,
      expectedAmountTotal: opts.expectedAmountTotal,
      expectedCurrency: opts.expectedCurrency,
    });
  }

  function sessionBodyWith(id: string, amountTotal: number, currency: string) {
    return JSON.stringify({
      id,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          amount_total: amountTotal,
          currency,
          payment_status: "paid",
        },
      },
    });
  }

  test("matching expectation records the payment", () => {
    const effect = deliverExpected(sessionBodyWith("evt_amt_ok_1", 3000, "usd"), {
      expectedAmountTotal: 3000,
      expectedCurrency: "usd",
    });
    expect(effect.effect).toBe("record_payment");
    expect(effect.payment.amountTotal).toBe(3000);
  });

  test("currency expectation is case-insensitive", () => {
    const effect = deliverExpected(sessionBodyWith("evt_amt_ci_1", 3000, "usd"), {
      expectedAmountTotal: 3000,
      expectedCurrency: "USD",
    });
    expect(effect.payment.eventId).toBe("evt_amt_ci_1");
  });

  test("under-reported amount throws AMOUNT_MISMATCH", () => {
    expect(() =>
      deliverExpected(sessionBodyWith("evt_amt_low_1", 2999, "usd"), {
        expectedAmountTotal: 3000,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH })
    );
  });

  test("over-reported amount throws AMOUNT_MISMATCH (exact match required)", () => {
    expect(() =>
      deliverExpected(sessionBodyWith("evt_amt_high_1", 3001, "usd"), {
        expectedAmountTotal: 3000,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH })
    );
  });

  test("currency swap throws AMOUNT_MISMATCH", () => {
    expect(() =>
      deliverExpected(sessionBodyWith("evt_amt_cur_1", 3000, "eur"), {
        expectedAmountTotal: 3000,
        expectedCurrency: "usd",
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH })
    );
  });

  test("mismatch does not mark the ledger — a correct retry stays retryable", () => {
    const body = sessionBodyWith("evt_amt_retry_1", 2999, "usd");
    const header = signServerWebhookPayload(body, UNIT_SECRET, NOW);
    expect(() =>
      handleServerWebhookDelivery(body, header, UNIT_SECRET, {
        nowSeconds: NOW,
        expectedAmountTotal: 3000,
      })
    ).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH })
    );
    // Same event id, no expectation → must still dispatch (ledger was
    // only marked after success, which never happened).
    const effect = handleServerWebhookDelivery(body, header, UNIT_SECRET, {
      nowSeconds: NOW,
    });
    expect(effect.payment.eventId).toBe("evt_amt_retry_1");
  });

  test("malformed expectation (zero/non-integer) fails closed with AMOUNT_MISMATCH", () => {
    for (const bad of [0, -3000, 30.5]) {
      expect(() =>
        deliverExpected(sessionBodyWith(`evt_amt_badexp_${bad}`, 3000, "usd"), {
          expectedAmountTotal: bad,
        })
      ).toThrow(
        expect.objectContaining({
          code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH,
        })
      );
    }
  });

  test("no expectation supplied → previous behavior unchanged", () => {
    const effect = deliver(sessionBodyWith("evt_amt_none_1", 999999, "gbp"));
    expect(effect.effect).toBe("record_payment");
    expect(effect.payment.amountTotal).toBe(999999);
  });
});

describe("assertServerPaymentSettled — the fulfill-time settlement gate", () => {
  beforeEach(() => {
    resetServerWebhookDispatch();
  });

  test("a settled payment (paid + payment_status 'paid') passes", () => {
    const effect = deliver(sessionBody("evt_settled_1"));
    expect(() => assertServerPaymentSettled(effect.payment)).not.toThrow();
  });

  test("unpaid payment_status throws PAYMENT_NOT_SETTLED", () => {
    const body = JSON.stringify({
      id: "evt_settled_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          amount_total: 3000,
          currency: "usd",
          payment_status: "unpaid",
        },
      },
    });
    const effect = deliver(body);
    expect(effect.payment.paid).toBe(false);
    expect(() => assertServerPaymentSettled(effect.payment)).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.PAYMENT_NOT_SETTLED })
    );
  });

  test("paid flag disagreeing with payment_status fails closed", () => {
    // A hand-built record that claims paid:true while the processor
    // status says otherwise is contradictory — untrustworthy.
    const effect = deliver(sessionBody("evt_settled_3"));
    const contradictory = { ...effect.payment, paymentStatus: "unpaid" };
    expect(() => assertServerPaymentSettled(contradictory)).toThrow(
      expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.PAYMENT_NOT_SETTLED })
    );
  });

  test("non-payment inputs fail closed with PAYMENT_NOT_SETTLED", () => {
    for (const bad of [null, undefined, 42, "paid", {}, { paid: true }]) {
      expect(() => assertServerPaymentSettled(bad)).toThrow(
        expect.objectContaining({ code: SERVER_DISPATCH_ERROR_CODES.PAYMENT_NOT_SETTLED })
      );
    }
  });
});
