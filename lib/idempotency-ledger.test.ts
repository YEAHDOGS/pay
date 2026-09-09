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
  BoundedIdempotencyLedger,
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

describe("bounded ledger — memory stays bounded (LRU + TTL)", () => {
  test("never exceeds maxEntries; least-recently-used evicts first", () => {
    const ledger = new BoundedIdempotencyLedger({ maxEntries: 3, ttlSeconds: 0 });
    ledger.add("evt_test_a");
    ledger.add("evt_test_b");
    ledger.add("evt_test_c");
    expect(ledger.size).toBe(3);
    // Touch `a` so `b` is the least-recently-used entry now.
    expect(ledger.has("evt_test_a")).toBe(true);
    ledger.add("evt_test_d"); // overflow: evicts exactly one id
    expect(ledger.size).toBe(3);
    expect(ledger.has("evt_test_b")).toBe(false); // evicted: stale, not looked up
    expect(ledger.has("evt_test_a")).toBe(true); // touched → kept
    expect(ledger.has("evt_test_c")).toBe(true);
    expect(ledger.has("evt_test_d")).toBe(true);
  });

  test("duplicate adds stay one entry; garbage still rejected", () => {
    const ledger = new BoundedIdempotencyLedger({ maxEntries: 8, ttlSeconds: 0 });
    ledger.add("evt_test_dup");
    ledger.add("evt_test_dup");
    expect(ledger.size).toBe(1);
    expect(() => ledger.add("")).toThrow();
    expect(() => new BoundedIdempotencyLedger({ maxEntries: 0 })).toThrow();
  });

  test("TTL expiry: an id forgotten after its TTL may be recorded again", () => {
    let now = 1_000_000;
    const ledger = new BoundedIdempotencyLedger({
      maxEntries: 100,
      ttlSeconds: 60,
      nowSeconds: () => now,
    });
    ledger.add("evt_test_ttl");
    expect(ledger.has("evt_test_ttl")).toBe(true);
    now += 61; // past the TTL
    expect(ledger.has("evt_test_ttl")).toBe(false);
    expect(ledger.size).toBe(0);
    // Re-adding after expiry is not a no-op duplicate — the id is fresh.
    ledger.add("evt_test_ttl");
    expect(ledger.has("evt_test_ttl")).toBe(true);
    expect(ledger.size).toBe(1);
  });

  test("constructor guards: maxEntries ≥ 1, ttlSeconds ≥ 0", () => {
    expect(() => new BoundedIdempotencyLedger({ maxEntries: 0 })).toThrow();
    expect(() => new BoundedIdempotencyLedger({ ttlSeconds: -1 })).toThrow();
  });
});

describe("conflict-aware ledger — per-id content fingerprints", () => {
  test("recordFingerprint: first write wins; mismatch is visible to the caller", () => {
    const ledger = new BoundedIdempotencyLedger({ maxEntries: 10, ttlSeconds: 0 });
    ledger.add("evt_test_fp");
    expect(ledger.fingerprintFor("evt_test_fp")).toBe(undefined);
    ledger.recordFingerprint("evt_test_fp", "fp-original");
    expect(ledger.fingerprintFor("evt_test_fp")).toBe("fp-original");
    // Second record does NOT overwrite — the handler compares before
    // recording; silent overwrite would destroy the evidence.
    ledger.recordFingerprint("evt_test_fp", "fp-forged");
    expect(ledger.fingerprintFor("evt_test_fp")).toBe("fp-original");
  });

  test("recordFingerprint refuses unknown ids and empty fingerprints", () => {
    const ledger = new BoundedIdempotencyLedger({ maxEntries: 10, ttlSeconds: 0 });
    expect(() => ledger.recordFingerprint("evt_test_missing", "fp")).toThrow();
    ledger.add("evt_test_empty");
    expect(() => ledger.recordFingerprint("evt_test_empty", "")).toThrow();
  });

  test("fingerprint evicts with its id; expired ids report no fingerprint", () => {
    let now = 500;
    const ledger = new BoundedIdempotencyLedger({
      maxEntries: 1,
      ttlSeconds: 60,
      nowSeconds: () => now,
    });
    ledger.add("evt_test_first");
    ledger.recordFingerprint("evt_test_first", "fp-1");
    ledger.add("evt_test_second"); // evicts `first` (capacity 1)
    expect(ledger.fingerprintFor("evt_test_first")).toBe(undefined);

    const ttl = new BoundedIdempotencyLedger({
      maxEntries: 10,
      ttlSeconds: 30,
      nowSeconds: () => now,
    });
    ttl.add("evt_test_ttl_fp");
    ttl.recordFingerprint("evt_test_ttl_fp", "fp-ttl");
    now += 31;
    expect(ttl.fingerprintFor("evt_test_ttl_fp")).toBe(undefined);
  });
});

describe("file ledger — compact bounds the file", () => {
  test("compact drops oldest ids, keeps newest; file rewrites cleanly", () => {
    const path = join(scratchDir(), "compact.jsonl");
    // Write five ids with ascending timestamps by hand (deterministic).
    writeFileSync(
      path,
      ["evt_test_1", "evt_test_2", "evt_test_3", "evt_test_4", "evt_test_5"]
        .map((id, i) => JSON.stringify({ id, ts: 1000 + i }))
        .join("\n") + "\n",
      "utf8"
    );
    const ledger = new FileIdempotencyLedger(path);
    expect(ledger.size).toBe(5);
    const dropped = ledger.compact(3);
    expect(dropped).toBe(2);
    expect(ledger.size).toBe(3);
    expect(ledger.has("evt_test_1")).toBe(false);
    expect(ledger.has("evt_test_2")).toBe(false);
    expect(ledger.has("evt_test_3")).toBe(true);
    expect(ledger.has("evt_test_4")).toBe(true);
    expect(ledger.has("evt_test_5")).toBe(true);
    // File on disk really is three lines now, all valid JSON-lines.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([
      "evt_test_3",
      "evt_test_4",
      "evt_test_5",
    ]);
    // The ledger stays usable after compact: new adds append.
    ledger.add("evt_test_6");
    expect(ledger.size).toBe(4);
    expect(ledger.has("evt_test_6")).toBe(true);
    // Reload from disk agrees — compact persisted.
    const reloaded = new FileIdempotencyLedger(path);
    expect(reloaded.size).toBe(4);
    expect(reloaded.has("evt_test_2")).toBe(false);
  });

  test("compact is a no-op when already within bounds; guards input", () => {
    const ledger = freshFileLedger();
    ledger.add("evt_test_only");
    expect(ledger.compact(100)).toBe(0);
    expect(ledger.size).toBe(1);
    expect(() => ledger.compact(0)).toThrow();
  });
});
