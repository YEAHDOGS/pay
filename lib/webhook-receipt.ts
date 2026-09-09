/**
 * webhook-receipt.ts — TEST-MODE-ONLY webhook receipt hardening.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The HTTP seam's front door. A processor POSTs two things to the
 * route: a raw body and a signature header. `handleTestWebhookDelivery`
 * in webhook-handler.ts already verifies-before-dispatching — THIS
 * module answers the cruder questions that come BEFORE signature
 * verification is even meaningful:
 *
 *   - Is there a signature at all? (missing/empty header)
 *   - Is the body sane enough to hand to the HMAC? (size guard)
 *
 *   const effect = receiveTestWebhook(rawBody, signatureHeader);
 *   // effect.effect === "unlock_deliverable" → fulfill it
 *
 * Guarantees by construction:
 *   - A missing signature is its own error, not a vague BAD_SIGNATURE:
 *     MISSING_SIGNATURE throws before any crypto runs, and the audit
 *     trail records `delivery.rejected` with code MISSING_SIGNATURE so
 *     staging forensics can tell "no header" apart from "forged
 *     header" apart from "tampered body".
 *   - Oversized bodies are rejected BEFORE the HMAC runs: a 10MB junk
 *     POST burns no crypto time and never reaches JSON.parse. The
 *     limit (1MB) is generous for fixture events and lives in one
 *     hoisted constant.
 *   - After the front-door checks pass, this delegates 1:1 to
 *     `handleTestWebhookDelivery` — verify, then dispatch, then
 *     audit. No second verification path exists.
 *   - Everything that reaches the verifier still travels the audit
 *     trail: webhook.received / effect.produced / delivery.rejected
 *     with ids and codes only — no bodies, no signatures, no secrets.
 *   - Zero dependencies. Zero network. Nothing leaves this process.
 */

import { AUDIT_EVENT_KINDS } from "./audit-log";
import {
  type TestWebhookEvent,
  type WebhookEffect,
  getAuditLog,
  handleTestWebhookDelivery,
} from "./webhook-handler";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** Largest webhook body the front door will hand to the verifier. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576 as const; // 1 MiB

export const RECEIPT_ERROR_CODES = Object.freeze({
  /** Everything verify/dispatch can throw, kept for convenience. */
  ...{
    BAD_SIGNATURE: "BAD_SIGNATURE",
    EXPIRED_EVENT: "EXPIRED_EVENT",
    REPLAYED_EVENT: "REPLAYED_EVENT",
    BAD_EVENT: "BAD_EVENT",
    UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
    INVALID_OBJECT: "INVALID_OBJECT",
    ALREADY_HANDLED: "ALREADY_HANDLED",
  },
  /** No signature header (or an empty one) on the delivery. */
  MISSING_SIGNATURE: "MISSING_SIGNATURE",
  /** Body exceeded MAX_WEBHOOK_BODY_BYTES. */
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
});

function err(code: string, message: string): Error {
  const e = new Error(`webhook-receipt: ${message}`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

/**
 * Byte length of a string without depending on Buffer — the front door
 * needs a size guard before it trusts the body for anything.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/* ── The front door ──────────────────────────────────────────────── */

/**
 * Receive a webhook delivery the way an HTTP route would: the exact
 * raw body plus the signature header value (which may be missing —
 * that is the whole point of this module).
 *
 * Front-door checks, in order:
 *   1. signature present (non-empty string) → else MISSING_SIGNATURE
 *   2. body within MAX_WEBHOOK_BODY_BYTES  → else BODY_TOO_LARGE
 *   3. delegate to handleTestWebhookDelivery (verify → dispatch)
 *
 * Rejections at the front door are audit-logged as
 * `delivery.rejected` with the receipt error code, through the same
 * audit log the handler uses — best-effort, never blocking.
 *
 * @throws MISSING_SIGNATURE | BODY_TOO_LARGE | (any verify/dispatch code)
 */
export function receiveTestWebhook(
  rawBody: string,
  signature: string | null | undefined,
  opts: {
    secret?: string;
    nowSeconds?: number;
    toleranceSeconds?: number;
  } = {}
): WebhookEffect {
  if (typeof signature !== "string" || signature.length === 0) {
    auditRejected(RECEIPT_ERROR_CODES.MISSING_SIGNATURE);
    throw err(
      RECEIPT_ERROR_CODES.MISSING_SIGNATURE,
      "webhook delivery carried no signature — refusing to verify or process."
    );
  }
  if (typeof rawBody !== "string" || byteLength(rawBody) > MAX_WEBHOOK_BODY_BYTES) {
    auditRejected(RECEIPT_ERROR_CODES.BODY_TOO_LARGE);
    throw err(
      RECEIPT_ERROR_CODES.BODY_TOO_LARGE,
      `webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes — refusing before verification.`
    );
  }
  return handleTestWebhookDelivery(rawBody, signature, opts);
}

/**
 * Best-effort audit of a front-door rejection: ids and the code only,
 * never the body or the signature. A failing audit adapter must never
 * block the rejection itself.
 */
function auditRejected(code: string): void {
  try {
    getAuditLog().record(AUDIT_EVENT_KINDS.DELIVERY_REJECTED, { code });
  } catch {
    // Audit is best-effort — never block on it.
  }
}

/* ── Re-exports for the route author ─────────────────────────────── */

export type { TestWebhookEvent, WebhookEffect };
export { AUDIT_EVENT_KINDS };
