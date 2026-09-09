/**
 * audit-log.ts — TEST-MODE-ONLY append-only audit trail.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  TEST MODE ONLY. NO REAL MONEY CAN MOVE THROUGH THIS MODULE.
 * ═══════════════════════════════════════════════════════════════════
 *
 * The idempotency ledger answers "have we seen this event?" — it
 * records event ids and nothing else. This module answers the
 * follow-up questions a money milestone will eventually be asked in
 * staging:
 *
 *   - "What did the route DO with event evt_test_X?" → effect.produced
 *   - "Why did delivery Y fail?"                     → delivery.rejected
 *   - "Was this delivery ever verified?"             → webhook.received
 *
 * Wired into `handleTestWebhookDelivery` (the documented server seam)
 * via `setAuditLog`, exactly like the handler ledger: the in-memory
 * default serves drills/tests, and a live staging route swaps in a
 * file-backed adapter (same interface) before handling traffic:
 *
 *   import { FileAuditLog, setAuditLog } from "./lib/audit-log";
 *   setAuditLog(new FileAuditLog("/var/lib/staging/webhook-audit.jsonl"));
 *
 * Guarantees by construction:
 *   - Records carry ids, event types, effect names, and error codes
 *     ONLY — no payloads, no secrets, no signatures, no PII. The
 *     ledger's "keys are event ids only" rule applies here too.
 *   - Audit NEVER blocks fulfillment: every record call inside the
 *     webhook handler is guarded, so a failing disk (or a broken
 *     adapter) throws nothing — the effect still goes out, and the
 *     worst case is a missing audit line, never a lost payment.
 *   - Crash-safe append: `record` writes one JSON line via a single
 *     synchronous append; a killed process can leave at most a
 *     partial trailing line, which the loader skips as corrupt.
 *   - Corrupt-line tolerance: blank lines, truncated JSON, and
 *     records without a valid shape are skipped and counted in
 *     `corruptLineCount` — a poisoned audit file never crashes the
 *     route, and valid records on either side still load.
 *   - Monotonic `seq` per process: records load in file order and the
 *     next `record` continues the sequence, so the file is a single
 *     causal order even across restarts.
 *   - Zero dependencies. The only IO is local-file append/read —
 *     no network, nothing leaves the machine.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/* ── Hoisted constants ───────────────────────────────────────────── */

/** Audit files are JSON-lines, one record per delivery milestone. */
export const AUDIT_LINE_SUFFIX = "\n" as const;

/** The only milestone kinds this trail ever records. */
export const AUDIT_EVENT_KINDS = Object.freeze({
  WEBHOOK_RECEIVED: "webhook.received",
  EFFECT_PRODUCED: "effect.produced",
  DELIVERY_REJECTED: "delivery.rejected",
});

export type AuditEventKind =
  (typeof AUDIT_EVENT_KINDS)[keyof typeof AUDIT_EVENT_KINDS];

/**
 * One audit milestone. Everything optional except kind/seq/ts is an
 * event id, an event type, an effect name, or an error code — never a
 * payload, a signature, or anything sensitive.
 */
export interface AuditRecord {
  readonly seq: number;
  /** Epoch seconds, like the rest of the pay fixtures. */
  readonly ts: number;
  readonly kind: AuditEventKind;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly effect?: string;
  /** Error code for delivery.rejected (BAD_SIGNATURE, ALREADY_HANDLED, …). */
  readonly code?: string;
  readonly testMode: true;
}

/** Fields the caller may attach to a record; kind is positional. */
export interface AuditFields {
  readonly eventId?: string;
  readonly eventType?: string;
  readonly effect?: string;
  readonly code?: string;
}

/**
 * The contract every audit log honors. The webhook handler programs
 * against this interface — memory or file, its choice.
 */
export interface AuditLog {
  /** How many records are currently known. */
  readonly size: number;
  /**
   * Append a milestone. Implementations must never throw on valid
   * input (the handler guards anyway — belt and suspenders).
   */
  record(kind: AuditEventKind, fields?: AuditFields): AuditRecord;
  /** All records in order (a copy — mutating it mutates nothing). */
  entries(): readonly AuditRecord[];
  /**
   * Forget every record. Test-harness reset ONLY — a live route must
   * never clear its audit trail.
   */
  clear(): void;
}

function isAuditKind(kind: unknown): kind is AuditEventKind {
  return (
    kind === AUDIT_EVENT_KINDS.WEBHOOK_RECEIVED ||
    kind === AUDIT_EVENT_KINDS.EFFECT_PRODUCED ||
    kind === AUDIT_EVENT_KINDS.DELIVERY_REJECTED
  );
}

function isAuditRecord(value: unknown): value is AuditRecord {
  const r = value as Partial<AuditRecord> | null;
  return (
    !!r &&
    typeof r === "object" &&
    isAuditKind(r.kind) &&
    typeof r.seq === "number" &&
    Number.isInteger(r.seq) &&
    r.seq >= 0 &&
    typeof r.ts === "number" &&
    r.testMode === true
  );
}

/* ── In-memory adapter (the drill/test default) ───────────────────── */

export class MemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];

  get size(): number {
    return this.records.length;
  }

  record(kind: AuditEventKind, fields: AuditFields = {}): AuditRecord {
    if (!isAuditKind(kind)) {
      throw new Error("audit-log: refusing to record an unknown kind.");
    }
    const rec: AuditRecord = {
      seq: this.records.length,
      ts: Math.floor(Date.now() / 1000),
      kind,
      ...fields,
      testMode: true,
    };
    this.records.push(rec);
    return rec;
  }

  entries(): readonly AuditRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

/* ── File-backed adapter (the staging-route upgrade) ──────────────── */

export class FileAuditLog implements AuditLog {
  private records: AuditRecord[] = [];
  private corruptLines = 0;
  private readonly filePath: string;

  /**
   * @param filePath where the JSON-lines audit trail lives. Parent
   *   directories are created. The file is loaded immediately and the
   *   sequence counter resumes where the file left off.
   */
  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("audit-log: FileAuditLog needs a file path.");
    }
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.reload();
  }

  /** Where this audit trail persists. */
  get path(): string {
    return this.filePath;
  }

  get size(): number {
    return this.records.length;
  }

  /**
   * Lines skipped at load: blank lines are ignored silently; anything
   * that failed to parse (or parsed without a valid audit shape)
   * lands here. A nonzero count means the file took damage — the
   * route still runs.
   */
  get corruptLineCount(): number {
    return this.corruptLines;
  }

  record(kind: AuditEventKind, fields: AuditFields = {}): AuditRecord {
    if (!isAuditKind(kind)) {
      throw new Error("audit-log: refusing to record an unknown kind.");
    }
    const rec: AuditRecord = {
      seq: this.records.length,
      ts: Math.floor(Date.now() / 1000),
      kind,
      ...fields,
      testMode: true,
    };
    // One synchronous append per record — crash-safe: the worst a
    // kill mid-write leaves is a partial trailing line, skipped at
    // load.
    appendFileSync(this.filePath, JSON.stringify(rec) + AUDIT_LINE_SUFFIX, "utf8");
    this.records.push(rec);
    return rec;
  }

  entries(): readonly AuditRecord[] {
    return [...this.records];
  }

  clear(): void {
    // Truncate atomically-ish via temp-file rename so a crash can
    // never leave a half-written audit file behind.
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, "", "utf8");
    renameSync(tmp, this.filePath);
    this.records = [];
    this.corruptLines = 0;
  }

  /**
   * Re-read the file from disk: picks up records another process (or
   * a pre-restart self) appended, and re-tolerates corrupt lines. The
   * sequence counter resumes after the last loaded record.
   */
  reload(): void {
    const seen: AuditRecord[] = [];
    let corrupt = 0;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (e) {
      // Fresh audit file — nothing to load, not an error.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = seen;
        this.corruptLines = 0;
        return;
      }
      throw e;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isAuditRecord(record)) {
          seen.push(record);
        } else {
          corrupt += 1;
        }
      } catch {
        corrupt += 1;
      }
    }
    this.records = seen;
    this.corruptLines = corrupt;
  }
}
