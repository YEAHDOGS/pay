# Checkout contract (test-mode fixtures)

`lib/checkout-test.ts` is the shared YEAHDOGS checkout contract — the
fixture implementation of the hosted-checkout flow every product consumes.

## Provider seam (consume through this)

`lib/checkout-provider.ts` is the interface every product should call.
`CheckoutProvider` is the contract; `TestCheckoutProvider` is the fixture
implementation; `getProvider()` hands it out. Live provider ids
(`"stripe"`, `"live"`, …) throw `TEST_MODE_VIOLATION` — live rails can
only ever arrive as a new server-side class implementing
`CheckoutProvider`, never in this module.

```js
// one-time divorce packet — through the seam
const provider = getProvider();
const session = provider.createSession("uncontested_packet");
const receipt = provider.confirmPayment(session.id, session);
if (!isValidTestReceipt(receipt)) throw new Error("bad receipt");

// wax $10/mo — through the same seam
const subSession = provider.createSession("wax_subscription");
const sub = provider.confirmSubscription(subSession.id, subSession);
if (!isValidTestSubscription(sub)) throw new Error("bad subscription");
```

## What it is

A dependency-free, network-free simulation of `create session → confirm
with test card → receipt`. One discrete change per product's money
milestone:

- `createTestCheckout(productId)` → `cs_test_*` session fixture
- `confirmTestPayment(sessionId, session)` → `rcpt_test_*` receipt
  (divorce $30 one-time packet)
- `confirmTestSubscription(sessionId, session)` → `sub_test_*`
  subscription (wax $10/mo)
- `isValidTestReceipt()` / `isValidTestSubscription()` validators
- `assertTestMode()` — any live-mode flag throws `TEST_MODE_VIOLATION`

Prices are catalog fixtures: `uncontested_packet` = 3000¢ one-time,
`wax_subscription` = 1000¢/mo. Amounts that don't match the catalog
throw `INVALID_AMOUNT`.

## How divorce consumes it

`lib/divorce-checkout.ts` is the first in-repo consumer: `startDivorceCheckout()`
opens the $30 packet session and `confirmDivorceCheckout()` confirms with the
test card through the seam (it also guards against catalog price drift so a
moved price throws instead of selling the wrong amount). divorce's own modal
logic stays in the divorce repo — only the money step lives here:

```js
const session = startDivorceCheckout();         // $30 packet session
const receipt = confirmDivorceCheckout(session); // test card 4242…
if (!isValidTestReceipt(receipt)) throw new Error("bad receipt");
```

divorce's staging flow already proves this pattern with
`src/lib/stripe-test.js`: questionnaire → checkout modal → receipt →
printable packet. To migrate to the shared contract:

```js
// one-time divorce packet
const session = createTestCheckout("uncontested_packet");
const receipt = confirmTestPayment(session.id, session);
if (!isValidTestReceipt(receipt)) throw new Error("bad receipt");
```

(Prefer the provider seam above — `getProvider().createSession(...)` —
direct `checkout-test.ts` calls remain the fixture engine underneath.)

## How wax consumes it

`lib/subscription-plans.ts` is the recurring-plan model behind the seam:
`describePlan()` derives the plan descriptor (price, interval, trial) from
the catalog product, `startWaxSubscription()` runs the lifecycle through the
provider, and `nextRenewalDate()` / `cancelSubscription()` give wax's alert
engine renewal scheduling and period-end cancellation as pure fixtures.

## How wax consumes it

```js
// $10/mo subscription
const session = createTestCheckout("wax_subscription");
const sub = confirmTestSubscription(session.id, session);
if (!isValidTestSubscription(sub)) throw new Error("bad subscription");
```

## Going live (requires Brandon)

Live checkout is deliberately impossible from this module. To accept
real money for a product:

1. Build a **server-side** session endpoint (the secret key never leaves
   the server).
2. Keep the receipt shape compatible so `isValidTestReceipt` stays the
   offline regression harness.
3. Swap fixture calls for the server endpoint behind the live flag —
   never the other way around.

## Guarantees

- `TEST_MODE` is hard-coded `true`; `{ live: true }` / `mode: "live"`
  options throw. No env var, flag, or input can flip it.
- Fixture ids are prefixed `cs_test_` / `rcpt_test_` / `sub_test_` and
  can never be mistaken for real processor objects.
- No key fields exist in the module; a test asserts this stays true.
- `lib/checkout-test.test.ts` runs with `bun test` (no installs needed).

## What this is NOT

This is not the pay p2p product (see ARCHITECTURE.md) — it's the shared
staging harness. Live p2p settlement rails are a separate decision (see
the open questions in ARCHITECTURE.md).
