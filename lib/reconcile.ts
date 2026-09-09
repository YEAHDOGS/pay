/**
 * reconcile.ts — TEST-MODE-ONLY settlement reconciliation.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The drill for real-money confidence. When a live rail lands, two
 * books must agree or money is wrong somewhere:
 *
 *   LOCAL   — the effects our route produced (WebhookEffect records:
 *             unlock_deliverable, record_payment, provision_…)
 *   PROVIDER — the processor's settlement statement (what it says it
 *             actually settled, in its own money-movement world)
 *
 * If they disagree, one of three things happened, and each one is a
 * specific operational failure:
 *
 *   MISSING  — the statement says money settled, but we never
 *              produced an effect. The customer paid; the product
 *              never unlocked. Under-fulfillment.
 *   EXTRA    — we produced an effect the statement never settled.
 *              The product unlocked; no money arrived. Leakage.
 *   AMOUNT   — same event on both sides, different amounts. Somebody
 *              is lying or rounding; either way, investigate.
 *
 *   const report = reconcileTestSettlement({ localEffects, statement });
 *   if (!report.balanced) pageSomeone(report);
 *
 * Fixtures only: the "provider statement" is a fixture builder, not a
 * network call — `buildTestStatement` assembles one from
 * WebhookEffect records so tests and staging drills can plant
 * missing/extra/mismatch lines deterministically. Statement ids are
 * `stmt_test_*` — unmistakably not real settlement data.
 *
 * Guarantees by construction:
 *   - Pure function, zero IO, zero deps. The same inputs always yield
 *     the same report.
 *   - Duplicate event ids on EITHER side throw BAD_STATEMENT /
 *     BAD_LOCAL — a double-counted ledger poisons reconciliation, so
 *     the drill refuses to bless it.
 *   - Comparison key is the event id (`evt_test_*`); amounts compare
 *     as (amountCents, currency) pairs — no float math anywhere.
 *   - Refunded statement lines are reported under `refunded` and
 *     excluded from matched — a refunded settlement is not a
 *     fulfillment the product should keep.
 *   - Zero dependencies. Zero network. Nothing leaves this process.
 */

import type { WebhookEffect } from "./webhook-handler";

/* ── Hoisted constants ───────────────────────────────────────────── */

export const RECONCILE_ERROR_CODES = Object.freeze({
  /** A statement entry is malformed or duplicated. */
  BAD_STATEMENT: "BAD_STATEMENT",
  /** A local effect record is malformed or duplicated. */
  BAD_LOCAL: "BAD_LOCAL",
});

/** What the provider's statement says happened to one event. */
export interface TestStatementEntry {
  /** The event id both sides agree on (evt_test_*). */
  readonly eventId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: "settled" | "refunded";
}

/** One produced effect, as the route's fulfillment journal would log it. */
export interface LocalEffectRecord {
  readonly eventId: string;
  readonly effect: string;
  readonly amountCents: number;
  readonly currency: string;
}

export interface TestStatement {
  readonly id: string;
  readonly entries: readonly TestStatementEntry[];
  readonly testMode: true;
}

export interface AmountMismatch {
  readonly eventId: string;
  readonly localAmountCents: number;
  readonly localCurrency: string;
  readonly statementAmountCents: number;
  readonly statementCurrency: string;
}

export interface ReconcileReport {
  readonly statementId: string;
  /** True when nothing is missing, extra, or mismatched. */
  readonly balanced: boolean;
  /** Event ids both sides agree on (settled, same amount + currency). */
  readonly matched: readonly string[];
  /** Settled statement lines with no local effect — under-fulfillment. */
  readonly missing: readonly string[];
  /** Local effects with no settled statement line — leakage. */
  readonly extra: readonly string[];
  /** Same event both sides, different (amount, currency). */
  readonly amountMismatch: readonly AmountMismatch[];
  /** Refunded statement lines, informational only. */
  readonly refunded: readonly string[];
}

function err(code: string, message: string): Error {
  const e = new Error(`reconcile: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/* ── Fixture builders ────────────────────────────────────────────── */

let statementCounter = 0;

/**
 * Lift a produced WebhookEffect into the local record shape the
 * reconciler consumes. The route's fulfillment journal would store
 * exactly these fields — event id, effect name, and the money the
 * effect was produced for.
 */
export function localEffectFromWebhookEffect(
  effect: WebhookEffect
): LocalEffectRecord {
  const obj = effect.object as { amountCents?: unknown; currency?: unknown };
  if (
    !effect ||
    typeof effect.eventId !== "string" ||
    typeof effect.effect !== "string" ||
    typeof obj.amountCents !== "number" ||
    typeof obj.currency !== "string"
  ) {
    throw err(
      RECONCILE_ERROR_CODES.BAD_LOCAL,
      "localEffectFromWebhookEffect needs a WebhookEffect with (eventId, effect, amountCents, currency)."
    );
  }
  return {
    eventId: effect.eventId,
    effect: effect.effect,
    amountCents: obj.amountCents,
    currency: obj.currency,
  };
}

/**
 * Build a test provider statement. Deterministic ids (`stmt_test_*`),
 * entries in the order given. This is the fixture stand-in for "the
 * processor's daily settlement report" — a staging drill plants
 * missing/extra/mismatch lines here on purpose.
 */
export function buildTestStatement(
  entries: ReadonlyArray<{
    eventId: string;
    amountCents: number;
    currency?: string;
    status?: "settled" | "refunded";
  }>
): TestStatement {
  statementCounter += 1;
  const id = `stmt_test_${String(statementCounter).padStart(6, "0")}`;
  const normalized: TestStatementEntry[] = entries.map((e) => ({
    eventId: e.eventId,
    amountCents: e.amountCents,
    currency: e.currency ?? "usd",
    status: e.status ?? "settled",
  }));
  assertStatement(normalized, id);
  return { id, entries: normalized, testMode: true };
}

/* ── Alert formatting ───────────────────────────────────────────── */

/**
 * Turn a ReconcileReport into a pager-ready alert string. Balanced
 * reports get one OK line; unbalanced reports name every discrepancy
 * category with counts and event ids, so the on-call engineer can
 * act without re-running the drill. Pure: same report, same string.
 *
 *   const report = reconcileTestSettlement({ localEffects, statement });
 *   if (!report.balanced) pageSomeone(formatReconcileAlert(report));
 */
export function formatReconcileAlert(report: ReconcileReport): string {
  if (report.balanced) {
    return (
      `reconcile ${report.statementId}: BALANCED ` +
      `(${report.matched.length} matched, ${report.refunded.length} refunded)`
    );
  }
  const lines = [`reconcile ${report.statementId}: UNBALANCED`];
  if (report.missing.length > 0) {
    // Settled on the provider's books, never fulfilled locally:
    // the customer paid and the product never unlocked.
    lines.push(
      `missing (${report.missing.length}): ${report.missing.join(", ")}`
    );
  }
  if (report.extra.length > 0) {
    // Fulfilled locally, never settled: the product unlocked and no
    // money arrived. A refunded line whose fulfillment still stands
    // surfaces here too — a human decision, never silent.
    lines.push(`extra (${report.extra.length}): ${report.extra.join(", ")}`);
  }
  for (const m of report.amountMismatch) {
    lines.push(
      `amountMismatch ${m.eventId}: local ${m.localAmountCents} ${m.localCurrency} ` +
        `vs statement ${m.statementAmountCents} ${m.statementCurrency}`
    );
  }
  if (report.refunded.length > 0) {
    lines.push(
      `refunded (info, ${report.refunded.length}): ${report.refunded.join(", ")}`
    );
  }
  return lines.join("\n");
}

/* ── Validation ──────────────────────────────────────────────────── */

function assertEventId(id: unknown, where: string, code: string): asserts id is string {
  if (typeof id !== "string" || !id.startsWith("evt_test_")) {
    throw err(code, `${where}: event id must be an evt_test_* fixture id.`);
  }
}

function assertStatement(entries: TestStatementEntry[], statementId: string): void {
  const seen = new Set<string>();
  for (const e of entries) {
    assertEventId(e.eventId, `statement ${statementId}`, RECONCILE_ERROR_CODES.BAD_STATEMENT);
    if (typeof e.amountCents !== "number" || !Number.isInteger(e.amountCents) || e.amountCents < 0) {
      throw err(
        RECONCILE_ERROR_CODES.BAD_STATEMENT,
        `statement ${statementId}: amountCents for ${e.eventId} must be a non-negative integer.`
      );
    }
    if (typeof e.currency !== "string" || e.currency.length === 0) {
      throw err(
        RECONCILE_ERROR_CODES.BAD_STATEMENT,
        `statement ${statementId}: currency for ${e.eventId} must be a non-empty string.`
      );
    }
    if (e.status !== "settled" && e.status !== "refunded") {
      throw err(
        RECONCILE_ERROR_CODES.BAD_STATEMENT,
        `statement ${statementId}: status for ${e.eventId} must be settled|refunded.`
      );
    }
    if (seen.has(e.eventId)) {
      throw err(
        RECONCILE_ERROR_CODES.BAD_STATEMENT,
        `statement ${statementId}: duplicate entry for ${e.eventId} — a double-counted statement poisons reconciliation.`
      );
    }
    seen.add(e.eventId);
  }
}

function assertLocal(records: LocalEffectRecord[]): void {
  const seen = new Set<string>();
  for (const r of records) {
    assertEventId(r.eventId, "local effects", RECONCILE_ERROR_CODES.BAD_LOCAL);
    if (seen.has(r.eventId)) {
      throw err(
        RECONCILE_ERROR_CODES.BAD_LOCAL,
        `local effects: duplicate record for ${r.eventId} — reconcile a de-duplicated journal.`
      );
    }
    seen.add(r.eventId);
  }
}

/* ── The reconcile routine ───────────────────────────────────────── */

/**
 * Compare the route's produced effects against a provider statement.
 * Pure: same inputs, same report. Never throws on a mere
 * disagreement — disagreement is the report. Throws only when an
 * input is structurally invalid (duplicates, malformed entries),
 * because a poisoned input would bless a lie.
 */
export function reconcileTestSettlement(args: {
  localEffects: readonly LocalEffectRecord[];
  statement: TestStatement;
}): ReconcileReport {
  const { localEffects, statement } = args;
  if (!statement || statement.testMode !== true || !statement.id.startsWith("stmt_test_")) {
    throw err(
      RECONCILE_ERROR_CODES.BAD_STATEMENT,
      "reconcile needs a test-mode statement (stmt_test_* id, testMode: true)."
    );
  }
  assertStatement([...statement.entries], statement.id);
  assertLocal([...localEffects]);

  const localByEventId = new Map<string, LocalEffectRecord>();
  for (const r of localEffects) localByEventId.set(r.eventId, r);

  const matched: string[] = [];
  const missing: string[] = [];
  const refunded: string[] = [];
  const amountMismatch: AmountMismatch[] = [];
  const coveredLocal = new Set<string>();

  for (const entry of statement.entries) {
    if (entry.status === "refunded") {
      refunded.push(entry.eventId);
      continue;
    }
    const local = localByEventId.get(entry.eventId);
    if (!local) {
      // Settled on the provider's books, never fulfilled locally.
      missing.push(entry.eventId);
      continue;
    }
    coveredLocal.add(entry.eventId);
    if (local.amountCents === entry.amountCents && local.currency === entry.currency) {
      matched.push(entry.eventId);
    } else {
      amountMismatch.push({
        eventId: entry.eventId,
        localAmountCents: local.amountCents,
        localCurrency: local.currency,
        statementAmountCents: entry.amountCents,
        statementCurrency: entry.currency,
      });
    }
  }

  const extra: string[] = [];
  for (const r of localEffects) {
    if (!coveredLocal.has(r.eventId)) {
      // Fulfilled locally, no settled line on the statement. (A local
      // effect whose statement line was refunded lands here too: the
      // money came back, the fulfillment stands — that is a decision
      // for a human, surfaced as extra, never silently matched.)
      extra.push(r.eventId);
    }
  }

  return {
    statementId: statement.id,
    balanced:
      missing.length === 0 && extra.length === 0 && amountMismatch.length === 0,
    matched,
    missing,
    extra,
    amountMismatch,
    refunded,
  };
}
