/**
 * webhook-delivery.ts — TEST-MODE-ONLY delivery outcome semantics.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * `webhook-handler.ts` throws when a delivery fails, but it doesn't
 * answer the route's next question: "should I retry this, and if not,
 * where does it go?" Retrying a forged signature is pointless and a
 * replay-vector; retrying an unknown code is a gamble; letting a
 * failed-but-retryable delivery vanish is a lost fulfillment. This
 * module classifies every known failure code so a staging route can
 * treat them all the same way without inventing its own taxonomy:
 *
 *   try {
 *     const effect = handleTestWebhookDelivery(rawBody, signature);
 *     fulfill(effect);
 *   } catch (e) {
 *     const outcome = resolveDeliveryFailure(e, attemptsUsed, {
 *       eventId, eventType,
 *     });
 *     switch (outcome.disposition) {
 *       case "ack":        break;                      // duplicate — nothing to do
 *       case "retry":      scheduleRetry(outcome.retryInSeconds); break;
 *       case "dead-letter": deadLetters.add(outcome.record); break;
 *     }
 *   }
 *
 * Classification by construction:
 *   - "ack" — duplicates, acknowledged never re-processed:
 *     REPLAYED_EVENT, ALREADY_HANDLED, DUPLICATE_REFUND.
 *   - "retryable" — the SAME delivery re-attempted later could
 *     succeed. Only REFUND_BEFORE_CAPTURE qualifies: the handler
 *     deliberately does NOT mark the event id handled on refund
 *     guard failures, so when the missing capture arrives (out-of-
 *     order delivery) the retry can land. Every other code is either
 *     permanent (retry can't fix it) or unknown (fail closed).
 *   - "fatal" — BAD_SIGNATURE, TIMESTAMP_MISMATCH, BAD_EVENT,
 *     INVALID_OBJECT, UNKNOWN_EVENT_TYPE, PAYLOAD_CONFLICT,
 *     EXPIRED_EVENT, MISSING_SIGNATURE, BODY_TOO_LARGE, OVER_REFUND,
 *     CURRENCY_MISMATCH, BAD_AMOUNT, BAD_ENTRY, DECLINED, ... — and
 *     ANY code this library doesn't know. Fail closed: never retry
 *     what you can't name.
 *
 * Dead-letter records carry ids, event types, effect names, and error
 * codes ONLY — no payloads, no signatures, no secrets, no PII (the
 * same rule as the audit trail). The queue is bounded: FIFO eviction
 * of the oldest record once `maxRecords` is reached, so a bad deploy
 * can't grow it without limit; `evictedCount` makes the loss visible.
 *
 * Backoff is deterministic (no jitter — fixtures are reproducible):
 * BASE_DELAY_SECONDS * 2^n, capped at MAX_DELAY_SECONDS. A live route
 * may want jitter; add it at the call site, never here.
 *
 * Zero dependencies. Zero network. Nothing leaves this process.
 */

/* ── Hoisted constants ───────────────────────────────────────────── */

/**
 * The terminal decision a route takes on a failed delivery.
 */
export const DELIVERY_DISPOSITIONS = Object.freeze({
  /** Duplicate — acknowledged, never re-processed, nothing to do. */
  ACK: "ack",
  /** Schedule one more attempt after `retryInSeconds`. */
  RETRY: "retry",
  /** Record in the dead-letter queue; investigate, then act by hand. */
  DEAD_LETTER: "dead-letter",
} as const);

export type DeliveryDisposition =
  (typeof DELIVERY_DISPOSITIONS)[keyof typeof DELIVERY_DISPOSITIONS];

/**
 * Delivery-failure severity: decides the disposition when combined
 * with the attempt count.
 */
export const DELIVERY_SEVERITIES = Object.freeze({
  /** Duplicates — acknowledged, never re-processed. */
  ACK: "ack",
  /** A later retry of the same delivery could succeed. */
  RETRYABLE: "retryable",
  /** Permanent, or unknown — fail closed, never retry. */
  FATAL: "fatal",
} as const);

export type DeliverySeverity =
  (typeof DELIVERY_SEVERITIES)[keyof typeof DELIVERY_SEVERITIES];

/* ── Classification ──────────────────────────────────────────────── */

/**
 * Duplicates: acknowledging them is the correct behavior — re-running
 * the effect would be the bug, not the fix.
 */
const ACK_CODES: ReadonlySet<string> = new Set([
  "REPLAYED_EVENT",
  "ALREADY_HANDLED",
  "DUPLICATE_REFUND",
]);

/**
 * Retryable: the only code whose failure is time-dependent. The
 * handler does NOT mark the event id handled when a refund guard
 * fails (see webhook-handler's charge.refunded dispatch), so a retry
 * can still land once the capture arrives out of order. Every other
 * guard failure is permanent for that delivery: OVER_REFUND and
 * CURRENCY_MISMATCH reflect wrong money, not missing money — they
 * need a human, not a retry loop. BAD_AMOUNT / BAD_ENTRY are
 * malformed fixtures: retrying can't un-malform them.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "REFUND_BEFORE_CAPTURE",
]);

/**
 * Known fatal codes — documented for the audit trail, but the switch
 * below defaults unknown codes to fatal too, so this set staying
 * exhaustive is a nicety, not a load-bearing invariant.
 */
const FATAL_CODES: ReadonlySet<string> = new Set([
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
  "UNKNOWN_PRODUCT",
  "INVALID_AMOUNT",
]);

/**
 * Classify a delivery failure code by its retry semantics.
 *
 * Fail closed: a missing, non-string, or UNKNOWN code is FATAL — a
 * route must never retry what the library can't name. The signature
 * accepts `unknown` so route catch-blocks can pass `e.code` raw.
 */
export function classifyDeliveryCode(code: unknown): DeliverySeverity {
  if (typeof code !== "string" || code.length === 0) {
    return DELIVERY_SEVERITIES.FATAL;
  }
  if (ACK_CODES.has(code)) return DELIVERY_SEVERITIES.ACK;
  if (RETRYABLE_CODES.has(code)) return DELIVERY_SEVERITIES.RETRYABLE;
  // FATAL_CODES and anything else: never retry the unnameable.
  return DELIVERY_SEVERITIES.FATAL;
}

/* ── Bounded backoff policy ──────────────────────────────────────── */

/**
 * Bounded retry policy. `maxAttempts` INCLUDES the first attempt, so
 * the default (5) allows 4 retries. Delays are exponential from
 * `baseDelaySeconds` and capped at `maxDelaySeconds` — a retry storm
 * can't schedule an infinite tail, and the worst case is always
 * known up front (default: last retry at most 15 minutes out).
 */
export interface DeliveryPolicy {
  readonly maxAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
}

/** Policy bounds enforced at construction. */
export const DELIVERY_POLICY_BOUNDS = Object.freeze({
  MIN_ATTEMPTS: 1,
  MAX_ATTEMPTS: 10,
  MIN_BASE_DELAY_SECONDS: 1,
  MAX_BASE_DELAY_SECONDS: 3600,
  MIN_MAX_DELAY_SECONDS: 1,
  MAX_MAX_DELAY_SECONDS: 86400,
} as const);

export const DELIVERY_POLICY_DEFAULTS = Object.freeze({
  MAX_ATTEMPTS: 5,
  BASE_DELAY_SECONDS: 5,
  MAX_DELAY_SECONDS: 900,
} as const);

/**
 * Build a bounded delivery policy. Throws on out-of-range values —
 * a retry policy is exactly the kind of config that must fail loud,
 * never silently clamp into something nobody asked for.
 */
export function makeDeliveryPolicy(
  opts: Partial<DeliveryPolicy> = {}
): DeliveryPolicy {
  const b = DELIVERY_POLICY_BOUNDS;
  const maxAttempts = opts.maxAttempts ?? DELIVERY_POLICY_DEFAULTS.MAX_ATTEMPTS;
  const baseDelaySeconds =
    opts.baseDelaySeconds ?? DELIVERY_POLICY_DEFAULTS.BASE_DELAY_SECONDS;
  const maxDelaySeconds =
    opts.maxDelaySeconds ?? DELIVERY_POLICY_DEFAULTS.MAX_DELAY_SECONDS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < b.MIN_ATTEMPTS ||
    maxAttempts > b.MAX_ATTEMPTS
  ) {
    throw new Error(
      `webhook-delivery: maxAttempts must be an integer ${b.MIN_ATTEMPTS}–${b.MAX_ATTEMPTS}, got ${String(maxAttempts)}.`
    );
  }
  for (const [name, value, min, max] of [
    ["baseDelaySeconds", baseDelaySeconds, b.MIN_BASE_DELAY_SECONDS, b.MAX_BASE_DELAY_SECONDS],
    ["maxDelaySeconds", maxDelaySeconds, b.MIN_MAX_DELAY_SECONDS, b.MAX_MAX_DELAY_SECONDS],
  ] as const) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ) {
      throw new Error(
        `webhook-delivery: ${name} must be ${min}–${max}, got ${String(value)}.`
      );
    }
  }
  if (baseDelaySeconds > maxDelaySeconds) {
    throw new Error(
      `webhook-delivery: baseDelaySeconds (${baseDelaySeconds}) must not exceed maxDelaySeconds (${maxDelaySeconds}).`
    );
  }
  return { maxAttempts, baseDelaySeconds, maxDelaySeconds };
}

/**
 * Delay in seconds before attempt `attemptsUsed + 1`, or `null` when
 * the policy is exhausted. `attemptsUsed` counts the attempts already
 * made (≥1 after the first failure). Deterministic — same inputs,
 * same schedule — so staging forensics are reproducible.
 */
export function nextRetryDelay(
  attemptsUsed: number,
  policy: DeliveryPolicy = makeDeliveryPolicy()
): number | null {
  if (
    !Number.isInteger(attemptsUsed) ||
    attemptsUsed < 1 ||
    attemptsUsed >= policy.maxAttempts
  ) {
    return null;
  }
  const delay = policy.baseDelaySeconds * 2 ** (attemptsUsed - 1);
  return Math.min(delay, policy.maxDelaySeconds);
}

/**
 * Full retry schedule from a fresh failure: the delays a route would
 * wait before attempts 2..maxAttempts. Pure — handy for forensics
 * ("the divorce checkout will retry in 5s, 10s, 20s, 40s, then stop").
 */
export function retrySchedule(
  policy: DeliveryPolicy = makeDeliveryPolicy()
): readonly number[] {
  const out: number[] = [];
  for (let attemptsUsed = 1; attemptsUsed < policy.maxAttempts; attemptsUsed++) {
    out.push(nextRetryDelay(attemptsUsed, policy) as number);
  }
  return out;
}

/* ── Dead-letter queue ───────────────────────────────────────────── */

/**
 * What a failed delivery leaves behind. ids, event type, effect and
 * error codes ONLY — no raw bodies, no signatures, no secrets, no
 * PII, ever.
 */
export interface DeadLetterRecord {
  readonly eventId?: string;
  readonly eventType?: string;
  readonly code: string;
  readonly reason: "fatal" | "retries-exhausted";
  /** Attempts already made when this was recorded (≥1). */
  readonly attempts: number;
  /** Unix seconds when recorded (fixture-clock injectable for tests). */
  readonly atSeconds: number;
  readonly testMode: true;
}

/**
 * Bounded dead-letter queue. FIFO eviction of the oldest record once
 * full — the alternative (refusing new records) would silently lose
 * the NEWEST failure, which is the one an operator most needs to see.
 * `evictedCount` keeps the loss honest.
 */
export class DeadLetterQueue {
  private readonly records: DeadLetterRecord[] = [];
  private evicted = 0;
  private readonly nowSeconds: () => number;

  constructor(
    private readonly maxRecords: number = 1000,
    nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new Error(
        `webhook-delivery: maxRecords must be a positive integer, got ${String(maxRecords)}.`
      );
    }
    this.nowSeconds = nowSeconds;
  }

  get size(): number {
    return this.records.length;
  }

  /** Records dropped by FIFO eviction — visible, never silent. */
  get evictedCount(): number {
    return this.evicted;
  }

  /** Oldest first. The returned array is a copy. */
  entries(): readonly DeadLetterRecord[] {
    return [...this.records];
  }

  add(record: Omit<DeadLetterRecord, "atSeconds" | "testMode">): DeadLetterRecord {
    if (!record || typeof record.code !== "string" || record.code.length === 0) {
      throw new Error(
        "webhook-delivery: refusing a dead-letter record without an error code."
      );
    }
    const full: DeadLetterRecord = {
      ...record,
      atSeconds: this.nowSeconds(),
      testMode: true,
    };
    this.records.push(full);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
      this.evicted += 1;
    }
    return full;
  }

  /** Test-harness reset ONLY — a live route must never clear its dead letters. */
  clear(): void {
    this.records.length = 0;
    this.evicted = 0;
  }
}

/* ── The one call a route makes ──────────────────────────────────── */

/**
 * Event context the route threads in for forensics. Optional — a
 * dead-letter record without an event id is still better than a lost
 * failure.
 */
export interface DeliveryFailureContext {
  readonly eventId?: string;
  readonly eventType?: string;
}

/**
 * A duplicate, acknowledged. No retry, no dead letter — re-running
 * the effect would be the bug, not the fix.
 */
export interface AckOutcome {
  readonly disposition: "ack";
}

/**
 * Try again after `retryInSeconds`. The route's scheduler owns the
 * clock; this module only names the delay.
 */
export interface RetryOutcome {
  readonly disposition: "retry";
  readonly retryInSeconds: number;
  readonly attempt: number;
}

/**
 * Done trying. Hand `record` to a `DeadLetterQueue` (or your own
 * journaling) and page the humans — this one needs eyes, not loops.
 */
export interface DeadLetterOutcome {
  readonly disposition: "dead-letter";
  readonly record: Omit<DeadLetterRecord, "atSeconds" | "testMode">;
}

export type DeliveryOutcome = AckOutcome | RetryOutcome | DeadLetterOutcome;

/**
 * The one call a staging route's catch block needs. Pure function of
 * (error code, attempts already made, policy) — the route supplies
 * `e.code` and its attempt counter, the module decides.
 *
 *   const outcome = resolveDeliveryFailure(e, attemptsUsed, { eventId, eventType });
 *
 * `attemptsUsed` counts failures so far (1 = first failure, just
 * failed its first attempt). Unknown / missing codes fail closed to
 * a fatal dead letter: never retry what you can't name.
 */
export function resolveDeliveryFailure(
  err: unknown,
  attemptsUsed: number,
  ctx: DeliveryFailureContext = {},
  policy: DeliveryPolicy = makeDeliveryPolicy()
): DeliveryOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  const severity = classifyDeliveryCode(code);
  const safeAttempts =
    Number.isInteger(attemptsUsed) && attemptsUsed >= 1 ? attemptsUsed : 1;
  const eventId =
    typeof ctx.eventId === "string" && ctx.eventId.length > 0
      ? ctx.eventId
      : undefined;
  const eventType =
    typeof ctx.eventType === "string" && ctx.eventType.length > 0
      ? ctx.eventType
      : undefined;

  if (severity === DELIVERY_SEVERITIES.ACK) {
    return { disposition: DELIVERY_DISPOSITIONS.ACK };
  }
  if (severity === DELIVERY_SEVERITIES.RETRYABLE) {
    const retryInSeconds = nextRetryDelay(safeAttempts, policy);
    if (retryInSeconds !== null) {
      return {
        disposition: DELIVERY_DISPOSITIONS.RETRY,
        retryInSeconds,
        attempt: safeAttempts + 1,
      };
    }
    return {
      disposition: DELIVERY_DISPOSITIONS.DEAD_LETTER,
      record: {
        eventId,
        eventType,
        code: String(code),
        reason: "retries-exhausted",
        attempts: safeAttempts,
      },
    };
  }
  // Fatal (or unknown): straight to dead letter, no retry ever.
  return {
    disposition: DELIVERY_DISPOSITIONS.DEAD_LETTER,
    record: {
      eventId,
      eventType,
      code: typeof code === "string" && code.length > 0 ? code : "UNKNOWN_CODE",
      reason: "fatal",
      attempts: safeAttempts,
    },
  };
}

/* ── Record-field allowlist (the no-leak contract) ───────────────── */

/**
 * The ONLY keys a DeadLetterRecord may carry. Tests assert this
 * allowlist against the record shape — ids, types, effects, and
 * codes; never payloads, signatures, secrets, or PII.
 */
export const DEAD_LETTER_RECORD_FIELDS: ReadonlySet<string> = new Set([
  "eventId",
  "eventType",
  "code",
  "reason",
  "attempts",
  "atSeconds",
  "testMode",
]);
