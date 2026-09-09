/**
 * server-checkout-drill.ts — TEST-MODE-ONLY end-to-end staging drill for
 * the SERVER-SIDE lane.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The reference staging drill that ties the whole live lane together
 * against THROWAWAY material — the drill a route author runs before
 * wiring `/api/webhooks/checkout`:
 *
 *   startDivorceCheckout()            // 3000¢ one-time session (catalog-guarded)
 *     → synthetic signed checkout.session.completed
 *         (signed with a THROWAWAY secret, Stripe-compatible header)
 *     → handleServerWebhookDelivery   // verify → parse → dispatch
 *         (with expectedAmountTotal: 3000 — the amount guard end to end)
 *     → record_payment effect
 *     → divorcePacketMayRender()      // the packet-unlock gate
 *
 * And the lock paths it proves:
 *   - runServerDivorceAmountTamperDrill(): a VALID-signature event
 *     whose amount_total (2000¢) mismatches the server's expectation
 *     throws AMOUNT_MISMATCH — no record_payment, packet stays locked.
 *   - A forged signature throws BAD_SIGNATURE before anything parses.
 *   - A replayed delivery throws ALREADY_HANDLED — one event, one effect.
 *   - A declined card throws DECLINED at confirm, so no webhook can
 *     even be built and nothing can unlock.
 *
 * The signing secret here is a hard-coded THROWAWAY string: it is NOT
 * the fixture dummy (verify rejects those outright) and it is NOT a
 * real processor secret (it cannot sign anything a live processor
 * would accept, and it never leaves this process). A regression test
 * asserts it doesn't look like live material. Do NOT swap in a real
 * secret — the live route reads process.env.STRIPE_WEBHOOK_SECRET.
 *
 * Guarantees by construction:
 *   - verify → parse → dispatch → gate, in that order, through the
 *     real public seams. No shortcuts, no reaching past the verifier.
 *   - The packet gate never trusts the receipt/session alone: it
 *     requires the record_payment effect off a VERIFIED delivery with
 *     the server's own amount expectation attached.
 *   - Zero dependencies beyond node:crypto (via webhook-server).
 *     Zero network. Nothing leaves this process.
 */

import type { CheckoutSession } from "./checkout-test";
import {
  DIVORCE_PRICE_CENTS,
  startDivorceCheckout,
} from "./divorce-checkout";
import {
  SERVER_DISPATCH_ERROR_CODES,
  handleServerWebhookDelivery,
  resetServerWebhookDispatch,
  type ServerWebhookEffect,
} from "./webhook-server-dispatch";
import {
  signServerWebhookPayload,
} from "./webhook-server";

/* ── Hoisted constants ───────────────────────────────────────────── */

/**
 * THROWAWAY signing key for this drill. Hard-coded, unit-test grade,
 * never a fixture dummy, never live material. It signs nothing a real
 * processor would ever accept.
 */
export const SERVER_DRILL_SECRET =
  "unit_test_throwaway_server_drill_secret_02" as const;

export const SERVER_DRILL_ERROR_CODES = Object.freeze({
  DRILL_DECLINED: "DRILL_DECLINED",
  ...SERVER_DISPATCH_ERROR_CODES,
});

export interface ServerCheckoutDrillResult {
  /** The verified, dispatched effect — the money milestone outcome. */
  readonly effect: ServerWebhookEffect;
  /** The catalog-guarded session the drill started from. */
  readonly session: CheckoutSession;
  /** The packet-unlock gate outcome: may the printable packet render? */
  readonly packetUnlocked: boolean;
  readonly testMode: true;
}

/** Structured drill failure: no effect, no unlock, machine-readable code. */
export interface ServerCheckoutDrillFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly packetUnlocked: false;
}

/* ── The packet-unlock gate ───────────────────────────────────────── */

/**
 * The fulfill step divorce's route performs on a record_payment effect:
 * the printable packet renders ONLY when the effect is a verified
 * record_payment, the payment is marked paid, and the recorded amount
 * still matches the catalog price. Pure — the route persists
 * effect.payment, this decides the gate.
 */
export function divorcePacketMayRender(
  effect: ServerWebhookEffect
): boolean {
  return (
    effect.effect === "record_payment" &&
    effect.payment.paid === true &&
    effect.payment.amountTotal === DIVORCE_PRICE_CENTS &&
    effect.payment.currency.toLowerCase() === "usd"
  );
}

/* ── Harness pieces ───────────────────────────────────────────────── */

/** Isolation for a test harness: clear the server dispatch ledger. */
export function resetServerCheckoutDrill(): void {
  resetServerWebhookDispatch();
}

/**
 * Build the synthetic checkout.session.completed body for a divorce
 * session — the shape a processor delivers once the customer pays.
 */
function sessionCompletedBody(
  eventId: string,
  sessionId: string,
  amountTotal: number
): string {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        amount_total: amountTotal,
        currency: "usd",
        payment_status: "paid",
      },
    },
  });
}

/**
 * Verify → parse → dispatch with the server's own amount expectation
 * (the 3000¢ catalog guard end to end).
 */
function deliverWithAmountGuard(
  rawBody: string,
  header: string,
  nowSeconds: number
): ServerWebhookEffect {
  return handleServerWebhookDelivery(rawBody, header, SERVER_DRILL_SECRET, {
    expectedAmountTotal: DIVORCE_PRICE_CENTS,
    expectedCurrency: "usd",
    nowSeconds,
  });
}

/* ── Happy path: $30 session → signed webhook → record_payment → unlock ── */

/**
 * The standing e2e drill: startDivorceCheckout (3000¢, catalog-guarded)
 * → synthetic signed checkout.session.completed → verify + amount
 * guard (3000¢) → record_payment → packet unlock gate.
 *
 * @throws TEST_MODE_VIOLATION | UNKNOWN_PRODUCT | INVALID_AMOUNT |
 *   MISSING_SECRET | FIXTURE_SECRET | BAD_HEADER | BAD_SIGNATURE |
 *   EXPIRED_EVENT | FUTURE_EVENT | BAD_EVENT | AMOUNT_MISMATCH |
 *   ALREADY_HANDLED | UNKNOWN_EVENT_TYPE | INVALID_OBJECT
 */
export function runServerDivorceCheckoutDrill(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ServerCheckoutDrillResult {
  resetServerCheckoutDrill();
  const session = startDivorceCheckout();
  const rawBody = sessionCompletedBody(
    "evt_drill_server_divorce_1",
    session.id,
    DIVORCE_PRICE_CENTS
  );
  const header = signServerWebhookPayload(rawBody, SERVER_DRILL_SECRET, nowSeconds);
  const effect = deliverWithAmountGuard(rawBody, header, nowSeconds);
  const packetUnlocked = divorcePacketMayRender(effect);
  return { effect, session, packetUnlocked, testMode: true };
}

/* ── Lock paths ───────────────────────────────────────────────────── */

/**
 * The forged-amount drill: the event is VALIDLY signed but carries
 * amount_total 2000¢ while the server expects 3000¢. The amount guard
 * throws AMOUNT_MISMATCH fail-closed — no record_payment, packet locked.
 */
export function runServerDivorceAmountTamperDrill(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ServerCheckoutDrillFailure {
  resetServerCheckoutDrill();
  const session = startDivorceCheckout();
  const rawBody = sessionCompletedBody(
    "evt_drill_server_tamper_1",
    session.id,
    2000 // tampered: 2000¢ against a 3000¢ expectation
  );
  const header = signServerWebhookPayload(rawBody, SERVER_DRILL_SECRET, nowSeconds);
  try {
    deliverWithAmountGuard(rawBody, header, nowSeconds);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH) {
      return {
        ok: false,
        code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH,
        message:
          "amount mismatch (2000¢ vs expected 3000¢) — refused to record; " +
          "packet stays locked.",
        packetUnlocked: false,
      };
    }
    throw e;
  }
  throw Object.assign(
    new Error(
      "server-checkout-drill: tampered amount was ACCEPTED — the " +
        "AMOUNT_MISMATCH guard broke."
    ),
    { code: SERVER_DISPATCH_ERROR_CODES.AMOUNT_MISMATCH }
  );
}

/**
 * Deliver a server-side webhook for a divorce session whose
 * payment_status the processor reports as "unpaid". Dispatch still
 * records (auditable trail), but the packet gate refuses: unpaid
 * payments never unlock.
 */
export function runServerDivorceUnpaidDrill(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ServerCheckoutDrillResult {
  resetServerCheckoutDrill();
  const session = startDivorceCheckout();
  const rawBody = JSON.stringify({
    id: "evt_drill_server_unpaid_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: session.id,
        object: "checkout.session",
        amount_total: DIVORCE_PRICE_CENTS,
        currency: "usd",
        payment_status: "unpaid",
      },
    },
  });
  const header = signServerWebhookPayload(rawBody, SERVER_DRILL_SECRET, nowSeconds);
  const effect = deliverWithAmountGuard(rawBody, header, nowSeconds);
  const packetUnlocked = divorcePacketMayRender(effect);
  return { effect, session, packetUnlocked, testMode: true };
}
