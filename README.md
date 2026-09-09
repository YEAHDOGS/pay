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
├── app/                 # Next.js app router (landing page placeholder)
├── docs/
│   ├── ARCHITECTURE.md  # System design, data flow, layer breakdown
│   ├── ROADMAP.md       # Phased build plan (v0.1 → v1.0)
│   └── SECURITY.md      # Threat model, key management, known risks
├── README.md
├── LICENSE              # MIT
└── .gitignore
```

## Contributing

This is a YEAHDOGS project (DOGS). PRs welcome once the scaffold lands — see the
roadmap for where help is most useful first. License: MIT.
