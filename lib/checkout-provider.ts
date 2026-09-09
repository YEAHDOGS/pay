/**
 * checkout-provider.ts — the swappable checkout-provider seam.
 *
 * TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 *
 * Products (divorce, wax) should consume checkout THROUGH THIS FILE, not
 * through `checkout-test.ts` directly. `CheckoutProvider` is the interface
 * every processor implements; `TestCheckoutProvider` is the fixture
 * implementation that ships now. When Brandon approves a live rail for a
 * product, the live integration lands as a NEW server-side class that
 * implements `CheckoutProvider` (secret key never leaves the server) —
 * product code keeps calling `getProvider()` and never changes shape.
 *
 * Guarantees by construction:
 *   - `getProvider()` only ever returns the test fixture provider. Any
 *     request for a live provider ("stripe", "live", …) throws
 *     TEST_MODE_VIOLATION.
 *   - There is NO field anywhere in this module for a publishable key,
 *     secret key, or access token. Do NOT add one.
 *   - Zero dependencies. Zero network. Fixtures are pure in-memory
 *     objects; nothing leaves this process.
 */

import {
  ERROR_CODES,
  type BillingMode,
  type CheckoutSession,
  type Product,
  type Receipt,
  type Subscription,
  assertTestMode,
  confirmTestPayment,
  confirmTestSubscription,
  createTestCheckout,
  getProduct,
  isValidTestReceipt,
  isValidTestSubscription,
} from "./checkout-test";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** The only provider id this module can hand out. */
export const TEST_PROVIDER_ID = "test-fixture" as const;

/* ── Provider interface ──────────────────────────────────────────── */

export interface CheckoutProvider {
  /** Provider id: "test-fixture" today; a live id only from a
   *  server-side class Brandon reviews. */
  readonly providerId: string;
  /** Hard-coded false for every in-repo implementation. */
  readonly isLive: boolean;

  /** Look up the catalog product this session would sell. */
  product(productId: string): Product;

  /** Create a hosted-checkout session for a catalog product. */
  createSession(
    productId: string,
    options?: Record<string, unknown>
  ): CheckoutSession;

  /** Pay a one-time session with the test card. */
  confirmPayment(
    sessionId: string,
    session: CheckoutSession,
    card?: { last4?: string },
    options?: Record<string, unknown>
  ): Receipt;

  /** Subscribe a recurring session with the test card. */
  confirmSubscription(
    sessionId: string,
    session: CheckoutSession,
    card?: { last4?: string },
    options?: Record<string, unknown>
  ): Subscription;
}

/* ── Fixture implementation ──────────────────────────────────────── */

/**
 * The test-mode provider. Delegates to the fixture contract in
 * `checkout-test.ts`. This is the ONLY CheckoutProvider implementation
 * allowed to exist in-repo; anything live is server-side and reviewed.
 */
export class TestCheckoutProvider implements CheckoutProvider {
  readonly providerId = TEST_PROVIDER_ID;
  readonly isLive = false as const;

  product(productId: string): Product {
    return getProduct(productId);
  }

  createSession(
    productId: string,
    options: Record<string, unknown> = {}
  ): CheckoutSession {
    assertTestMode(options);
    return createTestCheckout(productId, undefined, options);
  }

  confirmPayment(
    sessionId: string,
    session: CheckoutSession,
    card: { last4?: string } = { last4: "4242" },
    options: Record<string, unknown> = {}
  ): Receipt {
    assertTestMode(options);
    return confirmTestPayment(sessionId, session, card, options);
  }

  confirmSubscription(
    sessionId: string,
    session: CheckoutSession,
    card: { last4?: string } = { last4: "4242" },
    options: Record<string, unknown> = {}
  ): Subscription {
    assertTestMode(options);
    return confirmTestSubscription(sessionId, session, card, options);
  }
}

/* ── Factory ─────────────────────────────────────────────────────── */

/**
 * Return the checkout provider. Currently only the test fixture exists;
 * requesting any live provider id throws TEST_MODE_VIOLATION.
 *
 * @throws {Error} code TEST_MODE_VIOLATION
 */
export function getProvider(
  providerId: string = TEST_PROVIDER_ID,
  options: Record<string, unknown> = {}
): CheckoutProvider {
  assertTestMode(options);
  if (providerId !== TEST_PROVIDER_ID) {
    const err = new Error(
      `checkout-provider: live provider "${providerId}" is unavailable — ` +
        `this module only ships the "${TEST_PROVIDER_ID}" test fixture. ` +
        `A live rail needs Brandon's approval and a server-side implementation.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.TEST_MODE_VIOLATION;
    throw err;
  }
  return new TestCheckoutProvider();
}

/**
 * Re-exports so product code can validate without importing two modules.
 */
export { isValidTestReceipt, isValidTestSubscription };
export type { BillingMode };
