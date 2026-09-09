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
 *   - Event idempotency: each verified event id produces exactly one
 *     effect. A retried delivery (Stripe retries on any non-2xx)
 *     throws ALREADY_HANDLED instead of double-recording. The ledger
 *     marks an id only AFTER its handler succeeds.
 *   - `checkout.session.completed` → `record_payment`: the handler
 *     validates the session object shape (string id, numeric
 *     amount_total, currency, payment_status) and emits a PURE
 *     `PaymentRecord` — plain data the route fulfills against its own
 *     storage. This module never writes the ledger itself.
 *   - Unknown event types throw UNKNOWN_EVENT_TYPE. New processor
 *     events are added by extending the dispatch switch — nothing else.
 *   - Zero dependencies beyond node:crypto (via webhook-server).
 *     Zero network. Nothing leaves this process.
 */

import {
  SERVER_WEBHOOK_ERROR_CODES,
  type VerifyWebhookOptions,
  verifyServerWebhookSignature,
} from "./webhook-server";

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
  /** Verified event amount/currency didn't match the server's expectation. */
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
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

/* ── Event-id idempotency ledger ─────────────────────────────────── */

/**
 * Event ids already dispatched to an effect. Marking happens only
 * after a handler succeeds, so a handler crash leaves the event
 * retryable. In-memory per process — the route owns durable storage.
 */
const handledEventIds = new Set<string>();

/* ── Dispatch ────────────────────────────────────────────────────── */

/**
 * Dispatch a VERIFIED server webhook event to its effect.
 *
 * NOTE: pass only events returned by `parseServerWebhookEvent` (or
 * use `handleServerWebhookDelivery`, which does verify + parse +
 * dispatch in one call). Handling an unverified event is a server-side
 * violation — the caller must have verified first.
 *
 * @throws AMOUNT_MISMATCH | ALREADY_HANDLED | UNKNOWN_EVENT_TYPE |
 *         INVALID_OBJECT
 */
export function handleServerWebhookEvent(
  event: ServerWebhookEvent,
  opts: ServerWebhookDispatchOptions = {}
): ServerWebhookEffect {
  if (!event || typeof event !== "object" || typeof event.id !== "string") {
    throw dispatchErr(
      SERVER_DISPATCH_ERROR_CODES.BAD_EVENT,
      "refusing to dispatch an unverified event — parse it via parseServerWebhookEvent first."
    );
  }
  // Idempotency check before any handler runs: a retried delivery
  // must never double-apply.
  if (handledEventIds.has(event.id)) {
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
      const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
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
      handledEventIds.add(event.id);
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
 *         UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function handleServerWebhookDelivery(
  rawBody: string,
  header: unknown,
  secret: unknown,
  opts: ServerWebhookDispatchOptions = {}
): ServerWebhookEffect {
  const event = parseServerWebhookEvent(rawBody, header, secret, opts);
  return handleServerWebhookEvent(event, opts);
}

/**
 * Reset the dispatch ledger. For tests only.
 */
export function resetServerWebhookDispatch(): void {
  handledEventIds.clear();
}

export { SERVER_WEBHOOK_ERROR_CODES };
