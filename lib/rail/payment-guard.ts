// payment-guard.ts — amount-tamper rejection for checkout handlers.
//
// The rail settles money; the SERVER decides what unlocks the
// deliverable (divorce packet, wax alerts). The guard is the check the
// server runs on the rail's PaymentResult BEFORE it unlocks anything:
//
//   const invoice = await rail.createInvoice(3000, "divorce packet");
//   const result  = await rail.payInvoice(invoice.id, { idempotencyKey });
//   assertPaymentMatches(invoice, result, { invoiceId: invoice.id, amount: 3000, unit: "sats" });
//   // → only now render the packet
//
// It rejects every classic tamper: a result that under-reports the
// amount, a result swapped in from a different (cheaper) invoice, a
// unit swap (3000 "cents" vs 3000 "sats"), or a result for an invoice
// that isn't actually paid on the rail. Zero dependencies.

import type { Invoice, PaymentResult } from "./rail-adapter.ts";

/**
 * What the server expected to be paid, from ITS OWN records — never
 * from client-supplied input. The guard compares the rail's report
 * against both the created invoice and this expectation.
 */
export interface ExpectedPayment {
  /** The invoice id the server issued for this checkout. */
  readonly invoiceId: string;
  /** Integer minor units the server charged (e.g. 3000 for the $30 packet). */
  readonly amount: number;
  /** Unit the server priced in (e.g. "sats", "cents"). */
  readonly unit: string;
}

/**
 * Throws if `result` does not exactly match BOTH the rail's invoice
 * and the server's expectation. Returns void on success.
 *
 * Rejects: amount mismatch (under- OR over-report), invoice id swap,
 * unit swap, unpaid/non-paid invoice, non-integer amounts.
 */
export function assertPaymentMatches(
  invoice: Invoice,
  result: PaymentResult,
  expected: ExpectedPayment,
): void {
  if (invoice.status !== "paid") {
    throw new Error(
      `payment rejected: invoice ${invoice.id} is ${invoice.status}, not paid`,
    );
  }
  if (result.invoiceId !== invoice.id) {
    throw new Error(
      `payment rejected: result is for invoice ${result.invoiceId}, invoice is ${invoice.id}`,
    );
  }
  if (result.invoiceId !== expected.invoiceId) {
    throw new Error(
      `payment rejected: expected invoice ${expected.invoiceId}, got ${result.invoiceId}`,
    );
  }
  if (!Number.isInteger(result.amount) || result.amount <= 0) {
    throw new Error(`payment rejected: invalid result amount ${result.amount}`);
  }
  if (result.amount !== invoice.amount) {
    throw new Error(
      `payment rejected: rail settled ${result.amount} ${result.unit}, invoice billed ${invoice.amount} ${invoice.unit}`,
    );
  }
  if (result.amount !== expected.amount) {
    throw new Error(
      `payment rejected: rail settled ${result.amount} ${result.unit}, server expected ${expected.amount} ${expected.unit}`,
    );
  }
  if (result.unit !== expected.unit || invoice.unit !== expected.unit) {
    throw new Error(
      `payment rejected: unit mismatch (result ${result.unit}, invoice ${invoice.unit}, expected ${expected.unit})`,
    );
  }
}
