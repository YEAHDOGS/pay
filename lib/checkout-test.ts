/**
 * checkout-test.ts — YEAHDOGS TEST-MODE-ONLY checkout fixtures.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The shared checkout contract for YEAHDOGS products. It simulates the
 * hosted-checkout flow (create session → confirm with a test card →
 * receipt) so money milestones can be exercised end-to-end WITHOUT any
 * live processor account, secret key, or network call:
 *
 *   - divorce: the $30 one-time uncontested packet (`uncontested_packet`)
 *   - wax:     the $10/mo vinyl alert subscription (`wax_subscription`)
 *
 * Guarantees by construction:
 *   - There is NO field anywhere in this module for a publishable key,
 *     secret key, or access token. Do NOT add one. Live integration
 *     belongs in a server-side endpoint reviewed by Brandon — a client
 *     module must never touch live money rails.
 *   - `TEST_MODE` is a hard-coded `true`. Any attempt to run these
 *     fixtures with a live-mode flag throws a TEST_MODE_VIOLATION.
 *   - Generated ids carry the `cs_test_` / `rcpt_test_` / `sub_test_`
 *     prefix so they can never be mistaken for real processor objects.
 *   - Zero dependencies. Zero network. Fixtures are pure in-memory
 *     objects; nothing leaves this process.
 *
 * When live checkout is approved for a product: replace calls to this
 * module with a server-side session endpoint (secret stays on the
 * server), keep the receipt shape compatible below, and delete nothing
 * — these fixtures remain the offline regression harness.
 */

/* ── Hoisted constants ───────────────────────────────────────────── */

/** Hard-coded true. Never conditional on env, flags, or input. */
export const TEST_MODE = true;

export type BillingMode = "one_time" | "recurring";

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly billing: BillingMode;
  readonly interval?: "month";
}

/** The YEAHDOGS product catalog sold through checkout. Prices are fixed
 *  fixtures: the divorce packet is $30 flat one-time; wax is $10/mo. */
export const PRODUCTS: Record<string, Product> = Object.freeze({
  uncontested_packet: Object.freeze({
    id: "uncontested_packet",
    name: "Uncontested Divorce Packet",
    amountCents: 3000,
    currency: "usd",
    billing: "one_time",
  }),
  wax_subscription: Object.freeze({
    id: "wax_subscription",
    name: "Wax Drop Alerts — Monthly",
    amountCents: 1000,
    currency: "usd",
    billing: "recurring",
    interval: "month",
  }),
});

/** Documented test card. Never a real card number. */
export const TEST_CARD = Object.freeze({
  number: "4242 4242 4242 4242",
  exp: "12/34",
  cvc: "123",
  last4: "4242",
});

export const ERROR_CODES = Object.freeze({
  TEST_MODE_VIOLATION: "TEST_MODE_VIOLATION",
  UNKNOWN_PRODUCT: "UNKNOWN_PRODUCT",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  UNKNOWN_SESSION: "UNKNOWN_SESSION",
  DECLINED: "DECLINED",
  /** Idempotency key malformed (empty, non-string, too long). */
  INVALID_IDEMPOTENCY_KEY: "INVALID_IDEMPOTENCY_KEY",
  /** Idempotency key already recorded against a DIFFERENT session —
   *  not a retry, something is wrong; fail closed. */
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
});

/* ── Test-mode guard ─────────────────────────────────────────────── */

/**
 * Refuse to run if anyone attempts to flip this module into live mode.
 * @param options must not contain `live: true` / `mode: 'live'`.
 * @throws {Error} code TEST_MODE_VIOLATION
 */
export function assertTestMode(options: Record<string, unknown> = {}): true {
  const o = options || {};
  if (o.live === true || o.mode === "live" || o.mode === "production") {
    const err = new Error(
      "checkout-test: live mode is forbidden — this module only simulates TEST payments. No real money can move here."
    ) as Error & { code: string };
    err.code = ERROR_CODES.TEST_MODE_VIOLATION;
    throw err;
  }
  return true;
}

/**
 * Look up a catalog product. Unknown ids throw UNKNOWN_PRODUCT.
 */
export function getProduct(productId: string): Product {
  const p = PRODUCTS[productId];
  if (!p) {
    const err = new Error(
      `checkout-test: unknown product "${productId}". Known: ${Object.keys(PRODUCTS).join(", ")}.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_PRODUCT;
    throw err;
  }
  return p;
}

/* ── Confirm-side idempotency keys ──────────────────────────────── */

/**
 * Maximum idempotency key length. Keys are opaque client-generated
 * tokens (a UUID is typical); bounding them keeps the ledger a map of
 * small strings, not a memory sink for attacker-sized input.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128 as const;

/** What a recorded idempotency key is bound to: the session it named
 *  and the receipt that charge produced. */
interface IdempotencyRecord<T> {
  readonly sessionId: string;
  readonly result: T;
}

/**
 * Idempotency ledgers for the confirm step: key → the session + the
 * charge it produced. A double-submitted confirm with the same key
 * must never mint a second receipt — it replays the first. A key
 * reused for a DIFFERENT session throws IDEMPOTENCY_KEY_CONFLICT
 * instead of being honored: reusing a key across charges is not a
 * retry, it's a bug (or an attack).
 *
 * Failed attempts (declines) never write the ledger: a retry after a
 * decline with the same key is a NEW attempt, exactly like a live
 * processor treats it.
 *
 * NOTE: module-level and in-memory, like the counters. Fixtures are
 * single-process; `resetCheckoutIdempotency()` clears both ledgers
 * for tests.
 */
const paymentIdempotency = new Map<string, IdempotencyRecord<Receipt>>();
const subscriptionIdempotency = new Map<
  string,
  IdempotencyRecord<Subscription>
>();

function errWithCode(code: string, message: string): Error & { code: string } {
  const e = new Error(`checkout-test: ${message}`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

/**
 * Validate `options.idempotencyKey`. Returns the key when the caller
 * opted in, undefined when absent.
 *
 * @throws INVALID_IDEMPOTENCY_KEY for empty/non-string/oversized keys.
 */
export function assertIdempotencyKey(
  options: Record<string, unknown> = {}
): string | undefined {
  const key = options.idempotencyKey;
  if (key === undefined) return undefined;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw errWithCode(
      ERROR_CODES.INVALID_IDEMPOTENCY_KEY,
      "idempotencyKey must be a non-empty string of at most " +
        `${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
    );
  }
  return key;
}

/**
 * Look up an idempotency key on a confirm ledger. Same key + same
 * session → the original result (a retry, replay it). Same key +
 * DIFFERENT session → IDEMPOTENCY_KEY_CONFLICT (fail closed).
 */
function lookupIdempotency<T>(
  ledger: Map<string, IdempotencyRecord<T>>,
  key: string,
  sessionId: string
): T | undefined {
  const seen = ledger.get(key);
  if (!seen) return undefined;
  if (seen.sessionId !== sessionId) {
    throw errWithCode(
      ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      `idempotency key "${key}" was recorded for session ${seen.sessionId}, ` +
        `not ${sessionId} — refusing to replay a charge for a different session.`
    );
  }
  return seen.result;
}

/** Reset both confirm idempotency ledgers. For tests only. */
export function resetCheckoutIdempotency(): void {
  paymentIdempotency.clear();
  subscriptionIdempotency.clear();
}

/* ── Checkout sessions ───────────────────────────────────────────── */

let sessionCounter = 0;

export interface CheckoutSession {
  id: string;
  productId: string;
  amountCents: number;
  currency: string;
  billing: BillingMode;
  status: "open";
  testMode: true;
}

/**
 * Create a fake hosted-checkout session for a catalog product.
 * The amount must match the catalog price exactly (fixture integrity).
 * @throws {Error} code UNKNOWN_PRODUCT | INVALID_AMOUNT | TEST_MODE_VIOLATION
 */
export function createTestCheckout(
  productId: string,
  amountCents?: number,
  options: Record<string, unknown> = {}
): CheckoutSession {
  assertTestMode(options);
  const product = getProduct(productId);
  const amount = amountCents === undefined ? product.amountCents : amountCents;
  if (amount !== product.amountCents) {
    const err = new Error(
      `checkout-test: ${productId} is priced at ${product.amountCents}¢ (got ${amount}¢).`
    ) as Error & { code: string };
    err.code = ERROR_CODES.INVALID_AMOUNT;
    throw err;
  }
  sessionCounter += 1;
  return {
    id: `cs_test_${String(sessionCounter).padStart(6, "0")}`,
    productId: product.id,
    amountCents: product.amountCents,
    currency: product.currency,
    billing: product.billing,
    status: "open",
    testMode: true,
  };
}

/* ── One-time payment confirmation ───────────────────────────────── */

let receiptCounter = 0;

export interface Receipt {
  id: string;
  checkoutSessionId: string;
  productId: string;
  amountCents: number;
  currency: string;
  cardLast4: string;
  status: "succeeded";
  paidAt: string;
  testMode: true;
}

/**
 * Simulate paying a one-time checkout session with the test card.
 * Test-card convention: last4 `0002` is always declined.
 *
 * Idempotency: pass `options.idempotencyKey` and a double-submitted
 * confirm returns the ORIGINAL receipt instead of charging twice;
 * the key is bound to its first session and reuse across sessions
 * throws IDEMPOTENCY_KEY_CONFLICT. Declines never record the key, so
 * retrying after a decline re-attempts the charge.
 *
 * @throws {Error} code UNKNOWN_SESSION | DECLINED |
 *         INVALID_IDEMPOTENCY_KEY | IDEMPOTENCY_KEY_CONFLICT |
 *         TEST_MODE_VIOLATION
 */
export function confirmTestPayment(
  sessionId: string,
  session: CheckoutSession,
  card: { last4?: string } = { last4: TEST_CARD.last4 },
  options: Record<string, unknown> = {}
): Receipt {
  assertTestMode(options);
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_test_")) {
    const err = new Error(
      "checkout-test: unknown checkout session — only cs_test_* fixtures can be paid."
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_SESSION;
    throw err;
  }
  const idempotencyKey = assertIdempotencyKey(options);
  if (idempotencyKey !== undefined) {
    // A retry with the same key+session replays the original receipt —
    // no second charge, no counter bump.
    const replay = lookupIdempotency(paymentIdempotency, idempotencyKey, sessionId);
    if (replay) return replay;
  }
  if (session.billing !== "one_time") {
    const err = new Error(
      `checkout-test: ${session.productId} is a recurring product — use confirmTestSubscription.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.INVALID_AMOUNT;
    throw err;
  }
  if (card && card.last4 === "0002") {
    // Declines never record the key: retrying after a decline with
    // the same key is a fresh attempt, not a replay.
    const err = new Error("checkout-test: card declined (test decline card).") as Error & {
      code: string;
    };
    err.code = ERROR_CODES.DECLINED;
    throw err;
  }
  receiptCounter += 1;
  const receipt: Receipt = {
    id: `rcpt_test_${String(receiptCounter).padStart(6, "0")}`,
    checkoutSessionId: sessionId,
    productId: session.productId,
    amountCents: session.amountCents,
    currency: session.currency,
    cardLast4: (card && card.last4) || TEST_CARD.last4,
    status: "succeeded",
    paidAt: new Date().toISOString(),
    testMode: true,
  };
  if (idempotencyKey !== undefined) {
    paymentIdempotency.set(idempotencyKey, { sessionId, result: receipt });
  }
  return receipt;
}

/**
 * Validate a receipt: succeeded, catalog-priced, unmistakably test-mode.
 */
export function isValidTestReceipt(receipt: unknown): boolean {
  const r = receipt as Partial<Receipt> | null;
  if (!r || typeof r !== "object") return false;
  const product = PRODUCTS[r.productId ?? ""];
  return (
    r.testMode === true &&
    r.status === "succeeded" &&
    typeof r.id === "string" &&
    r.id.startsWith("rcpt_test_") &&
    !!product &&
    r.amountCents === product.amountCents
  );
}

/* ── Subscription confirmation (wax $10/mo) ──────────────────────── */

let subscriptionCounter = 0;

export interface Subscription {
  id: string;
  checkoutSessionId: string;
  productId: string;
  amountCents: number;
  currency: string;
  interval: "month";
  cardLast4: string;
  status: "active";
  startedAt: string;
  testMode: true;
}

/**
 * Simulate subscribing a recurring checkout session with the test card.
 * @throws {Error} code UNKNOWN_SESSION | DECLINED | TEST_MODE_VIOLATION
 */
export function confirmTestSubscription(
  sessionId: string,
  session: CheckoutSession,
  card: { last4?: string } = { last4: TEST_CARD.last4 },
  options: Record<string, unknown> = {}
): Subscription {
  assertTestMode(options);
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_test_")) {
    const err = new Error(
      "checkout-test: unknown checkout session — only cs_test_* fixtures can be subscribed."
    ) as Error & { code: string };
    err.code = ERROR_CODES.UNKNOWN_SESSION;
    throw err;
  }
  if (session.billing !== "recurring") {
    const err = new Error(
      `checkout-test: ${session.productId} is a one-time product — use confirmTestPayment.`
    ) as Error & { code: string };
    err.code = ERROR_CODES.INVALID_AMOUNT;
    throw err;
  }
  if (card && card.last4 === "0002") {
    const err = new Error("checkout-test: card declined (test decline card).") as Error & {
      code: string;
    };
    err.code = ERROR_CODES.DECLINED;
    throw err;
  }
  subscriptionCounter += 1;
  return {
    id: `sub_test_${String(subscriptionCounter).padStart(6, "0")}`,
    checkoutSessionId: sessionId,
    productId: session.productId,
    amountCents: session.amountCents,
    currency: session.currency,
    interval: "month",
    cardLast4: (card && card.last4) || TEST_CARD.last4,
    status: "active",
    startedAt: new Date().toISOString(),
    testMode: true,
  };
}

/**
 * Validate a subscription fixture: active, catalog-priced, test-mode.
 */
export function isValidTestSubscription(sub: unknown): boolean {
  const s = sub as Partial<Subscription> | null;
  if (!s || typeof s !== "object") return false;
  const product = PRODUCTS[s.productId ?? ""];
  return (
    s.testMode === true &&
    s.status === "active" &&
    typeof s.id === "string" &&
    s.id.startsWith("sub_test_") &&
    !!product &&
    product.billing === "recurring" &&
    s.amountCents === product.amountCents
  );
}
