/**
 * staging-drill.ts — TEST-MODE-ONLY end-to-end money-milestone drills.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The reference implementation of the staging server route both
 * products need. Each drill drives the FULL async checkout loop
 * through the public seam — no shortcuts, no reaching past the
 * provider, no hand-built events:
 *
 *   getProvider().createSession → confirm (test card)
 *     → deliverTestWebhookEvent (signed, t=<ts>,v1=<hmac>)
 *     → handleTestWebhookDelivery (VERIFY signature, freshness,
 *        replay) → dispatch → WebhookEffect (fulfill)
 *
 * Money milestones:
 *
 *   divorce $30 one-time:   runDivorceStagingDrill()
 *     → effect "unlock_deliverable"  (the printable packet gate)
 *   wax $10/mo:              runWaxStagingDrill()
 *     → effect "provision_subscription" (alerts go live)
 *   wax cancel at period end: runWaxCancelStagingDrill()
 *     → effect "grant_access_to_period_end" (+ accessUntil)
 *   declined card:            runDivorceDeclineDrill()
 *     → structured failure, DECLINED — never an unlock
 *
 * This is the harness a staging webhook route mirrors. When Brandon
 * approves a live rail, the live route keeps this shape (verify THEN
 * dispatch, dispatch THEN fulfill) and only the fixtures change.
 *
 * Guarantees by construction:
 *   - Drills reset both ledgers (parse replay + handler dispatch)
 *     before each run: `resetWebhookFixtures()` /
 *     `resetWebhookHandler()`. Isolation for a test harness — a live
 *     server must persist idempotency keys itself; this module never
 *     pretends its in-memory Sets survive a restart. A live route
 *     swaps in `FileIdempotencyLedger` from lib/idempotency-ledger.ts
 *     (same interface, crash-safe JSON-lines, load on boot) via
 *     `setHandlerLedger` — see docs/INTEGRATING.md step 5.
 *   - The deliverable never unlocks from the receipt alone: drills go
 *     through the signed webhook + verify path even though the fixture
 *     confirm is in-process. Same shape the modal/server uses live.
 *   - Declines short-circuit at confirm with DECLINED and produce NO
 *     receipt, NO webhook, NO effect.
 *   - Zero dependencies. Zero network. Nothing leaves this process.
 */

import {
  ERROR_CODES,
  type Receipt,
  type Subscription,
} from "./checkout-test";
import { getProvider } from "./checkout-provider";
import {
  TEST_WEBHOOK_SECRET,
  deliverTestWebhookEvent,
  resetWebhookFixtures,
  type WebhookEventType,
} from "./webhook-test";
import {
  handleTestWebhookDelivery,
  resetWebhookHandler,
  type WebhookEffect,
} from "./webhook-handler";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** The catalog product the divorce drill sells: $30 one-time packet. */
export const DRILL_DIVORCE_PRODUCT_ID = "uncontested_packet" as const;

/** The catalog product the wax drills sell: $10/mo alerts. */
export const DRILL_WAX_PRODUCT_ID = "wax_subscription" as const;

/** Documented decline card: last4 "0002" is always declined. */
export const DRILL_DECLINE_CARD_LAST4 = "0002" as const;

export const DRILL_ERROR_CODES = Object.freeze({
  DRILL_DECLINED: "DRILL_DECLINED",
});

export interface StagingDrillResult {
  /** The fulfilled effect — the money milestone outcome. */
  readonly effect: WebhookEffect;
  /** One-time flows only: the receipt that earned the effect. */
  readonly receipt?: Receipt;
  /** Recurring flows only: the subscription that earned the effect. */
  readonly subscription?: Subscription;
  readonly testMode: true;
}

/** Structured decline outcome: no receipt, no webhook, no effect. */
export interface StagingDeclineResult {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/* ── Server-route shape ──────────────────────────────────────────── */

/**
 * Reset both idempotency ledgers so one drill never sees another's
 * event ids. Test-harness isolation only — call at the start of a
 * drill, never in a live route (live idempotency keys persist).
 */
export function resetStagingDrill(): void {
  resetWebhookFixtures();
  resetWebhookHandler();
}

/**
 * The one call a staging webhook route needs: verify the signature,
 * freshness, and replay state, THEN dispatch to the product effect.
 * This is `handleTestWebhookDelivery` — named here so a route reader
 * sees the intent (verify → dispatch → fulfill).
 *
 * @throws BAD_SIGNATURE | EXPIRED_EVENT | REPLAYED_EVENT | BAD_EVENT
 *   before dispatch; UNKNOWN_EVENT_TYPE | INVALID_OBJECT |
 *   ALREADY_HANDLED after.
 */
export function verifyThenDispatch(
  rawBody: string,
  signature: string
): WebhookEffect {
  return handleTestWebhookDelivery(rawBody, signature, {
    secret: TEST_WEBHOOK_SECRET,
  });
}

/* ── divorce: the $30 milestone ───────────────────────────────────── */

/**
 * Full async loop for divorce's $30 uncontested packet.
 * Returns the effect the staging route fulfills — effect.effect ===
 * "unlock_deliverable" means the printable packet may render.
 *
 * @throws {Error} code DECLINED | TEST_MODE_VIOLATION | UNKNOWN_PRODUCT |
 *   INVALID_AMOUNT | BAD_SIGNATURE | EXPIRED_EVENT | REPLAYED_EVENT |
 *   BAD_EVENT | UNKNOWN_EVENT_TYPE | INVALID_OBJECT | ALREADY_HANDLED
 */
export function runDivorceStagingDrill(
  opts: { cardLast4?: string } = {}
): StagingDrillResult {
  resetStagingDrill();
  const provider = getProvider();
  const session = provider.createSession(DRILL_DIVORCE_PRODUCT_ID);
  const receipt = provider.confirmPayment(
    session.id,
    session,
    { last4: opts.cardLast4 ?? "4242" },
    {}
  );
  const { rawBody, signature } = deliverTestWebhookEvent(
    "checkout.session.completed" as WebhookEventType,
    receipt
  );
  const effect = verifyThenDispatch(rawBody, signature);
  return { effect, receipt, testMode: true };
}

/**
 * The decline path: the documented decline card (last4 0002) aborts
 * the drill at confirm. Returns a structured failure — the loop never
 * produces a receipt, webhook, or effect, so nothing can unlock.
 */
export function runDivorceDeclineDrill(
  cardLast4: string = DRILL_DECLINE_CARD_LAST4
): StagingDeclineResult {
  resetStagingDrill();
  const provider = getProvider();
  const session = provider.createSession(DRILL_DIVORCE_PRODUCT_ID);
  try {
    provider.confirmPayment(session.id, session, { last4: cardLast4 }, {});
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === ERROR_CODES.DECLINED) {
      return {
        ok: false,
        code: DRILL_ERROR_CODES.DRILL_DECLINED,
        message: `declined card (last4 ${cardLast4}) — no receipt, no webhook, no unlock.`,
      };
    }
    throw e;
  }
  throw Object.assign(
    new Error(
      `staging-drill: decline card ${cardLast4} was NOT declined — ` +
        `the DECLINED test-card convention broke.`
    ),
    { code: ERROR_CODES.DECLINED }
  );
}

/* ── wax: the $10/mo milestone ────────────────────────────────────── */

/**
 * Full async loop for wax's $10/mo drop-alert subscription.
 * Returns effect "provision_subscription" — wax turns alerts on.
 *
 * @throws {Error} same set as runDivorceStagingDrill.
 */
export function runWaxStagingDrill(
  opts: { cardLast4?: string } = {}
): StagingDrillResult {
  resetStagingDrill();
  const provider = getProvider();
  const session = provider.createSession(DRILL_WAX_PRODUCT_ID);
  const subscription = provider.confirmSubscription(
    session.id,
    session,
    { last4: opts.cardLast4 ?? "4242" },
    {}
  );
  const { rawBody, signature } = deliverTestWebhookEvent(
    "customer.subscription.created" as WebhookEventType,
    subscription
  );
  const effect = verifyThenDispatch(rawBody, signature);
  return { effect, subscription, testMode: true };
}

/**
 * The cancel path: a canceled subscription arrives with a non-active
 * status — the dispatch layer must still recognize the fixture and
 * grant access to period end (accessUntil = startedAt + one month).
 * Covers exactly the branch `isSubscriptionFixture` documents.
 */
export function runWaxCancelStagingDrill(): StagingDrillResult {
  resetStagingDrill();
  const provider = getProvider();
  const session = provider.createSession(DRILL_WAX_PRODUCT_ID);
  const subscription = provider.confirmSubscription(
    session.id,
    session,
    { last4: "4242" },
    {}
  );
  // A canceled event carries a subscription whose status is no longer
  // "active" — the real shape a processor delivers at period end.
  const canceled = {
    ...subscription,
    status: "canceled",
  } as unknown as Subscription;
  const { rawBody, signature } = deliverTestWebhookEvent(
    "customer.subscription.canceled" as WebhookEventType,
    canceled
  );
  const effect = verifyThenDispatch(rawBody, signature);
  return { effect, subscription: canceled, testMode: true };
}
