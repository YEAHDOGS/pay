// End-to-end regression test: the divorce $30 staging checkout through
// the hardened settlement rail.
//
// This is the first real consumer's happy path, in minor units, with
// every guard the server must run before unlocking the printable packet:
//
//   1. server prices the packet at 3000 (cents) from its OWN records
//   2. rail invoices + settles, with an idempotency key per checkout
//   3. the response is "lost" → payer retries → same result, no double charge
//   4. amount-tamper guard compares rail result vs invoice vs server expectation
//   5. ledger consistency check explains the balance from the journal
//
// Zero dependencies — uses only node:test.

import test from "node:test";
import assert from "node:assert/strict";

import { MockRail } from "./mock-rail.ts";
import { assertPaymentMatches } from "./payment-guard.ts";

/** Server-side constant: the divorce uncontested packet price. */
const DIVORCE_PACKET_CENTS = 3000;

test("e2e: divorce $30 staging checkout, lost response, no double charge", async () => {
  const rail = new MockRail({ startingBalance: 50_000, unit: "cents" });

  // 1. server issues the invoice for the packet price
  const invoice = await rail.createInvoice(DIVORCE_PACKET_CENTS, "divorce packet");

  // 2. payer pays; the idempotency key names this checkout attempt
  const key = `divorce-checkout-${invoice.id}`;
  const result = await rail.payInvoice(invoice.id, { idempotencyKey: key });

  // 3. response lost in transit → retry with the same key
  const retry = await rail.payInvoice(invoice.id, { idempotencyKey: key });
  assert.equal(retry, result, "retry replays the original settlement");

  // 4. server verifies before unlocking the packet
  const settled = await rail.getInvoice(invoice.id);
  assert.ok(settled);
  assert.doesNotThrow(() =>
    assertPaymentMatches(settled, retry, {
      invoiceId: invoice.id,
      amount: DIVORCE_PACKET_CENTS,
      unit: "cents",
    }),
  );

  // 5. ledger fully explains the balance: exactly one 3000 entry
  assert.doesNotThrow(() => rail.verifyLedger());
  assert.equal(rail.getLedger().length, 1);
  assert.equal((await rail.getBalance()).available, 47_000);

  // packet would unlock here
});

test("e2e: swapped receipt for a cheaper invoice does not unlock the packet", async () => {
  const rail = new MockRail({ startingBalance: 50_000, unit: "cents" });

  const packetInvoice = await rail.createInvoice(DIVORCE_PACKET_CENTS, "divorce packet");
  const cheapInvoice = await rail.createInvoice(100, "something else");
  const cheapResult = await rail.payInvoice(cheapInvoice.id);

  // Attacker never paid the packet invoice; presents the cheap receipt.
  const settled = await rail.getInvoice(packetInvoice.id);
  assert.ok(settled);
  assert.equal(settled.status, "pending");
  assert.throws(
    () =>
      assertPaymentMatches(settled, cheapResult, {
        invoiceId: packetInvoice.id,
        amount: DIVORCE_PACKET_CENTS,
        unit: "cents",
      }),
    /payment rejected/,
    "the packet stays locked",
  );
});
