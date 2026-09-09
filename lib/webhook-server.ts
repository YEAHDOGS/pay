/**
 * webhook-server.ts — SERVER-SIDE webhook signature verifier.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  SERVER USE ONLY. This module verifies signatures; it never moves,
 *  mints, or claims money, and it performs NO network IO.
 * ═══════════════════════════════════════════════════════════════════
 *
 * This is the LIVE-side counterpart to `webhook-test.ts`. Where
 * `webhook-test.ts` only ever signs with the hard-coded
 * `whsec_test_fixture_*` dummy and REFUSES anything else, THIS module
 * accepts only real processor webhook secrets passed explicitly by the
 * server route — and REFUSES the fixture dummy in the other direction.
 * The two modules can never be confused: fixture webhooks fail here,
 * live secrets fail there.
 *
 * Intended consumer (once Brandon approves a live rail):
 * divorce's `/api/webhooks/checkout` route does:
 *
 *   import { verifyServerWebhookSignature } from "pay/lib/webhook-server";
 *
 *   const rawBody = await request.text();          // EXACT raw bytes, un-parsed
 *   const header = request.headers.get("stripe-signature");
 *   const secret = process.env.STRIPE_WEBHOOK_SECRET; // from env at the route, never in-repo
 *   const ts = verifyServerWebhookSignature(rawBody, header, secret); // throws on anything fishy
 *   const event = JSON.parse(rawBody);
 *   if (event.type !== "checkout.session.completed") return ok();
 *   // …verify amount + product from the catalog, then unlock the packet
 *
 * Guarantees by construction:
 *   - The secret is an EXPLICIT parameter. This module never reads
 *     process.env, never ships a default, and never accepts an empty
 *     or missing secret (MISSING_SECRET). There is nothing in-repo
 *     to leak.
 *   - Fixture secrets are refused outright (FIXTURE_SECRET): a
 *     `whsec_test_fixture_*` dummy passed here throws instead of
 *     verifying — staging webhooks belong to `webhook-test.ts`.
 *   - Stripe-compatible header scheme: `t=<unix>,v1=<hex>,…`. Multiple
 *     `v1` values are supported (processor secret rollovers), unknown
 *     schemes (`v0`, …) are ignored. Malformed headers throw BAD_HEADER.
 *   - Expected MAC = HMAC-SHA256(`<timestamp>.<rawBody>`), compared in
 *     constant time (timingSafeEqual). Body tampering, wrong secret,
 *     or signature forgery throw BAD_SIGNATURE.
 *   - Freshness: events older than the tolerance (default 300s) throw
 *     EXPIRED_EVENT; events from the future beyond tolerance throw
 *     FUTURE_EVENT (clock-skew replays).
 *   - Verification is the ONLY job here — no replay ledger, no
 *     dispatch, no fulfillment. Idempotency + effects stay in the
 *     product's server route (the `webhook-handler.ts` skeleton is the
 *     test-mode model to port: verify → handle each event id exactly
 *     once → fulfill the effect).
 *   - Zero dependencies beyond node:crypto. Zero network.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* ── Hoisted constants ───────────────────────────────────────────── */

export const SERVER_WEBHOOK_ERROR_CODES = Object.freeze({
  MISSING_SECRET: "MISSING_SECRET",
  FIXTURE_SECRET: "FIXTURE_SECRET",
  BAD_HEADER: "BAD_HEADER",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  EXPIRED_EVENT: "EXPIRED_EVENT",
  FUTURE_EVENT: "FUTURE_EVENT",
});

/** Freshness tolerance, seconds. Matches the test-fixture module. */
export const SERVER_WEBHOOK_TOLERANCE_SECONDS = 300 as const;

/* ── Types ───────────────────────────────────────────────────────── */

export interface WebhookHeaderSignature {
  readonly scheme: string;
  readonly value: string;
}

export interface ParsedWebhookHeader {
  readonly timestamp: number;
  readonly signatures: readonly WebhookHeaderSignature[];
}

export interface VerifyWebhookOptions {
  /** Freshness tolerance, seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Unix seconds "now". Defaults to Date.now()/1000; inject for tests. */
  nowSeconds?: number;
}

/* ── Errors ──────────────────────────────────────────────────────── */

function err(code: string, message: string): Error {
  const e = new Error(`webhook-server: ${message}`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

/* ── Secret discipline ───────────────────────────────────────────── */

/**
 * Validate the signing secret supplied by the server route.
 *
 * Throws MISSING_SECRET for anything missing/empty/non-string, and
 * FIXTURE_SECRET for the test-fixture dummy prefix — fixture webhooks
 * are verified by `webhook-test.ts`, never here. Returns the secret
 * unchanged so routes can thread it through in one call.
 */
export function assertServerWebhookSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.MISSING_SECRET,
      "no webhook secret supplied — the server route must pass its " +
        "processor webhook secret explicitly (e.g. from an environment " +
        "variable). Never hard-code one in-repo."
    );
  }
  if (secret.startsWith("whsec_test_fixture_")) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.FIXTURE_SECRET,
      "refusing to verify with a test-fixture dummy secret — fixture " +
        "webhooks belong to webhook-test.ts. This verifier takes only " +
        "the live processor webhook secret."
    );
  }
  return secret;
}

/* ── Header parsing ──────────────────────────────────────────────── */

/**
 * Parse a processor signature header of the form
 * `t=1492774577,v1=<hex>,v1=<hex>` into its timestamp and signature
 * list. Unknown schemes are kept (callers ignore what they can't
 * check); the verifier only ever compares `v1` values.
 *
 * @throws BAD_HEADER for a missing, non-string, or unparseable header.
 */
export function parseServerWebhookHeader(
  header: unknown
): ParsedWebhookHeader {
  if (typeof header !== "string" || header.length === 0) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
      "missing webhook signature header — refusing to trust an unsigned delivery."
    );
  }
  const parts = header.split(",");
  let timestamp: number | undefined;
  const signatures: WebhookHeaderSignature[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw err(
        SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
        `malformed webhook signature header segment "${part}".`
      );
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== undefined || !/^\d+$/.test(value)) {
        throw err(
          SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
          "malformed webhook signature header: bad timestamp."
        );
      }
      timestamp = Number(value);
    } else {
      signatures.push({ scheme: key, value });
    }
  }
  if (timestamp === undefined) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
      "malformed webhook signature header: no t=<timestamp> segment."
    );
  }
  return { timestamp, signatures };
}

/* ── Signing (for tests and for routes that re-emit) ─────────────── */

/**
 * Sign a raw webhook body with the server secret, Stripe-style:
 * HMAC-SHA256 of `<timestamp>.<rawBody>`, header `t=<ts>,v1=<hex>`.
 *
 * Lives here for unit tests and for server routes that re-emit events
 * internally (e.g. a queue fan-out). NOT a substitute for verifying
 * what the processor actually delivered.
 *
 * @throws MISSING_SECRET | FIXTURE_SECRET via assertServerWebhookSecret.
 */
export function signServerWebhookPayload(
  rawBody: string,
  secret: string,
  timestamp?: number
): string {
  assertServerWebhookSecret(secret);
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${ts},v1=${mac}`;
}

/* ── Verification ────────────────────────────────────────────────── */

/**
 * Verify a delivered webhook's processor signature. This is the call
 * divorce's `/api/webhooks/checkout` route makes BEFORE trusting the
 * event body — only a verified event may gate the printable packet.
 *
 *   const ts = verifyServerWebhookSignature(rawBody, header, secret);
 *
 * @param rawBody  the EXACT request body bytes as received (un-parsed;
 *                 route code must not JSON.parse before verifying).
 * @param header   the processor signature header (e.g. `stripe-signature`).
 * @param secret   the processor webhook secret, passed explicitly by
 *                 the route (e.g. process.env.STRIPE_WEBHOOK_SECRET).
 * @param opts     tolerance / injected clock for tests.
 * @returns the verified event timestamp (Unix seconds).
 * @throws MISSING_SECRET | FIXTURE_SECRET | BAD_HEADER |
 *         BAD_SIGNATURE | EXPIRED_EVENT | FUTURE_EVENT
 */
export function verifyServerWebhookSignature(
  rawBody: string,
  header: unknown,
  secret: unknown,
  opts: VerifyWebhookOptions = {}
): number {
  const key = assertServerWebhookSecret(secret);
  if (typeof rawBody !== "string") {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
      "webhook body must be the exact raw string delivered by the processor."
    );
  }
  const parsed = parseServerWebhookHeader(header);
  const tolerance = opts.toleranceSeconds ?? SERVER_WEBHOOK_TOLERANCE_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Freshness BEFORE signature: stale/future events aren't worth a MAC.
  if (now - parsed.timestamp > tolerance) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.EXPIRED_EVENT,
      `webhook event is older than the ${tolerance}s tolerance window — possible replay.`
    );
  }
  if (parsed.timestamp - now > tolerance) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.FUTURE_EVENT,
      "webhook event timestamp is in the future beyond tolerance — possible forgery."
    );
  }

  const v1s = parsed.signatures.filter(
    (s) => s.scheme === "v1" && /^[0-9a-f]{64}$/i.test(s.value)
  );
  if (v1s.length === 0) {
    throw err(
      SERVER_WEBHOOK_ERROR_CODES.BAD_HEADER,
      "webhook signature header carries no verifiable v1 signature."
    );
  }

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key)
    .update(signedPayload, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  for (const candidate of v1s) {
    const candidateBuf = Buffer.from(candidate.value, "utf8");
    if (
      candidateBuf.length === expectedBuf.length &&
      timingSafeEqual(expectedBuf, candidateBuf)
    ) {
      return parsed.timestamp;
    }
  }
  throw err(
    SERVER_WEBHOOK_ERROR_CODES.BAD_SIGNATURE,
    "webhook signature verification failed — refusing to trust this event."
  );
}
