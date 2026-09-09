# pay

A decentralized peer-to-peer payments platform — send money directly to anyone,
without banks, intermediaries, or custody of user funds.

> **Status: vision / pre-alpha.** This repo currently holds the product vision,
> architecture, and roadmap. The app scaffold (`package.json`, `app/`) is a
> starting point; no live network or production code exists yet.

## Why

Every existing "p2p" payment app (Venmo, Cash App, Zelle) is centralized: your
money sits in their ledger, they see every transaction, and they can freeze your
account. `pay` is the opposite — a client that lets two people settle value
directly, where:

- **No custody** — the app never holds your money or your keys.
- **No accounts** — identity is a public key, not an email + password in a database.
- **No permission** — anyone can receive; nobody can be de-platformed.
- **Portable** — your payment history and contacts live on your device, exportable
  at any time.

## How it works (planned)

1. **Wallet** — client-side, non-custodial. Keys never leave the device.
2. **Identity** — a human-readable handle mapped to a public key (think
   `brandon.pay` → `0x…`), resolved without a central registry.
3. **Transport** — encrypted payment requests and invoices delivered over a
   decentralized transport (libp2p-style DHT or Nostr relays), with no single
   server that can censor or go down.
4. **Settlement** — pluggable rails. Start with one settlement layer (see
   [ARCHITECTURE.md](docs/ARCHITECTURE.md)); the UI stays the same regardless of
   which rail moves the value.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design,
[docs/ROADMAP.md](docs/ROADMAP.md) for the phased build plan, and
[docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Tech stack (planned)

- **Next.js + TypeScript** — web client, works in any modern browser
- **Tailwind CSS** — UI
- **IndexedDB** — local-first storage (contacts, history, encrypted keystore)
- **Web Crypto API** — key generation and signing, no key-management server

## Getting started (scaffold only)

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`. Right now this renders a placeholder landing
page — the wallet, identity, and transport layers are not implemented.

## Repo layout

```
pay/
├── app/                        # Next.js app router (landing page placeholder)
├── docs/
│   ├── ARCHITECTURE.md         # System design, data flow, layer breakdown
│   ├── CHECKOUT.md             # Shared checkout contract (test-mode fixtures)
│   ├── ROADMAP.md              # Phased build plan (v0.1 → v1.0)
│   └── SECURITY.md             # Threat model, key management, known risks
├── lib/
│   ├── checkout-test.ts        # Test-mode fixture contract (zero deps)
│   ├── checkout-provider.ts    # Swappable provider seam (consume through this)
│   ├── divorce-checkout.ts     # First consumer: divorce $30 packet
│   ├── webhook-test.ts         # Signed webhook event fixtures (modal unlock gate)
│   ├── webhook-receipt.ts      # HTTP-shaped front door: missing-signature + oversize-body rejection before verify
│   ├── webhook-handler.ts      # Dispatch skeleton: verified event → product effect
│   ├── webhook-delivery.ts     # Delivery semantics: classify failures (ack/retryable/fatal), bounded backoff, dead-letter queue
│   ├── reconcile.ts            # Settlement drill: produced effects vs provider statement fixture
│   ├── refund-ledger.ts          # Refund + reversal safety: idempotent refunds, sum-checked against captures, net-captured query
│   ├── staging-drill.ts        # End-to-end staging drills: the full loop for both money milestones
│   └── subscription-plans.ts   # Plan model: wax $10/mo lifecycle
├── README.md
├── LICENSE                     # MIT
└── .gitignore
```

## Integration recipe — plugging a site into checkout

> **Test mode only.** These fixtures move no real money. When Brandon approves
> a live rail, it lands as a **server-side** `CheckoutProvider` class and
> product code keeps calling `getProvider()` — same shape, zero key material
> in any site.

Consume checkout through the seam in `lib/checkout-provider.ts` — never
through `checkout-test.ts` directly. The product's own UI (modals, forms,
packet rendering) stays in the product repo; only the money step lives here.

```ts
import { getProvider, isValidTestReceipt } from "./lib/checkout-provider";

// divorce: $30 one-time uncontested packet (see lib/divorce-checkout.ts)
const provider = getProvider(); // always the "test-fixture" provider
const session = provider.createSession("uncontested_packet");
const receipt = provider.confirmPayment(session.id, session); // test card 4242…
if (!isValidTestReceipt(receipt)) throw new Error("bad receipt"); // never unlock on a bad receipt
```

```ts
import { getProvider } from "./lib/checkout-provider";
import { isValidTestSubscription } from "./lib/subscription-plans";

// wax: $10/mo drop-alert subscription (see lib/subscription-plans.ts)
const { plan, subscription } = startWaxSubscription();
if (!isValidTestSubscription(subscription)) throw new Error("bad subscription");
```

Migration path for an existing site (divorce's `stripe-test.js` flow):

1. Swap `createTestPaymentIntent` → `provider.createSession("uncontested_packet")`.
2. Swap `confirmTestPayment` → `provider.confirmPayment(session.id, session)`.
3. Keep the receipt gate: only a valid receipt unlocks the printable packet.
4. When a live rail is approved, point `getProvider()` at the new
   server-side implementation — the call sites do not change.

Run the fixture tests with `bun test lib/` (zero installs, zero network).

## Contributing

This is a YEAHDOGS project (DOGS). PRs welcome once the scaffold lands — see the
roadmap for where help is most useful first. License: MIT.
