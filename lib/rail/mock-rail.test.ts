// Regression tests for MockRail (and the RailAdapter contract).
// Run with: node --test "lib/**/*.test.ts"   (also `npm test`)
// Zero dependencies — uses only node:test.

import test from "node:test";
import assert from "node:assert/strict";

import { MockRail } from "./mock-rail.ts";
import type { RailAdapter } from "./rail-adapter.ts";

function rail(options: ConstructorParameters<typeof MockRail>[0] = {}): RailAdapter {
  return new MockRail(options);
}

test("createInvoice returns a pending invoice with the requested amount", async () => {
  const r = rail();
  const inv = await r.createInvoice(5000, "coffee");
  assert.equal(inv.status, "pending");
  assert.equal(inv.amount, 5000);
  assert.equal(inv.unit, "sats");
  assert.equal(inv.memo, "coffee");
  assert.ok(inv.expiresAt > inv.createdAt);
});

test("getInvoice round-trips a created invoice, null for unknown ids", async () => {
  const r = rail();
  const inv = await r.createInvoice(100);
  assert.deepEqual(await r.getInvoice(inv.id), inv);
  assert.equal(await r.getInvoice("nope"), null);
});

test("payInvoice debits balance exactly once and emits invoice-paid", async () => {
  const r = rail({ startingBalance: 10_000 });
  const events: unknown[] = [];
  const unsub = r.on("invoice-paid", (p) => events.push(p));

  const inv = await r.createInvoice(2500);
  const result = await r.payInvoice(inv.id);

  assert.equal(result.invoiceId, inv.id);
  assert.equal(result.amount, 2500);
  assert.equal((await r.getBalance()).available, 7500);
  assert.equal((await r.getInvoice(inv.id))!.status, "paid");
  assert.equal(events.length, 1);

  unsub();
});

test("payInvoice rejects double payment (no double-spend)", async () => {
  const r = rail();
  const inv = await r.createInvoice(1000);
  await r.payInvoice(inv.id);
  await assert.rejects(() => r.payInvoice(inv.id), /already paid/);
});

test("payInvoice rejects insufficient balance", async () => {
  const r = rail({ startingBalance: 500 });
  const inv = await r.createInvoice(501);
  await assert.rejects(() => r.payInvoice(inv.id), /insufficient balance/);
  // balance untouched, invoice still pending
  assert.equal((await r.getBalance()).available, 500);
  assert.equal((await r.getInvoice(inv.id))!.status, "pending");
});

test("payInvoice rejects unknown and cancelled invoices", async () => {
  const r = rail();
  await assert.rejects(() => r.payInvoice("ghost"), /unknown invoice/);

  const inv = await r.createInvoice(100);
  await r.cancelInvoice(inv.id);
  await assert.rejects(() => r.payInvoice(inv.id), /cancelled/);
  await assert.rejects(() => r.cancelInvoice(inv.id), /cancelled/);
});

test("expired invoices cannot be paid", async () => {
  const r = rail({ invoiceTtlMs: 1 });
  const inv = await r.createInvoice(100);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await r.getInvoice(inv.id))!.status, "expired");
  await assert.rejects(() => r.payInvoice(inv.id), /expired/);
});

test("amount validation rejects non-integers, zero, negatives, NaN, Infinity", async () => {
  const r = rail();
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(() => r.createInvoice(bad), /positive integer/, `amount ${bad}`);
  }
  assert.throws(() => new MockRail({ startingBalance: 0 }), /positive integer/);
});

test("full lifecycle: create → pay → balance and event consistency", async () => {
  const r = rail({ startingBalance: 100_000 });
  let paidTotal = 0;
  r.on("invoice-paid", (p) => {
    paidTotal += p.amount;
  });

  for (const amount of [10_000, 20_000, 30_000]) {
    const inv = await r.createInvoice(amount);
    await r.payInvoice(inv.id);
  }
  const balance = await r.getBalance();
  assert.equal(balance.total, 40_000);
  assert.equal(paidTotal, 60_000);
});
