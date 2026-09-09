/**
 * Regression tests for lib/audit-log.ts + the audit wiring in
 * lib/webhook-handler.ts.
 *
 * Fixtures only: dummy events, tmpdir scratch files, no network.
 * Run: bun test lib/audit-log.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUDIT_EVENT_KINDS,
  type AuditLog,
  MemoryAuditLog,
  FileAuditLog,
} from "./audit-log";
import {
  getAuditLog,
  handleTestWebhookDelivery,
  resetWebhookHandler,
  setAuditLog,
} from "./webhook-handler";
import { getProvider } from "./checkout-provider";
import {
  deliverTestWebhookEvent,
  resetWebhookFixtures,
  type WebhookEventType,
} from "./webhook-test";
import {
  DRILL_DIVORCE_PRODUCT_ID,
  resetStagingDrill,
  runDivorceStagingDrill,
  verifyThenDispatch,
} from "./staging-drill";

let scratch: string | null = null;
function scratchDir(): string {
  if (!scratch) scratch = mkdtempSync(join(tmpdir(), "pay-audit-"));
  return scratch;
}

function freshAudit(): MemoryAuditLog {
  const log = new MemoryAuditLog();
  setAuditLog(log);
  return log;
}

afterEach(() => {
  // Never leak a custom audit log into the other suites: drills and
  // the webhook tests expect the in-memory default, empty.
  setAuditLog(new MemoryAuditLog());
  resetStagingDrill();
  resetWebhookFixtures();
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

describe("AuditLog interface — both adapters honor it", () => {
  test("memory adapter contract", () => {
    const log: AuditLog = new MemoryAuditLog();
    const a = log.record(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED, {
      eventId: "evt_test_aaa",
      eventType: "checkout.session.completed",
    });
    const b = log.record(AUDIT_EVENT_KINDS.EFFECT_PRODUCED, {
      eventId: "evt_test_aaa",
      effect: "unlock_deliverable",
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.testMode).toBe(true);
    expect(log.size).toBe(2);
    const entries = log.entries();
    expect(entries.length).toBe(2);
    expect(entries[0].kind).toBe(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED);
    // entries() returns a copy — mutating it mutates nothing.
    (entries as unknown[]).pop();
    expect(log.size).toBe(2);
    log.clear();
    expect(log.size).toBe(0);
  });

  test("file adapter contract", () => {
    const path = join(scratchDir(), "contract.jsonl");
    const log: AuditLog = new FileAuditLog(path);
    const a = log.record(AUDIT_EVENT_KINDS.DELIVERY_REJECTED, {
      code: "BAD_SIGNATURE",
    });
    expect(a.seq).toBe(0);
    expect(a.code).toBe("BAD_SIGNATURE");
    expect(a.testMode).toBe(true);
    expect(log.size).toBe(1);
    log.clear();
    expect(log.size).toBe(0);
  });

  test("record rejects an unknown kind", () => {
    const log = new MemoryAuditLog();
    expect(() =>
      log.record("nonsense.kind" as never)
    ).toThrow(/unknown kind/);
    expect(() =>
      new FileAuditLog(join(scratchDir(), "bad-kind.jsonl")).record(
        "nonsense.kind" as never
      )
    ).toThrow(/unknown kind/);
  });
});

describe("file audit log — trail survives a restart", () => {
  test("write, reload in a new instance on the same file; seq resumes", () => {
    const path = join(scratchDir(), "restart.jsonl");
    const before = new FileAuditLog(path);
    before.record(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED, {
      eventId: "evt_test_111",
      eventType: "checkout.session.completed",
    });
    before.record(AUDIT_EVENT_KINDS.EFFECT_PRODUCED, {
      eventId: "evt_test_111",
      effect: "unlock_deliverable",
    });
    // A restarted server boots a fresh adapter on the same file.
    const after = new FileAuditLog(path);
    expect(after.size).toBe(2);
    const entries = after.entries();
    expect(entries[0].eventId).toBe("evt_test_111");
    expect(entries[1].effect).toBe("unlock_deliverable");
    // The sequence continues where the file left off — no collisions.
    const next = after.record(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED, {
      eventId: "evt_test_222",
    });
    expect(next.seq).toBe(2);
    expect(after.size).toBe(3);
  });
});

describe("file audit log — corrupt-line tolerance", () => {
  test("poisoned file loads without crashing; valid records survive", () => {
    const path = join(scratchDir(), "poisoned.jsonl");
    writeFileSync(
      path,
      [
        `{"seq":0,"ts":1,"kind":"webhook.received","eventId":"evt_test_ok1","testMode":true}`,
        ``, // blank line — ignored silently
        `{"seq":1,"ts":1,"kind":"webhook.received",`, // truncated JSON
        `{"seq":2,"ts":1,"kind":"webhook.received","testMode":true}`, // valid shape, no id
        `[1,2,3]`, // parses, wrong shape
        `{"seq":3,"ts":1,"kind":"webhook.received","eventId":"evt_test_ok2","testMode":true}`,
      ].join("\n"),
      "utf8"
    );
    const log = new FileAuditLog(path);
    expect(log.size).toBe(3);
    expect(log.corruptLineCount).toBe(2); // truncated + wrong-shape
    const ids = log.entries().map((e) => e.eventId);
    expect(ids).toContain("evt_test_ok1");
    expect(ids).toContain("evt_test_ok2");
  });
});

describe("webhook handler — audit wiring", () => {
  test("full divorce drill leaves received + produced in order", () => {
    const log = freshAudit();
    const { effect } = runDivorceStagingDrill();
    expect(effect.effect).toBe("unlock_deliverable");
    expect(log.size).toBe(2);
    const [received, produced] = log.entries();
    expect(received.seq).toBe(0);
    expect(received.kind).toBe(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED);
    expect(received.eventId).toBe(effect.eventId);
    expect(received.eventType).toBe("checkout.session.completed");
    expect(produced.seq).toBe(1);
    expect(produced.kind).toBe(AUDIT_EVENT_KINDS.EFFECT_PRODUCED);
    expect(produced.eventId).toBe(effect.eventId);
    expect(produced.eventType).toBe("checkout.session.completed");
    expect(produced.effect).toBe("unlock_deliverable");
  });

  test("forged signature: rejection is audited, nothing else happens", () => {
    const log = freshAudit();
    resetStagingDrill();
    const provider = getProvider();
    const session = provider.createSession(DRILL_DIVORCE_PRODUCT_ID);
    const receipt = provider.confirmPayment(
      session.id,
      session,
      { last4: "4242" },
      {}
    );
    const { rawBody } = deliverTestWebhookEvent(
      "checkout.session.completed" as WebhookEventType,
      receipt
    );
    let code: string | undefined;
    try {
      handleTestWebhookDelivery(rawBody, "bogus-signature");
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("BAD_SIGNATURE");
    expect(log.size).toBe(1);
    const [rejected] = log.entries();
    expect(rejected.kind).toBe(AUDIT_EVENT_KINDS.DELIVERY_REJECTED);
    expect(rejected.code).toBe("BAD_SIGNATURE");
    expect(rejected.eventId).toBeUndefined(); // never verified — no id to blame
  });

  test("double delivery: one produced, then a rejected replay", () => {
    const log = freshAudit();
    resetStagingDrill();
    const provider = getProvider();
    const session = provider.createSession(DRILL_DIVORCE_PRODUCT_ID);
    const receipt = provider.confirmPayment(
      session.id,
      session,
      { last4: "4242" },
      {}
    );
    const { rawBody, signature } = deliverTestWebhookEvent(
      "checkout.session.completed" as WebhookEventType,
      receipt
    );
    verifyThenDispatch(rawBody, signature);
    let code: string | undefined;
    try {
      verifyThenDispatch(rawBody, signature);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    // Second delivery dies at parse-level replay — ALREADY_HANDLED
    // never fires here; the audit still names the rejection.
    expect(["REPLAYED_EVENT", "ALREADY_HANDLED"]).toContain(code);
    const kinds = log.entries().map((e) => e.kind);
    expect(kinds[0]).toBe(AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED);
    expect(kinds[1]).toBe(AUDIT_EVENT_KINDS.EFFECT_PRODUCED);
    expect(kinds[kinds.length - 1]).toBe(AUDIT_EVENT_KINDS.DELIVERY_REJECTED);
    // Exactly one effect was ever produced for this event id.
    const produced = log
      .entries()
      .filter((e) => e.kind === AUDIT_EVENT_KINDS.EFFECT_PRODUCED);
    expect(produced.length).toBe(1);
  });

  test("audit failure never blocks fulfillment", () => {
    // A sabotaged adapter whose record() always throws: delivery must
    // still produce its effect.
    class BrokenAuditLog extends MemoryAuditLog {
      override record(): never {
        throw new Error("disk on fire");
      }
    }
    setAuditLog(new BrokenAuditLog());
    const { effect } = runDivorceStagingDrill();
    expect(effect.effect).toBe("unlock_deliverable");
  });

  test("setAuditLog rejects garbage; resetWebhookHandler clears the log", () => {
    expect(() => setAuditLog(null as never)).toThrow(/AuditLog/);
    expect(() => setAuditLog({} as never)).toThrow(/AuditLog/);
    const log = freshAudit();
    runDivorceStagingDrill();
    expect(log.size).toBe(2);
    resetWebhookHandler();
    expect(log.size).toBe(0);
    // The default stays in-memory and swappable.
    expect(getAuditLog()).toBeInstanceOf(MemoryAuditLog);
  });

  test("audit records carry no payloads, signatures, or secrets", () => {
    const log = freshAudit();
    runDivorceStagingDrill();
    const json = JSON.stringify(log.entries());
    expect(json).not.toContain("signature");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("whsec");
    expect(json).not.toContain("rawBody");
    expect(json).not.toContain("cardNumber");
  });
});
