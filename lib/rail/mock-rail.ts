// MockRail — a deterministic, in-memory RailAdapter for tests and UI spikes.
//
// This is NOT a real settlement rail. It exists so the payment flow
// (invoice → confirm → pay → receipt) can be built and tested end to end
// before a real rail is wired up. It never touches the network, never
// touches real funds, and has no dependencies.
//
// Rules it enforces (same rules a real adapter must enforce):
// - amounts are positive integers (no floats, no negatives, no zero)
// - an invoice can only be paid once (double-spend is rejected)
// - an invoice can only be paid while pending and unexpired
// - you cannot pay more than your available balance

import type {
  Balance,
  Invoice,
  InvoiceStatus,
  PaymentResult,
  PayInvoiceOptions,
  RailAdapter,
  RailEvent,
  Unsubscribe,
} from "./rail-adapter.ts";

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `amount must be a positive integer of minor units, got: ${amount}`,
    );
  }
}

let invoiceCounter = 0;
function nextId(): string {
  invoiceCounter += 1;
  return `mock-inv-${Date.now().toString(36)}-${invoiceCounter}`;
}

/**
 * One settled payment, appended exactly once per payment — never on an
 * idempotent replay. The journal is the rail's source of truth for "what
 * money moved"; `verifyLedger()` checks it against the balance.
 */
export interface LedgerEntry {
  readonly invoiceId: string;
  /** Integer minor units. */
  readonly amount: number;
  readonly unit: string;
  readonly settledAt: number;
  readonly proof: string;
  readonly idempotencyKey?: string;
}

export interface MockRailOptions {
  /** Starting balance in minor units. Defaults to 100_000. */
  startingBalance?: number;
  /** Unit label. Defaults to "sats". */
  unit?: string;
  /** Invoice lifetime in ms. Defaults to 15 minutes. */
  invoiceTtlMs?: number;
}

export class MockRail implements RailAdapter {
  readonly id = "mock";
  readonly displayName = "Mock rail (test only — no real funds)";
  readonly unit: string;

  private balance: number;
  private readonly startingBalance: number;
  private readonly invoices = new Map<string, Invoice>();
  private readonly listeners = new Map<RailEvent, Set<(r: PaymentResult) => void>>();
  private readonly invoiceTtlMs: number;
  /**
   * Idempotency ledger: key → the settled result of the attempt it
   * named. A retry carrying the same key for the same invoice returns
   * the stored result WITHOUT touching balances or the journal again.
   */
  private readonly idempotency = new Map<string, PaymentResult>();
  private readonly idempotencyInvoice = new Map<string, string>();
  /** Append-only settlement journal. One entry per payment, never per replay. */
  private readonly journal: LedgerEntry[] = [];

  constructor(options: MockRailOptions = {}) {
    const startingBalance = options.startingBalance ?? 100_000;
    assertAmount(startingBalance);
    this.balance = startingBalance;
    this.startingBalance = startingBalance;
    this.unit = options.unit ?? "sats";
    this.invoiceTtlMs = options.invoiceTtlMs ?? 15 * 60 * 1000;
  }

  private withStatus(invoice: Invoice, status: InvoiceStatus): Invoice {
    const updated: Invoice = { ...invoice, status };
    this.invoices.set(invoice.id, updated);
    return updated;
  }

  private live(invoice: Invoice): Invoice {
    if (invoice.status === "pending" && Date.now() > invoice.expiresAt) {
      return this.withStatus(invoice, "expired");
    }
    return invoice;
  }

  private emit(event: RailEvent, result: PaymentResult): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(result);
    }
  }

  async createInvoice(amount: number, memo?: string): Promise<Invoice> {
    assertAmount(amount);
    const now = Date.now();
    const invoice: Invoice = {
      id: nextId(),
      amount,
      unit: this.unit,
      memo,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.invoiceTtlMs,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    return invoice ? this.live(invoice) : null;
  }

  async cancelInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new Error(`unknown invoice: ${invoiceId}`);
    }
    const current = this.live(invoice);
    if (current.status !== "pending") {
      throw new Error(`cannot cancel invoice in status ${current.status}`);
    }
    return this.withStatus(current, "cancelled");
  }

  async payInvoice(
    invoiceId: string,
    opts: PayInvoiceOptions = {},
  ): Promise<PaymentResult> {
    const { idempotencyKey } = opts;

    // Idempotent retry: same key + same invoice → replay the original
    // result with NO state change. No second debit, no second event.
    if (idempotencyKey !== undefined) {
      const seen = this.idempotency.get(idempotencyKey);
      if (seen) {
        const seenInvoice = this.idempotencyInvoice.get(idempotencyKey);
        if (seenInvoice === invoiceId) {
          return seen;
        }
        throw new Error(
          `idempotency key reused for a different invoice: key was for ${seenInvoice}, now ${invoiceId}`,
        );
      }
    }

    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new Error(`unknown invoice: ${invoiceId}`);
    }
    const current = this.live(invoice);
    if (current.status === "paid") {
      throw new Error(`invoice already paid: ${invoiceId}`);
    }
    if (current.status !== "pending") {
      throw new Error(`cannot pay invoice in status ${current.status}`);
    }
    if (current.amount > this.balance) {
      throw new Error(
        `insufficient balance: need ${current.amount} ${this.unit}, have ${this.balance}`,
      );
    }
    this.balance -= current.amount;
    this.withStatus(current, "paid");
    const result: PaymentResult = {
      invoiceId: current.id,
      amount: current.amount,
      unit: this.unit,
      proof: `mock-proof-${current.id}`,
      confirmations: 1,
      settledAt: Date.now(),
    };
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, result);
      this.idempotencyInvoice.set(idempotencyKey, invoiceId);
    }
    this.journal.push({
      invoiceId: current.id,
      amount: current.amount,
      unit: this.unit,
      settledAt: result.settledAt,
      proof: result.proof,
      idempotencyKey,
    });
    this.emit("invoice-paid", result);
    return result;
  }

  async getBalance(): Promise<Balance> {
    return { total: this.balance, available: this.balance, unit: this.unit };
  }

  /**
   * The append-only settlement journal: one entry per payment, in
   * settlement order. Returned as a copy — the rail's history is not
   * writable from outside.
   */
  getLedger(): readonly LedgerEntry[] {
    return [...this.journal];
  }

  /**
   * Ledger consistency check. Throws on the first violated invariant:
   *   1. every journal amount is a positive integer of minor units
   *   2. no invoice appears twice (one settlement per invoice, ever)
   *   3. sum(journal amounts) + balance === startingBalance (no money
   *      created or destroyed outside a recorded payment)
   *   4. every journaled invoice exists and is in "paid" status
   *
   * Run this after any batch of payments — a green check means the
   * balance is fully explained by recorded settlements.
   */
  verifyLedger(): void {
    const seen = new Set<string>();
    let settled = 0;
    for (const entry of this.journal) {
      if (!Number.isInteger(entry.amount) || entry.amount <= 0) {
        throw new Error(`ledger corrupt: invalid amount on ${entry.invoiceId}`);
      }
      if (seen.has(entry.invoiceId)) {
        throw new Error(`ledger corrupt: duplicate settlement of ${entry.invoiceId}`);
      }
      seen.add(entry.invoiceId);
      const invoice = this.invoices.get(entry.invoiceId);
      if (!invoice) {
        throw new Error(`ledger corrupt: settlement for unknown invoice ${entry.invoiceId}`);
      }
      if (this.live(invoice).status !== "paid") {
        throw new Error(
          `ledger corrupt: journaled invoice ${entry.invoiceId} is not paid`,
        );
      }
      settled += entry.amount;
    }
    if (settled + this.balance !== this.startingBalance) {
      throw new Error(
        `ledger corrupt: settled ${settled} + balance ${this.balance} != starting ${this.startingBalance}`,
      );
    }
  }

  on(event: RailEvent, listener: (result: PaymentResult) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}
