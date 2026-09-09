/**
 * Regression tests for lib/idempotency-ledger.ts + the swappable
 * handler ledger in lib/webhook-handler.ts.
 *
 * Fixtures only: dummy keys, tmpdir scratch files, no network.
 * Run: bun test lib/idempotency-ledger.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type IdempotencyLedger,
  MemoryIdempotencyLedger,
  FileIdempotencyLedger,
} from "./idempotency-ledger";
import {
  HANDLER_ERROR_CODES,
  getHandlerLedger,
  handleTestWebhookDelivery,
  setHandlerLedger,
} from "./webhook-handler";
import { getProvider } from "./checkout-provider";
import {
  deliverTestWebhookEvent,
  resetWebhookFixtures,
} from "./webhook-test";
import { resetStagingDrill, runDivorceStagingDrill } from "./staging-drill";

let scratch: string | null = null;
function scratchDir(): string {
  if (!scratch) scratch = mkdtempSync(join(tmpdir(), "pay-ledger-"));
  return scratch;
}
afterEach(() => {
  // Never leak a file ledger into the other suites: drills and the
  // webhook tests expect the in-memory default.
  setHandlerLedger(new MemoryIdempotencyLedger());
  resetStagingDrill();
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

function freshFileLedger(): FileIdempotencyLedger {
  return new FileIdempotencyLedger(join(scratchDir(), "webhook-ids.jsonl"));
}

/** Deliver one divorce $30 event end-to-end through the public seam. */
function deliverDivorceEvent() {
  const provider = getProvider();
  const session = provider.createSession("uncontested_packet");
  const receipt = provider.confirmPayment(session.id, session);
  return deliverTestWebhookEvent("checkout.session.completed", receipt);
}

function sameInterfaceContract(make: () => IdempotencyLedger): void {
  const ledger = make();
  expect(ledger.size).toBe(0);
  expect(ledger.has("evt_test_abc")).toBe(false);
  ledger.add("evt_test_abc");
  expect(ledger.has("evt_test_abc")).toBe(true);
  expect(ledger.size).toBe(1);
  // Duplicate adds are no-ops — exactly-once stays exactly-once.
  ledger.add("evt_test_abc");
  ledger.add("evt_test_abc");
  expect(ledger.size).toBe(1);
  expect(() => ledger.add("")).toThrow();
  expect(() => ledger.add(undefined as unknown as string)).toThrow();
  ledger.clear();
  expect(ledger.size).toBe(0);
  expect(ledger.has("evt_test_abc")).toBe(false);
}

describe("IdempotencyLedger interface — both adapters honor it", () => {
  test("memory adapter contract", () => {
    sameInterfaceContract(() => new MemoryIdempotencyLedger());
  });

  test("file adapter contract", () => {
    sameInterfaceContract(() => freshFileLedger());
  });
});

describe("file ledger — keys survive a process restart", () => {
  test("write, reload in a new instance on the same file", () => {
    const first = freshFileLedger();
    first.add("evt_test_restart_1");
    first.add("evt_test_restart_2");
    expect(first.size).toBe(2);
    // Simulate a server restart: a brand-new ledger on the same file
    // must still know every id the old process recorded.
    const second = new FileIdempotencyLedger(first.path);
    expect(second.size).toBe(2);
    expect(second.has("evt_test_restart_1")).toBe(true);
    expect(second.has("evt_test_restart_2")).toBe(true);
    // And the file really is JSON-lines on disk, one record per id.
    const lines = readFileSync(first.path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe("evt_test_restart_1");
  });

  test("handler replay after restart: same event → ALREADY_HANDLED", () => {
    const path = join(scratchDir(), "restart.jsonl");
    setHandlerLedger(new FileIdempotencyLedger(path));
    resetStagingDrill();
    const { rawBody, signature } = deliverDivorceEvent();
    const effect = handleTestWebhookDelivery(rawBody, signature);
    expect(effect.effect).toBe("unlock_deliverable");

    // Simulate the restart: new ledger instance on the same file,
    // fresh parse-level ledger (its in-memory keys died with the
    // process), then redeliver the EXACT same event.
    setHandlerLedger(new FileIdempotencyLedger(path));
    resetWebhookFixtures();
    try {
      handleTestWebhookDelivery(rawBody, signature);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        HANDLER_ERROR_CODES.ALREADY_HANDLED
      );
    }
    // Single effect, not two: the packet was earned exactly once.
    expect(getHandlerLedger().size).toBe(1);
  });
});

describe("file ledger — corrupt-line tolerance", () => {
  test("poisoned file loads without crashing; valid keys survive", () => {
    const path = join(scratchDir(), "poisoned.jsonl");
    writeFileSync(
      path,
      [
        `{"id":"evt_test_good_1","ts":1}`,
        ``, // blank line — ignored silently
        `{"id":"evt_test_good_2","ts":2}`,
        `{"this is not json`, // truncated/corrupt line
        `{"id":42}`, // wrong shape: id not a string
        `{"nope":"missing id"}`, // wrong shape: no id
        `{"id":"evt_test_good_3","ts":3}`,
      ].join("\n"),
      "utf8"
    );
    let ledger: FileIdempotencyLedger | null = null;
    expect(() => {
      ledger = new FileIdempotencyLedger(path);
    }).not.toThrow();
    expect(ledger!.size).toBe(3);
    expect(ledger!.has("evt_test_good_1")).toBe(true);
    expect(ledger!.has("evt_test_good_2")).toBe(true);
    expect(ledger!.has("evt_test_good_3")).toBe(true);
    expect(ledger!.corruptLineCount).toBe(3);
    // The ledger stays usable: new ids append after the damage.
    ledger!.add("evt_test_good_4");
    expect(ledger!.has("evt_test_good_4")).toBe(true);
  });
});

describe("file ledger — concurrent duplicate delivery is single-effect", () => {
  test("double delivery of one event: one effect, one ALREADY_HANDLED", () => {
    const ledger = freshFileLedger();
    setHandlerLedger(ledger);
    resetStagingDrill();
    const { rawBody, signature } = deliverDivorceEvent();
    const first = handleTestWebhookDelivery(rawBody, signature);
    expect(first.effect).toBe("unlock_deliverable");

    // The parse-level replay ledger would reject the duplicate first —
    // clear it so the duplicate reaches the HANDLER ledger, the layer
    // under test. (JS is single-threaded, so "concurrent" here means
    // the handler's check-then-add is atomic across deliveries; the
    // file ledger makes the second delivery's replay visible to any
    // process holding the file.)
    resetWebhookFixtures();
    try {
      handleTestWebhookDelivery(rawBody, signature);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        HANDLER_ERROR_CODES.ALREADY_HANDLED
      );
    }
    expect(ledger.size).toBe(1);
    const lines = readFileSync(ledger.path, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });
});

describe("handler ledger swap — default stays in-memory", () => {
  test("default ledger is in-memory; swap is explicit", () => {
    expect(getHandlerLedger()).toBeInstanceOf(MemoryIdempotencyLedger);
  });

  test("setHandlerLedger rejects garbage", () => {
    expect(() =>
      setHandlerLedger(undefined as unknown as IdempotencyLedger)
    ).toThrow();
    expect(() => setHandlerLedger({} as unknown as IdempotencyLedger)).toThrow();
  });

  test("full drill loop runs on a file ledger end-to-end", () => {
    const ledger = freshFileLedger();
    setHandlerLedger(ledger);
    const { effect } = runDivorceStagingDrill();
    expect(effect.effect).toBe("unlock_deliverable");
    expect(ledger.has(effect.eventId)).toBe(true);
    // The effect's event id is really on disk.
    expect(readFileSync(ledger.path, "utf8")).toContain(effect.eventId);
  });
});
