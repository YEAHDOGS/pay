/**
 * divorce-checkout.ts — the FIRST CONSUMER of the checkout-provider seam.
 *
 * TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 *
 * This file shows exactly how divorce's staging flow calls checkout.
 * It is the reusable provider/seam side: divorce's own modal logic
 * (CheckoutModal.svelte, questionnaire gating, packet rendering) is NOT
 * duplicated here — divorce keeps its UI and calls `startDivorceCheckout()`
 * / `confirmDivorceCheckout()` for the money step.
 *
 * Flow divorce uses:
 *   const session = startDivorceCheckout();        // $30 packet session
 *   const receipt = confirmDivorceCheckout(session); // test card 4242…
 *   if (!isValidTestReceipt(receipt)) throw …      // never unlock otherwise
 *
 * When Brandon approves a live rail for divorce, the live implementation
 * lands as a server-side CheckoutProvider and divorce's UI code here
 * never changes shape.
 */

import {
  ERROR_CODES,
  type CheckoutSession,
  type Receipt,
} from "./checkout-test";
import {
  getProvider,
  isValidTestReceipt,
} from "./checkout-provider";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** The catalog product divorce sells: $30 one-time uncontested packet. */
export const DIVORCE_PRODUCT_ID = "uncontested_packet" as const;

/** divorce's money milestone: 3000¢, one-time, USD. */
export const DIVORCE_PRICE_CENTS = 3000 as const;

/**
 * Open a test-checkout session for the divorce packet.
 * @throws {Error} code TEST_MODE_VIOLATION | UNKNOWN_PRODUCT | INVALID_AMOUNT
 */
export function startDivorceCheckout(
  options: Record<string, unknown> = {}
): CheckoutSession {
  const provider = getProvider("test-fixture", options);
  const product = provider.product(DIVORCE_PRODUCT_ID);
  if (product.amountCents !== DIVORCE_PRICE_CENTS || product.billing !== "one_time") {
    const err = new Error(
      `divorce-checkout: catalog price for "${DIVORCE_PRODUCT_ID}" moved — expected 3000¢ one-time.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.INVALID_AMOUNT;
    throw err;
  }
  return provider.createSession(DIVORCE_PRODUCT_ID, options);
}

/**
 * Confirm the divorce packet payment with the test card.
 * Test-card convention: last4 "0002" is always declined.
 * @throws {Error} code UNKNOWN_SESSION | DECLINED | TEST_MODE_VIOLATION
 */
export function confirmDivorceCheckout(
  session: CheckoutSession,
  card: { last4?: string } = { last4: "4242" },
  options: Record<string, unknown> = {}
): Receipt {
  const provider = getProvider("test-fixture", options);
  return provider.confirmPayment(session.id, session, card, options);
}

export { isValidTestReceipt };
