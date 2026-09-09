/**
 * route.ts — REFERENCE server webhook route for the divorce $30
 * test payment on staging.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  REFERENCE ONLY — copy into the divorce repo and wire the order
 *  ledger before it can accept a real payment. It fails LOUD
 *  (persistPaymentRecord throws) until then, so a verbatim copy can
 *  never silently drop a payment.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The full live-lane route a product needs, in one place:
 *
 *   raw body (exact bytes, un-parsed)
 *     → handleServerWebhookDeliveryOnce   // verify → parse → dispatch,
 *                                           // duplicate deliveries get a
 *                                           // clear already_processed 2xx
 *     → assertServerPaymentSettled        // no unlock on unpaid status
 *     → persistPaymentRecord             // ← divorce wires its order
 *                                           //    ledger here
 *     → 2xx
 *
 * Verification failures return 4xx (the processor retries on
 * non-2xx, which the idempotency ledger deduplicates — that retry
 * path is exercised in the pay test suite). Fulfill failures return
 * 5xx so the processor retries the delivery rather than the route
 * 2xx-ing a payment it never recorded.
 *
 * Env (set on the STAGING host, never in-repo):
 *   STRIPE_WEBHOOK_SECRET  — the processor webhook secret for the
 *                            staging endpoint.
 */

import {
  SERVER_DISPATCH_ERROR_CODES,
  assertServerPaymentSettled,
  handleServerWebhookDeliveryOnce,
  type PaymentRecord,
  type ServerWebhookDeliveryResult,
} from "../../../../lib/webhook-server-dispatch";

/** Minimal ambient for the route runtime (no @types/node in this repo). */
declare const process:
  | { env: Record<string, string | undefined> }
  | undefined;

/* ── Hoisted constants ───────────────────────────────────────────── */

/**
 * divorce's catalog price for the uncontested packet, in minor units.
 * The server's own expectation — never anything the webhook claimed.
 * Keep in sync with divorce's price config; a drift throws
 * AMOUNT_MISMATCH and the packet stays locked.
 */
export const REFERENCE_EXPECTED_AMOUNT_TOTAL = 3000 as const;
export const REFERENCE_EXPECTED_CURRENCY = "usd" as const;

/* ── Fulfill seam ────────────────────────────────────────────────── */

/**
 * Persist the verified, settled payment to the product's order ledger,
 * then (in the divorce repo) gate the printable packet on the ledger
 * entry. NOT IMPLEMENTED here on purpose: a reference that silently
 * swallowed payments would be worse than one that refuses to run.
 *
 * Copy this file into divorce and implement: write effect.payment to
 * the order store keyed by eventId, then return.
 *
 * IMPORTANT: make the implementation IDEMPOTENT (upsert keyed by
 * eventId). The dispatch ledger deduplicates *dispatch* — a delivery
 * that 5xx'd at fulfill time answers "already_processed" 2xx on
 * retry, so a non-idempotent fulfill would silently drop the retry's
 * write. With an upsert keyed by eventId, the 2xx is always safe.
 */
async function persistPaymentRecord(_payment: PaymentRecord): Promise<void> {
  throw new Error(
    "webhook route: persistPaymentRecord is not implemented — " +
      "wire divorce's order ledger here before this route accepts " +
      "real payments."
  );
}

function failureCode(e: unknown): string {
  const code = (e as Error & { code?: string } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
}

/**
 * Answer a processor webhook delivery. Next.js App Router accepts the
 * native Request/Response shapes, so this stays dependency-free.
 */
export async function POST(request: Request): Promise<Response> {
  // 1. Exact raw bytes, un-parsed — verification must see what the
  //    processor actually sent.
  const rawBody = await request.text();
  const header = request.headers.get("stripe-signature");
  const secret = process?.env?.STRIPE_WEBHOOK_SECRET;

  // 2. Verify → parse → dispatch, idempotently. Missing/empty/fixture
  //    secrets, bad signatures, stale events, unknown types, and
  //    amount mismatches all throw → 4xx → processor retries, and the
  //    ledger deduplicates the retry.
  let result: ServerWebhookDeliveryResult;
  try {
    result = handleServerWebhookDeliveryOnce(rawBody, header, secret, {
      expectedAmountTotal: REFERENCE_EXPECTED_AMOUNT_TOTAL,
      expectedCurrency: REFERENCE_EXPECTED_CURRENCY,
    });
  } catch (e) {
    return Response.json(
      { ok: false, code: failureCode(e) },
      { status: 400 }
    );
  }

  // 3. A duplicate of an already-recorded event is a clean 2xx — the
  //    payment was recorded exactly once, on first delivery.
  if (result.status === "already_processed") {
    return Response.json({
      ok: true,
      alreadyProcessed: true,
      eventId: result.eventId,
    });
  }

  // 4. Fulfill: settlement gate first, then the order-ledger write.
  //    A 5xx here tells the processor to retry the delivery — never
  //    2xx a payment we didn't record.
  try {
    assertServerPaymentSettled(result.effect.payment);
    await persistPaymentRecord(result.effect.payment);
  } catch (e) {
    const code = failureCode(e);
    const known =
      code === SERVER_DISPATCH_ERROR_CODES.PAYMENT_NOT_SETTLED;
    return Response.json({ ok: false, code }, { status: known ? 400 : 500 });
  }

  return Response.json({
    ok: true,
    eventId: result.effect.eventId,
    sessionId: result.effect.payment.sessionId,
  });
}
