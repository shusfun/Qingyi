import { ByteLRU } from "./memory";
import {
  compress,
  decompress,
  decodeLines,
  encodeLines,
  unbase64,
} from "./codec";
import {
  MiB,
  sha256,
  requireValue,
  normalizeSource,
  normalizeLang,
  inferScriptLang,
  encoder,
  decoder,
  validTranslation,
  type CacheInput,
  type CacheEntry,
  type PackEntry,
  type PackManifest,
  type Trace,
} from "./types";
import { childTrace, type TraceBuffer } from "./trace";

type SQL = any;
interface Pending {
  entry: CacheEntry;
  bytes: number;
  trace: Trace;
}
interface PackState {
  id: string;
  version: number;
  active: number;
  previous: number | null;
  root: number;
  staging: number | null;
  source_lang: string;
  target_lang: string;
  domain: string;
  enabled: number;
  priority: number;
}
interface DecodedBlock {
  raw: Uint8Array;
  offsets: number[];
  slots: unknown[];
}

const schema = `
PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768; PRAGMA journal_size_limit=16777216;
CREATE TABLE IF NOT EXISTS blocks(id TEXT PRIMARY KEY,codec INTEGER NOT NULL,raw_bytes INTEGER NOT NULL,data BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS model(k BLOB PRIMARY KEY,block_id TEXT NOT NULL,slot INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS model_blocks(seq INTEGER PRIMARY KEY AUTOINCREMENT,block_id TEXT UNIQUE NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_model(k BLOB PRIMARY KEY,block_id TEXT NOT NULL,slot INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS local_blocks(seq INTEGER PRIMARY KEY AUTOINCREMENT,block_id TEXT UNIQUE NOT NULL,bytes INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS local_model_block ON local_model(block_id);
CREATE TABLE IF NOT EXISTS packs(id TEXT PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0,previous INTEGER,root INTEGER NOT NULL DEFAULT 0,staging INTEGER,source_lang TEXT NOT NULL,target_lang TEXT NOT NULL,domain TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,priority INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots(pack TEXT NOT NULL,version INTEGER NOT NULL,root INTEGER NOT NULL,parent INTEGER,status TEXT NOT NULL,manifest TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,entries INTEGER NOT NULL DEFAULT 0,raw_bytes INTEGER NOT NULL DEFAULT 0,trace_id TEXT NOT NULL,PRIMARY KEY(pack,version)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pack_rows(pack TEXT NOT NULL,k BLOB NOT NULL,vfrom INTEGER NOT NULL,vto INTEGER,block_id TEXT,slot INTEGER,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(pack,k,vfrom)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS revisions(k BLOB NOT NULL,revision INTEGER NOT NULL,block_id TEXT NOT NULL,slot INTEGER NOT NULL,time INTEGER NOT NULL,trace_id TEXT NOT NULL,PRIMARY KEY(k,revision)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS operations(id INTEGER PRIMARY KEY,trace_id TEXT NOT NULL,operation_id TEXT NOT NULL,operation TEXT NOT NULL,resource TEXT NOT NULL,time INTEGER NOT NULL,items INTEGER NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance(k TEXT PRIMARY KEY,v TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS model_block ON model(block_id);
CREATE INDEX IF NOT EXISTS pack_block ON pack_rows(block_id);
CREATE INDEX IF NOT EXISTS revision_block ON revisions(block_id);
CREATE INDEX IF NOT EXISTS pack_expired ON pack_rows(pack,vto);
CREATE INDEX IF NOT EXISTS pack_version ON pack_rows(pack,vfrom);
CREATE TABLE IF NOT EXISTS totals(k TEXT PRIMARY KEY,v INTEGER NOT NULL) WITHOUT ROWID;
INSERT INTO totals SELECT 'model',(SELECT count(*) FROM model) WHERE NOT EXISTS(SELECT 1 FROM totals WHERE k='model');
INSERT INTO totals SELECT 'revisions',(SELECT count(*) FROM revisions) WHERE NOT EXISTS(SELECT 1 FROM totals WHERE k='revisions');
INSERT INTO totals SELECT 'block',(SELECT coalesce(sum(length(data)),0) FROM blocks) WHERE NOT EXISTS(SELECT 1 FROM totals WHERE k='block');
INSERT INTO totals SELECT 'raw',(SELECT coalesce(sum(raw_bytes),0) FROM blocks) WHERE NOT EXISTS(SELECT 1 FROM totals WHERE k='raw');
CREATE TRIGGER IF NOT EXISTS count_model_insert AFTER INSERT ON model BEGIN UPDATE totals SET v=v+1 WHERE k='model'; END;
CREATE TRIGGER IF NOT EXISTS count_model_delete AFTER DELETE ON model BEGIN UPDATE totals SET v=v-1 WHERE k='model'; END;
CREATE TRIGGER IF NOT EXISTS count_revision_insert AFTER INSERT ON revisions BEGIN UPDATE totals SET v=v+1 WHERE k='revisions'; END;
CREATE TRIGGER IF NOT EXISTS count_revision_delete AFTER DELETE ON revisions BEGIN UPDATE totals SET v=v-1 WHERE k='revisions'; END;
CREATE TRIGGER IF NOT EXISTS count_block_insert AFTER INSERT ON blocks BEGIN UPDATE totals SET v=v+length(new.data) WHERE k='block'; UPDATE totals SET v=v+new.raw_bytes WHERE k='raw'; END;
CREATE TRIGGER IF NOT EXISTS count_block_delete AFTER DELETE ON blocks BEGIN UPDATE totals SET v=v-length(old.data) WHERE k='block'; UPDATE totals SET v=v-old.raw_bytes WHERE k='raw'; END;
PRAGMA user_version=1;`;

const bytesKey = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));

export async function entryKey(entry: CacheInput, model = true) {
  return sha256(
    JSON.stringify([
      normalizeSource(entry.source),
      normalizeLang(entry.sourceLang),
      normalizeLang(entry.targetLang),
      entry.domain,
      model ? entry.scope : "",
    ]),
  );
}

function buildLineOffsets(raw: Uint8Array): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 10 && i + 1 < raw.length) offsets.push(i + 1);
  }
  return offsets;
}

function readSlotFromBlock(blk: DecodedBlock, slot: number): unknown {
  if (slot < 0 || slot >= blk.offsets.length) return undefined;
  const existing = blk.slots[slot];
  if (existing !== undefined) return existing;
  const start = blk.offsets[slot];
  let end =
    slot + 1 < blk.offsets.length ? blk.offsets[slot + 1] - 1 : blk.raw.length;
  while (end > start && (blk.raw[end - 1] === 10 || blk.raw[end - 1] === 13)) {
    end--;
  }
  if (end <= start) return undefined;
  const parsed = JSON.parse(decoder.decode(blk.raw.subarray(start, end)));
  blk.slots[slot] = parsed;
  return parsed;
}

export function validateManifest(m: PackManifest) {
  requireValue(
    m?.format === "qingyi-pack-v1" && /^[\w.-]{1,80}$/.test(m.id),
    "INVALID_PACK",
  );
  requireValue(
    Number.isSafeInteger(m.version) &&
      m.version > 0 &&
      ["full", "delta"].includes(m.kind),
    "INVALID_VERSION",
  );
  requireValue(
    m.kind === "full"
      ? m.baseVersion === null
      : Number.isSafeInteger(m.baseVersion) &&
          Number(m.baseVersion) > 0 &&
          Number(m.baseVersion) < m.version,
    "INVALID_BASE_VERSION",
  );
  requireValue(
    typeof m.sourceLang === "string" &&
      typeof m.targetLang === "string" &&
      /^[a-z*-]{1,20}$/i.test(m.sourceLang) &&
      /^[a-z-]{1,20}$/i.test(m.targetLang) &&
      typeof m.domain === "string" &&
      m.domain.length <= 100,
    "INVALID_LANGUAGE_DOMAIN",
  );
  requireValue(
    Number.isSafeInteger(m.entries) &&
      m.entries >= 0 &&
      m.entries <= 100_000_000 &&
      Number.isSafeInteger(m.uncompressedBytes) &&
      m.uncompressedBytes >= 0,
    "INVALID_PACK_SIZE",
  );
  requireValue(
    Array.isArray(m.blocks) && m.blocks.length <= 100000,
    "INVALID_BLOCKS",
  );
  let count = 0,
    raw = 0;
  const names = new Set<string>();
  for (const b of m.blocks) {
    requireValue(
      typeof b.file === "string" &&
        /^[\w.-]{1,100}$/.test(b.file) &&
        !names.has(b.file) &&
        /^[a-f0-9]{64}$/.test(b.sha256),
      "INVALID_BLOCK",
    );
    requireValue(
      Number.isSafeInteger(b.bytes) &&
        b.bytes > 0 &&
        b.bytes <= 2 * MiB &&
        Number.isSafeInteger(b.uncompressedBytes) &&
        b.uncompressedBytes > 0 &&
        b.uncompressedBytes <= MiB &&
        Number.isSafeInteger(b.entries) &&
        b.entries > 0 &&
        b.entries <= 5000,
      "BLOCK_LIMIT",
    );
    names.add(b.file);
    count += b.entries;
    raw += b.uncompressedBytes;
  }
  requireValue(
    count === m.entries && raw === m.uncompressedBytes,
    "MANIFEST_TOTAL_MISMATCH",
  );
  return m;
}

export class CacheDatabase {
  readonly hot = new ByteLRU<string>(8 * MiB);
  readonly decoded = new ByteLRU<DecodedBlock>(16 * MiB);
  private pending = new Map<string, Pending>();
  private pendingBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private dirtyAt = 0;
  private writeError = "";
  private flushing = Promise.resolve();
  private decoding = new Map<string, Promise<DecodedBlock>>();
  private budget = 4 * 1024 * MiB;
  private gcCursor = "";
  metrics = {
    transactions: 0,
    submittedBytes: 0,
    modelRowsWritten: 0,
    maintenanceBytes: 0,
    lookups: 0,
    hits: 0,
  };
  constructor(
    readonly db: SQL,
    private trace: Pick<TraceBuffer, "record">,
    private now = () => Date.now(),
  ) {
    db.exec(schema);
  }
  private exec(sql: string, bind: unknown[] = []) {
    this.db.exec(bind.length ? { sql, bind } : sql);
  }
  private one(sql: string, bind: unknown[] = []): any {
    return this.db.selectObject(sql, bind.length ? bind : undefined);
  }
  private all(sql: string, bind: unknown[] = []): any[] {
    return this.db.selectObjects(sql, bind.length ? bind : undefined);
  }
  private value(sql: string, bind: unknown[] = []): any {
    return this.db.selectValue(sql, bind.length ? bind : undefined);
  }
  private nullableNumber(sql: string, bind: unknown[] = []): number | null {
    const v = this.value(sql, bind);
    if (v === null || v === undefined) return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  }
  private audit(
    t: Trace,
    operation: string,
    resource: string,
    items: number,
    bytes: number,
  ) {
    this.exec(
      "INSERT INTO operations(trace_id,operation_id,operation,resource,time,items,bytes) VALUES(?,?,?,?,?,?,?)",
      [t.traceId, t.operationId, operation, resource, this.now(), items, bytes],
    );
    this.exec(
      "DELETE FROM operations WHERE id < (SELECT max(id)-5000 FROM operations)",
    );
  }
  private transaction(
    t: Trace,
    operation: string,
    resource: string,
    items: number,
    bytes: number,
    run: () => void,
  ) {
    const start = performance.now(),
      span = childTrace(t);
    this.trace.record(span, "database.start", {
      outcome: "started",
      resourceId: resource,
    });
    let began = false;
    try {
      this.exec("BEGIN IMMEDIATE");
      began = true;
      run();
      this.audit(t, operation, resource, items, bytes);
      this.exec("COMMIT");
      this.metrics.transactions++;
      this.metrics.submittedBytes += bytes;
      this.trace.record(span, "database.commit", {
        outcome: "success",
        resourceId: resource,
        items,
        bytes,
        durationMs: performance.now() - start,
      });
    } catch (e) {
      if (began) {
        try {
          this.exec("ROLLBACK");
        } catch {}
      }
      this.trace.record(span, "database.commit", {
        outcome: "failed",
        resourceId: resource,
        reason: "transaction-aborted",
        durationMs: performance.now() - start,
      });
      throw e;
    }
  }
  setBudget(bytes: number) {
    requireValue(
      Number.isSafeInteger(bytes) && bytes >= 64 * MiB,
      "INVALID_BUDGET",
    );
    this.budget = bytes;
    const size = Number(this.value("PRAGMA page_size"));
    this.exec(
      `PRAGMA max_page_count=${Math.floor((bytes - Math.max(40 * MiB, bytes * 0.15)) / size)}`,
    );
  }
  private usedDbBytes(): number {
    const pages = Number(this.value("PRAGMA page_count")),
      free = Number(this.value("PRAGMA freelist_count")),
      pageSize = Number(this.value("PRAGMA page_size"));
    return (pages - free) * pageSize;
  }
  private usableBudgetBytes(): number {
    return this.budget - Math.max(40 * MiB, this.budget * 0.15);
  }
  private async checkSpace(bytes: number) {
    requireValue(
      this.usedDbBytes() + bytes < this.usableBudgetBytes(),
      "CACHE_BUDGET_EXCEEDED",
    );
    if (typeof globalThis.navigator !== "undefined" && navigator.storage) {
      const s = await navigator.storage.estimate();
      requireValue(
        (s.quota || 0) - (s.usage || 0) > bytes + 32 * MiB,
        "DEVICE_SPACE_LOW",
      );
    }
  }
  // Lazy per-slot block cache (Q-T19): avoids full-block JSON.parse on random misses.
  private async block(id: string): Promise<DecodedBlock> {
    const cached = this.decoded.get(id);
    if (cached) return cached;
    const existing = this.decoding.get(id);
    if (existing) return existing;
    const decoding = (async () => {
      const row = this.one(
        "SELECT codec,raw_bytes,data FROM blocks WHERE id=?",
        [id],
      );
      requireValue(row, "MISSING_BLOCK");
      const data = await decompress(row.data, row.codec, row.raw_bytes);
      requireValue(data.length === row.raw_bytes, "CORRUPT_BLOCK");
      const offsets = buildLineOffsets(data);
      const blk: DecodedBlock = {
        raw: data,
        offsets,
        slots: new Array(offsets.length),
      };
      this.decoded.set(id, blk, data.length + offsets.length * 16 + 64);
      return blk;
    })();
    this.decoding.set(id, decoding);
    try {
      return await decoding;
    } finally {
      this.decoding.delete(id);
    }
  }
  private async translation(
    row: any,
    input: CacheInput,
    healTable?: "model" | "local_model",
    healKeyHex?: string,
    t?: Trace,
  ): Promise<string | null> {
    if (!row?.block_id) return null;
    const blk = await this.block(row.block_id);
    const item = readSlotFromBlock(blk, row.slot) as
      | Partial<CacheEntry>
      | undefined;
    if (!item) return null;
    if (normalizeSource(item.source || "") !== normalizeSource(input.source)) {
      return null;
    }
    if (validTranslation(input.source, item.translation)) {
      return item.translation;
    }
    // Self-heal bad/misordered cached model entries on read (Q-T02).
    if (healTable && healKeyHex) {
      try {
        this.exec(`DELETE FROM ${healTable} WHERE k=?`, [bytesKey(healKeyHex)]);
        this.hot.delete(healKeyHex);
        if (t) {
          this.trace.record(childTrace(t), "cache.heal", {
            outcome: "fallback",
            reason: "INVALID_CACHED_PLACEHOLDERS",
            items: 1,
          });
        }
      } catch {
        // Ignore read-heal write failure
      }
    }
    return null;
  }
  async lookup(inputs: CacheInput[], t: Trace, dictionaryOnly = false) {
    requireValue(inputs.length <= 64, "LOOKUP_LIMIT");
    const span = childTrace(t),
      started = performance.now(),
      out: (string | null)[] = new Array(inputs.length),
      sources: string[] = new Array(inputs.length);
    this.trace.record(span, "cache.start", {
      outcome: "started",
      items: inputs.length,
    });
    const packs = this.all(
      "SELECT * FROM packs WHERE active>0 AND enabled=1 ORDER BY priority DESC,id",
    );
    const resolve = async (input: CacheInput, index: number) => {
      const normInputLang = normalizeLang(input.sourceLang);
      const normTargetLang = normalizeLang(input.targetLang);
      const inferredLang =
        normInputLang === "auto"
          ? inferScriptLang(input.source)
          : normInputLang;
      const normalizedInput: CacheInput = {
        ...input,
        sourceLang: normInputLang,
        targetLang: normTargetLang,
      };
      const key = await entryKey(normalizedInput);
      const hot = !dictionaryOnly ? this.hot.get(key) : undefined;
      const pending = !dictionaryOnly ? this.pending.get(key) : undefined;
      let result: string | null =
          hot && validTranslation(input.source, hot) ? hot : null,
        source = result ? "memory" : "";
      if (hot && !result) this.hot.delete(key);

      if (!result) {
        const candidateLangs = [normInputLang];
        if (inferredLang !== normInputLang && inferredLang !== "auto") {
          candidateLangs.push(inferredLang);
        }
        if (normInputLang !== "auto") candidateLangs.push("auto");
        const candidateDomains = [input.domain];
        if (input.domain !== "*" && input.domain !== "") {
          candidateDomains.push("*", "");
        }
        outerRevision: for (const dom of candidateDomains) {
          for (const sl of candidateLangs) {
            const plain = bytesKey(
              await entryKey(
                { ...normalizedInput, domain: dom, sourceLang: sl },
                false,
              ),
            );
            const row = this.one(
              "SELECT block_id,slot FROM revisions WHERE k=? ORDER BY revision DESC LIMIT 1",
              [plain],
            );
            result = await this.translation(row, input);
            if (result) {
              source = "user";
              break outerRevision;
            }
          }
        }
      }
      if (!result) {
        for (const pack of packs as PackState[]) {
          const normPackSource = normalizeLang(pack.source_lang);
          const normPackTarget = normalizeLang(pack.target_lang);
          const langOk =
            normPackSource === "*" ||
            normPackSource === normInputLang ||
            (normInputLang === "auto" && normPackSource === inferredLang);
          if (
            !langOk ||
            normPackTarget !== normTargetLang ||
            (pack.domain !== "*" && pack.domain !== input.domain)
          ) {
            continue;
          }
          // Try pack's raw source_lang key (matches how pack rows were inserted)
          const pk = bytesKey(
            await entryKey(
              {
                ...normalizedInput,
                domain: pack.domain,
                sourceLang: pack.source_lang,
                targetLang: pack.target_lang,
              },
              false,
            ),
          );
          const row = this.one(
            "SELECT block_id,slot,deleted FROM pack_rows WHERE pack=? AND k=? AND vfrom>=? AND vfrom<=? AND (vto IS NULL OR vto>?) ORDER BY vfrom DESC LIMIT 1",
            [pack.id, pk, pack.root, pack.active, pack.active],
          );
          if (row && !row.deleted) {
            result = await this.translation(row, input);
            if (result) {
              source = "pack:" + pack.id;
              break;
            }
          }
        }
      }
      if (!dictionaryOnly) {
        if (!result && pending) {
          if (validTranslation(input.source, pending.entry.translation)) {
            result = pending.entry.translation;
            source = "pending";
          } else {
            this.pendingBytes -= pending.bytes;
            this.pending.delete(key);
          }
        }
        if (!result) {
          const table = input.scope.startsWith("local:")
            ? "local_model"
            : "model";
          const row = this.one(
            "SELECT block_id,slot FROM " + table + " WHERE k=?",
            [bytesKey(key)],
          );
          result = await this.translation(row, input, table, key, span);
          if (result) source = "model";
        }
        if (result) {
          this.hot.set(
            key,
            result,
            encoder.encode(input.source + result).length + 128,
          );
        }
      }
      out[index] = result;
      sources[index] = source || "miss";
    };
    let next = 0;
    const resolved = await Promise.allSettled(
      Array.from({ length: Math.min(4, inputs.length) }, async () => {
        while (next < inputs.length) {
          const index = next++;
          await resolve(inputs[index], index);
        }
      }),
    );
    const failed = resolved.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      this.trace.record(span, "cache.lookup", {
        outcome: "failed",
        items: inputs.length,
        reason: "CACHE_READ_FAILED",
        durationMs: performance.now() - started,
      });
      throw failed.reason;
    }
    const hits = out.filter((v) => v !== null).length;
    this.metrics.lookups += inputs.length;
    this.metrics.hits += hits;
    this.trace.record(span, "cache.lookup", {
      outcome: "success",
      items: inputs.length,
      hits,
      durationMs: performance.now() - started,
      source: [...new Set(sources)].join(","),
    });
    return { translations: out, sources, hits };
  }
  async lookupModels(inputs: CacheInput[], t: Trace) {
    const span = childTrace(t),
      start = performance.now();
    const translations: (string | null)[] = [];
    requireValue(inputs.length <= 64, "LOOKUP_LIMIT");
    for (const input of inputs) {
      const key = await entryKey(input);
      const pending = this.pending.get(key);
      if (pending) {
        if (validTranslation(input.source, pending.entry.translation)) {
          translations.push(pending.entry.translation);
          continue;
        }
        this.pendingBytes -= pending.bytes;
        this.pending.delete(key);
      }
      const table = input.scope.startsWith("local:") ? "local_model" : "model";
      const row = this.one(
        "SELECT block_id,slot FROM " + table + " WHERE k=?",
        [bytesKey(key)],
      );
      translations.push(await this.translation(row, input, table, key, span));
    }
    const hits = translations.filter(Boolean).length;
    this.trace.record(span, "cache.legacy", {
      outcome: "success",
      items: inputs.length,
      hits,
      durationMs: performance.now() - start,
    });
    return { translations, hits };
  }
  async enqueue(entries: CacheEntry[], t: Trace) {
    for (const rawEntry of entries) {
      const entry: CacheEntry = {
        ...rawEntry,
        sourceLang: normalizeLang(rawEntry.sourceLang),
        targetLang: normalizeLang(rawEntry.targetLang),
      };
      requireValue(
        entry.source.length <= 24000 &&
          validTranslation(entry.source, entry.translation),
        "INVALID_CACHE_ENTRY",
      );
      const key = await entryKey(entry);
      if (this.pending.get(key)?.entry.translation === entry.translation)
        continue;
      const table = entry.scope.startsWith("local:") ? "local_model" : "model";
      const existing = this.one(
        "SELECT block_id,slot FROM " + table + " WHERE k=?",
        [bytesKey(key)],
      );
      if ((await this.translation(existing, entry)) === entry.translation)
        continue;
      const bytes = encoder.encode(JSON.stringify(entry)).length + 128;
      if (bytes > 8 * MiB) {
        this.trace.record(childTrace(t), "cache.skip", {
          outcome: "failed",
          reason: "ENTRY_TOO_LARGE",
          bytes,
        });
        continue;
      }
      if (
        this.pendingBytes + bytes - (this.pending.get(key)?.bytes || 0) >
        8 * MiB
      ) {
        requireValue(!this.writeError, "CACHE_WRITES_PAUSED");
        await this.flush();
      }
      this.pendingBytes -= this.pending.get(key)?.bytes || 0;
      this.pending.set(key, { entry, bytes, trace: t });
      this.pendingBytes += bytes;
    }
    if (this.pending.size && !this.timer && !this.writeError) {
      this.dirtyAt = this.now();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => {});
      }, 60000);
    }
    return {
      pending: this.pending.size,
      pendingBytes: this.pendingBytes,
      writeError: this.writeError,
    };
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const run = this.flushing
      .catch(() => {})
      .then(async () => {
        if (!this.pending.size) return;
        const batch = [...this.pending.entries()];
        const sealed: {
          group: typeof batch;
          id: string;
          codec: number;
          rawBytes: number;
          data: Uint8Array;
        }[] = [];
        let group: typeof batch = [],
          size = 0;
        const seal = async () => {
          if (!group.length) return;
          const compressionStart = performance.now();
          const raw = encodeLines(group.map(([, v]) => v.entry)),
            packed = await compress(raw),
            id = await sha256(raw);
          const traces = [
            ...new Map(
              group.map(([, v]) => [v.trace.traceId, v.trace]),
            ).values(),
          ];
          const compressionMs = performance.now() - compressionStart;
          for (const contributor of traces)
            this.trace.record(childTrace(contributor), "cache.compress", {
              outcome: "success",
              resourceId: id,
              items: group.length,
              bytes: raw.length,
              compressedBytes: packed.data.length,
              durationMs: compressionMs,
            });
          sealed.push({
            group,
            id,
            codec: packed.codec,
            rawBytes: raw.length,
            data: packed.data,
          });
          group = [];
          size = 0;
        };
        for (const entry of batch) {
          if (
            size &&
            (size + entry[1].bytes > 256 * 1024 ||
              group[0][1].entry.scope.startsWith("local:") !==
                entry[1].entry.scope.startsWith("local:"))
          )
            await seal();
          group.push(entry);
          size += entry[1].bytes;
        }
        await seal();
        const contributors = new Map<string, { trace: Trace; items: number }>();
        for (const [, item] of batch) {
          const c = contributors.get(item.trace.traceId);
          if (c) c.items++;
          else
            contributors.set(item.trace.traceId, {
              trace: item.trace,
              items: 1,
            });
        }
        const packedBytes = sealed.reduce((n, b) => n + b.data.length, 0);
        const incomingLocal = sealed
          .filter((b) => b.group[0][1].entry.scope.startsWith("local:"))
          .reduce((n, b) => n + b.data.length + b.group.length * 96, 0);
        const oldLocal = Number(
          this.value("SELECT coalesce(sum(bytes),0) FROM local_blocks"),
        );
        if (oldLocal + incomingLocal > 256 * MiB)
          this.trimLocal(
            Math.max(0, 256 * MiB - incomingLocal),
            batch[0][1].trace,
          );
        const incomingTotal = packedBytes + batch.length * 192;
        if (this.usedDbBytes() + incomingTotal >= this.usableBudgetBytes()) {
          this.trimCloud(incomingTotal, batch[0][1].trace);
        }
        await this.checkSpace(incomingTotal);
        const resource = sealed[0].id;
        this.transaction(
          batch[0][1].trace,
          "model.flush",
          resource,
          batch.length,
          packedBytes + batch.length * 96 + contributors.size * 256,
          () => {
            for (const b of sealed)
              this.exec("INSERT OR IGNORE INTO blocks VALUES(?,?,?,?)", [
                b.id,
                b.codec,
                b.rawBytes,
                b.data,
              ]);
            const rows = sealed.flatMap((b) =>
              b.group.map(([key, item], slot) => ({
                key,
                id: b.id,
                slot,
                local: item.entry.scope.startsWith("local:"),
              })),
            );
            rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            const stmt = this.db.prepare(
              "INSERT INTO model VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET block_id=excluded.block_id,slot=excluded.slot",
            );
            const localStmt = this.db.prepare(
              "INSERT INTO local_model VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET block_id=excluded.block_id,slot=excluded.slot",
            );
            try {
              for (const row of rows)
                (row.local ? localStmt : stmt)
                  .bind([bytesKey(row.key), row.id, row.slot])
                  .stepReset();
            } finally {
              stmt.finalize();
              localStmt.finalize();
            }
            for (const b of sealed) {
              if (b.group[0][1].entry.scope.startsWith("local:")) {
                this.exec(
                  "INSERT OR IGNORE INTO local_blocks(block_id,bytes) VALUES(?,?)",
                  [b.id, b.data.length + b.group.length * 96],
                );
              } else {
                this.exec(
                  "INSERT OR IGNORE INTO model_blocks(block_id,bytes) VALUES(?,?)",
                  [b.id, b.data.length + b.group.length * 96],
                );
              }
            }
            for (const c of [...contributors.values()].slice(1))
              this.audit(c.trace, "model.flush.shared", resource, c.items, 0);
          },
        );
        for (const [key, item] of batch)
          if (this.pending.get(key) === item) {
            this.pending.delete(key);
            this.pendingBytes -= item.bytes;
          }
        this.metrics.modelRowsWritten += batch.length;
        for (const c of contributors.values())
          this.trace.record(childTrace(c.trace), "cache.persist", {
            outcome: "success",
            resourceId: resource,
            items: c.items,
          });
      });
    this.flushing = run;
    try {
      await run;
      this.writeError = "";
      if (!this.pending.size) this.dirtyAt = 0;
    } catch (e) {
      this.writeError =
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "CACHE_COMMIT_FAILED";
      for (const t of new Map(
        [...this.pending.values()].map((v) => [v.trace.traceId, v.trace]),
      ).values())
        this.trace.record(childTrace(t), "cache.persist", {
          outcome: "paused",
          reason: this.writeError,
        });
      throw e;
    } finally {
      if (this.pending.size && !this.timer && !this.writeError)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush().catch(() => {});
        }, 60000);
    }
  }
  private trimLocal(target: number, trace: Trace) {
    this.transaction(trace, "local.evict", "local-model", 0, 0, () => {
      let bytes = Number(
        this.value("SELECT coalesce(sum(bytes),0) FROM local_blocks"),
      );
      for (const b of this.all(
        "SELECT block_id,bytes FROM local_blocks ORDER BY seq",
      )) {
        if (bytes <= target) break;
        this.exec("DELETE FROM local_model WHERE block_id=?", [b.block_id]);
        this.exec("DELETE FROM local_blocks WHERE block_id=?", [b.block_id]);
        this.exec(
          "DELETE FROM blocks WHERE id=? AND NOT EXISTS(SELECT 1 FROM model WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM pack_rows WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM revisions WHERE block_id=?)",
          [b.block_id, b.block_id, b.block_id, b.block_id],
        );
        this.decoded.delete(b.block_id);
        bytes -= b.bytes;
      }
    });
    this.hot.clear();
  }
  // Automatically evict oldest cloud model blocks when budget is full, preserving packs and user revisions (Q-T14).
  private trimCloud(incomingBytes: number, trace: Trace) {
    const needed =
      this.usedDbBytes() + incomingBytes - this.usableBudgetBytes() + 4 * MiB;
    if (needed <= 0) return;
    let reclaimed = 0;
    this.transaction(trace, "cloud.evict", "model", 0, 0, () => {
      const stillOver = () =>
        reclaimed < needed ||
        this.usedDbBytes() + incomingBytes >= this.usableBudgetBytes();
      const tracked = this.all(
        "SELECT block_id,bytes FROM model_blocks ORDER BY seq",
      );
      for (const b of tracked) {
        if (!stillOver()) break;
        this.exec("DELETE FROM model WHERE block_id=?", [b.block_id]);
        this.exec("DELETE FROM model_blocks WHERE block_id=?", [b.block_id]);
        this.exec(
          "DELETE FROM blocks WHERE id=? AND NOT EXISTS(SELECT 1 FROM local_model WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM pack_rows WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM revisions WHERE block_id=?)",
          [b.block_id, b.block_id, b.block_id, b.block_id],
        );
        this.decoded.delete(b.block_id);
        reclaimed += b.bytes;
      }
      if (stillOver()) {
        // Also evict legacy cloud blocks created prior to model_blocks tracking
        const legacy = this.all(
          "SELECT DISTINCT m.block_id, length(b.data) AS bytes FROM model m JOIN blocks b ON b.id=m.block_id LIMIT 256",
        );
        for (const b of legacy) {
          if (!stillOver()) break;
          this.exec("DELETE FROM model WHERE block_id=?", [b.block_id]);
          this.exec("DELETE FROM model_blocks WHERE block_id=?", [b.block_id]);
          this.exec(
            "DELETE FROM blocks WHERE id=? AND NOT EXISTS(SELECT 1 FROM local_model WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM pack_rows WHERE block_id=?) AND NOT EXISTS(SELECT 1 FROM revisions WHERE block_id=?)",
            [b.block_id, b.block_id, b.block_id, b.block_id],
          );
          this.decoded.delete(b.block_id);
          reclaimed += Number(b.bytes) || 1024;
        }
      }
    });
    if (reclaimed > 0) this.hot.clear();
  }
  async startPack(manifest: PackManifest, t: Trace) {
    const m = validateManifest(manifest),
      p = this.one("SELECT * FROM packs WHERE id=?", [m.id]);
    requireValue(!p?.staging, "IMPORT_ALREADY_STAGED");
    requireValue(
      m.kind === "full" || p?.active === m.baseVersion,
      "BASE_VERSION_MISMATCH",
    );
    requireValue(
      m.kind === "full" || !p?.previous || p.previous < p.active,
      "ROLL_FORWARD_OR_FULL_PACK_REQUIRED",
    );
    requireValue(
      !p || m.version > Math.max(p.active, p.previous || 0),
      "VERSION_NOT_NEWER",
    );
    if (p)
      requireValue(
        p.source_lang === m.sourceLang &&
          p.target_lang === m.targetLang &&
          p.domain === m.domain,
        "PACK_IDENTITY_CHANGED",
      );
    await this.checkSpace(
      m.blocks.reduce((n, b) => n + b.bytes, 0) + m.entries * 320 + 1024,
    );
    const root = m.kind === "full" ? m.version : p.root;
    this.transaction(
      t,
      "pack.start",
      m.id,
      0,
      encoder.encode(JSON.stringify(m)).length,
      () => {
        if (!p)
          this.exec(
            "INSERT INTO packs(id,staging,source_lang,target_lang,domain) VALUES(?,?,?,?,?)",
            [m.id, m.version, m.sourceLang, m.targetLang, m.domain],
          );
        else
          this.exec("UPDATE packs SET staging=? WHERE id=?", [m.version, m.id]);
        this.exec(
          "INSERT INTO snapshots(pack,version,root,parent,status,manifest,trace_id) VALUES(?,?,?,?,?,?,?)",
          [
            m.id,
            m.version,
            root,
            p?.active || null,
            "staging",
            JSON.stringify(m),
            t.traceId,
          ],
        );
      },
    );
    return { staging: m.version };
  }
  async appendPack(
    id: string,
    version: number,
    file: string,
    base64Data: string,
    t: Trace,
  ) {
    const snapshot = this.one(
      "SELECT * FROM snapshots WHERE pack=? AND version=? AND status=?",
      [id, version, "staging"],
    );
    requireValue(snapshot, "NO_STAGED_IMPORT");
    const m = JSON.parse(snapshot.manifest) as PackManifest,
      expected = m.blocks[snapshot.received];
    requireValue(expected?.file === file, "BLOCK_ORDER_MISMATCH");
    const compressed = unbase64(base64Data);
    requireValue(
      compressed.length === expected.bytes &&
        (await sha256(compressed)) === expected.sha256,
      "BLOCK_CHECKSUM_MISMATCH",
    );
    const raw = await decompress(compressed, 1, expected.uncompressedBytes);
    requireValue(
      raw.length === expected.uncompressedBytes,
      "BLOCK_SIZE_MISMATCH",
    );
    const rows = decodeLines(raw) as PackEntry[];
    requireValue(rows.length === expected.entries, "BLOCK_ENTRY_MISMATCH");
    return this.appendRows(m, rows, raw, t);
  }
  private async appendRows(
    m: PackManifest,
    rows: PackEntry[],
    raw: Uint8Array,
    t: Trace,
  ) {
    const keys: Uint8Array[] = [];
    for (const e of rows) {
      requireValue(
        e &&
          typeof e.source === "string" &&
          e.source.trim().length > 0 &&
          e.source.length <= 24000 &&
          (e.domain === undefined || e.domain === m.domain),
        "INVALID_PACK_ENTRY",
      );
      requireValue(
        e.deleted === true || validTranslation(e.source, e.translation),
        "INVALID_PACK_TRANSLATION",
      );
      keys.push(
        bytesKey(
          await entryKey(
            {
              source: e.source,
              scope: "",
              domain: m.domain,
              sourceLang: m.sourceLang,
              targetLang: m.targetLang,
            },
            false,
          ),
        ),
      );
    }
    const changed: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (m.kind === "delta") {
        requireValue(
          !this.value(
            "SELECT 1 FROM pack_rows WHERE pack=? AND k=? AND vfrom=?",
            [m.id, keys[i], m.version],
          ),
          "DUPLICATE_PACK_SOURCE",
        );
        const current = this.one(
          "SELECT block_id,slot,deleted FROM pack_rows WHERE pack=? AND k=? AND vfrom<=? AND (vto IS NULL OR vto>?) ORDER BY vfrom DESC LIMIT 1",
          [m.id, keys[i], m.baseVersion, m.baseVersion],
        );
        if (
          rows[i].deleted
            ? !current || current.deleted
            : current &&
              !current.deleted &&
              (await this.translation(current, {
                source: rows[i].source,
              } as CacheInput)) === rows[i].translation
        )
          continue;
      }
      changed.push(i);
    }
    requireValue(
      new Set(keys.map((k) => Array.from(k).join(","))).size === keys.length,
      "DUPLICATE_PACK_SOURCE",
    );
    const compressionStarted = performance.now();
    const packed = await compress(raw),
      block = await sha256(raw);
    this.trace.record(childTrace(t), "cache.compress", {
      outcome: "success",
      items: rows.length,
      bytes: raw.length,
      compressedBytes: packed.data.length,
      durationMs: performance.now() - compressionStarted,
    });
    await this.checkSpace(packed.data.length + rows.length * 192);
    this.transaction(
      t,
      "pack.append",
      m.id,
      rows.length,
      packed.data.length + rows.length * 96,
      () => {
        if (changed.some((i) => !rows[i].deleted))
          this.exec("INSERT OR IGNORE INTO blocks VALUES(?,?,?,?)", [
            block,
            packed.codec,
            raw.length,
            packed.data,
          ]);
        const close = this.db.prepare(
            "UPDATE pack_rows SET vto=? WHERE pack=? AND k=? AND vto IS NULL AND vfrom<?",
          ),
          insert = this.db.prepare(
            "INSERT INTO pack_rows VALUES(?,?,?,?,?,?,?)",
          );
        try {
          changed.forEach((slot) => {
            const e = rows[slot];
            if (m.kind === "delta")
              close.bind([m.version, m.id, keys[slot], m.version]).stepReset();
            insert
              .bind([
                m.id,
                keys[slot],
                m.version,
                null,
                e.deleted ? null : block,
                e.deleted ? null : slot,
                e.deleted ? 1 : 0,
              ])
              .stepReset();
          });
        } finally {
          close.finalize();
          insert.finalize();
        }
        this.exec(
          "UPDATE snapshots SET received=received+1,entries=entries+?,raw_bytes=raw_bytes+? WHERE pack=? AND version=?",
          [rows.length, raw.length, m.id, m.version],
        );
      },
    );
    return {
      received: rows.length,
      compressedBytes: packed.data.length,
      rawBytes: raw.length,
    };
  }
  async activatePack(id: string, version: number, t: Trace) {
    const s = this.one(
      "SELECT * FROM snapshots WHERE pack=? AND version=? AND status=?",
      [id, version, "staging"],
    );
    requireValue(s, "NO_STAGED_IMPORT");
    const m = JSON.parse(s.manifest) as PackManifest;
    requireValue(
      s.received === m.blocks.length &&
        s.entries === m.entries &&
        s.raw_bytes === m.uncompressedBytes,
      "INCOMPLETE_IMPORT",
    );
    const p = this.one("SELECT * FROM packs WHERE id=?", [id]);
    requireValue(p.staging === version, "STAGING_CHANGED");
    this.transaction(t, "pack.activate", id, m.entries, 512, () => {
      this.exec(
        "UPDATE snapshots SET status='ready' WHERE pack=? AND version=?",
        [id, version],
      );
      this.exec(
        "UPDATE packs SET previous=active,active=?,root=?,staging=NULL WHERE id=?",
        [version, s.root, id],
      );
      this.exec(
        "UPDATE snapshots SET status='retired' WHERE pack=? AND version NOT IN (?,?) AND status='ready'",
        [id, version, p.active],
      );
    });
    this.hot.clear();
    return { active: version, previous: p.active };
  }
  async abortPack(id: string, t: Trace) {
    const p = this.one("SELECT * FROM packs WHERE id=?", [id]);
    requireValue(p?.staging, "NO_STAGED_IMPORT");
    const inserted = this.all(
      "SELECT k FROM pack_rows WHERE pack=? AND vfrom=? LIMIT 257",
      [id, p.staging],
    );
    const closed = this.all(
      "SELECT k,vfrom FROM pack_rows WHERE pack=? AND vto=? LIMIT 257",
      [id, p.staging],
    );
    const more = inserted.length > 256 || closed.length > 256;
    this.transaction(
      t,
      "pack.abort",
      id,
      Math.min(256, inserted.length) + Math.min(256, closed.length),
      1024 +
        Math.min(256, inserted.length) * 192 +
        Math.min(256, closed.length) * 128,
      () => {
        for (const row of inserted.slice(0, 256))
          this.exec("DELETE FROM pack_rows WHERE pack=? AND k=? AND vfrom=?", [
            id,
            row.k,
            p.staging,
          ]);
        for (const row of closed.slice(0, 256))
          this.exec(
            "UPDATE pack_rows SET vto=NULL WHERE pack=? AND k=? AND vfrom=?",
            [id, row.k, row.vfrom],
          );
        if (!more) {
          this.exec("DELETE FROM snapshots WHERE pack=? AND version=?", [
            id,
            p.staging,
          ]);
          this.exec("UPDATE packs SET staging=NULL WHERE id=?", [id]);
        }
      },
    );
    return { aborted: !more, more };
  }
  rollback(id: string, t: Trace) {
    const p = this.one("SELECT * FROM packs WHERE id=?", [id]);
    requireValue(p?.previous && !p.staging, "NO_ROLLBACK_VERSION");
    const s = this.one(
      "SELECT root FROM snapshots WHERE pack=? AND version=? AND status='ready'",
      [id, p.previous],
    );
    requireValue(s, "ROLLBACK_VERSION_UNAVAILABLE");
    this.transaction(t, "pack.rollback", id, 0, 256, () =>
      this.exec("UPDATE packs SET active=?,previous=?,root=? WHERE id=?", [
        p.previous,
        p.active,
        s.root,
        id,
      ]),
    );
    this.hot.clear();
    return { active: p.previous };
  }
  async revision(rawEntry: CacheEntry, t: Trace) {
    const entry: CacheEntry = {
      ...rawEntry,
      sourceLang: normalizeLang(rawEntry.sourceLang),
      targetLang: normalizeLang(rawEntry.targetLang),
    };
    requireValue(
      validTranslation(entry.source, entry.translation),
      "INVALID_TRANSLATION",
    );
    const keyHex = await entryKey(entry, false);
    const key = bytesKey(keyHex),
      raw = encodeLines([entry]),
      packed = await compress(raw),
      id = await sha256(raw),
      rev = Number(
        this.value(
          "SELECT coalesce(max(revision),0)+1 FROM revisions WHERE k=?",
          [key],
        ),
      );
    const latest = this.one(
      "SELECT block_id,slot FROM revisions WHERE k=? ORDER BY revision DESC LIMIT 1",
      [key],
    );
    if ((await this.translation(latest, entry)) === entry.translation)
      return { revision: rev - 1, unchanged: true };
    await this.checkSpace(packed.data.length + 512);
    this.transaction(
      t,
      "revision.save",
      keyHex,
      1,
      packed.data.length + 192,
      () => {
        this.exec("INSERT OR IGNORE INTO blocks VALUES(?,?,?,?)", [
          id,
          packed.codec,
          raw.length,
          packed.data,
        ]);
        this.exec("INSERT INTO revisions VALUES(?,?,?,?,?,?)", [
          key,
          rev,
          id,
          0,
          this.now(),
          t.traceId,
        ]);
        this.exec("DELETE FROM revisions WHERE k=? AND revision<=?", [
          key,
          rev - 20,
        ]);
      },
    );
    this.hot.clear();
    return { revision: rev };
  }
  revisionHistory(input: CacheInput) {
    const normalized: CacheInput = {
      ...input,
      sourceLang: normalizeLang(input.sourceLang),
      targetLang: normalizeLang(input.targetLang),
    };
    return entryKey(normalized, false).then((k) =>
      this.all(
        "SELECT revision,time,trace_id FROM revisions WHERE k=? ORDER BY revision DESC",
        [bytesKey(k)],
      ),
    );
  }
  async clearModels(t: Trace) {
    await this.flushing.catch(() => {});
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.pendingBytes = 0;
    this.writeError = "";
    this.dirtyAt = 0;
    const count =
      Number(
        this.value("SELECT coalesce((SELECT v FROM totals WHERE k='model'),0)"),
      ) + Number(this.value("SELECT count(*) FROM local_model"));
    if (count)
      this.transaction(
        t,
        "model.clear",
        "model",
        Math.min(count, 256),
        Math.min(count, 256) * 256,
        () => {
          this.exec(
            "DELETE FROM model WHERE k IN (SELECT k FROM model LIMIT 256)",
          );
          this.exec(
            "DELETE FROM model_blocks WHERE NOT EXISTS(SELECT 1 FROM model WHERE model.block_id=model_blocks.block_id)",
          );
          this.exec(
            "DELETE FROM local_model WHERE k IN (SELECT k FROM local_model LIMIT 256)",
          );
          this.exec(
            "DELETE FROM local_blocks WHERE NOT EXISTS(SELECT 1 FROM local_model WHERE local_model.block_id=local_blocks.block_id)",
          );
        },
      );
    this.hot.clear();
    return { cleared: Math.min(count, 256), more: count > 256 };
  }
  async purgeInvalidModels(t: Trace) {
    await this.flushing.catch(() => {});
    const invalidCloud: Uint8Array[] = [];
    const invalidLocal: Uint8Array[] = [];
    let scanned = 0;
    for (const table of ["model", "local_model"] as const) {
      const rows = this.all(`SELECT k,block_id,slot FROM ${table}`);
      for (const row of rows) {
        scanned++;
        const blk = await this.block(row.block_id).catch(() => null);
        const item = blk
          ? (readSlotFromBlock(blk, row.slot) as
              | Partial<CacheEntry>
              | undefined)
          : undefined;
        if (
          !item ||
          typeof item.source !== "string" ||
          !validTranslation(item.source, item.translation)
        ) {
          if (table === "model") invalidCloud.push(row.k);
          else invalidLocal.push(row.k);
        }
      }
    }
    const purged = invalidCloud.length + invalidLocal.length;
    if (purged > 0) {
      this.transaction(
        t,
        "model.purge_invalid",
        "model",
        purged,
        purged * 256,
        () => {
          for (const k of invalidCloud) {
            this.exec("DELETE FROM model WHERE k=?", [k]);
          }
          for (const k of invalidLocal) {
            this.exec("DELETE FROM local_model WHERE k=?", [k]);
          }
          this.exec(
            "DELETE FROM model_blocks WHERE NOT EXISTS(SELECT 1 FROM model WHERE model.block_id=model_blocks.block_id)",
          );
          this.exec(
            "DELETE FROM local_blocks WHERE NOT EXISTS(SELECT 1 FROM local_model WHERE local_model.block_id=local_blocks.block_id)",
          );
        },
      );
      this.hot.clear();
    }
    return { scanned, purged };
  }
  deletePack(id: string, t: Trace) {
    requireValue(
      !this.one("SELECT staging FROM packs WHERE id=?", [id])?.staging,
      "ABORT_IMPORT_FIRST",
    );
    const key = "delete-pack:" + id;
    const count = Number(
      this.value(
        "SELECT count(*) FROM (SELECT 1 FROM pack_rows WHERE pack=? LIMIT 257)",
        [id],
      ),
    );
    this.transaction(
      t,
      "pack.delete",
      id,
      Math.min(count, 256),
      Math.min(count, 256) * 256 + 1024,
      () => {
        this.exec("UPDATE packs SET enabled=0 WHERE id=?", [id]);
        this.exec("INSERT OR REPLACE INTO maintenance VALUES(?,?)", [
          key,
          "true",
        ]);
        this.exec(
          "DELETE FROM pack_rows WHERE (pack,k,vfrom) IN (SELECT pack,k,vfrom FROM pack_rows WHERE pack=? LIMIT 256)",
          [id],
        );
        if (count <= 256) {
          this.exec("DELETE FROM snapshots WHERE pack=?", [id]);
          this.exec("DELETE FROM packs WHERE id=?", [id]);
          this.exec("DELETE FROM maintenance WHERE k=?", [key]);
        }
      },
    );
    this.hot.clear();
    return { deleted: count <= 256, more: count > 256 };
  }
  clearRevisions(t: Trace) {
    const count = Number(
      this.value(
        "SELECT coalesce((SELECT v FROM totals WHERE k='revisions'),0)",
      ),
    );
    if (count)
      this.transaction(
        t,
        "revision.clear",
        "revisions",
        Math.min(count, 256),
        Math.min(count, 256) * 256,
        () =>
          this.exec(
            "DELETE FROM revisions WHERE (k,revision) IN (SELECT k,revision FROM revisions LIMIT 256)",
          ),
      );
    this.hot.clear();
    return { cleared: Math.min(count, 256), more: count > 256 };
  }
  configurePack(
    id: string,
    settings: { enabled: boolean; priority: number },
    t: Trace,
  ) {
    requireValue(
      !this.value("SELECT v FROM maintenance WHERE k=?", ["delete-pack:" + id]),
      "PACK_DELETION_IN_PROGRESS",
    );
    requireValue(
      Number.isInteger(settings.priority) &&
        Math.abs(settings.priority) <= 1000,
      "INVALID_PRIORITY",
    );
    this.transaction(t, "pack.configure", id, 0, 256, () =>
      this.exec("UPDATE packs SET enabled=?,priority=? WHERE id=?", [
        settings.enabled ? 1 : 0,
        settings.priority,
        id,
      ]),
    );
    this.hot.clear();
    return { saved: true };
  }
  async readRevision(input: CacheInput, revision: number) {
    const normalized: CacheInput = {
      ...input,
      sourceLang: normalizeLang(input.sourceLang),
      targetLang: normalizeLang(input.targetLang),
    };
    const key = bytesKey(await entryKey(normalized, false)),
      row = this.one(
        "SELECT block_id,slot FROM revisions WHERE k=? AND revision=?",
        [key, revision],
      );
    requireValue(row, "REVISION_UNAVAILABLE");
    const blk = await this.block(row.block_id);
    return readSlotFromBlock(blk, row.slot);
  }
  // Export active user revisions and enabled dictionary entries for one-way sync to mistral-gui (Prompt item 11).
  async exportSyncData(
    sinceTime = 0,
    packVersions: Record<string, number> = {},
  ) {
    const revRows = this.all(
      "SELECT r.block_id, r.slot, r.revision, r.time FROM revisions r JOIN (SELECT k, max(revision) AS max_rev FROM revisions GROUP BY k) m ON r.k = m.k AND r.revision = m.max_rev ORDER BY r.time ASC LIMIT 20001",
    );
    requireValue(revRows.length <= 20000, "SYNC_LIMIT_EXCEEDED");
    const revisions: {
      source: string;
      translation: string;
      sourceLang: string;
      targetLang: string;
      domain: string;
      revision: number;
      time: number;
    }[] = [];
    let maxRevisionTime = sinceTime;
    for (const row of revRows) {
      const blk = await this.block(row.block_id);
      const item = readSlotFromBlock(blk, row.slot) as CacheEntry | undefined;
      if (item?.source && item?.translation) {
        revisions.push({
          source: normalizeSource(item.source),
          translation: item.translation,
          sourceLang: normalizeLang(item.sourceLang),
          targetLang: normalizeLang(item.targetLang),
          domain: item.domain || "*",
          revision: row.revision,
          time: row.time,
        });
        if (row.time > maxRevisionTime) maxRevisionTime = row.time;
      }
    }

    const activePacks = this.all(
      "SELECT * FROM packs WHERE active>0 AND enabled=1 ORDER BY priority DESC, id",
    ) as PackState[];
    const packs: {
      id: string;
      version: number;
      priority: number;
      sourceLang: string;
      targetLang: string;
      domain: string;
      unchanged?: boolean;
      entries: { source: string; translation: string }[];
    }[] = [];

    for (const p of activePacks) {
      if (packVersions[p.id] === p.active) {
        packs.push({
          id: p.id,
          version: p.active,
          priority: p.priority,
          sourceLang: normalizeLang(p.source_lang),
          targetLang: normalizeLang(p.target_lang),
          domain: p.domain,
          unchanged: true,
          entries: [],
        });
        continue;
      }
      const rows = this.all(
        "SELECT block_id, slot FROM pack_rows WHERE pack=? AND vfrom>=? AND vfrom<=? AND (vto IS NULL OR vto>?) AND deleted=0 LIMIT 50001",
        [p.id, p.root, p.active, p.active],
      );
      requireValue(rows.length <= 50000, "SYNC_LIMIT_EXCEEDED");
      const entries: { source: string; translation: string }[] = [];
      for (const r of rows) {
        if (!r.block_id) continue;
        const blk = await this.block(r.block_id);
        const item = readSlotFromBlock(blk, r.slot) as PackEntry | undefined;
        if (item?.source && item?.translation && !item.deleted) {
          entries.push({
            source: normalizeSource(item.source),
            translation: item.translation,
          });
        }
      }
      packs.push({
        id: p.id,
        version: p.active,
        priority: p.priority,
        sourceLang: normalizeLang(p.source_lang),
        targetLang: normalizeLang(p.target_lang),
        domain: p.domain,
        entries,
      });
    }

    return {
      revisions,
      revisionsSnapshot: true,
      packs,
      activePackIds: activePacks.map((p) => p.id),
      maxRevisionTime,
    };
  }
  async collect(t: Trace, cancelled: () => boolean = () => false) {
    const hour = Math.floor(this.now() / 3600000),
      state = JSON.parse(
        this.value("SELECT v FROM maintenance WHERE k='gc'") || "{}",
      ),
      used = state.hour === hour ? state.bytes : 0;
    if (cancelled() || used + 2048 > 8 * MiB)
      return { bytes: 0, budgetRemaining: Math.max(0, 8 * MiB - used) };
    let bytes = 0;
    const expired: { pack: string; k: Uint8Array; vfrom: number }[] = [];
    for (const p of this.all("SELECT * FROM packs WHERE staging IS NULL")) {
      if (!p.previous) continue;
      const old = this.one(
        "SELECT root FROM snapshots WHERE pack=? AND version=?",
        [p.id, p.previous],
      );
      const root = Math.min(p.root, old?.root || p.root),
        cutoff = Math.min(p.active, p.previous);
      const rows = this.all(
        "SELECT pack,k,vfrom FROM pack_rows WHERE pack=? AND (vfrom<? OR (vto IS NOT NULL AND vto<=?)) LIMIT 128",
        [p.id, root, cutoff],
      );
      expired.push(...rows);
      if (expired.length >= 128) break;
    }
    const chosen: any[] = [];
    if (!expired.length) {
      const candidates = this.all(
        "SELECT id,length(data) AS bytes FROM blocks WHERE id>? ORDER BY id LIMIT 128",
        [this.gcCursor],
      );
      for (const row of candidates) {
        this.gcCursor = row.id;
        if (
          this.value("SELECT 1 FROM model WHERE block_id=? LIMIT 1", [
            row.id,
          ]) ||
          this.value("SELECT 1 FROM local_model WHERE block_id=? LIMIT 1", [
            row.id,
          ]) ||
          this.value("SELECT 1 FROM pack_rows WHERE block_id=? LIMIT 1", [
            row.id,
          ]) ||
          this.value("SELECT 1 FROM revisions WHERE block_id=? LIMIT 1", [
            row.id,
          ])
        )
          continue;
        if (
          used + bytes + row.bytes + 1024 > 8 * MiB ||
          bytes + row.bytes + 1024 > 2 * MiB
        )
          break;
        chosen.push(row);
        bytes += row.bytes + 1024;
      }
      if (candidates.length < 128) this.gcCursor = "";
    }
    const allowance = Math.min(
      expired.length,
      Math.floor((8 * MiB - used - 1024) / 1024),
    );
    bytes += allowance * 1024;
    const retired: any[] = [];
    for (const row of this.all(
      "SELECT s.pack,s.version,length(CAST(s.manifest AS BLOB))+512 AS bytes FROM snapshots s JOIN packs p ON p.id=s.pack WHERE s.status='retired' AND s.version<>p.active AND s.version<>coalesce(p.previous,0) AND s.version<>coalesce(p.staging,0) LIMIT 16",
    )) {
      if (
        used + bytes + row.bytes + 1024 > 8 * MiB ||
        bytes + row.bytes + 1024 > 2 * MiB
      )
        break;
      retired.push(row);
      bytes += row.bytes;
    }
    if (!bytes)
      return {
        bytes: 0,
        budgetRemaining: 8 * MiB - used,
        more: !!this.gcCursor,
      };
    this.transaction(
      t,
      "maintenance.collect",
      "blocks",
      chosen.length + allowance + retired.length,
      bytes + 1024,
      () => {
        for (const row of expired.slice(0, allowance))
          this.exec("DELETE FROM pack_rows WHERE pack=? AND k=? AND vfrom=?", [
            row.pack,
            row.k,
            row.vfrom,
          ]);
        for (const row of chosen) {
          this.exec("DELETE FROM model_blocks WHERE block_id=?", [row.id]);
          this.exec("DELETE FROM blocks WHERE id=?", [row.id]);
        }
        for (const row of retired)
          this.exec("DELETE FROM snapshots WHERE pack=? AND version=?", [
            row.pack,
            row.version,
          ]);
        this.exec("INSERT OR REPLACE INTO maintenance VALUES('gc',?)", [
          JSON.stringify({ hour, bytes: used + bytes + 1024 }),
        ]);
      },
    );
    this.metrics.maintenanceBytes += bytes + 1024;
    for (const row of chosen) this.decoded.delete(row.id);
    return {
      bytes: bytes + 1024,
      budgetRemaining: Math.max(0, 8 * MiB - used - bytes - 1024),
      more: !!this.gcCursor || expired.length > 0 || retired.length > 0,
    };
  }
  // Use nullableNumber on totals so missing rows yield null -> "未知" instead of 0 (Q-V5).
  status(t?: Trace) {
    const packs = this.all(
      "SELECT p.*,s.entries,s.raw_bytes FROM packs p LEFT JOIN snapshots s ON s.pack=p.id AND s.version=p.active ORDER BY p.priority DESC,p.id",
    );
    return {
      packs,
      modelEntries: this.nullableNumber("SELECT v FROM totals WHERE k='model'"),
      localModelEntries: this.nullableNumber(
        "SELECT count(*) FROM local_model",
      ),
      localModelBytes:
        this.nullableNumber(
          "SELECT coalesce(sum(bytes),0) FROM local_blocks",
        ) ?? 0,
      localModelBudgetBytes: 256 * MiB,
      revisions: this.nullableNumber(
        "SELECT v FROM totals WHERE k='revisions'",
      ),
      dbBytes:
        Number(this.value("PRAGMA page_count")) *
        Number(this.value("PRAGMA page_size")),
      freeBytes:
        Number(this.value("PRAGMA freelist_count")) *
        Number(this.value("PRAGMA page_size")),
      blockBytes: this.nullableNumber("SELECT v FROM totals WHERE k='block'"),
      rawBytes: this.nullableNumber("SELECT v FROM totals WHERE k='raw'"),
      pending: this.pending.size,
      pendingBytes: this.pendingBytes,
      writeError: this.writeError,
      dirtySince: this.dirtyAt,
      hotBytes: this.hot.bytes,
      decodedBytes: this.decoded.bytes,
      budgetBytes: this.budget,
      metrics: { ...this.metrics },
      operations: t
        ? this.all("SELECT * FROM operations WHERE trace_id=? ORDER BY id", [
            t.traceId,
          ])
        : [],
    };
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.db.close();
  }
}
