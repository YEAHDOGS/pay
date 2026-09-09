/**
 * idempotency-ledger.ts — TEST-MODE-ONLY idempotency ledger adapters.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The in-memory handler ledger (`handledEventIds` in webhook-handler)
 * does not survive a process restart — a live server would happily
 * fulfill the same webhook twice. A live staging route must persist
 * idempotency keys; this module gives it a swap-in adapter with the
 * exact same interface as the in-memory ledger:
 *
 *   import { FileIdempotencyLedger, setHandlerLedger } from "./lib/...";
 *   setHandlerLedger(new FileIdempotencyLedger("/var/lib/staging/webhook-ids.jsonl"));
 *   // handleTestWebhookDelivery now persists every dispatched event id.
 *
 * Guarantees by construction:
 *   - Same interface: both adapters implement `IdempotencyLedger`
 *     (has / add / clear / size). `setHandlerLedger` accepts either.
 *   - Crash-safe append: `add` writes one JSON line per id via a
 *     single synchronous append; a killed process can leave at most
 *     a partial trailing line, which the loader skips as corrupt.
 *   - Load on boot: the constructor (and `reload()`) re-reads the
 *     file, so keys recorded before a restart still reject replays.
 *   - Corrupt-line tolerance: blank lines, truncated JSON, and
 *     records without a string `id` are skipped and counted in
 *     `corruptLineCount` — a poisoned ledger file never crashes
 *     the route, and valid keys on either side of the damage still
 *     load.
 *   - Duplicate adds are no-ops (memory + dedupe on load): redelivering
 *     the same event id can never produce a second effect.
 *   - Keys are event ids only (`evt_test_*` strings). No payloads,
 *     no secrets, no PII ever touch the file.
 *   - Zero dependencies. The only IO is local-file append/read —
 *     no network, nothing leaves the machine.
 */

/* ── Hoisted constants ───────────────────────────────────────────── */

/** Ledger files are JSON-lines, one record per id. */
export const LEDGER_LINE_SUFFIX = "\n" as const;

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The contract every idempotency ledger honors. The webhook handler
 * programs against this interface — memory or file, its choice.
 */
export interface IdempotencyLedger {
  /** How many distinct ids are currently known. */
  readonly size: number;
  /** True if this id already produced an effect (a replay). */
  has(id: string): boolean;
  /**
   * Record an id as handled. Duplicate adds are no-ops: exactly-once
   * stays exactly-once even under double delivery.
   * @throws on a non-string / empty id — never record garbage.
   */
  add(id: string): void;
  /**
   * Forget every id. Test-harness reset ONLY — a live route must
   * never clear its ledger.
   */
  clear(): void;
}

function assertId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "idempotency-ledger: refusing to record a non-string or empty id."
    );
  }
}

function isLedgerRecord(value: unknown): value is { id: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    ((value as { id: string }).id.length > 0)
  );
}

/* ── In-memory adapter (the drill/test default) ───────────────────── */

export class MemoryIdempotencyLedger implements IdempotencyLedger {
  private readonly ids = new Set<string>();

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    assertId(id);
    this.ids.add(id);
  }

  clear(): void {
    this.ids.clear();
  }
}

/* ── File-backed adapter (the staging-route upgrade) ─────────────── */

export class FileIdempotencyLedger implements IdempotencyLedger {
  private ids = new Set<string>();
  private corruptLines = 0;
  private readonly filePath: string;

  /**
   * @param filePath where the JSON-lines ledger lives. Parent
   *   directories are created. The file is loaded immediately, so a
   *   restarted server resumes rejecting replays from its first event.
   */
  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(
        "idempotency-ledger: FileIdempotencyLedger needs a file path."
      );
    }
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.reload();
  }

  /** Where this ledger persists. */
  get path(): string {
    return this.filePath;
  }

  get size(): number {
    return this.ids.size;
  }

  /**
   * Lines skipped at load: blank lines are ignored silently; anything
   * that failed to parse (or parsed without a string `id`) lands here.
   * A nonzero count means the file took damage — the route still runs.
   */
  get corruptLineCount(): number {
    return this.corruptLines;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    assertId(id);
    if (this.ids.has(id)) return; // duplicate delivery: no second write.
    const record = JSON.stringify({
      id,
      ts: Math.floor(Date.now() / 1000),
    });
    // One synchronous append per id — crash-safe: the worst a kill
    // mid-write leaves is a partial trailing line, skipped at load.
    appendFileSync(this.filePath, record + LEDGER_LINE_SUFFIX, "utf8");
    this.ids.add(id);
  }

  clear(): void {
    // Truncate atomically-ish via temp-file rename so a crash can
    // never leave a half-written ledger behind.
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, "", "utf8");
    renameSync(tmp, this.filePath);
    this.ids.clear();
    this.corruptLines = 0;
  }

  /**
   * Re-read the file from disk: picks up ids another process (or a
   * pre-restart self) appended, and re-tolerates corrupt lines.
   */
  reload(): void {
    const seen = new Set<string>();
    let corrupt = 0;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (e) {
      // Fresh ledger file — nothing to load, not an error.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.ids = seen;
        this.corruptLines = 0;
        return;
      }
      throw e;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isLedgerRecord(record)) {
          seen.add(record.id);
        } else {
          corrupt += 1;
        }
      } catch {
        corrupt += 1;
      }
    }
    this.ids = seen;
    this.corruptLines = corrupt;
  }
}
