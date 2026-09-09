/**
 * Regression tests for lib/reconcile.ts — the settlement drill:
 * matched / missing / extra / amount-mismatch against a provider
 * statement fixture. Fixtures only: no keys, no network.
 * Run: bun test lib/reconcile.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  confirmTestPayment,
  confirmTestSubscription,
  createTestCheckout,
} from "./checkout-test";
import { deliverTestWebhookEvent, resetWebhookFixtures } from "./webhook-test";
import {
  type WebhookEffect,
  handleTestWebhookDelivery,
  resetWebhookHandler,
} from "./webhook-handler";
import {
  RECONCILE_ERROR_CODES,
  buildTestStatement,
  localEffectFromWebhookEffect,
  reconcileTestSettlement,
  type LocalEffectRecord,
} from "./reconcile";

beforeEach(() => {
  resetWebhookFixtures();
  resetWebhookHandler();
});

function divorceEffect(): WebhookEffect {
  const session = createTestCheckout("uncontested_packet");
  const receipt = confirmTestPayment(session.id, session);
  const { rawBody, signature } = deliverTestWebhookEvent(
    "checkout.session.completed",
    receipt
  );
  return handleTestWebhookDelivery(rawBody, signature);
}

function waxEffect(): WebhookEffect {
  const session = createTestCheckout("wax_subscription");
  const sub = confirmTestSubscription(session.id, session);
  const { rawBody, signature } = deliverTestWebhookEvent(
    "customer.subscription.created",
    sub
  );
  return handleTestWebhookDelivery(rawBody, signature);
}

function localOf(fx: WebhookEffect): LocalEffectRecord {
  return localEffectFromWebhookEffect(fx);
}

describe("reconcileTestSettlement — the clean drill", () => {
  test("both money milestones reconcile clean: matched, balanced", () => {
    const local = [localOf(divorceEffect()), localOf(waxEffect())];
    const statement = buildTestStatement(
      local.map((r) => ({
        eventId: r.eventId,
        amountCents: r.amountCents,
        currency: r.currency,
      }))
    );
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.balanced).toBe(true);
    expect(report.matched).toHaveLength(2);
    expect(report.missing).toHaveLength(0);
    expect(report.extra).toHaveLength(0);
    expect(report.amountMismatch).toHaveLength(0);
    expect(report.statementId.startsWith("stmt_test_")).toBe(true);
  });

  test("empty books reconcile clean", () => {
    const statement = buildTestStatement([]);
    const report = reconcileTestSettlement({ localEffects: [], statement });
    expect(report.balanced).toBe(true);
  });
});

describe("reconcileTestSettlement — planted discrepancies", () => {
  test("planted missing: settled on the statement, never fulfilled locally", () => {
    const local = [localOf(divorceEffect())];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 3000 },
      // The provider settled a charge we have no effect for.
      { eventId: "evt_test_planted_missing_0001", amountCents: 3000 },
    ]);
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.balanced).toBe(false);
    expect(report.missing).toEqual(["evt_test_planted_missing_0001"]);
    expect(report.matched).toHaveLength(1);
    expect(report.extra).toHaveLength(0);
  });

  test("planted extra: fulfilled locally, never settled on the statement", () => {
    const local = [localOf(divorceEffect()), localOf(waxEffect())];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 3000 },
      // wax was fulfilled but the statement has no line for it.
    ]);
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.balanced).toBe(false);
    expect(report.extra).toEqual([local[1].eventId]);
    expect(report.matched).toHaveLength(1);
    expect(report.missing).toHaveLength(0);
  });

  test("amount mismatch: same event, different money", () => {
    const local = [localOf(divorceEffect())];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 2999 }, // a cent short
    ]);
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.balanced).toBe(false);
    expect(report.amountMismatch).toHaveLength(1);
    expect(report.amountMismatch[0]).toMatchObject({
      eventId: local[0].eventId,
      localAmountCents: 3000,
      statementAmountCents: 2999,
    });
    expect(report.matched).toHaveLength(0);
  });

  test("currency mismatch counts as an amount mismatch", () => {
    const local = [localOf(divorceEffect())];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 3000, currency: "eur" },
    ]);
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.balanced).toBe(false);
    expect(report.amountMismatch[0].statementCurrency).toBe("eur");
  });

  test("refunded lines are reported, never matched", () => {
    const local = [localOf(divorceEffect())];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 3000, status: "refunded" },
    ]);
    const report = reconcileTestSettlement({ localEffects: local, statement });
    expect(report.refunded).toEqual([local[0].eventId]);
    expect(report.matched).toHaveLength(0);
    // Money came back but the fulfillment stands: surfaced as extra,
    // a human decision, never silently absorbed.
    expect(report.extra).toEqual([local[0].eventId]);
    expect(report.balanced).toBe(false);
  });
});

describe("reconcileTestSettlement — poisoned inputs", () => {
  test("duplicate statement entries throw BAD_STATEMENT", () => {
    const local = [localOf(divorceEffect())];
    expect(() =>
      buildTestStatement([
        { eventId: local[0].eventId, amountCents: 3000 },
        { eventId: local[0].eventId, amountCents: 3000 },
      ])
    ).toThrow(expect.objectContaining({ code: RECONCILE_ERROR_CODES.BAD_STATEMENT }));
  });

  test("non-fixture event id on a statement line throws BAD_STATEMENT", () => {
    expect(() =>
      buildTestStatement([{ eventId: "evt_live_123", amountCents: 3000 }])
    ).toThrow(expect.objectContaining({ code: RECONCILE_ERROR_CODES.BAD_STATEMENT }));
  });

  test("duplicate local records throw BAD_LOCAL", () => {
    const fx = divorceEffect();
    const local = [localOf(fx), localOf(fx)];
    const statement = buildTestStatement([
      { eventId: local[0].eventId, amountCents: 3000 },
    ]);
    expect(() => reconcileTestSettlement({ localEffects: local, statement })).toThrow(
      expect.objectContaining({ code: RECONCILE_ERROR_CODES.BAD_LOCAL })
    );
  });

  test("a non-fixture statement object is refused", () => {
    const local = [localOf(divorceEffect())];
    expect(() =>
      reconcileTestSettlement({
        localEffects: local,
        statement: {
          id: "stmt_live_999",
          entries: [],
          testMode: false,
        } as never,
      })
    ).toThrow(expect.objectContaining({ code: RECONCILE_ERROR_CODES.BAD_STATEMENT }));
  });

  test("localEffectFromWebhookEffect refuses a garbage effect", () => {
    expect(() =>
      localEffectFromWebhookEffect({ eventId: "nope" } as never)
    ).toThrow(expect.objectContaining({ code: RECONCILE_ERROR_CODES.BAD_LOCAL }));
  });
});
