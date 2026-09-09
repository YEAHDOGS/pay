/**
 * webhook-handler.ts — TEST-MODE-ONLY webhook dispatch skeleton.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The second half of the async checkout loop. `webhook-test.ts` proves a
 * delivered event is authentic (signature + freshness + no replay);
 * THIS module answers the server's next question: "given a VERIFIED
 * event, what should the product do?" Both divorce and wax consume the
 * same skeleton:
 *
 *   divorce ($30 packet)        wax ($10/mo)
 *   ────────────────────        ────────────
 *   checkout.session.completed  customer.subscription.created
 *     → unlock_deliverable        → provision_subscription
 *   payment_intent.succeeded    customer.subscription.updated
 *     → record_payment            → sync_subscription
 *                               customer.subscription.canceled
 *                                 → grant_access_to_period_end
 *
 * Effects are PURE fixture records — plain data describing the
 * outcome, never IO. A live server consumes an effect by fulfilling
 * it (render the packet, provision alerts, revoke at period end);
 * this skeleton never touches the network, storage, or email.
 *
 *   const effect = handleTestWebhookDelivery(rawBody, signature);
 *   // effect.effect === "unlock_deliverable" → divorce renders the packet
 *
 * Guarantees by construction:
 *   - `handleTestWebhookDelivery` verifies BEFORE dispatching: it calls
 *     `parseTestWebhookEvent` first, so bad signatures, stale events,
 *     and replays throw before any handler runs.
 *   - Only test-mode fixture objects are accepted: a live-looking
 *     event (no `testMode: true`, non-`evt_test_*` ids handled in
 *     parse) or a payload that fails the receipt/subscription
 *     validators throws INVALID_OBJECT instead of producing an effect.
 *   - Handlers never unlock on a session fixture: a
 *     `checkout.session.completed` whose object is a CheckoutSession
 *     (payment not yet confirmed in-fixture) yields no unlock — only
 *     a validated receipt does.
 *   - Handler-level idempotency: each verified event id produces
 *     exactly one effect; redelivery throws ALREADY_HANDLED.
 *   - Unknown event types throw UNKNOWN_EVENT_TYPE. New processor
 *     events are added by extending `WebhookEventType` + the dispatch
 *     map — nothing else.
 *   - Zero dependencies. Zero network. Nothing leaves this process.
 */

import {
  ERROR_CODES,
  type Receipt,
  type Subscription,
  isValidTestReceipt,
  isValidTestSubscription,
} from "./checkout-test";
import {
  type TestWebhookEvent,
  parseTestWebhookEvent,
} from "./webhook-test";
import {
  MONTH_MILLIS,
  describePlan,
} from "./subscription-plans";

/* ── Hoisted constants ───────────────────────────────────────────── */

export const HANDLER_ERROR_CODES = Object.freeze({
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  INVALID_OBJECT: "INVALID_OBJECT",
  ALREADY_HANDLED: "ALREADY_HANDLED",
});

/**
 * The outcomes the skeleton can produce. `object` is always the
 * validated fixture that earned the effect; `accessUntil` only rides
 * on `grant_access_to_period_end`.
 */
export interface WebhookEffect {
  readonly effect:
    | "unlock_deliverable"
    | "record_payment"
    | "provision_subscription"
    | "sync_subscription"
    | "grant_access_to_period_end";
  readonly eventId: string;
  readonly eventType: string;
  readonly object: Receipt | Subscription;
  /** Cancel events only: access runs until this ISO timestamp. */
  readonly accessUntil?: string;
  readonly testMode: true;
}

function handlerErr(code: string, message: string): Error {
  const e = new Error(`webhook-handler: ${message}`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

/* ── Per-event validators ────────────────────────────────────────── */

/**
 * Subscription fixture shape check that tolerates non-active statuses.
 * A `customer.subscription.canceled` event arrives with a subscription
 * whose status may no longer be "active" — but it must still be an
 * unmistakable test fixture for a recurring catalog product.
 */
function isSubscriptionFixture(obj: unknown): obj is Subscription {
  const s = obj as Partial<Subscription> | null;
  if (!s || typeof s !== "object") return false;
  let product;
  try {
    product = (s.productId && describePlan(s.productId)) || null;
  } catch {
    return false;
  }
  return (
    s.testMode === true &&
    typeof s.id === "string" &&
    s.id.startsWith("sub_test_") &&
    !!product &&
    s.amountCents === product.amountCents &&
    typeof s.startedAt === "string"
  );
}

/* ── Effect builders ─────────────────────────────────────────────── */

function effect(
  event: TestWebhookEvent,
  effectName: WebhookEffect["effect"],
  object: Receipt | Subscription,
  accessUntil?: string
): WebhookEffect {
  return {
    effect: effectName,
    eventId: event.id,
    eventType: event.type,
    object,
    ...(accessUntil === undefined ? {} : { accessUntil }),
    testMode: true,
  };
}

/* ── Handler-level idempotency ledger ────────────────────────────── */

/** Event ids already dispatched to an effect (defense in depth:
 *  parseTestWebhookEvent already rejects replays at the gate). */
const handledEventIds = new Set<string>();

/* ── Dispatch ────────────────────────────────────────────────────── */

/**
 * Dispatch a VERIFIED test webhook event to its product effect.
 *
 * NOTE: pass only events returned by `parseTestWebhookEvent` (or use
 * `handleTestWebhookDelivery`, which does both steps). Handling an
 * unverified event is a test-mode violation in spirit — the caller
 * must have verified first.
 *
 * @throws ALREADY_HANDLED | UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function handleTestWebhookEvent(event: TestWebhookEvent): WebhookEffect {
  if (!event || typeof event !== "object" || event.testMode !== true) {
    throw handlerErr(
      HANDLER_ERROR_CODES.INVALID_OBJECT,
      "refusing to dispatch an event that is not a verified test-mode fixture."
    );
  }
  if (handledEventIds.has(event.id)) {
    throw handlerErr(
      HANDLER_ERROR_CODES.ALREADY_HANDLED,
      `event ${event.id} already produced an effect — refusing redispatch.`
    );
  }
  const obj = event.data && event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      // divorce's unlock gate: only a validated receipt earns the packet.
      if (!isValidTestReceipt(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          `checkout.session.completed carried no valid receipt — never unlocking on a ${obj && typeof obj === "object" ? "non-receipt" : "missing"} payload.`
        );
      }
      handledEventIds.add(event.id);
      return effect(event, "unlock_deliverable", obj);
    }
    case "payment_intent.succeeded": {
      if (!isValidTestReceipt(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "payment_intent.succeeded carried no valid receipt."
        );
      }
      handledEventIds.add(event.id);
      return effect(event, "record_payment", obj);
    }
    case "customer.subscription.created": {
      if (!isValidTestSubscription(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "customer.subscription.created carried no valid active subscription."
        );
      }
      handledEventIds.add(event.id);
      return effect(event, "provision_subscription", obj);
    }
    case "customer.subscription.updated": {
      if (!isValidTestSubscription(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "customer.subscription.updated carried no valid active subscription."
        );
      }
      handledEventIds.add(event.id);
      return effect(event, "sync_subscription", obj);
    }
    case "customer.subscription.canceled": {
      if (!isSubscriptionFixture(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "customer.subscription.canceled carried no recognizable subscription fixture."
        );
      }
      const plan = describePlan(obj.productId);
      const accessUntil = plan.keepAccessToPeriodEnd
        ? new Date(new Date(obj.startedAt).getTime() + MONTH_MILLIS).toISOString()
        : new Date().toISOString();
      handledEventIds.add(event.id);
      return effect(event, "grant_access_to_period_end", obj, accessUntil);
    }
    default: {
      throw handlerErr(
        HANDLER_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `no handler for event type "${(event as { type: string }).type}" — ` +
          "extend WebhookEventType and the dispatch map to support it."
      );
    }
  }
}

/**
 * Verify then dispatch: the one call a server webhook route needs.
 *
 *   const effect = handleTestWebhookDelivery(rawBody, signature);
 *   if (effect.effect === "unlock_deliverable") { /* render packet *\/ }
 *
 * Verification errors (BAD_SIGNATURE / EXPIRED_EVENT / REPLAYED_EVENT /
 * BAD_EVENT) throw before any handler runs; dispatch errors
 * (UNKNOWN_EVENT_TYPE / INVALID_OBJECT / ALREADY_HANDLED) throw after.
 */
export function handleTestWebhookDelivery(
  rawBody: string,
  signature: string,
  opts: {
    secret?: string;
    nowSeconds?: number;
    toleranceSeconds?: number;
  } = {}
): WebhookEffect {
  const event = parseTestWebhookEvent(rawBody, signature, opts);
  return handleTestWebhookEvent(event);
}

/**
 * Reset the handler ledger. For tests only — the parse replay ledger
 * is reset separately via `resetWebhookFixtures()`.
 */
export function resetWebhookHandler(): void {
  handledEventIds.clear();
}

export { ERROR_CODES };
