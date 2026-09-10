# Architecture

`pay` is a **client-side-first** p2p payments app. There is no backend that
touches money, keys, or plaintext transaction data. The "platform" is a set of
protocols plus a reference web client (this repo).

## Design principles

1. **Non-custodial or nothing.** If a component requires trusting a server with
   funds or keys, it does not ship.
2. **Local-first.** State lives on the device (IndexedDB); the network is a
   transport, not a database.
3. **Pluggable settlement.** The UX (request → approve → send → confirm) is
   rail-agnostic. Rails are adapters behind one interface.
4. **Progressive decentralization.** Ship v0.1 with pragmatic central points
   (e.g. a default relay list), but every one of them must be replaceable by the
   user. No hard-coded single point of failure.
5. **No surveillance business model.** No analytics on payment activity, no ad
   SDKs, no third-party trackers in the client.

## Layers

```
┌─────────────────────────────────────────────────────┐
│ UI (Next.js app)                                    │
│  screens: home, send, request, activity, contacts   │
├─────────────────────────────────────────────────────┤
│ Wallet core (pure TS, no DOM)                       │
│  keystore · signing · address book · tx history     │
├─────────────────────────────────────────────────────┤
│ Identity layer                                      │
│  handle → pubkey resolution (pluggable resolvers)    │
├─────────────────────────────────────────────────────┤
│ Transport layer                                     │
│  encrypted messaging: invoices, receipts, presence  │
├─────────────────────────────────────────────────────┤
│ Settlement adapters                                 │
│  RailAdapter interface → concrete rail(s)           │
└─────────────────────────────────────────────────────┘
```

### Wallet core

- Keys generated with Web Crypto (`Ed25519` where supported, `secp256k1`
  fallback for rail compatibility), stored encrypted in IndexedDB via a
  user passphrase (Argon2id KDF → AES-GCM).
- `WalletCore` is framework-free TypeScript so it can later run in a mobile
  shell, CLI, or browser extension without rewrites.
- Recovery: BIP-39-style mnemonic, shown once, verified by re-entry.

### Identity

Handles like `founder.pay` map to public keys. Resolver priority (user can
reorder or disable any):

1. **Local address book** — explicit mappings the user saved (always trusted).
2. **DHT / decentralized name system** — no central registrar.
3. **Fallback resolver** — pragmatic default for v0.1; user-replaceable.

The UI must show *which* resolver answered and its trust level before the user
confirms a payment. Handle-squatting and impersonation are the #1 UX risk —
see SECURITY.md.

### Transport

Payment requests, invoices, and receipts are end-to-end encrypted messages
(X25519 + XSalsa20-Poly1305 style sealed boxes) between the two parties'
keys. v0.1 can use a small set of default relays (Nostr-style); the client
lets the user add their own relays and run their own. Relays see ciphertext
and routing metadata only.

### Settlement adapters

```ts
interface RailAdapter {
  readonly id: string;            // e.g. "lightning", "onchain-btc"
  readonly displayName: string;
  readonly unit: string;          // e.g. "sats"
  createInvoice(amount, memo): Promise<Invoice>;
  payInvoice(invoice): Promise<PaymentResult>;
  getBalance(): Promise<Balance>;
  // …events for confirmations
}
```

The first rail should be the simplest one that demonstrates real p2p value
transfer. Candidates: Bitcoin Lightning (fast, cheap, mature tooling) or a
stablecoin on a low-fee L2. Decision to be made in the v0.1 milestone —
document the trade-off in the PR that adds the adapter.

## Data model (client-local)

- `contacts` — handle, pubkey, resolver used, trust flags, labels
- `invoices` — id, counterparty, amount, memo, status, timestamps
- `payments` — invoice ref, rail, tx/secret proof, confirmations
- `keystore` — encrypted seed (never exported except via mnemonic flow)

All of it exportable as an encrypted JSON backup. Import restores on a new
device with the same passphrase.

## What we explicitly do NOT build

- No custodial accounts, no "pay balance" held by us.
- No central transaction database.
- No KYC/AML collection in the client (compliance surface stays with
  optional fiat on/off-ramp partners, outside this repo).
- No push-notification server that learns who pays whom (use local
  notifications / polling in v0.1).

## Open questions

1. Which settlement rail ships in v0.1? (Lightning vs stablecoin L2)
2. Handle namespace: build our own or adopt an existing decentralized naming
   system?
3. Relay economics: who runs default relays and how are they funded?
4. Mobile: PWA first, or native shell from day one?

These should be answered with short ADRs (Architecture Decision Records) in
`docs/adr/` as the project moves.
