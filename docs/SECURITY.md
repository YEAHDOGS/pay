# Security model

`pay` is a money app. The threat model is written before the code, not after.

## What we protect

- **User funds** — only the user can move them. Ever.
- **Private keys / seed** — never leave the device, never touch a server.
- **Payment metadata** — who pays whom, how much, when. Relays and resolvers
  see as little as possible.

## Trust boundaries

| Component            | Trust level | Notes |
|----------------------|-------------|-------|
| User's device        | Trusted     | If the device is compromised, all bets are off |
| WalletCore (our code)| Trusted     | Must be audited before v1.0 |
| Local address book   | Trusted     | Explicit user mappings win over everything |
| Handle resolvers     | Untrusted   | Must show trust level in UI; impersonation risk |
| Relays               | Untrusted   | Ciphertext + routing metadata only |
| Settlement rail      | Protocol    | Trust = the underlying network's guarantees |

## Key management rules

1. Keys are generated on-device with Web Crypto. No server-side keygen, no
   "recover via email."
2. Keystore encrypted with a user passphrase via Argon2id → AES-GCM.
3. BIP-39 mnemonic shown exactly once at creation; user must re-enter it to
   continue. No screenshots allowed on the reveal screen (best effort).
4. No key material in logs, error reports, or analytics (there is no analytics).
5. Lose the seed + passphrase = lose the funds. The UI must say this plainly
   during onboarding. No sugar-coating.

## Top threats and mitigations

- **Handle impersonation** (`founder.pay` vs `f0under.pay`): show resolver
  source + trust level, safety-number verification for contacts, homoglyph
  warnings on lookalike handles.
- **Malicious resolver**: resolvers are untrusted by default; local address
  book overrides; user can disable any resolver.
- **Relay metadata analysis**: minimize metadata (no amounts/memos in
  routing layer), support Tor / private relays, document the residual risk.
- **Clipboard / invoice tampering (malware on device)**: show full payment
  details on a confirmation screen; safety numbers for repeat counterparties.
- **Phishing payment links**: `pay/<handle>/<amount>` links must resolve and
  display the verified pubkey fingerprint before any signing.
- **Supply-chain**: lockfile committed, minimal dependencies, no analytics or
  ad SDKs, reproducible builds for releases.

## Disclosure

Found a vulnerability? Do not open a public issue. (Disclosure contact to be
added — for now, reach out through the YEAHDOGS org.) We will publish
post-mortems for anything affecting user funds.

## Known residual risks (documented, not hidden)

- Device compromise defeats everything — we say so in onboarding.
- Default relay/resolver lists are a centralization point until Phase 2;
  the client makes them visible and replaceable.
- No code here has been audited yet. Treat everything pre-v1.0 as experimental.
