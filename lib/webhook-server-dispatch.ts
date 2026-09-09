/**
 * webhook-server-dispatch.ts — SERVER-SIDE webhook event dispatch.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  SERVER USE ONLY. This module runs after `webhook-server.ts` has
 *  verified the delivery's signature; it dispatches verified events
 *  to effects, exactly once per event id. It never moves, mints, or
 *  claims money, and it performs NO network IO.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The live counterpart to the test-mode `webhook-handler.ts` skeleton.
 * Route shape (divorce's `/api/webhooks/checkout` once approved):
 *
 *   import { handleServerWebhookDelivery } from "pay/lib/webhook-server-dispatch";
 *
 *   const rawBody = await request.text();              // EXACT raw bytes, un-parsed
 *   const effect = handleServerWebhookDelivery(        // verify → parse → dispatch
 *     rawBody,
 *     request.headers.get("stripe-signature"),
 *     process.env.STRIPE_WEBHOOK_SECRET,
 *     {
 *       // Fail closed on amount tamper: the server's own catalog price,
 *       // never anything the webhook claimed.
 *       expectedAmountTotal: 3000,                    // 3000¢ — the $30 packet
 *       expectedCurrency: "usd",
 *     }
 *   );
 *   if (effect.effect === "record_payment") {
 *     // fulfill: write effect.payment to divorce's order ledger,
 *     // then gate the printable packet on it.
 *   }
 *
 * Guarantees by construction:
 *   - Verify-before-dispatch: `handleServerWebhookDelivery` calls
 *     `verifyServerWebhookSignature` FIRST. Bad signatures, stale
 *     events, and future events throw before anything is parsed.
 *     A missing webhook secret throws MISSING_SECRET — the module
 *     refuses to start work without it (fail closed).
 *   - Parse AFTER verify: the raw body is only JSON.parsed once the
 *     signature is good, so attacker-controlled bytes can't shape an
 *     event. Non-JSON, non-object, or id/type-less events throw
 *     BAD_EVENT.
 *   - Amount expectation: when the route supplies its own
 *     `expectedAmountTotal`/`expectedCurrency`, a verified event whose
 *     amount or currency differs throws AMOUNT_MISMATCH instead of
 *     producing a record_payment — the packet never unlocks on a
 *     tampered or mis-priced event.
 *   - Event idempotency with TTL: each verified event id produces
 *     exactly one effect per retention window (7 days). A retried
 *     delivery (Stripe retries on any non-2xx) throws ALREADY_HANDLED
 *     instead of double-recording; `handleServerWebhookDeliveryOnce`
 *     answers with a clear `{ status: "already_processed" }` response
 *     instead of throwing. A duplicate whose body DIFFERS from the
 *     handled delivery throws EVENT_BODY_CONFLICT — a retry must be
 *     byte-identical. The ledger marks an id only AFTER its handler
 *     succeeds, and lazily prunes ids older than the retention window
 *     so it stays bounded.
 *   - Replay protection: stale events (older than the 300s tolerance)
 *     throw EXPIRED_EVENT at verification, before any ledger lookup
 *     or handler runs — an ancient replay can never double-record or
 *     even reach dispatch.
 *   - `checkout.session.completed` → `record_payment`: the handler
 *     validates the session object shape (string id, numeric
 *     amount_total, currency, payment_status) and emits a PURE
 *     `PaymentRecord` — plain data the route fulfills against its own
 *     storage. This module never writes the ledger itself.
 *   - Unknown event types throw UNKNOWN_EVENT_TYPE. New processor
 *     events are added by extending the dispatch switch — nothing else.
 *   - `assertServerPaymentSettled` is the fulfill-time guard every
 *     route must call before unlocking anything: a verified
 *     record_payment whose payment_status isn't "paid" (or whose
 *     paid flag disagrees) throws PAYMENT_NOT_SETTLED instead of
 *     unlocking. Dispatch records for the audit trail; settlement
 *     gates the deliverable.
 *   - Zero dependencies beyond node:crypto (via webhook-server).
 *     Zero network. Nothing leaves this process.
 */

import {
  SERVER_WEBHOOK_ERROR_CODES,
  type VerifyWebhookOptions,
  verifyServerWebhookSignature,
} from "./webhook-server";
import { createHash } from "node:crypto";

/* ── Hoisted constants ───────────────────────────────────────────── */

export const SERVER_DISPATCH_ERROR_CODES = Object.freeze({
  ...SERVER_WEBHOOK_ERROR_CODES,
  /** Body verified but not parseable / not an event shape. */
  BAD_EVENT: "BAD_EVENT",
  /** Event type has no handler. */
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  /** Session object failed shape validation. */
  INVALID_OBJECT: "INVALID_OBJECT",
  /** Event id already dispatched. */
  ALREADY_HANDLED: "ALREADY_HANDLED",
  /** Same event id delivered again with a DIFFERENT body — not a
   *  retry, something is wrong; fail closed instead of deduping. */
  EVENT_BODY_CONFLICT: "EVENT_BODY_CONFLICT",
  /** Verified event amount/currency didn't match the server's expectation. */
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  /**
   * A verified payment record that is NOT settled: payment_status is
   * not "paid", or the paid flag disagrees with it. Thrown by
   * `assertServerPaymentSettled` — the route must never unlock a
   * deliverable on an unsettled payment.
   */
  PAYMENT_NOT_SETTLED: "PAYMENT_NOT_SETTLED",
});

/* ── Types ───────────────────────────────────────────────────────── */

/**
 * The minimal event shape this dispatcher accepts: id + type at the
 * top level and the processor's object under data.object. Extra fields
 * are tolerated — Stripe events carry far more than we consume.
 */
export interface ServerWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: unknown };
}

/**
 * Dispatch options: verification options from webhook-server plus the
 * server's own amount expectations. The expectations come from the
 * route's catalog (e.g. divorce's 3000¢ uncontested_packet price),
 * never from the webhook payload — they close the hole where a
 * verified event carries an unexpected amount.
 */
export interface ServerWebhookDispatchOptions extends VerifyWebhookOptions {
  /**
   * Integer minor units the server charged (e.g. 3000 for the $30
   * packet). When supplied, a verified event whose amount_total
   * differs throws AMOUNT_MISMATCH.
   */
  expectedAmountTotal?: number;
  /**
   * Expected currency code, case-insensitive (e.g. "usd"). When
   * supplied, a verified event whose currency differs throws
   * AMOUNT_MISMATCH.
   */
  expectedCurrency?: string;
}

/**
 * Pure record of a verified payment, for the route to persist.
 * `recordedAt` is the route call's Unix-seconds timestamp.
 */
export interface PaymentRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly amountTotal: number;
  readonly currency: string;
  readonly paymentStatus: string;
  readonly paid: boolean;
  readonly recordedAt: number;
}

/**
 * The outcomes the dispatcher can produce. `payment` is always the
 * validated record the event earned; `liveMode: true` marks this as
 * the live lane (the test-mode skeleton uses `testMode: true`).
 */
export interface ServerWebhookEffect {
  readonly effect: "record_payment";
  readonly eventId: string;
  readonly eventType: string;
  readonly payment: PaymentRecord;
  readonly liveMode: true;
}

function dispatchErr(code: string, message: string): Error {
  const e = new Error(`webhook-server-dispatch: ${message}`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

/* ── Parse AFTER verify ──────────────────────────────────────────── */

/**
 * Verify the delivery signature, then parse the raw body into the
 * minimal event shape. Throws BAD_EVENT for anything that verified
 * but isn't a usable event.
 *
 * @throws MISSING_SECRET | FIXTURE_SECRET | BAD_HEADER |
 *         BAD_SIGNATURE | EXPIRED_EVENT | FUTURE_EVENT | BAD_EVENT
 */
export function parseServerWebhookEvent(
  rawBody: string,
  header: unknown,
  secret: unknown,
  opts: VerifyWebhookOptions = {}
): ServerWebhookEvent {
  // Verification first — only a trusted body may be parsed.
  verifyServerWebhookSignature(rawBody, header, secret, opts);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.BAD_EVENT,
      "verified webhook body is not valid JSON."
    );
  }
  const ev = parsed as Partial<ServerWebhookEvent> | null;
  if (
    !ev ||
    typeof ev !== "object" ||
    typeof ev.id !== "string" ||
    ev.id.length === 0 ||
    typeof ev.type !== "string" ||
    ev.type.length === 0
  ) {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.BAD_EVENT,
      "verified webhook body is not an event: missing string id/type."
    );
  }
  const data = ev.data as { object?: unknown } | undefined;
  return { id: ev.id, type: ev.type, data: { object: data?.object } };
}

/* ── Session object validation ───────────────────────────────────── */

interface CheckoutSessionObject {
  id: string;
  amount_total: number;
  currency: string;
  payment_status: string;
}

function isCheckoutSessionObject(
  obj: unknown
): obj is CheckoutSessionObject {
  const s = obj as Partial<CheckoutSessionObject> | null;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    s.id.length > 0 &&
    typeof s.amount_total === "number" &&
    typeof s.currency === "string" &&
    s.currency.length > 0 &&
    typeof s.payment_status === "string" &&
    s.payment_status.length > 0
  );
}

/* ── Server-side amount expectation ────────────────────────────────── */

/**
 * Compare the verified session object against the server's own
 * catalog expectations. Both must match exactly: an amount difference
 * (under OR over) or a currency swap throws AMOUNT_MISMATCH.
 *
 * The expectation is validated first — a malformed expectation can't
 * verify anything, so it throws too (fail closed).
 *
 * @throws AMOUNT_MISMATCH
 */
export function assertServerWebhookAmountMatches(
  obj: CheckoutSessionObject,
  opts: ServerWebhookDispatchOptions
): void {
  const { expectedAmountTotal, expectedCurrency } = opts;
  if (expectedAmountTotal === undefined && expectedCurrency === undefined) {
    return; // route didn't opt in — shape validation already ran
  }
  if (
    expectedAmountTotal !== undefined &&
    (!Number.isInteger(expectedAmountTotal) || expectedAmountTotal <= 0)
  ) {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH,
      "malformed server amount expectation — refusing to verify " +
        "against a bad expectation."
    );
  }
  if (
    expectedAmountTotal !== undefined &&
    obj.amount_total !== expectedAmountTotal
  ) {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH,
      `verified webhook reported amount_total ${obj.amount_total} but the ` +
        `server expected ${expectedAmountTotal} — refusing to record.`
    );
  }
  if (
    expectedCurrency !== undefined &&
    typeof expectedCurrency === "string" &&
    expectedCurrency.length > 0 &&
    obj.currency.toLowerCase() !== expectedCurrency.toLowerCase()
  ) {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH,
      `verified webhook reported currency "${obj.currency}" but the ` +
        `server expected "${expectedCurrency}" — refusing to record.`
    );
  }
}

/* ── Event-id idempotency ledger with TTL ──────────────────────── */

/**
 * How long a processed event id stays in the ledger, seconds.
 * Past this window the id is forgotten — a delivery that old would
 * fail the signature-freshness check anyway, so the window is
 * defense in depth against both unbounded memory growth and
 * ancient-id collisions.
 */
export const SERVER_DISPATCH_ID_RETENTION_SECONDS = 604800 as const; // 7 days

/** Event id → when its effect was produced + the delivery's body hash. */
interface HandledEventEntry {
  readonly processedAt: number;
  readonly bodyHash: string;
}

const handledEvents = new Map<string, HandledEventEntry>();

/** SHA-256 hex of a raw delivery body — identifies the exact payload. */
function bodyHashOf(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Lazily drop processed ids older than the retention window, keeping
 * the ledger bounded. Runs at dispatch time, before the lookup.
 */
function pruneHandledEvents(now: number): void {
  const cutoff = now - SERVER_DISPATCH_ID_RETENTION_SECONDS;
  for (const [id, entry] of handledEvents) {
    if (entry.processedAt <= cutoff) handledEvents.delete(id);
  }
}

/* ── Dispatch ────────────────────────────────────────────────────── */

/**
 * Dispatch a VERIFIED server webhook event to its effect.
 *
 * NOTE: pass only events returned by `parseServerWebhookEvent` (or
 * use `handleServerWebhookDelivery` / `handleServerWebhookDeliveryOnce`,
 * which do verify + parse + dispatch in one call). Handling an
 * unverified event is a server-side violation — the caller must have
 * verified first.
 *
 * When dispatching through the delivery wrappers, pass `bodyHash` (the
 * SHA-256 of the raw delivery body): a redelivery of the same event id
 * with a DIFFERENT body then throws EVENT_BODY_CONFLICT instead of
 * being quietly deduplicated — a retry must be byte-identical.
 *
 * @throws AMOUNT_MISMATCH | ALREADY_HANDLED | EVENT_BODY_CONFLICT |
 *         UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function handleServerWebhookEvent(
  event: ServerWebhookEvent,
  opts: ServerWebhookDispatchOptions = {},
  bodyHash?: string
): ServerWebhookEffect {
  if (!event || typeof event !== "object" || typeof event.id !== "string") {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.BAD_EVENT,
      "refusing to dispatch an unverified event — parse it via parseServerWebhookEvent first."
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // TTL prune before the lookup: an id forgotten this call behaves
  // as never-seen, matching the retention-window guarantee.
  pruneHandledEvents(now);
  // Idempotency check before any handler runs: a retried delivery
  // must never double-apply. Same id + different body is NOT a
  // retry — it fails closed.
  const prior = handledEvents.get(event.id);
  if (prior !== undefined) {
    if (
      bodyHash !== undefined &&
      bodyHash.length > 0 &&
      prior.bodyHash !== bodyHash
    ) {
      throw dispatchErr(
        SERVER_DISPATCH_ERROR_CODES.EVENT_BODY_CONFLICT,
        `event ${event.id} was already handled with a different body — ` +
          "refusing to treat this as a retry."
      );
    }
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.ALREADY_HANDLED,
      `event ${event.id} already produced an effect — refusing redispatch.`
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data.object;
      if (!isCheckoutSessionObject(obj)) {
        throw dispatchErr(
          SERVER_DISPATCH_ERROR_CODES.INVALID_OBJECT,
          "checkout.session.completed carried no valid session object — " +
            "never recording a payment off a malformed payload."
        );
      }
      // Amount/currency expectation: checked BEFORE the ledger marks,
      // so a mismatch never records and the event stays retryable.
      assertServerWebhookAmountMatches(obj, opts);
      const effect: ServerWebhookEffect = {
        effect: "record_payment",
        eventId: event.id,
        eventType: event.type,
        payment: {
          eventId: event.id,
          sessionId: obj.id,
          amountTotal: obj.amount_total,
          currency: obj.currency,
          paymentStatus: obj.payment_status,
          paid: obj.payment_status === "paid",
          recordedAt: now,
        },
        liveMode: true,
      };
      // Ledger marks only after the effect was built successfully.
      handledEvents.set(event.id, { processedAt: now, bodyHash: bodyHash ?? "" });
      return effect;
    }
    default: {
      throw dispatchErr(
        SERVER_DISPATCH_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `no handler for event type "${event.type}" — extend the ` +
          "dispatch switch in handleServerWebhookEvent to support it."
      );
    }
  }
}

/**
 * Verify, parse, then dispatch: the one call a server webhook route
 * needs. Fail closed: a missing/empty/fixture webhook secret throws
 * before anything is trusted.
 *
 *   const effect = handleServerWebhookDelivery(
 *     rawBody,
 *     request.headers.get("stripe-signature"),
 *     process.env.STRIPE_WEBHOOK_SECRET
 *   );
 *
 * @throws MISSING_SECRET | FIXTURE_SECRET | BAD_HEADER |
 *         BAD_SIGNATURE | EXPIRED_EVENT | FUTURE_EVENT |
 *         BAD_EVENT | AMOUNT_MISMATCH | ALREADY_HANDLED |
 *         EVENT_BODY_CONFLICT | UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function handleServerWebhookDelivery(
  rawBody: string,
  header: unknown,
  secret: unknown,
  opts: ServerWebhookDispatchOptions = {}
): ServerWebhookEffect {
  const event = parseServerWebhookEvent(rawBody, header, secret, opts);
  return handleServerWebhookEvent(event, opts, bodyHashOf(rawBody));
}

/**
 * Fail-closed settlement gate: call this on a record_payment effect's
 * payment BEFORE unlocking anything (the printable packet, wax
 * access, …). Dispatch records a payment for the audit trail even when
 * the processor reports it unpaid — settlement is what gates the
 * deliverable, and that's this function's job.
 *
 * Throws PAYMENT_NOT_SETTLED when:
 *   - the input isn't a payment-shaped object at all,
 *   - `paid` is not exactly `true`, or
 *   - `paymentStatus` is not exactly `"paid"` (the two must agree —
 *     a contradictory record is untrustworthy, fail closed).
 */
export function assertServerPaymentSettled(
  payment: unknown
): asserts payment is PaymentRecord {
  const p = payment as Partial<PaymentRecord> | null;
  const settled =
    !!p &&
    typeof p === "object" &&
    p.paid === true &&
    p.paymentStatus === "paid";
  if (!settled) {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.PAYMENT_NOT_SETTLED,
      "payment is not settled (paymentStatus must be \"paid\" and " +
        "the paid flag must agree) — refusing to unlock the deliverable."
    );
  }
}

/**
 * Reset the dispatch ledger. For tests only.
 */
export function resetServerWebhookDispatch(): void {
  handledEvents.clear();
}

/* ── Idempotent delivery: a clear answer instead of a throw ─────── */

/**
 * The idempotent answer a server route wants for its 2xx decision:
 * first delivery → `processed` with the effect to fulfill;
 * redelivery of the same event id → `already_processed` naming the
 * exact event, with NO second payment recorded.
 */
export type ServerWebhookDeliveryResult =
  | { readonly status: "processed"; readonly effect: ServerWebhookEffect }
  | { readonly status: "already_processed"; readonly eventId: string };

function isAlreadyHandled(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as Error & { code?: string }).code ===
      SERVER_DISPATCH_ERROR_CODES.ALREADY_HANDLED
  );
}

/**
 * Verify, parse, then dispatch — returning a clear idempotent result
 * instead of throwing on duplicate delivery.
 *
 *   const result = handleServerWebhookDeliveryOnce(rawBody, header, secret);
 *   if (result.status === "processed") {
 *     // fulfill result.effect.payment exactly once
 *   }
 *   return ok(); // 2xx either way — the duplicate is already recorded
 *
 * A duplicate still has to pass verification (signature + freshness)
 * before the ledger is consulted, so `already_processed` is never
 * returned for a forged or stale replay: those keep throwing
 * (BAD_SIGNATURE / EXPIRED_EVENT) exactly as before. A duplicate whose
 * body DIFFERS from the handled delivery throws EVENT_BODY_CONFLICT —
 * a retry must be byte-identical. Unknown types, malformed objects,
 * and amount mismatches also still throw — only ALREADY_HANDLED
 * converts to the `already_processed` answer.
 *
 * @throws MISSING_SECRET | FIXTURE_SECRET | BAD_HEADER |
 *         BAD_SIGNATURE | EXPIRED_EVENT | FUTURE_EVENT |
 *         BAD_EVENT | AMOUNT_MISMATCH | EVENT_BODY_CONFLICT |
 *         UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function handleServerWebhookDeliveryOnce(
  rawBody: string,
  header: unknown,
  secret: unknown,
  opts: ServerWebhookDispatchOptions = {}
): ServerWebhookDeliveryResult {
  // Verify + parse first: the duplicate answer is only meaningful for
  // an event we can actually identify (id/type at top level).
  const event = parseServerWebhookEvent(rawBody, header, secret, opts);
  try {
    return {
      status: "processed",
      effect: handleServerWebhookEvent(event, opts, bodyHashOf(rawBody)),
    };
  } catch (e) {
    if (isAlreadyHandled(e)) {
      return { status: "already_processed", eventId: event.id };
    }
    throw e;
  }
}

export { SERVER_WEBHOOK_ERROR_CODES };
