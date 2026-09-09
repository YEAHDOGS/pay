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
 *   - Bounded memory: `BoundedIdempotencyLedger` (the intake default)
 *     never holds more than `maxEntries` ids and forgets entries older
 *     than `ttlSeconds` — LRU eviction, so a redelivery storm is not a
 *     memory leak. `FileIdempotencyLedger.compact(n)` bounds the file
 *     side the same way.
 *   - Conflict detection: `ConflictAwareLedger` (implemented by the
 *     bounded adapter) remembers one content fingerprint per id; a
 *     replay of a consumed id with a DIFFERENT payload surfaces as
 *     PAYLOAD_CONFLICT instead of being swallowed as a duplicate.
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

/**
 * Extended contract for ledgers that can also remember a content
 * fingerprint per id. A redelivery of the same event id with a
 * DIFFERENT payload (possible forgery or split-brain retry) is a
 * replay the plain dedupe set cannot distinguish — the fingerprint
 * lets the handler throw PAYLOAD_CONFLICT instead of silently
 * swallowing it as a duplicate.
 */
export interface ConflictAwareLedger extends IdempotencyLedger {
  /**
   * Remember `fingerprint` (e.g. sha256 of the raw webhook body) for
   * an id that was just recorded. First write wins: an already-stored
   * fingerprint is never overwritten — call `fingerprintFor` first to
   * compare before recording.
   * @throws if the id is not currently in the ledger (record with
   * `add` before noting its fingerprint).
   */
  recordFingerprint(id: string, fingerprint: string): void;
  /**
   * The fingerprint recorded for `id`, or `undefined` if none was
   * recorded (or the id is unknown / expired).
   */
  fingerprintFor(id: string): string | undefined;
}

/** Guard: does this ledger track per-id payload fingerprints? */
export function isConflictAwareLedger(
  ledger: unknown
): ledger is ConflictAwareLedger {
  return (
    !!ledger &&
    typeof ledger === "object" &&
    typeof (ledger as ConflictAwareLedger).recordFingerprint === "function" &&
    typeof (ledger as ConflictAwareLedger).fingerprintFor === "function"
  );
}

/* ── Bounded in-memory adapter (the intake default) ───────────────── */

/** Defaults keep memory bounded at ~a few MB even in pathological redelivery storms. */
export const BOUNDED_LEDGER_DEFAULTS = Object.freeze({
  /** Max ids remembered before the least-recently-used entry evicts. */
  MAX_ENTRIES: 50_000,
  /** How long an id is remembered (seconds); 0 disables expiry. */
  TTL_SECONDS: 30 * 24 * 3600, // 30 days — covers dispute/chargeback windows
});

export interface BoundedLedgerOptions {
  /** Defaults to BOUNDED_LEDGER_DEFAULTS.MAX_ENTRIES. Must be ≥ 1. */
  maxEntries?: number;
  /** Defaults to BOUNDED_LEDGER_DEFAULTS.TTL_SECONDS. 0 disables TTL. */
  ttlSeconds?: number;
  /** Injectable clock (unix seconds); defaults to Date.now()/1000. For tests. */
  nowSeconds?: () => number;
}

/**
 * Bounded in-memory idempotency ledger with LRU eviction + TTL.
 *
 * The unbounded `MemoryIdempotencyLedger` grows forever — a
 * redelivery storm (or just years of traffic) is a memory leak. This
 * adapter never holds more than `maxEntries` ids, drops entries older
 * than `ttlSeconds`, and touch-updates recency on both `add` and
 * `has` (least-recently-used evicts first, not FIFO). Eviction only
 * weakens the dedupe guarantee: an id forgotten early could let a
 * very-late replay slip to the handler, which still has its own
 * ledger — defense in depth, never a silent double-effect.
 *
 * Also implements `ConflictAwareLedger`: `recordFingerprint` /
 * `fingerprintFor` remember one sha256 per id for the
 * PAYLOAD_CONFLICT check. Fingerprints evict with their id.
 */
export class BoundedIdempotencyLedger
  implements IdempotencyLedger, ConflictAwareLedger
{
  private readonly entries = new Map<string, { ts: number; fp?: string }>();
  private readonly maxEntries: number;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(opts: BoundedLedgerOptions = {}) {
    const maxEntries = opts.maxEntries ?? BOUNDED_LEDGER_DEFAULTS.MAX_ENTRIES;
    const ttlSeconds = opts.ttlSeconds ?? BOUNDED_LEDGER_DEFAULTS.TTL_SECONDS;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        "idempotency-ledger: BoundedIdempotencyLedger needs maxEntries ≥ 1."
      );
    }
    if (typeof ttlSeconds !== "number" || ttlSeconds < 0 || !Number.isFinite(ttlSeconds)) {
      throw new Error(
        "idempotency-ledger: BoundedIdempotencyLedger needs ttlSeconds ≥ 0."
      );
    }
    this.maxEntries = maxEntries;
    this.ttlSeconds = ttlSeconds;
    this.now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Capacity before LRU eviction starts. */
  get capacity(): number {
    return this.maxEntries;
  }

  get size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  has(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return false;
    }
    // Touch: a looked-up id is "recently used" — it should not be the
    // first thing evicted while live ids sit idle.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return true;
  }

  add(id: string): void {
    assertId(id);
    const now = this.now();
    // Refresh semantics: re-adding an id moves it to most-recently-used.
    this.entries.delete(id);
    this.entries.set(id, { ts: now });
    this.sweepExpired();
    // Evict least-recently-used (Map preserves insertion order; the
    // first key is the stalest entry).
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  recordFingerprint(id: string, fingerprint: string): void {
    assertId(id);
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      throw new Error(
        "idempotency-ledger: refusing to record an empty fingerprint."
      );
    }
    const entry = this.entries.get(id);
    if (!entry || this.isExpired(entry)) {
      throw new Error(
        `idempotency-ledger: no live entry for id "${id}" — add it before noting its fingerprint.`
      );
    }
    // First write wins: never overwrite a stored fingerprint. The
    // handler compares BEFORE recording, so any second call means a
    // conflict path was skipped — keep the original evidence.
    if (entry.fp === undefined) {
      entry.fp = fingerprint;
    }
  }

  fingerprintFor(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry || this.isExpired(entry)) return undefined;
    return entry.fp;
  }

  private isExpired(entry: { ts: number }): boolean {
    return this.ttlSeconds > 0 && this.now() - entry.ts > this.ttlSeconds;
  }

  /** Drop every entry older than the TTL. Cheap relative to file IO; runs on add/size. */
  sweepExpired(): number {
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }
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
  /** Best-effort arrival timestamps per id (seconds); powers compact(). */
  private readonly arrivalTs = new Map<string, number>();
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
    const now = Math.floor(Date.now() / 1000);
    const record = JSON.stringify({
      id,
      ts: now,
    });
    // One synchronous append per id — crash-safe: the worst a kill
    // mid-write leaves is a partial trailing line, skipped at load.
    appendFileSync(this.filePath, record + LEDGER_LINE_SUFFIX, "utf8");
    this.ids.add(id);
    this.arrivalTs.set(id, now);
  }

  clear(): void {
    // Truncate atomically-ish via temp-file rename so a crash can
    // never leave a half-written ledger behind.
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, "", "utf8");
    renameSync(tmp, this.filePath);
    this.ids.clear();
    this.arrivalTs.clear();
    this.corruptLines = 0;
  }

  /**
   * Bound the ledger file: rewrite it keeping only the `maxEntries`
   * newest ids (by arrival timestamp), dropping the oldest.
   * Returns how many ids were dropped. Call from a maintenance loop —
   * a web route never compacts on the request path.
   */
  compact(maxEntries: number): number {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        "idempotency-ledger: compact needs maxEntries ≥ 1."
      );
    }
    this.reload();
    if (this.ids.size <= maxEntries) return 0;
    const ordered = [...this.ids].sort((a, b) => {
      const ta = this.arrivalTs.get(a) ?? 0;
      const tb = this.arrivalTs.get(b) ?? 0;
      return ta - tb || a.localeCompare(b);
    });
    const dropped = ordered.slice(0, ordered.length - maxEntries);
    const kept = ordered.slice(ordered.length - maxEntries);
    const tmp = `${this.filePath}.tmp`;
    const lines = kept.map((id) =>
      JSON.stringify({ id, ts: this.arrivalTs.get(id) ?? 0 })
    );
    writeFileSync(tmp, lines.join(LEDGER_LINE_SUFFIX) + LEDGER_LINE_SUFFIX, "utf8");
    renameSync(tmp, this.filePath);
    for (const id of dropped) {
      this.ids.delete(id);
      this.arrivalTs.delete(id);
    }
    this.corruptLines = 0;
    return dropped.length;
  }

  /**
   * Re-read the file from disk: picks up ids another process (or a
   * pre-restart self) appended, and re-tolerates corrupt lines.
   */
  reload(): void {
    const seen = new Set<string>();
    const tsById = new Map<string, number>();
    let corrupt = 0;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (e) {
      // Fresh ledger file — nothing to load, not an error.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.ids = seen;
        this.arrivalTs.clear();
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
          const ts = (record as { ts?: unknown }).ts;
          // A repeated id in the file keeps its EARLIEST timestamp —
          // arrival order is what compact() evicts by.
          if (!tsById.has(record.id)) {
            tsById.set(
              record.id,
              typeof ts === "number" && Number.isFinite(ts) ? ts : 0
            );
          }
        } else {
          corrupt += 1;
        }
      } catch {
        corrupt += 1;
      }
    }
    this.ids = seen;
    this.arrivalTs.clear();
    for (const [id, ts] of tsById) this.arrivalTs.set(id, ts);
    this.corruptLines = corrupt;
  }
}
