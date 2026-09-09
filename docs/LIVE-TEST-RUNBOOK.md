# Live $30 test payment — staging runbook

The money milestone: **one real $30 test payment on staging that produces a
printable divorce packet.** Everything below runs in **Stripe test mode** —
no live keys, no real money. The pay repo itself never touches a secret
key; all money steps live in divorce's server code, which consumes the
plumbing here.

**Safety rules (non-negotiable):**
- Use **test-mode** keys only (`sk_test_…`, `whsec_…` from the Stripe
  dashboard's test-mode webhook endpoint). Live keys never enter this
  repo, never enter chat, never get committed.
- The `pay` repo stays network-free and secret-free — a test in the
  suite asserts that stays true.
- If anything below asks for a key you don't have, stop. Don't improvise.

## 0. Prerequisites

- A Stripe account (test mode is free, no bank account needed).
- divorce's staging deploy with the webhook route copied from
  `pay/app/api/webhooks/checkout/route.ts` and `persistPaymentRecord`
  implemented against divorce's order ledger (idempotent upsert keyed
  by `eventId` — see the route's docblock for why).
- divorce's server-side checkout-session endpoint (creates the Stripe
  Checkout Session with the secret key server-side; the key never
  reaches the browser).

## 1. Create the $30 product (Stripe dashboard, test mode)

1. Products → Add product: name `Divorce packet — uncontested`.
2. One-time price: **$30.00 USD**.
3. Copy the **price id** (`price_…`) into divorce's staging config as
   the packet price. The webhook route expects exactly **3000¢ / usd** —
   a different price throws `AMOUNT_MISMATCH` and the packet stays
   locked (that's the guard working, not a bug).

## 2. Register the webhook endpoint (test mode)

1. Developers → Webhooks → Add endpoint:
   `https://<divorce-staging-host>/api/webhooks/checkout`
2. Subscribe to **`checkout.session.completed`** only.
3. Copy the endpoint's **signing secret** (`whsec_…`).
4. Set it on the staging host as `STRIPE_WEBHOOK_SECRET` (env var on
   the host — never in-repo).

## 3. Run the test payment

1. Open divorce staging, start the $30 packet checkout.
2. Pay with the Stripe test card **`4242 4242 4242 4242`**, any future
   expiry, any CVC.
3. Watch the staging logs. Expected, in order:
   - Webhook delivered → route verifies signature (freshness 300s).
   - `record_payment` effect, `paymentStatus: "paid"`, amount 3000, usd.
   - `assertServerPaymentSettled` passes → order ledger write.
   - Route responds **2xx** → Stripe marks the event delivered.
   - Printable packet unlocks.

## 4. Prove the guards (same session, no extra charges)

These are free — they reuse the signed event shape, no new payments:

| Drill | How | Expected |
|---|---|---|
| Replay | Stripe dashboard → event → resend | Route answers `already_processed` 2xx; **one** ledger entry for the event id |
| Amount tamper | (dev only) re-sign the event body with `amount_total: 2000` using the endpoint secret | `AMOUNT_MISMATCH` 4xx; packet stays locked |
| Forged signature | POST a body with a bogus `stripe-signature` header | `BAD_SIGNATURE` 4xx before anything parses |
| Stale event | Re-send an event >5 min old | `EXPIRED_EVENT` 4xx |
| Unpaid status | (dev only) session with `payment_status: "unpaid"` | recorded for the audit trail, `PAYMENT_NOT_SETTLED` — packet stays locked |

The pay repo's suite (`bun test lib`) covers every one of these paths
against the same code the route calls — 181 tests green.

## 5. What "done" looks like

- [ ] One `checkout.session.completed` for 3000¢/usd in test mode.
- [ ] Exactly one order-ledger entry keyed by the event id.
- [ ] Printable packet renders, gated on the ledger entry (never on
      the client-side receipt alone).
- [ ] A resent delivery returns `already_processed` without a second entry.
- [ ] No key material anywhere in the divorce or pay repos
      (`git log -p | grep` for `sk_`, `whsec_` comes back clean apart
      from test fixtures).

## 6. After the test payment lands

The same plumbing carries wax's $10/mo next: `subscription-plans.ts`
already models the plan, and the dispatcher's event switch is where
`customer.subscription.created` → `provision_subscription` gets added.
Don't go live until the test payment above is green end to end.
