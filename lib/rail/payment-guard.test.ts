// Regression tests for payment-guard.ts (amount-tamper rejection).
// Run with: bun test lib   (also node --test "lib/rail/**/*.test.ts")
// Zero dependencies — uses only node:test.

import test from "node:test";
import assert from "node:assert/strict";

import { MockRail } from "./mock-rail.ts";
import { assertPaymentMatches } from "./payment-guard.ts";
import type { Invoice } from "./rail-adapter.ts";

async function paidInvoice(amount: number, unit = "sats") {
  const rail = new MockRail({ startingBalance: 1_000_000, unit });
  const invoice = await rail.createInvoice(amount, "test");
  const result = await rail.payInvoice(invoice.id, { idempotencyKey: "k" });
  const paid = (await rail.getInvoice(invoice.id)) as Invoice;
  return { rail, invoice: paid, result };
}

test("assertPaymentMatches accepts an exact payment", async () => {
  const { invoice, result } = await paidInvoice(3000);
  assert.doesNotThrow(() =>
    assertPaymentMatches(invoice, result, {
      invoiceId: invoice.id,
      amount: 3000,
      unit: "sats",
    }),
  );
});

test("assertPaymentMatches rejects an under-reported amount", async () => {
  const { invoice, result } = await paidInvoice(3000);
  assert.throws(
    () =>
      assertPaymentMatches(
        invoice,
        { ...result, amount: 2999 },
        { invoiceId: invoice.id, amount: 3000, unit: "sats" },
      ),
    /rail settled 2999/,
  );
});

test("assertPaymentMatches rejects a result swapped from a cheaper invoice", async () => {
  const cheap = await paidInvoice(100);
  const pricey = await paidInvoice(3000);
  // Attacker presents the cheap invoice's result against the 3000 invoice.
  assert.throws(
    () =>
      assertPaymentMatches(pricey.invoice, cheap.result, {
        invoiceId: pricey.invoice.id,
        amount: 3000,
        unit: "sats",
      }),
    /result is for invoice/,
  );
});

test("assertPaymentMatches rejects a unit swap", async () => {
  const { invoice, result } = await paidInvoice(3000, "cents");
  assert.throws(
    () =>
      assertPaymentMatches(invoice, result, {
        invoiceId: invoice.id,
        amount: 3000,
        unit: "sats",
      }),
    /unit mismatch/,
  );
});

test("assertPaymentMatches rejects when the invoice is not paid", async () => {
  const rail = new MockRail({ startingBalance: 1_000_000 });
  const invoice = await rail.createInvoice(3000);
  const fake = {
    invoiceId: invoice.id,
    amount: 3000,
    unit: "sats",
    proof: "fake",
    confirmations: 1,
    settledAt: Date.now(),
  };
  assert.throws(
    () =>
      assertPaymentMatches(invoice, fake, {
        invoiceId: invoice.id,
        amount: 3000,
        unit: "sats",
      }),
    /not paid/,
  );
});

test("assertPaymentMatches rejects a server-expectation mismatch", async () => {
  const { invoice, result } = await paidInvoice(3000);
  assert.throws(
    () =>
      assertPaymentMatches(invoice, result, {
        invoiceId: invoice.id,
        amount: 2500,
        unit: "sats",
      }),
    /server expected 2500/,
  );
});
