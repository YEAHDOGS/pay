/**
 * refund-ledger.ts — TEST-MODE-ONLY refund + reversal safety.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * A payment rail without refund safety is a money-losing bug waiting
 * to happen: a refund webhook redelivered twice must never refund
 * twice, a refund bigger than the capture must never apply, and a
 * refund with no capture must never be invented out of thin air.
 *
 * This module is the money guard rail:
 *
 *   capture  — a `record_payment` capture of payment `p` for N cents.
 *   refund   — a reversal of M ≤ (captured − already-refunded) cents
 *              against the SAME payment id, keyed by refund id.
 *
 *   const after = applyRefundLedgerEntry(ledger, refundEntry);
 *   netCaptured(ledger, "rcpt_test_000001"); // captured − refunded
 *
 * Guarantees by construction:
 *   - Pure functions, zero IO, zero deps. Same inputs → same ledger.
 *   - Idempotent by refund id: re-applying an already-recorded refund
 *     id is a no-op that returns the ledger unchanged — a redelivered
 *     (or re-emitted under a new event id) refund can never
 *     double-apply. Only an EXACT record of a new refund id appends.
 *   - Sum-checked: cumulative refunds for a payment can never exceed
 *     what was captured for it — an over-refund throws OVER_REFUND
 *     and the ledger is unchanged. Partial refunds sum: 1200 + 800
 *     against 3000 captured is fine; a third 1000 is refused.
 *   - Capture first: a refund against a payment id with no capture
 *     entry throws REFUND_BEFORE_CAPTURE — reversals are linked to
 *     the original payment, never conjured.
 *   - Reversal entries link back: every refund entry carries the
 *     original `paymentId`, so the ledger reads as a full
 *     money-movement history per payment.
 *   - Amounts are integer cents, never floats; currency must match
 *     the capture — a cross-currency refund throws CURRENCY_MISMATCH.
 *   - Non-positive amounts throw BAD_AMOUNT at the door.
 *   - Test-mode fixtures only: refund ids must be `rfnd_test_*`,
 *     payment ids `rcpt_test_*`, testMode: true.
 */

import { fixtureSha256 } from "./webhook-test";

/* ── Hoisted constants ───────────────────────────────────────────── */

export const REFUND_ERROR_CODES = Object.freeze({
  /** A refund id (or capture) was already recorded — replay, not an error the caller should retry. */
  DUPLICATE_REFUND: "DUPLICATE_REFUND",
  /** Refund against a payment with no capture entry. */
  REFUND_BEFORE_CAPTURE: "REFUND_BEFORE_CAPTURE",
  /** Cumulative refunds would exceed the captured amount. */
  OVER_REFUND: "OVER_REFUND",
  /** Refund currency differs from the capture's currency. */
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  /** Non-positive or non-integer amount; malformed entry/refund. */
  BAD_AMOUNT: "BAD_AMOUNT",
  BAD_ENTRY: "BAD_ENTRY",
});

/**
 * A test-mode refund fixture: the processor's reversal claim.
 * `id` is the processor's refund id — the idempotency key.
 */
export interface TestRefund {
  readonly id: string; // rfnd_test_*
  /** The original payment this reverses — the link back. rcpt_test_* */
  readonly paymentId: string;
  /** Integer cents, > 0. */
  readonly amountCents: number;
  readonly currency: string;
  /** ISO timestamp the refund was issued. */
  readonly refundedAt: string;
  readonly testMode: true;
}

/** One money-movement line in the ledger. */
export type RefundLedgerEntry =
  | {
      readonly kind: "capture";
      /** rcpt_test_* — the captured payment. */
      readonly paymentId: string;
      readonly amountCents: number;
      readonly currency: string;
      /** The event id that earned the capture (evt_test_*). */
      readonly eventId: string;
    }
  | {
      readonly kind: "refund";
      /** rfnd_test_* — the refund's own id, the dedupe key. */
      readonly refundId: string;
      /** rcpt_test_* — the original payment this reverses. */
      readonly paymentId: string;
      readonly amountCents: number;
      readonly currency: string;
      /** The event id that carried the refund (evt_test_*). */
      readonly eventId: string;
    };

export interface RefundLedger {
  readonly entries: readonly RefundLedgerEntry[];
  readonly testMode: true;
}

function err(code: string, message: string): Error {
  const e = new Error(`refund-ledger: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/* ── Fixture builders + validators ───────────────────────────────── */

let refundCounter = 0;

/**
 * Issue a test refund against a captured payment fixture. Partial
 * refunds are the norm: pass any amountCents ≤ the capture — the
 * LEDGER (not the fixture builder) enforces the sum check, so a drill
 * can plant an over-refund deterministically.
 */
export function issueTestRefund(args: {
  /** The original payment id — must be an rcpt_test_* fixture. */
  paymentId: string;
  amountCents: number;
  currency?: string;
}): TestRefund {
  const { paymentId, amountCents } = args;
  const currency = args.currency ?? "usd";
  if (typeof paymentId !== "string" || !paymentId.startsWith("rcpt_test_")) {
    throw err(
      REFUND_ERROR_CODES.BAD_ENTRY,
      "issueTestRefund needs a paymentId that is an rcpt_test_* fixture."
    );
  }
  assertPositiveCents(amountCents, "issueTestRefund");
  refundCounter += 1;
  return {
    id: `rfnd_test_${String(refundCounter).padStart(6, "0")}`,
    paymentId,
    amountCents,
    currency,
    refundedAt: new Date().toISOString(),
    testMode: true,
  };
}

/**
 * Validate a refund fixture: unmistakably test-mode, positively-priced,
 * linked to a test payment. Does NOT check the ledger — a valid
 * fixture can still be an over-refund; that is `applyRefund`'s job.
 */
export function isValidTestRefund(refund: unknown): refund is TestRefund {
  const r = refund as Partial<TestRefund> | null;
  if (!r || typeof r !== "object") return false;
  // Destructure into consts: property-access narrowing is invalidated
  // by the method calls below, const locals narrow cleanly.
  const { id, paymentId, amountCents, currency, refundedAt, testMode } = r;
  return (
    testMode === true &&
    typeof id === "string" &&
    id.startsWith("rfnd_test_") &&
    typeof paymentId === "string" &&
    paymentId.startsWith("rcpt_test_") &&
    typeof amountCents === "number" &&
    Number.isInteger(amountCents) &&
    amountCents > 0 &&
    typeof currency === "string" &&
    currency.length > 0 &&
    typeof refundedAt === "string"
  );
}

function assertPositiveCents(amountCents: unknown, where: string): void {
  if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
    throw err(
      REFUND_ERROR_CODES.BAD_AMOUNT,
      `${where}: amountCents must be a positive integer — never zero, negative, or float.`
    );
  }
}

function assertEntry(entry: unknown): asserts entry is RefundLedgerEntry {
  const e = entry as Partial<RefundLedgerEntry> | null;
  if (!e || typeof e !== "object" || (e.kind !== "capture" && e.kind !== "refund")) {
    throw err(
      REFUND_ERROR_CODES.BAD_ENTRY,
      "ledger entry must be a {kind: capture|refund} record."
    );
  }
  if (
    typeof e.paymentId !== "string" ||
    !e.paymentId.startsWith("rcpt_test_") ||
    typeof e.currency !== "string" ||
    e.currency.length === 0 ||
    typeof e.eventId !== "string" ||
    !e.eventId.startsWith("evt_test_")
  ) {
    throw err(
      REFUND_ERROR_CODES.BAD_ENTRY,
      "ledger entry needs (paymentId: rcpt_test_*, currency, eventId: evt_test_*)."
    );
  }
  if (e.kind === "refund") {
    if (typeof e.refundId !== "string" || !e.refundId.startsWith("rfnd_test_")) {
      throw err(
        REFUND_ERROR_CODES.BAD_ENTRY,
        "refund entry needs a refundId (rfnd_test_*)."
      );
    }
  }
  assertPositiveCents(e.amountCents, "ledger entry");
}

/** A refund event's deterministic payload fingerprint — evidence, not a secret. */
export function refundFingerprint(refund: TestRefund): string {
  return fixtureSha256(
    JSON.stringify({
      id: refund.id,
      paymentId: refund.paymentId,
      amountCents: refund.amountCents,
      currency: refund.currency,
    })
  );
}

/* ── The pure ledger ─────────────────────────────────────────────── */

/** An empty ledger. Test-harness only — a live route persists this. */
export function emptyRefundLedger(): RefundLedger {
  return { entries: [], testMode: true };
}

function assertLedger(ledger: unknown): asserts ledger is RefundLedger {
  const l = ledger as Partial<RefundLedger> | null;
  if (!l || typeof l !== "object" || l.testMode !== true || !Array.isArray(l.entries)) {
    throw err(
      REFUND_ERROR_CODES.BAD_ENTRY,
      "refund-ledger: expected a RefundLedger ({entries, testMode: true})."
    );
  }
  for (const e of l.entries) assertEntry(e);
}

/** Result of applying one entry: the new ledger + whether it appended. */
export interface ApplyRefundResult {
  readonly ledger: RefundLedger;
  /**
   * False when the entry was a replay of an already-recorded refund id
   * — the ledger is returned UNCHANGED, and the caller must not
   * produce a second effect.
   */
  readonly applied: boolean;
}

/**
 * Append one money-movement entry. Pure: never mutates the input
 * ledger; returns the new one. Guards, in order:
 *
 *   1. capture for an already-captured paymentId → DUPLICATE_REFUND
 *      (a payment captures once; a second capture is a bug, not a
 *      second payment);
 *   2. refund for an unknown paymentId → REFUND_BEFORE_CAPTURE;
 *   3. refund id already recorded → idempotent no-op (applied: false);
 *   4. refund currency ≠ capture currency → CURRENCY_MISMATCH;
 *   5. cumulative refunds + this refund > captured → OVER_REFUND.
 *
 * On any throw the ledger is unchanged — the caller can retry with
 * corrected input without a half-written book.
 */
export function applyRefundLedgerEntry(
  ledger: RefundLedger,
  entry: RefundLedgerEntry
): ApplyRefundResult {
  assertLedger(ledger);
  assertEntry(entry);

  if (entry.kind === "capture") {
    if (ledger.entries.some((e) => e.kind === "capture" && e.paymentId === entry.paymentId)) {
      throw err(
        REFUND_ERROR_CODES.DUPLICATE_REFUND,
        `payment ${entry.paymentId} already captured — refusing a second capture.`
      );
    }
    return {
      ledger: { entries: [...ledger.entries, entry], testMode: true },
      applied: true,
    };
  }

  // ── refund path ──
  const capture = ledger.entries.find(
    (e): e is Extract<RefundLedgerEntry, { kind: "capture" }> =>
      e.kind === "capture" && e.paymentId === entry.paymentId
  );
  if (!capture) {
    throw err(
      REFUND_ERROR_CODES.REFUND_BEFORE_CAPTURE,
      `refund ${entry.refundId} targets ${entry.paymentId} with no capture — refusing to conjure a reversal.`
    );
  }
  // Idempotency by refund id: an already-recorded refund id is a
  // replay — the ledger comes back UNCHANGED, never double-applied.
  if (
    ledger.entries.some(
      (e) => e.kind === "refund" && e.refundId === entry.refundId
    )
  ) {
    return { ledger, applied: false };
  }
  if (entry.currency !== capture.currency) {
    throw err(
      REFUND_ERROR_CODES.CURRENCY_MISMATCH,
      `refund ${entry.refundId} is ${entry.currency} but capture ${entry.paymentId} is ${capture.currency}.`
    );
  }
  const refundedSoFar = totalRefunded(ledger, entry.paymentId);
  if (refundedSoFar + entry.amountCents > capture.amountCents) {
    throw err(
      REFUND_ERROR_CODES.OVER_REFUND,
      `refund ${entry.refundId} of ${entry.amountCents} would exceed capture ` +
        `${entry.paymentId} (${capture.amountCents}; already refunded ${refundedSoFar}).`
    );
  }
  return {
    ledger: { entries: [...ledger.entries, entry], testMode: true },
    applied: true,
  };
}

/** Total cents refunded against one payment. 0 when unknown. */
export function totalRefunded(ledger: RefundLedger, paymentId: string): number {
  assertLedger(ledger);
  return ledger.entries
    .filter((e) => e.kind === "refund" && e.paymentId === paymentId)
    .reduce((sum, e) => sum + e.amountCents, 0);
}

/**
 * Net captured cents for one payment: captured minus all refunds.
 * Unknown payment → 0. Never negative — the sum-check in
 * `applyRefundLedgerEntry` makes that structurally impossible.
 */
export function netCaptured(ledger: RefundLedger, paymentId: string): number {
  assertLedger(ledger);
  const capture = ledger.entries.find(
    (e) => e.kind === "capture" && e.paymentId === paymentId
  );
  if (!capture) return 0;
  return capture.amountCents - totalRefunded(ledger, paymentId);
}

/**
 * All refund entries linked to one payment, in ledger order — the
 * reversal history of the original payment id.
 */
export function refundsFor(
  ledger: RefundLedger,
  paymentId: string
): Extract<RefundLedgerEntry, { kind: "refund" }>[] {
  assertLedger(ledger);
  return ledger.entries.filter(
    (e): e is Extract<RefundLedgerEntry, { kind: "refund" }> =>
      e.kind === "refund" && e.paymentId === paymentId
  );
}
