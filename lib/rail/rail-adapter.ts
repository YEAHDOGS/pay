// RailAdapter — the pluggable settlement interface from docs/ARCHITECTURE.md.
//
// Every settlement rail (Lightning, stablecoin L2, …) implements this.
// The UI only ever talks to this interface, never to a rail directly.
//
// Design notes:
// - Amounts are integer minor units (e.g. sats). No floats cross this
//   boundary — floating-point money math is how funds get lost.
// - All methods are async: real rails hit the network. The in-memory
//   MockRail in ./mock-rail.ts implements the same contract for tests.
// - A rail never sees keys. It moves value authorized by WalletCore
//   signatures; signing happens one layer up.

export type InvoiceStatus = "pending" | "paid" | "expired" | "cancelled";

export interface Invoice {
  readonly id: string;
  /** Integer minor units (e.g. sats). Always > 0. */
  readonly amount: number;
  readonly unit: string;
  readonly memo?: string;
  readonly status: InvoiceStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PaymentResult {
  readonly invoiceId: string;
  readonly amount: number;
  readonly unit: string;
  /** Rail-specific settlement proof (txid, preimage, …). Opaque to the UI. */
  readonly proof: string;
  readonly confirmations: number;
  readonly settledAt: number;
}

export interface Balance {
  /** Integer minor units. */
  readonly total: number;
  readonly available: number;
  readonly unit: string;
}

export type RailEvent = "invoice-paid";

/** Unsubscribe function returned by `on`. */
export type Unsubscribe = () => void;

export interface RailAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly unit: string;

  createInvoice(amount: number, memo?: string): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>;
  payInvoice(invoiceId: string): Promise<PaymentResult>;
  cancelInvoice(invoiceId: string): Promise<Invoice>;
  getBalance(): Promise<Balance>;

  /** Subscribe to rail events. Returns an unsubscribe function. */
  on(event: RailEvent, listener: (result: PaymentResult) => void): Unsubscribe;
}
