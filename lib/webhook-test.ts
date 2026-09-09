/**
 * webhook-test.ts — TEST-MODE-ONLY webhook fixtures for YEAHDOGS checkout.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The seam piece divorce's checkout modal needs next. In a real hosted-
 * checkout flow the modal doesn't settle the money in-process: the
 * customer pays, the processor fires a signed webhook (e.g.
 * `checkout.session.completed` / `payment_intent.succeeded`), and the
 * server verifies the signature BEFORE unlocking the deliverable (the
 * printable divorce packet). This module simulates exactly that async
 * half of the flow, with zero deps and zero network:
 *
 *   session → confirm (test card) → signed webhook event → verify →
 *   unlock packet (receipt stays the receipt-shape contract)
 *
 *   const { rawBody, signature } = deliverTestWebhookEvent(
 *     "checkout.session.completed", receipt);
 *   const event = parseTestWebhookEvent(rawBody, signature);
 *   if (!isValidTestReceipt(event.data.object)) throw new Error("nope");
 *
 * Guarantees by construction:
 *   - TEST_WEBHOOK_SECRET is a hard-coded DUMMY string. It is NOT a real
 *     processor secret and can never be confused with one: it starts
 *     with "whsec_test_fixture_" and a regression test rejects any
 *     secret that looks like live material. Do NOT swap in a real
 *     secret — live webhooks belong to the server-side rail Brandon
 *     reviews, which ships its own verifier for THIS EVENT SHAPE.
 *   - Signatures are HMAC-SHA256 over the exact raw body, compared in
 *     constant time (timingSafeEqual). Tampered payloads, wrong
 *     secrets, expired timestamps, and replayed event ids all throw.
 *   - Event ids are DETERMINISTIC: the same (type, object id) always
 *     produces the same `evt_test_*` id, so tests and staging fixtures
 *     are reproducible. No randomness, no Date.now in the id.
 *   - Zero dependencies. Zero network. Nothing leaves this process.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  BOUNDED_LEDGER_DEFAULTS,
  BoundedIdempotencyLedger,
} from "./idempotency-ledger";
import type {
  CheckoutSession,
  Receipt,
  Subscription,
} from "./checkout-test";

/* ── Hoisted constants ───────────────────────────────────────────── */

/**
 * DUMMY signing key for test webhooks. Fixture-only — see module header.
 * A test asserts this prefix stays test-only; live secrets can never
 * be plugged in here by construction (verify rejects real-looking
 * prefixes outright).
 */
export const TEST_WEBHOOK_SECRET =
  "whsec_test_fixture_yeahdogs_0001_DO_NOT_USE_FOR_REAL_MONEY" as const;

/** Header-style signature scheme, Stripe-compatible format. */
export const TEST_SIGNATURE_SCHEME = "v1" as const;

/** How old a webhook event may be (seconds) before parse rejects it. */
export const WEBHOOK_TOLERANCE_SECONDS = 300 as const;

export const WEBHOOK_ERROR_CODES = Object.freeze({
  BAD_SIGNATURE: "BAD_SIGNATURE",
  EXPIRED_EVENT: "EXPIRED_EVENT",
  REPLAYED_EVENT: "REPLAYED_EVENT",
  BAD_EVENT: "BAD_EVENT",
});

export type WebhookEventType =
  | "checkout.session.completed"
  | "payment_intent.succeeded"
  | "charge.refunded"
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.canceled";

import type { TestRefund } from "./refund-ledger";

export interface TestWebhookEvent {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly testMode: true;
  /** Unix seconds. */
  readonly created: number;
  readonly data: {
    readonly object: Receipt | Subscription | CheckoutSession | TestRefund;
  };
}

export interface DeliveredTestWebhook {
  readonly event: TestWebhookEvent;
  /** Canonical JSON string that was signed. */
  readonly rawBody: string;
  /** `t=<ts>,v1=<hex>` */
  readonly signature: string;
}

/* ── Guard rails ─────────────────────────────────────────────────── */

function err(code: string, message: string): Error {
  const e = new Error(`webhook-test: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * Refuse to verify (or sign) with anything that looks like a real
 * processor webhook secret. Test fixtures stay fixture-keyed, forever.
 */
export function assertFixtureSecret(secret: string): void {
  if (typeof secret !== "string" || !secret.startsWith("whsec_test_fixture_")) {
    throw err(
      WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      "refusing to use a non-fixture webhook secret — test webhooks may " +
        "only be signed with a whsec_test_fixture_* dummy key. Live " +
        "webhook secrets belong to the server-side rail."
    );
  }
}

/**
 * Parse-level replay ledger: event ids the parser has already accepted.
 * Bounded (LRU + TTL) — the raw Set it replaced was an unbounded
 * memory leak on a long-lived server. An id evicted here is NOT a
 * security hole: a replay that slips past this gate still fails
 * freshness verification (EXPIRED_EVENT) or hits the handler's
 * exactly-once ledger (ALREADY_HANDLED / PAYLOAD_CONFLICT).
 */
const seenEventIds = new BoundedIdempotencyLedger({
  maxEntries: BOUNDED_LEDGER_DEFAULTS.MAX_ENTRIES,
  ttlSeconds: 3600, // 1h — far past the 300s freshness window
});

/**
 * Deterministic event id: `evt_test_` + 24 hex chars derived from the
 * fixture secret, event type, and the payload object's id. Same inputs →
 * same id, so staging fixtures and tests are reproducible.
 */
export function testEventId(
  type: WebhookEventType,
  objectId: string
): string {
  const digest = createHmac("sha256", TEST_WEBHOOK_SECRET)
    .update(`${type}:${objectId}`)
    .digest("hex")
    .slice(0, 24);
  return `evt_test_${digest}`;
}

/**
 * Build a signed webhook event for a fixture object. Deterministic:
 * the same (type, object) always yields the same event id and body.
 *
 * @param created Unix seconds; defaults to now. Pass an explicit value
 *                in tests to simulate fresh/expired events.
 */
export function deliverTestWebhookEvent(
  type: WebhookEventType,
  object: Receipt | Subscription | CheckoutSession | TestRefund,
  opts: { created?: number; secret?: string } = {}
): DeliveredTestWebhook {
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  assertFixtureSecret(secret);
  const created =
    opts.created ?? Math.floor(Date.now() / 1000);
  const event: TestWebhookEvent = {
    id: testEventId(type, object.id),
    type,
    testMode: true,
    created,
    data: { object },
  };
  const rawBody = JSON.stringify(event);
  const signature = signTestWebhookPayload(rawBody, secret, created);
  return { event, rawBody, signature };
}

/**
 * Sign a raw webhook body: `t=<created>,v1=<hmac>`.
 * @throws BAD_SIGNATURE if the secret is not a fixture key.
 */
export function signTestWebhookPayload(
  rawBody: string,
  secret: string = TEST_WEBHOOK_SECRET,
  created?: number
): string {
  assertFixtureSecret(secret);
  const ts = created ?? Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return `t=${ts},${TEST_SIGNATURE_SCHEME}=${mac}`;
}

/**
 * Verify a webhook signature in constant time.
 * Returns false (never throws) for malformed/absent signatures.
 */
export function verifyTestWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string = TEST_WEBHOOK_SECRET
): boolean {
  try {
    assertFixtureSecret(secret);
  } catch {
    return false;
  }
  if (typeof signature !== "string") return false;
  const m = signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const expected = signTestWebhookPayload(rawBody, secret, Number(m[1]));
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── Parser: the modal's "unlock the packet" gate ─────────────────── */

/**
 * Verify a delivered webhook and return the event. This is the function
 * divorce's modal calls before rendering the printable packet:
 *
 *   const event = parseTestWebhookEvent(rawBody, signature);
 *   if (!isValidTestReceipt(event.data.object)) throw … // never unlock
 *
 * Rejects: bad/forged signatures, stale events (>300s old or from the
 * future beyond tolerance), replayed event ids, and anything that isn't
 * an unmistakable test-mode fixture event.
 *
 * @throws BAD_SIGNATURE | EXPIRED_EVENT | REPLAYED_EVENT | BAD_EVENT
 */
export function parseTestWebhookEvent(
  rawBody: string,
  signature: string,
  opts: {
    secret?: string;
    nowSeconds?: number;
    toleranceSeconds?: number;
  } = {}
): TestWebhookEvent {
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  if (!verifyTestWebhookSignature(rawBody, signature, secret)) {
    throw err(
      WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      "webhook signature verification failed — refusing to trust this event."
    );
  }
  let event: TestWebhookEvent;
  try {
    event = JSON.parse(rawBody) as TestWebhookEvent;
  } catch {
    throw err(WEBHOOK_ERROR_CODES.BAD_EVENT, "webhook body is not valid JSON.");
  }
  if (
    !event ||
    typeof event !== "object" ||
    event.testMode !== true ||
    typeof event.id !== "string" ||
    !event.id.startsWith("evt_test_") ||
    typeof event.created !== "number"
  ) {
    throw err(
      WEBHOOK_ERROR_CODES.BAD_EVENT,
      "webhook event is not a test-mode fixture (missing evt_test_* id / testMode flag)."
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - event.created) > tolerance) {
    throw err(
      WEBHOOK_ERROR_CODES.EXPIRED_EVENT,
      `webhook event is outside the ${tolerance}s tolerance window — possible replay of a stale event.`
    );
  }
  if (seenEventIds.has(event.id)) {
    throw err(
      WEBHOOK_ERROR_CODES.REPLAYED_EVENT,
      `webhook event ${event.id} was already processed — refusing replay.`
    );
  }
  seenEventIds.add(event.id);
  return event;
}

/**
 * Reset the replay ledger. For tests only — lets fixtures be
 * redelivered between test cases.
 */
export function resetWebhookFixtures(): void {
  seenEventIds.clear();
}

/**
 * Content-fingerprint helper for the security sweep: sha256 of any
 * string (used by tests to pin fixture shapes, not for auth).
 */
export function fixtureSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
