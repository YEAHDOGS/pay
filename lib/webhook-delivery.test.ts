/**
 * webhook-delivery.test.ts — regression tests for delivery outcome semantics.
 *
 * The money-critical promise: a failed webhook delivery is NEVER
 * retried when retry is wrong (forgeries, duplicates, unknown codes)
 * and NEVER vanishes silently when retry is right. These tests pin
 * the classification table, the bounded backoff, the bounded dead-
 * letter queue, and the one-call route API (`resolveDeliveryFailure`).
 */

import { describe, expect, test } from "bun:test";

import {
  DELIVERY_DISPOSITIONS,
  DELIVERY_POLICY_DEFAULTS,
  DEAD_LETTER_RECORD_FIELDS,
  DeadLetterQueue,
  classifyDeliveryCode,
  makeDeliveryPolicy,
  nextRetryDelay,
  retrySchedule,
  resolveDeliveryFailure,
} from "./webhook-delivery";

/* ── Classification ──────────────────────────────────────────────── */

describe("classifyDeliveryCode", () => {
  test("duplicates ack, never re-process", () => {
    for (const code of ["REPLAYED_EVENT", "ALREADY_HANDLED", "DUPLICATE_REFUND"]) {
      expect(classifyDeliveryCode(code)).toBe("ack");
    }
  });

  test("refund-before-capture is the only retryable code", () => {
    expect(classifyDeliveryCode("REFUND_BEFORE_CAPTURE")).toBe("retryable");
  });

  test("known fatal codes fail closed (never retried)", () => {
    for (const code of [
      "BAD_SIGNATURE",
      "TIMESTAMP_MISMATCH",
      "BAD_EVENT",
      "INVALID_OBJECT",
      "UNKNOWN_EVENT_TYPE",
      "PAYLOAD_CONFLICT",
      "EXPIRED_EVENT",
      "MISSING_SIGNATURE",
      "BODY_TOO_LARGE",
      "OVER_REFUND",
      "CURRENCY_MISMATCH",
      "BAD_AMOUNT",
      "BAD_ENTRY",
      "DECLINED",
      "TEST_MODE_VIOLATION",
    ]) {
      expect(classifyDeliveryCode(code)).toBe("fatal");
    }
  });

  test("unknown, missing, or non-string codes fail closed to fatal", () => {
    for (const code of ["NO_SUCH_CODE", "", undefined, null, 42, {}]) {
      expect(classifyDeliveryCode(code)).toBe("fatal");
    }
  });
});

/* ── Policy bounds ───────────────────────────────────────────────── */

describe("makeDeliveryPolicy", () => {
  test("defaults are the bounded standard policy", () => {
    const p = makeDeliveryPolicy();
    expect(p.maxAttempts).toBe(DELIVERY_POLICY_DEFAULTS.MAX_ATTEMPTS);
    expect(p.baseDelaySeconds).toBe(DELIVERY_POLICY_DEFAULTS.BASE_DELAY_SECONDS);
    expect(p.maxDelaySeconds).toBe(DELIVERY_POLICY_DEFAULTS.MAX_DELAY_SECONDS);
  });

  test("custom valid policy passes through", () => {
    const p = makeDeliveryPolicy({ maxAttempts: 3, baseDelaySeconds: 10, maxDelaySeconds: 60 });
    expect(p).toEqual({ maxAttempts: 3, baseDelaySeconds: 10, maxDelaySeconds: 60 });
  });

  test("out-of-range configs throw, never silently clamp", () => {
    expect(() => makeDeliveryPolicy({ maxAttempts: 0 })).toThrow();
    expect(() => makeDeliveryPolicy({ maxAttempts: 11 })).toThrow();
    expect(() => makeDeliveryPolicy({ maxAttempts: 2.5 })).toThrow();
    expect(() => makeDeliveryPolicy({ baseDelaySeconds: 0 })).toThrow();
    expect(() => makeDeliveryPolicy({ maxDelaySeconds: 100000 })).toThrow();
    expect(() => makeDeliveryPolicy({ baseDelaySeconds: 60, maxDelaySeconds: 30 })).toThrow();
  });
});

describe("nextRetryDelay / retrySchedule", () => {
  test("default schedule is 5s, 10s, 20s, 40s — deterministic", () => {
    expect(retrySchedule()).toEqual([5, 10, 20, 40]);
    expect(retrySchedule()).toEqual(retrySchedule()); // no jitter
  });

  test("delays are capped at maxDelaySeconds", () => {
    const p = makeDeliveryPolicy({ maxAttempts: 6, baseDelaySeconds: 500, maxDelaySeconds: 700 });
    expect(retrySchedule(p)).toEqual([500, 700, 700, 700, 700]);
  });

  test("single-attempt policy has no retry schedule", () => {
    const p = makeDeliveryPolicy({ maxAttempts: 1 });
    expect(retrySchedule(p)).toEqual([]);
    expect(nextRetryDelay(1, p)).toBeNull();
  });

  test("invalid attempt counts return null, never a delay", () => {
    const p = makeDeliveryPolicy();
    expect(nextRetryDelay(0, p)).toBeNull();
    expect(nextRetryDelay(-1, p)).toBeNull();
    expect(nextRetryDelay(5, p)).toBeNull(); // attemptsUsed >= maxAttempts
    expect(nextRetryDelay(1.5, p)).toBeNull();
  });
});

/* ── Dead-letter queue ───────────────────────────────────────────── */

function fixedClock(start = 1_700_000_000): () => number {
  let t = start;
  return () => t++;
}

describe("DeadLetterQueue", () => {
  test("records carry forensics fields only, stamped by the clock", () => {
    const q = new DeadLetterQueue(10, fixedClock());
    const rec = q.add({
      eventId: "evt_test_1",
      eventType: "checkout.session.completed",
      code: "BAD_SIGNATURE",
      reason: "fatal",
      attempts: 1,
    });
    expect(rec.atSeconds).toBe(1_700_000_000);
    expect(rec.testMode).toBe(true);
    expect(q.size).toBe(1);
    // No-leak contract: every key on the record is allowlisted.
    for (const key of Object.keys(rec)) {
      expect(DEAD_LETTER_RECORD_FIELDS.has(key)).toBe(true);
    }
    const json = JSON.stringify(rec);
    expect(json).not.toContain("rawBody");
    expect(json).not.toContain("signature");
  });

  test("bounded: oldest record evicts, evictedCount stays honest", () => {
    const q = new DeadLetterQueue(3, fixedClock());
    for (let i = 1; i <= 5; i++) {
      q.add({ code: `E${i}`, reason: "fatal", attempts: i });
    }
    expect(q.size).toBe(3);
    expect(q.evictedCount).toBe(2);
    // Newest failure survives — the one the operator most needs.
    expect(q.entries().map((r) => r.code)).toEqual(["E3", "E4", "E5"]);
  });

  test("refuses records without an error code", () => {
    const q = new DeadLetterQueue(10, fixedClock());
    expect(() =>
      q.add({ code: "", reason: "fatal", attempts: 1 })
    ).toThrow();
    expect(q.size).toBe(0);
  });

  test("constructor rejects non-positive bounds", () => {
    expect(() => new DeadLetterQueue(0)).toThrow();
    expect(() => new DeadLetterQueue(-5)).toThrow();
  });

  test("clear() resets records and the eviction counter", () => {
    const q = new DeadLetterQueue(2, fixedClock());
    q.add({ code: "A", reason: "fatal", attempts: 1 });
    q.add({ code: "B", reason: "fatal", attempts: 1 });
    q.add({ code: "C", reason: "fatal", attempts: 1 });
    q.clear();
    expect(q.size).toBe(0);
    expect(q.evictedCount).toBe(0);
  });

  test("entries() returns a copy — the queue can't be mutated from outside", () => {
    const q = new DeadLetterQueue(10, fixedClock());
    q.add({ code: "A", reason: "fatal", attempts: 1 });
    const copy = q.entries() as unknown[];
    copy.pop();
    expect(q.size).toBe(1);
  });
});

/* ── The route's one call ────────────────────────────────────────── */

describe("resolveDeliveryFailure", () => {
  test("duplicate → ack: nothing to do", () => {
    const out = resolveDeliveryFailure({ code: "ALREADY_HANDLED" }, 1);
    expect(out.disposition).toBe(DELIVERY_DISPOSITIONS.ACK);
  });

  test("refund-before-capture → retry with the backoff delay", () => {
    const out = resolveDeliveryFailure(
      { code: "REFUND_BEFORE_CAPTURE" },
      1,
      { eventId: "evt_test_9", eventType: "charge.refunded" }
    );
    expect(out.disposition).toBe("retry");
    if (out.disposition === "retry") {
      expect(out.retryInSeconds).toBe(5);
      expect(out.attempt).toBe(2);
    }
  });

  test("retryable exhausted → dead letter with retries-exhausted", () => {
    const out = resolveDeliveryFailure({ code: "REFUND_BEFORE_CAPTURE" }, 5);
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.reason).toBe("retries-exhausted");
      expect(out.record.code).toBe("REFUND_BEFORE_CAPTURE");
      expect(out.record.attempts).toBe(5);
    }
  });

  test("forged signature → dead letter, never retried", () => {
    const out = resolveDeliveryFailure(
      { code: "BAD_SIGNATURE" },
      1,
      { eventId: "evt_test_2", eventType: "checkout.session.completed" }
    );
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.reason).toBe("fatal");
      expect(out.record.eventId).toBe("evt_test_2");
    }
  });

  test("payload conflict → fatal dead letter (possible forgery, investigate)", () => {
    const out = resolveDeliveryFailure({ code: "PAYLOAD_CONFLICT" }, 3);
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.reason).toBe("fatal");
    }
  });

  test("unknown code fails closed to a fatal dead letter, never retried", () => {
    const out = resolveDeliveryFailure({ code: "SOME_FUTURE_CODE" }, 1);
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.code).toBe("SOME_FUTURE_CODE");
      expect(out.record.reason).toBe("fatal");
    }
  });

  test("missing error → dead letter with UNKNOWN_CODE", () => {
    const out = resolveDeliveryFailure({}, 1);
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.code).toBe("UNKNOWN_CODE");
    }
  });

  test("malformed attempt counter is treated as the first failure", () => {
    const out = resolveDeliveryFailure({ code: "REFUND_BEFORE_CAPTURE" }, 0);
    expect(out.disposition).toBe("retry");
    if (out.disposition === "retry") {
      expect(out.retryInSeconds).toBe(5);
      expect(out.attempt).toBe(2);
    }
  });

  test("custom policy changes the schedule and the stop point", () => {
    const policy = makeDeliveryPolicy({ maxAttempts: 3, baseDelaySeconds: 30, maxDelaySeconds: 30 });
    const first = resolveDeliveryFailure({ code: "REFUND_BEFORE_CAPTURE" }, 1, {}, policy);
    expect(first.disposition).toBe("retry");
    if (first.disposition === "retry") expect(first.retryInSeconds).toBe(30);
    const last = resolveDeliveryFailure({ code: "REFUND_BEFORE_CAPTURE" }, 3, {}, policy);
    expect(last.disposition).toBe("dead-letter");
  });

  test("empty context omits eventId/eventType rather than recording garbage", () => {
    const out = resolveDeliveryFailure({ code: "EXPIRED_EVENT" }, 1, {});
    expect(out.disposition).toBe("dead-letter");
    if (out.disposition === "dead-letter") {
      expect(out.record.eventId).toBeUndefined();
      expect(out.record.eventType).toBeUndefined();
    }
  });
});
