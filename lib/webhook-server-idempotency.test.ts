/**
 * Regression tests for webhook idempotency + replay protection —
 * lib/webhook-server-dispatch.ts.
 *
 * Covered:
 *   1. duplicate delivery → single payment record (the `already_processed`
 *      answer, no double record_payment);
 *   2. stale events → rejected with EXPIRED_EVENT, never reaching
 *      dispatch (replay protection), and not poisoning the ledger;
 *   3. distinct event ids → both processed;
 *   4. TTL: a processed id is forgotten after the retention window.
 *
 * No network, no real secrets: the secret is a throwaway unit-test
 * string that never leaves this process.
 * Run: bun test lib/webhook-server-idempotency.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  signServerWebhookPayload,
  SERVER_WEBHOOK_TOLERANCE_SECONDS,
} from "./webhook-server";
import {
  SERVER_DISPATCH_ERROR_CODES,
  SERVER_DISPATCH_ID_RETENTION_SECONDS,
  handleServerWebhookDeliveryOnce,
  resetServerWebhookDispatch,
  type ServerWebhookDeliveryResult,
} from "./webhook-server-dispatch";

/** Throwaway secret for these tests — never a fixture dummy, never real. */
const UNIT_SECRET = "unit_test_server_idempotency_secret_02";

const NOW = 1_800_000_000; // fixed "now" for determinism

function sessionBody(eventId: string, amountTotal = 3000): string {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        object: "checkout.session",
        amount_total: amountTotal,
        currency: "usd",
        payment_status: "paid",
      },
    },
  });
}

/**
 * Deliver through the idempotent entry point. The duplicate still has
 * to verify, so a fresh signature (fresh ts) is signed per call —
 * exactly like a processor retry would re-deliver a signed payload.
 */
function deliverOnce(
  body: string,
  opts: { ts?: number; now?: number } = {}
): ServerWebhookDeliveryResult {
  const ts = opts.ts ?? NOW;
  const header = signServerWebhookPayload(body, UNIT_SECRET, ts);
  return handleServerWebhookDeliveryOnce(body, header, UNIT_SECRET, {
    nowSeconds: opts.now ?? NOW,
  });
}

beforeEach(() => {
  resetServerWebhookDispatch();
});

describe("duplicate delivery → single payment record", () => {
  test("first delivery processes, redelivery answers already_processed", () => {
    const body = sessionBody("evt_dup_1");

    const first = deliverOnce(body);
    expect(first.status).toBe("processed");
    if (first.status !== "processed") throw new Error("unreachable");
    expect(first.effect.effect).toBe("record_payment");
    expect(first.effect.payment.eventId).toBe("evt_dup_1");

    // Same event id delivered again (re-signed, fresh ts): no second
    // payment record — the route gets a clear duplicate answer.
    const second = deliverOnce(body, { ts: NOW + 10, now: NOW + 10 });
    expect(second.status).toBe("already_processed");
    if (second.status !== "already_processed") throw new Error("unreachable");
    expect(second.eventId).toBe("evt_dup_1");

    // Exactly one payment effect exists across both deliveries.
    const payments = [first, second].filter(
      (r) => r.status === "processed"
    );
    expect(payments).toHaveLength(1);
  });

  test("three rapid redeliveries still yield exactly one payment record", () => {
    const body = sessionBody("evt_dup_3");
    const results = [0, 1, 2, 3].map((i) =>
      deliverOnce(body, { ts: NOW + i, now: NOW + i })
    );
    const processed = results.filter((r) => r.status === "processed");
    const dupes = results.filter((r) => r.status === "already_processed");
    expect(processed).toHaveLength(1);
    expect(dupes).toHaveLength(3);
    for (const d of dupes) {
      if (d.status === "already_processed") {
        expect(d.eventId).toBe("evt_dup_3");
      }
    }
  });

  test("same id with a DIFFERENT body throws EVENT_BODY_CONFLICT (fail closed)", () => {
    const body = sessionBody("evt_dup_tamper_1");
    const first = deliverOnce(body);
    expect(first.status).toBe("processed");

    // Same event id re-delivered with a different (tampered) payload:
    // the signature verifies (it was signed over the tampered bytes),
    // but the body hash no longer matches the handled delivery — this
    // is not a retry, so it fails closed instead of being deduplicated.
    const tampered = body.replace("3000", "1");
    const header = signServerWebhookPayload(tampered, UNIT_SECRET, NOW + 5);
    expect(() =>
      handleServerWebhookDeliveryOnce(tampered, header, UNIT_SECRET, {
        nowSeconds: NOW + 5,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.EVENT_BODY_CONFLICT,
      })
    );
  });

  test("conflict does not shadow a later genuine duplicate", () => {
    const body = sessionBody("evt_dup_conflict_1");
    const first = deliverOnce(body);
    expect(first.status).toBe("processed");

    const tampered = body.replace("3000", "1");
    const badHeader = signServerWebhookPayload(tampered, UNIT_SECRET, NOW + 5);
    expect(() =>
      handleServerWebhookDeliveryOnce(tampered, badHeader, UNIT_SECRET, {
        nowSeconds: NOW + 5,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.EVENT_BODY_CONFLICT,
      })
    );

    // The genuine byte-identical retry still deduplicates cleanly —
    // the conflict attempt never touched the ledger entry.
    const dupe = deliverOnce(body, { ts: NOW + 6, now: NOW + 6 });
    expect(dupe.status).toBe("already_processed");
  });
});

describe("stale events are rejected — replay protection", () => {
  test("event older than the tolerance window throws EXPIRED_EVENT", () => {
    const body = sessionBody("evt_stale_1");
    const staleTs = NOW - SERVER_WEBHOOK_TOLERANCE_SECONDS - 1;
    const header = signServerWebhookPayload(body, UNIT_SECRET, staleTs);
    expect(() =>
      handleServerWebhookDeliveryOnce(body, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.EXPIRED_EVENT,
      })
    );
  });

  test("a rejected stale delivery does not poison the ledger", () => {
    const body = sessionBody("evt_stale_2");
    const staleTs = NOW - SERVER_WEBHOOK_TOLERANCE_SECONDS - 1;
    const staleHeader = signServerWebhookPayload(body, UNIT_SECRET, staleTs);
    expect(() =>
      handleServerWebhookDeliveryOnce(body, staleHeader, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.EXPIRED_EVENT,
      })
    );
    // The same event id delivered fresh still processes — the stale
    // attempt never marked the ledger (it threw at verification).
    const fresh = deliverOnce(body);
    expect(fresh.status).toBe("processed");
    if (fresh.status !== "processed") throw new Error("unreachable");
    expect(fresh.effect.payment.eventId).toBe("evt_stale_2");
  });

  test("future-dated events beyond tolerance throw FUTURE_EVENT", () => {
    const body = sessionBody("evt_future_1");
    const futureTs = NOW + SERVER_WEBHOOK_TOLERANCE_SECONDS + 1;
    const header = signServerWebhookPayload(body, UNIT_SECRET, futureTs);
    expect(() =>
      handleServerWebhookDeliveryOnce(body, header, UNIT_SECRET, {
        nowSeconds: NOW,
      })
    ).toThrow(
      expect.objectContaining({
        code: SERVER_DISPATCH_ERROR_CODES.FUTURE_EVENT,
      })
    );
  });
});

describe("distinct events are independent", () => {
  test("two different event ids both process", () => {
    const a = deliverOnce(sessionBody("evt_a_1"));
    const b = deliverOnce(sessionBody("evt_b_1"));
    expect(a.status).toBe("processed");
    expect(b.status).toBe("processed");
    if (a.status !== "processed" || b.status !== "processed")
      throw new Error("unreachable");
    expect(a.effect.payment.eventId).toBe("evt_a_1");
    expect(b.effect.payment.eventId).toBe("evt_b_1");
  });

  test("a duplicate of one id does not shadow a new id", () => {
    const first = deliverOnce(sessionBody("evt_shadow_1"));
    expect(first.status).toBe("processed");
    const dupe = deliverOnce(sessionBody("evt_shadow_1"), {
      ts: NOW + 1,
      now: NOW + 1,
    });
    expect(dupe.status).toBe("already_processed");
    const other = deliverOnce(sessionBody("evt_shadow_2"));
    expect(other.status).toBe("processed");
  });
});

describe("id retention TTL — the ledger stays bounded", () => {
  test("a processed id is forgotten after the retention window", () => {
    const body = sessionBody("evt_ttl_1");
    const first = deliverOnce(body);
    expect(first.status).toBe("processed");

    // Advance past the retention window (fresh signature at the new
    // now, so verification still passes): the id has been pruned, so
    // the delivery processes again instead of answering already_processed.
    const later = NOW + SERVER_DISPATCH_ID_RETENTION_SECONDS + 1;
    const again = deliverOnce(body, { ts: later, now: later });
    expect(again.status).toBe("processed");
    if (again.status !== "processed") throw new Error("unreachable");
    expect(again.effect.payment.eventId).toBe("evt_ttl_1");
  });

  test("an id inside the retention window is still deduplicated", () => {
    const body = sessionBody("evt_ttl_2");
    const first = deliverOnce(body);
    expect(first.status).toBe("processed");

    const within = NOW + SERVER_DISPATCH_ID_RETENTION_SECONDS - 60;
    const dupe = deliverOnce(body, { ts: within, now: within });
    expect(dupe.status).toBe("already_processed");
  });

  test("pruning does not drop ids that are still fresh", () => {
    const old_ = deliverOnce(sessionBody("evt_ttl_old_1"));
    expect(old_.status).toBe("processed");
    const fresh = deliverOnce(sessionBody("evt_ttl_fresh_1"), {
      ts: NOW + 3600,
      now: NOW + 3600,
    });
    expect(fresh.status).toBe("processed");

    // Deliver the fresh id again just past retention-from-FIRST time:
    // the fresh id (processed at NOW+3600) must still dedupe because
    // prune is relative to each id's own processed-at, not global.
    const justPast = NOW + SERVER_DISPATCH_ID_RETENTION_SECONDS + 1;
    const dupe = deliverOnce(sessionBody("evt_ttl_fresh_1"), {
      ts: justPast,
      now: justPast,
    });
    expect(dupe.status).toBe("already_processed");
  });
});
