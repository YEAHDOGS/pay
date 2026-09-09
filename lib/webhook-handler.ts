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
 *   - Every delivery leaves an audit line (webhook.received /
 *     effect.produced / delivery.rejected) in the swappable audit
 *     log — the ledger keeps exactly-once, the audit trail keeps
 *     the receipt of what exactly-once did. Audit is best-effort:
 *     it can never block or alter an effect.
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

import {
  type IdempotencyLedger,
  MemoryIdempotencyLedger,
  FileIdempotencyLedger,
} from "./idempotency-ledger";

import {
  AUDIT_EVENT_KINDS,
  type AuditEventKind,
  type AuditFields,
  type AuditLog,
  MemoryAuditLog,
  FileAuditLog,
} from "./audit-log";

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

/**
 * Event ids already dispatched to an effect (defense in depth:
 * parseTestWebhookEvent already rejects replays at the gate).
 *
 * The default ledger is in-memory — drills and tests reset it freely.
 * A LIVE staging route must persist keys across restarts: swap in a
 * file-backed adapter (same interface) before handling traffic:
 *
 *   setHandlerLedger(new FileIdempotencyLedger("/var/lib/staging/webhook-ids.jsonl"));
 *
 * The parse-level replay ledger (`seenEventIds` in webhook-test) has
 * the same constraint — swap it the same way when the route goes live.
 */
let handlerLedger: IdempotencyLedger = new MemoryIdempotencyLedger();

/**
 * Swap the handler idempotency ledger. Pass a `FileIdempotencyLedger`
 * (or any `IdempotencyLedger`) for a live staging route; the drills
 * and tests keep the in-memory default.
 */
export function setHandlerLedger(ledger: IdempotencyLedger): void {
  if (!ledger || typeof ledger.has !== "function" || typeof ledger.add !== "function") {
    throw handlerErr(
      HANDLER_ERROR_CODES.INVALID_OBJECT,
      "setHandlerLedger needs an IdempotencyLedger (has/add/clear/size)."
    );
  }
  handlerLedger = ledger;
}

/** The currently installed handler ledger (drill default: in-memory). */
export function getHandlerLedger(): IdempotencyLedger {
  return handlerLedger;
}

export { FileIdempotencyLedger };

/* ── Audit trail (append-only; never blocks fulfillment) ─────────── */

/**
 * Every delivery milestone through the server seam gets a line:
 * `webhook.received` after verify, `effect.produced` after dispatch,
 * `delivery.rejected` on any verify/dispatch failure. The default log
 * is in-memory — drills and tests reset it freely. A LIVE staging
 * route must persist the trail across restarts: swap in a file-backed
 * adapter (same interface) before handling traffic:
 *
 *   setAuditLog(new FileAuditLog("/var/lib/staging/webhook-audit.jsonl"));
 *
 * Records carry ids, event types, effect names, and error codes ONLY —
 * no payloads, no signatures, no secrets, no PII.
 */
let auditLog: AuditLog = new MemoryAuditLog();

/**
 * Swap the audit log. Pass a `FileAuditLog` (or any `AuditLog`) for a
 * live staging route; the drills and tests keep the in-memory default.
 */
export function setAuditLog(log: AuditLog): void {
  if (
    !log ||
    typeof log.record !== "function" ||
    typeof log.entries !== "function" ||
    typeof log.clear !== "function"
  ) {
    throw handlerErr(
      HANDLER_ERROR_CODES.INVALID_OBJECT,
      "setAuditLog needs an AuditLog (record/entries/clear/size)."
    );
  }
  auditLog = log;
}

/** The currently installed audit log (drill default: in-memory). */
export function getAuditLog(): AuditLog {
  return auditLog;
}

export { FileAuditLog };

/**
 * Record an audit milestone. Best-effort BY DESIGN: a failing adapter
 * (full disk, bad path) must never throw here — the effect still goes
 * out, and the worst case is a missing audit line, never a lost
 * fulfillment. Belt and suspenders: the adapters never throw on valid
 * input either.
 */
function audit(kind: AuditEventKind, fields: AuditFields = {}): void {
  try {
    auditLog.record(kind, fields);
  } catch {
    // Audit is best-effort — never block delivery on it.
  }
}

/**
 * Persist the event id in the idempotency ledger AND note the
 * produced effect in the audit trail. The ledger keeps exactly-once;
 * the audit trail keeps the receipt of what exactly-once did.
 */
function commitEffect(
  event: TestWebhookEvent,
  effectName: WebhookEffect["effect"]
): void {
  handlerLedger.add(event.id);
  audit(AUDIT_EVENT_KINDS.EFFECT_PRODUCED, {
    eventId: event.id,
    eventType: event.type,
    effect: effectName,
  });
}

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
  if (handlerLedger.has(event.id)) {
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
      commitEffect(event, "unlock_deliverable");
      return effect(event, "unlock_deliverable", obj);
    }
    case "payment_intent.succeeded": {
      if (!isValidTestReceipt(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "payment_intent.succeeded carried no valid receipt."
        );
      }
      commitEffect(event, "record_payment");
      return effect(event, "record_payment", obj);
    }
    case "customer.subscription.created": {
      if (!isValidTestSubscription(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "customer.subscription.created carried no valid active subscription."
        );
      }
      commitEffect(event, "provision_subscription");
      return effect(event, "provision_subscription", obj);
    }
    case "customer.subscription.updated": {
      if (!isValidTestSubscription(obj)) {
        throw handlerErr(
          HANDLER_ERROR_CODES.INVALID_OBJECT,
          "customer.subscription.updated carried no valid active subscription."
        );
      }
      commitEffect(event, "sync_subscription");
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
      commitEffect(event, "grant_access_to_period_end");
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
  let event: TestWebhookEvent;
  try {
    event = parseTestWebhookEvent(rawBody, signature, opts);
  } catch (e) {
    // Verification failed: log the rejection (code only, no body) and
    // rethrow — nothing reached dispatch, no effect was produced.
    audit(AUDIT_EVENT_KINDS.DELIVERY_REJECTED, {
      code: (e as { code?: string }).code,
    });
    throw e;
  }
  audit(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED, {
    eventId: event.id,
    eventType: event.type,
  });
  try {
    return handleTestWebhookEvent(event);
  } catch (e) {
    // Dispatch failed (UNKNOWN_EVENT_TYPE / INVALID_OBJECT /
    // ALREADY_HANDLED): the rejection goes in the trail, then the
    // error propagates to the route.
    audit(AUDIT_EVENT_KINDS.DELIVERY_REJECTED, {
      eventId: event.id,
      eventType: event.type,
      code: (e as { code?: string }).code,
    });
    throw e;
  }
}

/**
 * Reset the handler ledger AND the audit log. For tests only — the
 * parse replay ledger is reset separately via `resetWebhookFixtures()`.
 */
export function resetWebhookHandler(): void {
  handlerLedger.clear();
  auditLog.clear();
}

export { ERROR_CODES };
