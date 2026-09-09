# test-checkout example

> **TEST MODE ONLY. NO REAL MONEY.** Runs entirely in your browser.
> No build step, no network, no dependencies.

A static HTML + plain-JS (`example-logic.js`) demo of the full YEAHDOGS
test-mode checkout loop, matching `docs/INTEGRATING.md`:

```
"Pay $30 (test)" → session → test card 4242… → signed test webhook
  → signature VERIFIED → fulfilled receipt (unlock the packet)
```

Extra buttons demonstrate the guards: the decline card (···0002),
a replayed webhook (`REPLAYED_EVENT`), and a tampered payload
(`BAD_SIGNATURE`).

## Run it

```sh
# option 1: serve the folder (any static server)
python3 -m http.server 8080
# then open http://localhost:8080/examples/test-checkout/index.html

# option 2: open index.html directly as a file
# (ES modules from file:// work for sibling relative imports in
#  Chromium/Firefox; Safari requires option 1)
```

## Notes

- `example-logic.js` re-implements the lib contract with WebCrypto
  instead of `node:crypto` (browsers have no node:crypto), so the
  example runs with zero build. Same shapes, same `t=<ts>,v1=<hex>`
  signature scheme, same guards (freshness, replay ledger, fixture-key
  gate). The bun regression tests in `checkout-example.test.ts` drive
  this exact file.
- The webhook key in `example-logic.js` is a DUMMY
  `whsec_test_fixture_*` fixture key — verify refuses anything else.
  Real processor keys are server-side only, never in client code.
