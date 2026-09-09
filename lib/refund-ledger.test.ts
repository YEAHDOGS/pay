/**
 * Regression tests for lib/refund-ledger.ts + the handler's
 * `charge.refunded` dispatch — refund + reversal safety in the
 * idempotency ledger.
 * Fixtures only: no keys, no network.
 * Run: bun test lib/refund-ledger.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { createTestCheckout, confirmTestPayment } from "./checkout-test";
import {
  deliverTestWebhookEvent,
  resetWebhookFixtures,
  type TestWebhookEvent,
} from "./webhook-test";
import {
  HANDLER_ERROR_CODES,
  getRefundLedger,
  handleTestWebhookDelivery,
  handleTestWebhookEvent,
  resetWebhookHandler,
  setRefundLedger,
} from "./webhook-handler";
import {
  REFUND_ERROR_CODES,
  applyRefundLedgerEntry,
  emptyRefundLedger,
  isValidTestRefund,
  issueTestRefund,
  netCaptured,
  refundsFor,
  totalRefunded,
  type RefundLedgerEntry,
} from "./refund-ledger";

/* ── Harness ─────────────────────────────────────────────────────── */

beforeEach(() => {
  resetWebhookFixtures();
  resetWebhookHandler();
});

function paidReceipt() {
  const session = createTestCheckout("uncontested_packet"); // $30 = 3000¢
  return confirmTestPayment(session.id, session);
}

function capture(
  ledger: ReturnType<typeof emptyRefundLedger>,
  paymentId: string,
  amountCents = 3000,
  currency = "usd"
) {
  const entry: RefundLedgerEntry = {
    kind: "capture",
    paymentId,
    amountCents,
    currency,
    eventId: "evt_test_capture_0001",
  };
  return applyRefundLedgerEntry(ledger, entry).ledger;
}

function refundEntry(
  paymentId: string,
  refundId: string,
  amountCents: number,
  currency = "usd"
): RefundLedgerEntry {
  return {
    kind: "refund",
    refundId,
    paymentId,
    amountCents,
    currency,
    eventId: `evt_test_refund_${refundId.slice(-4)}`,
  };
}

/* ── Fixture validation ──────────────────────────────────────────── */

describe("isValidTestRefund", () => {
  test("accepts a fixture from issueTestRefund", () => {
    const r = issueTestRefund({ paymentId: "rcpt_test_000001", amountCents: 1500 });
    expect(isValidTestRefund(r)).toBe(true);
    expect(r.id.startsWith("rfnd_test_")).toBe(true);
    expect(r.testMode).toBe(true);
  });

  test("rejects non-fixture shapes", () => {
    expect(isValidTestRefund(null)).toBe(false);
    expect(isValidTestRefund({})).toBe(false);
    // live-looking id
    expect(
      isValidTestRefund({
        id: "re_live_1",
        paymentId: "rcpt_test_000001",
        amountCents: 100,
        currency: "usd",
        refundedAt: new Date().toISOString(),
        testMode: true,
      })
    ).toBe(false);
    // zero amount
    expect(
      isValidTestRefund({
        id: "rfnd_test_000001",
        paymentId: "rcpt_test_000001",
        amountCents: 0,
        currency: "usd",
        refundedAt: new Date().toISOString(),
        testMode: true,
      })
    ).toBe(false);
    // payment id from the wrong world
    expect(
      isValidTestRefund({
        id: "rfnd_test_000001",
        paymentId: "pi_live_1",
        amountCents: 100,
        currency: "usd",
        refundedAt: new Date().toISOString(),
        testMode: true,
      })
    ).toBe(false);
  });

  test("issueTestRefund throws on bad amounts", () => {
    expect(() =>
      issueTestRefund({ paymentId: "rcpt_test_000001", amountCents: 0 })
    ).toThrow(/positive integer/);
    expect(() =>
      issueTestRefund({ paymentId: "rcpt_test_000001", amountCents: -50 })
    ).toThrow(/positive integer/);
    expect(() =>
      issueTestRefund({ paymentId: "rcpt_test_000001", amountCents: 10.5 })
    ).toThrow(/positive integer/);
  });
});

/* ── Pure ledger: captures ───────────────────────────────────────── */

describe("applyRefundLedgerEntry — captures", () => {
  test("a capture appends and net-captures its full amount", () => {
    const ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    expect(ledger.entries).toHaveLength(1);
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(3000);
  });

  test("a second capture of the same payment throws DUPLICATE_REFUND", () => {
    const ledger = capture(emptyRefundLedger(), "rcpt_test_000001");
    expect(() =>
      applyRefundLedgerEntry(ledger, {
        kind: "capture",
        paymentId: "rcpt_test_000001",
        amountCents: 3000,
        currency: "usd",
        eventId: "evt_test_capture_0002",
      })
    ).toThrowError(expect.objectContaining({ code: REFUND_ERROR_CODES.DUPLICATE_REFUND }));
  });

  test("netCaptured is 0 for an unknown payment", () => {
    expect(netCaptured(emptyRefundLedger(), "rcpt_test_999999")).toBe(0);
  });
});

/* ── Pure ledger: refunds ────────────────────────────────────────── */

describe("applyRefundLedgerEntry — refunds", () => {
  test("partial refunds sum-check: 1200 + 800 against 3000 is fine, net is 1000", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 1200)
    ).ledger;
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000002", 800)
    ).ledger;
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(1000);
    expect(totalRefunded(ledger, "rcpt_test_000001")).toBe(2000);
  });

  test("duplicate refund id is an idempotent no-op: ledger UNCHANGED, applied=false", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    const first = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 1200)
    );
    expect(first.applied).toBe(true);
    ledger = first.ledger;
    const replay = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 1200)
    );
    expect(replay.applied).toBe(false);
    // The returned ledger is the SAME value — redelivery never double-applies.
    expect(replay.ledger).toBe(ledger);
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(1800);
    expect(refundsFor(ledger, "rcpt_test_000001")).toHaveLength(1);
  });

  test("a single refund bigger than the capture is refused (OVER_REFUND)", () => {
    const ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    const before = ledger.entries.length;
    expect(() =>
      applyRefundLedgerEntry(ledger, refundEntry("rcpt_test_000001", "rfnd_test_000001", 3001))
    ).toThrowError(expect.objectContaining({ code: REFUND_ERROR_CODES.OVER_REFUND }));
    expect(ledger.entries).toHaveLength(before); // failed apply changes nothing
  });

  test("cumulative over-refund is refused: 1200 + 800 + 1001 against 3000", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 1200)
    ).ledger;
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000002", 800)
    ).ledger;
    expect(() =>
      applyRefundLedgerEntry(ledger, refundEntry("rcpt_test_000001", "rfnd_test_000003", 1001))
    ).toThrowError(expect.objectContaining({ code: REFUND_ERROR_CODES.OVER_REFUND }));
    // The first two refunds still stand; net is untouched by the refusal.
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(1000);
  });

  test("full refund zeroes the net but keeps the reversal history", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 3000)
    ).ledger;
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(0);
    const history = refundsFor(ledger, "rcpt_test_000001");
    expect(history).toHaveLength(1);
    expect(history[0].paymentId).toBe("rcpt_test_000001"); // linked to the original
    expect(history[0].refundId).toBe("rfnd_test_000001");
  });

  test("refund before any capture is refused (REFUND_BEFORE_CAPTURE)", () => {
    expect(() =>
      applyRefundLedgerEntry(
        emptyRefundLedger(),
        refundEntry("rcpt_test_000001", "rfnd_test_000001", 100)
      )
    ).toThrowError(
      expect.objectContaining({ code: REFUND_ERROR_CODES.REFUND_BEFORE_CAPTURE })
    );
  });

  test("cross-currency refund is refused (CURRENCY_MISMATCH)", () => {
    const ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000, "usd");
    expect(() =>
      applyRefundLedgerEntry(
        ledger,
        refundEntry("rcpt_test_000001", "rfnd_test_000001", 100, "eur")
      )
    ).toThrowError(expect.objectContaining({ code: REFUND_ERROR_CODES.CURRENCY_MISMATCH }));
  });

  test("reversal entries link the original payment id, per payment", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    ledger = capture(ledger, "rcpt_test_000002", 1000);
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000002", "rfnd_test_000009", 400)
    ).ledger;
    // Payment 1 is untouched by payment 2's refund.
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(3000);
    expect(netCaptured(ledger, "rcpt_test_000002")).toBe(600);
    expect(refundsFor(ledger, "rcpt_test_000001")).toHaveLength(0);
  });

  test("netCaptured can never go negative through the public API", () => {
    let ledger = capture(emptyRefundLedger(), "rcpt_test_000001", 3000);
    // Drain it exactly, then any further cent throws.
    ledger = applyRefundLedgerEntry(
      ledger,
      refundEntry("rcpt_test_000001", "rfnd_test_000001", 3000)
    ).ledger;
    expect(() =>
      applyRefundLedgerEntry(ledger, refundEntry("rcpt_test_000001", "rfnd_test_000002", 1))
    ).toThrowError(expect.objectContaining({ code: REFUND_ERROR_CODES.OVER_REFUND }));
    expect(netCaptured(ledger, "rcpt_test_000001")).toBe(0);
  });
});

/* ── Handler: charge.refunded end-to-end ─────────────────────────── */

function deliverChargeRefunded(paymentId: string, amountCents: number) {
  const refund = issueTestRefund({ paymentId, amountCents });
  const { rawBody, signature } = deliverTestWebhookEvent("charge.refunded", refund);
  return { rawBody, signature, refund };
}

describe("handleTestWebhookDelivery — charge.refunded", () => {
  test("payment_intent.succeeded records the capture; charge.refunded produces record_refund", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    const payEffect = handleTestWebhookDelivery(pay.rawBody, pay.signature);
    expect(payEffect.effect).toBe("record_payment");
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(3000);

    const { rawBody, signature } = deliverChargeRefunded(receipt.id, 1200);
    const refundEffect = handleTestWebhookDelivery(rawBody, signature);
    expect(refundEffect.effect).toBe("record_refund");
    expect(refundEffect.eventType).toBe("charge.refunded");
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);
  });

  test("redelivered refund event (same event id) throws ALREADY_HANDLED, never double-applies", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    handleTestWebhookDelivery(pay.rawBody, pay.signature);

    const { rawBody, signature } = deliverChargeRefunded(receipt.id, 1200);
    handleTestWebhookDelivery(rawBody, signature);
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);

    // The parse-level replay gate would fire first — clear it so the
    // duplicate reaches the HANDLER ledger, the layer under test.
    resetWebhookFixtures();
    expect(() => handleTestWebhookDelivery(rawBody, signature)).toThrowError(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED })
    );
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);
    expect(refundsFor(getRefundLedger(), receipt.id)).toHaveLength(1);
  });

  test("re-emitted refund under a NEW event id still dedupes by refund id", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    handleTestWebhookDelivery(pay.rawBody, pay.signature);

    const refund = issueTestRefund({ paymentId: receipt.id, amountCents: 1200 });
    const first = deliverTestWebhookEvent("charge.refunded", refund);
    handleTestWebhookDelivery(first.rawBody, first.signature);
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);

    // The processor re-emits the SAME refund under a fresh event id
    // (split-brain retry). The event-id ledger sees a new id; the
    // refund-id ledger must still refuse the second application.
    const reemit: TestWebhookEvent = {
      id: "evt_test_reemit_000001",
      type: "charge.refunded",
      testMode: true,
      created: Math.floor(Date.now() / 1000),
      data: { object: refund },
    };
    expect(() =>
      handleTestWebhookEvent(reemit, { payloadFingerprint: "fp-reemit" })
    ).toThrowError(expect.objectContaining({ code: HANDLER_ERROR_CODES.ALREADY_HANDLED }));
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);
    expect(refundsFor(getRefundLedger(), receipt.id)).toHaveLength(1);
  });

  test("refund before capture is refused with REFUND_BEFORE_CAPTURE", () => {
    const receipt = paidReceipt(); // paid, but no webhook ever recorded the capture
    const { rawBody, signature } = deliverChargeRefunded(receipt.id, 500);
    expect(() => handleTestWebhookDelivery(rawBody, signature)).toThrowError(
      expect.objectContaining({ code: REFUND_ERROR_CODES.REFUND_BEFORE_CAPTURE })
    );
    expect(getRefundLedger().entries).toHaveLength(0);
  });

  test("over-refund is refused with OVER_REFUND", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    handleTestWebhookDelivery(pay.rawBody, pay.signature);

    const { rawBody, signature } = deliverChargeRefunded(receipt.id, 3001);
    expect(() => handleTestWebhookDelivery(rawBody, signature)).toThrowError(
      expect.objectContaining({ code: REFUND_ERROR_CODES.OVER_REFUND })
    );
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(3000);
  });

  test("partial refund sums hold across multiple refund events", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    handleTestWebhookDelivery(pay.rawBody, pay.signature);

    const r1 = deliverChargeRefunded(receipt.id, 1200);
    handleTestWebhookDelivery(r1.rawBody, r1.signature);
    const r2 = deliverChargeRefunded(receipt.id, 800);
    handleTestWebhookDelivery(r2.rawBody, r2.signature);
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1000);

    // A third refund would push the sum past the capture — refused.
    const r3 = deliverChargeRefunded(receipt.id, 1001);
    expect(() => handleTestWebhookDelivery(r3.rawBody, r3.signature)).toThrowError(
      expect.objectContaining({ code: REFUND_ERROR_CODES.OVER_REFUND })
    );
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1000);
  });

  test("charge.refunded with a non-refund object throws INVALID_OBJECT", () => {
    const receipt = paidReceipt();
    const bad = deliverTestWebhookEvent("charge.refunded", receipt as never);
    expect(() => handleTestWebhookDelivery(bad.rawBody, bad.signature)).toThrowError(
      expect.objectContaining({ code: HANDLER_ERROR_CODES.INVALID_OBJECT })
    );
  });

  test("resetWebhookHandler clears the refund ledger", () => {
    const receipt = paidReceipt();
    const pay = deliverTestWebhookEvent("payment_intent.succeeded", receipt);
    handleTestWebhookDelivery(pay.rawBody, pay.signature);
    expect(getRefundLedger().entries.length).toBeGreaterThan(0);
    resetWebhookHandler();
    expect(getRefundLedger().entries).toHaveLength(0);
  });

  test("a pre-seeded refund ledger can be swapped in", () => {
    const receipt = paidReceipt();
    // Seed: capture + one partial refund, as a live route would load them.
    let seeded = capture(emptyRefundLedger(), receipt.id, 3000);
    seeded = applyRefundLedgerEntry(
      seeded,
      refundEntry(receipt.id, "rfnd_test_000001", 500)
    ).ledger;
    setRefundLedger(seeded);

    const { rawBody, signature } = deliverChargeRefunded(receipt.id, 700);
    const effect = handleTestWebhookDelivery(rawBody, signature);
    expect(effect.effect).toBe("record_refund");
    expect(netCaptured(getRefundLedger(), receipt.id)).toBe(1800);
  });
});
