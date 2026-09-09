# Integrating a YEAHDOGS checkout into a Svelte SPA

> ═══════════════════════════════════════════════════════════════════
> TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS DOCUMENT'S CODE.
> Everything below exercises fixture sessions, fixture receipts, and a
> DUMMY webhook key (`whsec_test_fixture_*`) that is hard-coded in
> `lib/webhook-test.ts` and labeled as such. REAL processor keys and
> secrets live SERVER-SIDE ONLY — never in a SPA, never in client
> JavaScript, never in git. When Brandon approves a live rail for your
> product, the live `CheckoutProvider` implementation ships as a
> server-side class and the UI code below does not change shape.
> ═══════════════════════════════════════════════════════════════════

This guide wires a test-mode checkout end-to-end in a Svelte app — the
same shape divorce's staging modal uses. You get the full loop:

```
click "Pay $30 (test)" → session → confirm (test card 4242…)
  → signed test webhook → VERIFY signature → fulfill (unlock)
```

A runnable in-browser version of this loop lives at
`examples/test-checkout/index.html` (static HTML, no build step, no
network). The snippets below call the real library API in `lib/`.

## 1. One rule: consume through the provider seam

Do NOT import `checkout-test.ts` directly from product code. Go through
`lib/checkout-provider.ts` — the interface every processor implements.
When a live rail lands, it arrives as a new server-side class behind
`getProvider()` and your UI keeps working:

```ts
import { getProvider } from "../../pay/lib/checkout-provider";
// or, if pay is a dependency:
// import { getProvider } from "@yeahdogs/pay/lib/checkout-provider";

const provider = getProvider(); // "test-fixture"; "stripe"/"live" ids throw
const product = provider.product("uncontested_packet"); // $30 one-time
```

Catalog products: `uncontested_packet` (3000¢ one-time, divorce),
`wax_subscription` (1000¢/mo, wax). Prices are fixed fixtures — a moved
price throws `INVALID_AMOUNT` instead of selling the wrong amount.

## 2. Create the checkout session (the "Pay" click)

```ts
import { startDivorceCheckout } from "../../pay/lib/divorce-checkout";
// divorce already ships this wrapper — one call, price-drift guarded:
const session = startDivorceCheckout();
// → { id: "cs_test_000001", productId: "uncontested_packet",
//     amountCents: 3000, currency: "usd", billing: "one_time",
//     status: "open", testMode: true }
```

For a different product, use the seam directly:

```ts
const session = provider.createSession("wax_subscription"); // $10/mo
```

Render your checkout modal with `session.amountCents` (never hard-code
the price in the UI — read it from the product/session).

## 3. Confirm with the test card

```ts
import { confirmDivorceCheckout } from "../../pay/lib/divorce-checkout";

try {
  const receipt = confirmDivorceCheckout(session); // test card 4242 4242…
  // → { id: "rcpt_test_000001", status: "succeeded",
  //     amountCents: 3000, testMode: true, … }
} catch (e) {
  if (e.code === "DECLINED") {
    // last4 0002 is the documented decline card — show "card declined"
  }
}
```

In the fixture flow the modal confirms in-process. On the live rail
this step becomes: redirect to hosted checkout → the processor fires the
webhook below. **The UI must not unlock the deliverable from the receipt
alone.** The unlock gate is the verified webhook event (step 5).

## 4. The signed webhook (the async half)

Real flow: the processor POSTs a signed event to your server. Test flow:
`lib/webhook-test.ts` builds an identical-shaped signed fixture — same
`checkout.session.completed` type, same `t=<ts>,v1=<hex>` signature
scheme, HMAC-SHA256 over the exact raw body:

```ts
import { deliverTestWebhookEvent } from "../../pay/lib/webhook-test";

const { rawBody, signature } = deliverTestWebhookEvent(
  "checkout.session.completed",
  receipt
);
// In staging you can dump these into the browser console, or POST them
// to your /webhooks endpoint — the verifier reads (rawBody, signature).
```

Event ids are deterministic (`evt_test_*` from type + object id), so
fixtures are reproducible across runs and tests.

## 5. VERIFY — the unlock gate (do this before unlocking anything)

```ts
import {
  parseTestWebhookEvent,
  WEBHOOK_ERROR_CODES,
} from "../../pay/lib/webhook-test";
import { isValidTestReceipt } from "../../pay/lib/checkout-provider";

function fulfillFromWebhook(rawBody: string, signature: string) {
  let event;
  try {
    event = parseTestWebhookEvent(rawBody, signature);
  } catch (e) {
    switch (e.code) {
      case WEBHOOK_ERROR_CODES.BAD_SIGNATURE:
        return logAndShow("Payment verification failed. Do not deliver.");
      case WEBHOOK_ERROR_CODES.EXPIRED_EVENT:
        return logAndShow("Payment event expired — ask the customer to retry.");
      case WEBHOOK_ERROR_CODES.REPLAYED_EVENT:
        return logAndShow("Duplicate payment notification ignored.");
      default:
        return logAndShow("Unrecognized payment event. Do not deliver.");
    }
  }
  if (!isValidTestReceipt(event.data.object)) {
    throw new Error("never unlock on an invalid receipt");
  }
  unlockDivorcePacket(event.data.object); // ← the money milestone
}
```

`parseTestWebhookEvent` rejects, in order:

1. **Bad/forged signature** — constant-time HMAC compare; tampered
   payloads and wrong secrets throw `BAD_SIGNATURE`. A live-looking
   secret is refused outright (`assertFixtureSecret`).
2. **Stale events** — `|now - created| > 300s` throws `EXPIRED_EVENT`.
3. **Replays** — an already-accepted `evt_test_*` id throws
   `REPLAYED_EVENT` (module-level ledger; `resetWebhookFixtures()` in
   tests only). The handler layer has its own defense-in-depth ledger
   (`ALREADY_HANDLED`). **Going live: swap both in-memory ledgers for
   the file-backed adapter — `setHandlerLedger(new
   FileIdempotencyLedger(path))` in `lib/idempotency-ledger.ts` (crash-
   safe JSON-lines appends, corrupt-line tolerant, keys survive
   restarts). The drills keep the in-memory default deliberately.
   Same story for the audit trail: `setAuditLog(new
   FileAuditLog(path))` in `lib/audit-log.ts` — every delivery then
   leaves a persistent `webhook.received` / `effect.produced` /
   `delivery.rejected` line for staging forensics. Records carry ids,
   event types, effect names, and error codes only — no payloads, no
   secrets, no PII — and a failing adapter can never block an effect.
4. **Non-fixture events** — anything missing `testMode: true` or an
   `evt_test_*` id throws `BAD_EVENT`.

## 6. Svelte wiring sketch

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { writable } from "svelte/store";
  import { startDivorceCheckout, confirmDivorceCheckout } from "../../pay/lib/divorce-checkout";
  import { deliverTestWebhookEvent, parseTestWebhookEvent } from "../../pay/lib/webhook-test";
  import { isValidTestReceipt } from "../../pay/lib/checkout-provider";

  const order = writable<{ state: "idle" | "paying" | "fulfilled" | "failed"; message?: string }>(
    { state: "idle" }
  );

  function pay() {
    order.set({ state: "paying" });
    try {
      const session = startDivorceCheckout();
      const receipt = confirmDivorceCheckout(session);
      // test-mode stand-in for the processor POST:
      const { rawBody, signature } = deliverTestWebhookEvent("checkout.session.completed", receipt);
      const event = parseTestWebhookEvent(rawBody, signature);
      if (!isValidTestReceipt(event.data.object)) throw new Error("bad receipt");
      order.set({ state: "fulfilled" }); // → render printable packet
    } catch (e) {
      order.set({ state: "failed", message: e.code ?? e.message });
    }
  }
</script>

{#if $order.state === "idle"}
  <button on:click={pay}>Pay $30 (test)</button>
{:else if $order.state === "paying"}
  <p>Processing test payment…</p>
{:else if $order.state === "fulfilled"}
  <slot name="packet" /><!-- printable deliverable -->
{:else}
  <p class="error">{$order.message ?? "Payment failed"}</p>
{/if}
```

## 7. What changes when a live rail is approved

| Piece | Test mode (now) | Live rail (later) |
|---|---|---|
| Provider | `getProvider()` → `TestCheckoutProvider` | New server-side class, same `CheckoutProvider` interface |
| Session | `createTestCheckout` fixture | Server endpoint, secret key stays server-side |
| Confirm | Test card in-process | Hosted checkout / processor SDK |
| Webhook | `deliverTestWebhookEvent` fixture (dummy key) | Real processor event, real secret, same verify-then-unlock shape |
| Unlock gate | `parseTestWebhookEvent` + `isValidTestReceipt` | Server-side verifier for THIS EVENT SHAPE, then unlock |

Keep the receipt shape compatible — the fixture validators are the
contract the live verifier honors. Nothing in this guide or in
`examples/test-checkout` may ever touch a live key: if it starts with
anything other than `whsec_test_fixture_`, `assertFixtureSecret`
refuses it by construction.

## 8. The receipt front door + the settlement drill

Two more pieces complete the loop your staging route will run:

**`receiveTestWebhook(rawBody, signature)`** (`lib/webhook-receipt.ts`) is
the HTTP-shaped front door — the body plus the possibly-absent
signature header. Before `handleTestWebhookDelivery` ever sees the
delivery it rejects:

- a missing/empty signature header → `MISSING_SIGNATURE` (distinct
  from `BAD_SIGNATURE`, so forensics can tell "no header" from "forged
  header" from "tampered body");
- an oversized body (>1 MiB) → `BODY_TOO_LARGE`, before the HMAC or
  `JSON.parse` burns any work on it.

Both rejections land in the audit trail as `delivery.rejected` with
the code only — no bodies, no signatures. After the front door,
everything travels the same verify → dispatch → audit path.

**`reconcileTestSettlement({ localEffects, statement })`**
(`lib/reconcile.ts`) is the drill for real-money confidence: the
route's produced `WebhookEffect`s (lifted via
`localEffectFromWebhookEffect`) against the provider's settlement
statement (`buildTestStatement`, `stmt_test_*` fixture ids). The
report flags the three operational failures by name — `missing`
(settled, never fulfilled), `extra` (fulfilled, never settled),
`amountMismatch` (same event, different money) — plus `refunded`
lines, which are reported, never matched. A live route journals its
effects and reconciles against the real statement on a schedule;
here it is a pure function, so the drill is deterministic.

## Checklist before you call the money milestone done

- [ ] Session created through `getProvider()` / `startDivorceCheckout()`
- [ ] Deliverable unlocks ONLY after `parseTestWebhookEvent` succeeds AND
      `isValidTestReceipt` passes — never from the receipt alone
- [ ] Replay (`REPLAYED_EVENT`) and expiry (`EXPIRED_EVENT`) paths tested
- [ ] No keys, tokens, or card numbers in client code or git history
- [ ] `bun test` in `pay/` is green before you commit
- [ ] Ran the money-milestone drills as the loop reference:
      `runDivorceStagingDrill()` → `unlock_deliverable` ($30 packet),
      `runWaxStagingDrill()` → `provision_subscription` ($10/mo),
      `runDivorceDeclineDrill()` → decline with no unlock. See
      `lib/staging-drill.ts` — your staging webhook route mirrors its
      verify-then-dispatch shape.
