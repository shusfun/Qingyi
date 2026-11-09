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
  encoder,
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
const schema = `
PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768; PRAGMA journal_size_limit=16777216;
CREATE TABLE IF NOT EXISTS blocks(id TEXT PRIMARY KEY,codec INTEGER NOT NULL,raw_bytes INTEGER NOT NULL,data BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS model(k BLOB PRIMARY KEY,block_id TEXT NOT NULL,slot INTEGER NOT NULL) WITHOUT ROWID;
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
      entry.sourceLang,
      entry.targetLang,
      entry.domain,
      model ? entry.scope : "",
    ]),
  );
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
  readonly decoded = new ByteLRU<unknown[]>(16 * MiB);
  private pending = new Map<string, Pending>();
  private pendingBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private dirtyAt = 0;
  private writeError = "";
  private flushing = Promise.resolve();
  private decoding = new Map<string, Promise<unknown[]>>();
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
  private async checkSpace(bytes: number) {
    const pages = Number(this.value("PRAGMA page_count")),
      free = Number(this.value("PRAGMA freelist_count")),
      pageSize = Number(this.value("PRAGMA page_size"));
    requireValue(
      (pages - free) * pageSize + bytes <
        this.budget - Math.max(40 * MiB, this.budget * 0.15),
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
  private async block(id: string) {
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
      const rows = decodeLines(data);
      this.decoded.set(id, rows, data.length * 3 + rows.length * 256);
      return rows;
    })();
    this.decoding.set(id, decoding);
    try {
      return await decoding;
    } finally {
      this.decoding.delete(id);
    }
  }
  private async translation(row: any, input: CacheInput) {
    if (!row?.block_id) return null;
    const item = (await this.block(row.block_id))[
      row.slot
    ] as Partial<CacheEntry>;
    if (
      item &&
      normalizeSource(item.source || "") === normalizeSource(input.source) &&
      validTranslation(input.source, item.translation)
    )
      return item.translation;
    return null;
  }
  async lookup(inputs: CacheInput[], t: Trace) {
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
      const key = await entryKey(input),
        hot = this.hot.get(key),
        pending = this.pending.get(key);
      let result: string | null = hot ?? null,
        source = result ? "memory" : "";
      const plain = bytesKey(await entryKey(input, false));
      if (!result) {
        const row = this.one(
          "SELECT block_id,slot FROM revisions WHERE k=? ORDER BY revision DESC LIMIT 1",
          [plain],
        );
        result = await this.translation(row, input);
        if (result) source = "user";
      }
      if (!result)
        for (const pack of packs as PackState[]) {
          if (
            (pack.source_lang !== "*" &&
              pack.source_lang !== input.sourceLang) ||
            pack.target_lang !== input.targetLang ||
            (pack.domain !== "*" && pack.domain !== input.domain)
          )
            continue;
          const pk = bytesKey(
            await entryKey(
              { ...input, domain: pack.domain, sourceLang: pack.source_lang },
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
      if (!result && pending) {
        result = pending.entry.translation;
        source = "pending";
      }
      if (!result) {
        const row = this.one(
          "SELECT block_id,slot FROM " +
            (input.scope.startsWith("local:") ? "local_model" : "model") +
            " WHERE k=?",
          [bytesKey(key)],
        );
        result = await this.translation(row, input);
        if (result) source = "model";
      }
      if (result)
        this.hot.set(
          key,
          result,
          encoder.encode(input.source + result).length + 128,
        );
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
      const row = this.one(
        "SELECT block_id,slot FROM " +
          (input.scope.startsWith("local:") ? "local_model" : "model") +
          " WHERE k=?",
        [bytesKey(key)],
      );
      translations.push(
        pending?.entry.translation || (await this.translation(row, input)),
      );
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
    for (const entry of entries) {
      requireValue(
        entry.source.length <= 24000 &&
          validTranslation(entry.source, entry.translation),
        "INVALID_CACHE_ENTRY",
      );
      const key = await entryKey(entry);
      if (this.pending.get(key)?.entry.translation === entry.translation)
        continue;
      const existing = this.one(
        "SELECT block_id,slot FROM " +
          (entry.scope.startsWith("local:") ? "local_model" : "model") +
          " WHERE k=?",
        [bytesKey(key)],
      );
      if ((await this.translation(existing, entry)) === entry.translation)
        continue;
      const bytes = encoder.encode(JSON.stringify(entry)).length + 128;
      if (bytes > 8 * MiB) continue;
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
        await this.checkSpace(packedBytes + batch.length * 192);
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
            for (const b of sealed)
              if (b.group[0][1].entry.scope.startsWith("local:"))
                this.exec(
                  "INSERT OR IGNORE INTO local_blocks(block_id,bytes) VALUES(?,?)",
                  [b.id, b.data.length + b.group.length * 96],
                );
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
  async revision(entry: CacheEntry, t: Trace) {
    requireValue(
      validTranslation(entry.source, entry.translation),
      "INVALID_TRANSLATION",
    );
    const key = bytesKey(await entryKey(entry, false)),
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
      await entryKey(entry, false),
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
    return entryKey(input, false).then((k) =>
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
      Number(this.value("SELECT v FROM totals WHERE k='model'")) +
      Number(this.value("SELECT count(*) FROM local_model"));
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
      this.value("SELECT v FROM totals WHERE k='revisions'"),
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
    const key = bytesKey(await entryKey(input, false)),
      row = this.one(
        "SELECT block_id,slot FROM revisions WHERE k=? AND revision=?",
        [key, revision],
      );
    requireValue(row, "REVISION_UNAVAILABLE");
    return (await this.block(row.block_id))[row.slot];
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
        for (const row of chosen)
          this.exec("DELETE FROM blocks WHERE id=?", [row.id]);
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
  status(t?: Trace) {
    const packs = this.all(
      "SELECT p.*,s.entries,s.raw_bytes FROM packs p LEFT JOIN snapshots s ON s.pack=p.id AND s.version=p.active ORDER BY p.priority DESC,p.id",
    );
    return {
      packs,
      modelEntries: Number(this.value("SELECT v FROM totals WHERE k='model'")),
      localModelEntries: Number(this.value("SELECT count(*) FROM local_model")),
      localModelBytes: Number(
        this.value("SELECT coalesce(sum(bytes),0) FROM local_blocks"),
      ),
      localModelBudgetBytes: 256 * MiB,
      revisions: Number(this.value("SELECT v FROM totals WHERE k='revisions'")),
      dbBytes:
        Number(this.value("PRAGMA page_count")) *
        Number(this.value("PRAGMA page_size")),
      freeBytes:
        Number(this.value("PRAGMA freelist_count")) *
        Number(this.value("PRAGMA page_size")),
      blockBytes: Number(this.value("SELECT v FROM totals WHERE k='block'")),
      rawBytes: Number(this.value("SELECT v FROM totals WHERE k='raw'")),
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
