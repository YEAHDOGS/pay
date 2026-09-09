/**
 * example-logic.js — browser-runnable test-mode checkout loop.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * This file mirrors the guarantees of pay's lib/ (same event shapes,
 * same `t=<ts>,v1=<hex>` signature scheme, same guards) so the
 * in-browser example in index.html runs with ZERO build step and ZERO
 * network. It intentionally does NOT import lib/checkout-test.ts or
 * lib/webhook-test.ts: those use node:crypto, which browsers don't
 * have, so this module re-implements the same contract with WebCrypto
 * (`crypto.subtle`, available in every modern browser AND in bun, so
 * the same file is driven by the bun regression tests).
 *
 * The webhook key below is a DUMMY fixture key. It can never be a real
 * processor secret: verify refuses anything not starting with
 * "whsec_test_fixture_". Real keys live server-side only — never in
 * a SPA, never in client JavaScript.
 */

const subtle = () => globalThis.crypto.subtle;

/* ── Hoisted constants ───────────────────────────────────────────── */

export const TEST_MODE = true;

export const PRODUCTS = Object.freeze({
  uncontested_packet: Object.freeze({
    id: "uncontested_packet",
    name: "Uncontested Divorce Packet",
    amountCents: 3000,
    currency: "usd",
    billing: "one_time",
  }),
});

/** Documented test card. Never a real card number. */
export const TEST_CARD = Object.freeze({
  number: "4242 4242 4242 4242",
  exp: "12/34",
  cvc: "123",
  last4: "4242",
});

/**
 * DUMMY signing key for the example's test webhooks. Fixture-only.
 * See module header — live secrets are refused by construction.
 */
export const EXAMPLE_WEBHOOK_SECRET =
  "whsec_test_fixture_EXAMPLE_browser_DO_NOT_USE_FOR_REAL_MONEY";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const ERROR_CODES = Object.freeze({
  TEST_MODE_VIOLATION: "TEST_MODE_VIOLATION",
  UNKNOWN_PRODUCT: "UNKNOWN_PRODUCT",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  UNKNOWN_SESSION: "UNKNOWN_SESSION",
  DECLINED: "DECLINED",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  EXPIRED_EVENT: "EXPIRED_EVENT",
  REPLAYED_EVENT: "REPLAYED_EVENT",
  BAD_EVENT: "BAD_EVENT",
});

function err(code, message) {
  const e = new Error(`example-logic: ${message}`);
  e.code = code;
  return e;
}

/* ── HMAC-SHA256 via WebCrypto ───────────────────────────────────── */

async function hmacSha256Hex(secret, data) {
  const key = await subtle().importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await subtle().sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Full-length XOR-accumulating compare — no early exit on mismatch. */
function compareHexConstantTime(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string") return false;
  if (aHex.length !== bHex.length) return false;
  let diff = 0;
  for (let i = 0; i < aHex.length; i++) {
    diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  }
  return diff === 0;
}

/* ── Fixture-key guard ───────────────────────────────────────────── */

/**
 * Refuse to sign/verify with anything that isn't a fixture key.
 */
export function assertFixtureSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_test_fixture_")) {
    throw err(
      ERROR_CODES.BAD_SIGNATURE,
      "refusing a non-fixture webhook secret — test webhooks may only be " +
        "signed with a whsec_test_fixture_* dummy key. Live webhook " +
        "secrets belong to the server-side rail."
    );
  }
}

/* ── Sessions & payment (mirrors lib/checkout-test.ts) ───────────── */

let sessionCounter = 0;
let receiptCounter = 0;

/**
 * Create a fixture checkout session. Amount must match the catalog.
 * @throws UNKNOWN_PRODUCT | INVALID_AMOUNT | TEST_MODE_VIOLATION
 */
export function createTestSession(
  productId,
  amountCents,
  options = {}
) {
  if (options.live === true || options.mode === "live" || options.mode === "production") {
    throw err(
      ERROR_CODES.TEST_MODE_VIOLATION,
      "live mode is forbidden — this example only simulates TEST payments."
    );
  }
  const product = PRODUCTS[productId];
  if (!product) {
    throw err(
      ERROR_CODES.UNKNOWN_PRODUCT,
      `unknown product "${productId}". Known: ${Object.keys(PRODUCTS).join(", ")}.`
    );
  }
  const amount = amountCents === undefined ? product.amountCents : amountCents;
  if (amount !== product.amountCents) {
    throw err(
      ERROR_CODES.INVALID_AMOUNT,
      `${productId} is priced at ${product.amountCents}¢ (got ${amount}¢).`
    );
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

/**
 * Confirm a one-time session with the test card.
 * Test-card convention: last4 `0002` is always declined.
 * @throws UNKNOWN_SESSION | DECLINED | TEST_MODE_VIOLATION
 */
export async function confirmTestPayment(
  sessionId,
  session,
  card = { last4: TEST_CARD.last4 },
  options = {}
) {
  if (options.live === true || options.mode === "live" || options.mode === "production") {
    throw err(
      ERROR_CODES.TEST_MODE_VIOLATION,
      "live mode is forbidden — this example only simulates TEST payments."
    );
  }
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_test_")) {
    throw err(
      ERROR_CODES.UNKNOWN_SESSION,
      "unknown checkout session — only cs_test_* fixtures can be paid."
    );
  }
  if (card && card.last4 === "0002") {
    throw err(ERROR_CODES.DECLINED, "card declined (test decline card).");
  }
  receiptCounter += 1;
  return {
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
}

/** Validate a receipt: succeeded, catalog-priced, unmistakably test-mode. */
export function isValidTestReceipt(receipt) {
  const r = receipt;
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

/* ── Test webhooks (mirrors lib/webhook-test.ts) ─────────────────── */

/**
 * Deterministic event id: `evt_test_` + 24 hex chars of HMAC(type:id).
 * Same inputs → same id; no randomness.
 */
export async function testEventId(type, objectId, secret = EXAMPLE_WEBHOOK_SECRET) {
  const digest = await hmacSha256Hex(secret, `${type}:${objectId}`);
  return `evt_test_${digest.slice(0, 24)}`;
}

/**
 * Sign a raw webhook body: `t=<created>,v1=<hmac>`.
 * @throws BAD_SIGNATURE if the secret is not a fixture key.
 */
export async function signTestWebhookPayload(rawBody, secret, created) {
  assertFixtureSecret(secret);
  const ts = created ?? Math.floor(Date.now() / 1000);
  const mac = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  return `t=${ts},v1=${mac}`;
}

/**
 * Build a signed webhook event for a fixture receipt. Deterministic id.
 */
export async function deliverTestWebhookEvent(
  type,
  receipt,
  opts = {}
) {
  const secret = opts.secret ?? EXAMPLE_WEBHOOK_SECRET;
  assertFixtureSecret(secret);
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const event = {
    id: await testEventId(type, receipt.id, secret),
    type,
    testMode: true,
    created,
    data: { object: receipt },
  };
  const rawBody = JSON.stringify(event);
  const signature = await signTestWebhookPayload(rawBody, secret, created);
  return { event, rawBody, signature };
}

/**
 * Verify a webhook signature. Returns false (never throws) for
 * malformed/absent signatures.
 */
export async function verifyTestWebhookSignature(rawBody, signature, secret) {
  try {
    assertFixtureSecret(secret);
  } catch {
    return false;
  }
  if (typeof signature !== "string") return false;
  const m = signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const ts = Number(m[1]);
  const expectedMac = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  const expected = `t=${ts},v1=${expectedMac}`;
  return compareHexConstantTime(expected, signature);
}

/** Event ids the example has already accepted — the replay ledger. */
const seenEventIds = new Set();

/**
 * Verify a delivered webhook and return the event — the unlock gate.
 * Rejects forged/stale/replayed/non-fixture events.
 * @throws BAD_SIGNATURE | EXPIRED_EVENT | REPLAYED_EVENT | BAD_EVENT
 */
export async function parseTestWebhookEvent(rawBody, signature, opts = {}) {
  const secret = opts.secret ?? EXAMPLE_WEBHOOK_SECRET;
  if (!(await verifyTestWebhookSignature(rawBody, signature, secret))) {
    throw err(
      ERROR_CODES.BAD_SIGNATURE,
      "webhook signature verification failed — refusing to trust this event."
    );
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw err(ERROR_CODES.BAD_EVENT, "webhook body is not valid JSON.");
  }
  if (
    !event ||
    typeof event !== "object" ||
    event.testMode !== true ||
    typeof event.id !== "string" ||
    !event.id.startsWith("evt_test_") ||
    typeof event.created !== "number"
  ) {
    throw err(
      ERROR_CODES.BAD_EVENT,
      "webhook event is not a test-mode fixture (missing evt_test_* id / testMode flag)."
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - event.created) > tolerance) {
    throw err(
      ERROR_CODES.EXPIRED_EVENT,
      `webhook event is outside the ${tolerance}s tolerance window — possible replay of a stale event.`
    );
  }
  if (seenEventIds.has(event.id)) {
    throw err(
      ERROR_CODES.REPLAYED_EVENT,
      `webhook event ${event.id} was already processed — refusing replay.`
    );
  }
  seenEventIds.add(event.id);
  return event;
}

/** Reset session/receipt counters and the replay ledger. Tests/example only. */
export function resetExampleFixtures() {
  sessionCounter = 0;
  receiptCounter = 0;
  seenEventIds.clear();
}
