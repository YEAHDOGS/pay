# Roadmap

Phased plan from empty repo to a usable v1.0. Each phase ends with something a
real person can try.

## Phase 0 — Foundation (current)

- [x] Repo created, MIT license
- [x] Vision, architecture, security model, roadmap documented
- [x] Next.js + TypeScript scaffold with placeholder landing page
- [ ] ADR process set up (`docs/adr/`)
- [ ] Decide v0.1 settlement rail (Lightning vs stablecoin L2)

## Phase 1 — v0.1 "Send sats to a handle" (MVP)

Goal: two people can complete a real p2p payment using this client.

- [ ] `WalletCore` TS package: keygen (Web Crypto), encrypted keystore
      (Argon2id → AES-GCM in IndexedDB), BIP-39 mnemonic backup/verify
- [ ] One `RailAdapter` implemented end-to-end (invoice create/pay/balance)
- [ ] Identity v0: local address book + one fallback resolver, with trust
      indicators in the send-confirm screen
- [ ] Screens: onboarding (create/import wallet), home/balance, send flow,
      request flow, activity list
- [ ] Encrypted JSON backup export/import
- [ ] Security review of the v0.1 surface before any public release
      (see SECURITY.md)

## Phase 2 — v0.5 "Actually decentralized"

- [ ] Transport layer: E2E-encrypted payment requests over user-chosen relays
- [ ] Presence: see when a contact is reachable (without leaking metadata)
- [ ] Custom relay support in settings; run-your-own-relay docs
- [ ] DHT-based handle resolution as an option alongside the fallback
- [ ] PWA packaging: installable, works offline for history/contacts

## Phase 3 — v1.0 "Money app replacement"

- [ ] Second settlement rail (adapter #2) proving the pluggable design
- [ ] Recurring payments / payment links (`pay/<handle>/<amount>`)
- [ ] Contact verification UX: QR fingerprint compare, safety numbers
- [ ] Multi-device: encrypted sync of address book + history
- [ ] External security audit of wallet core + adapters
- [ ] 1.0 release: signed builds, reproducible build notes

## Non-goals (won't build)

- Fiat on/off-ramps in-repo (partner integrations only, kept outside)
- Custodial features of any kind
- Merchant tooling / POS (maybe a separate repo later)
- Native mobile apps before the PWA proves the UX

## How to help

Highest leverage right now, in order:

1. Settle the open questions in ARCHITECTURE.md as ADRs.
2. Implement `WalletCore` (pure TS, well-tested) — the foundation everything
   else stands on.
3. Spike the v0.1 settlement rail choice with a throwaway prototype.
