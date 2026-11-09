import { test } from "node:test";
import assert from "node:assert/strict";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { CacheDatabase, entryKey } from "../src/db-core";
import { newTrace, TraceBuffer, traceparent } from "../src/trace";
import { base64, encodeLines, streamBytes } from "../src/codec";
import { sha256, type CacheEntry, type PackManifest } from "../src/types";
const sqlite = await sqlite3InitModule();
const input: CacheEntry = {
  source: "Hello world",
  translation: "你好世界",
  scope: "test",
  domain: "example.com",
  sourceLang: "en",
  targetLang: "zh-CN",
};
function create() {
  const events: any[] = [];
  return {
    cache: new CacheDatabase(new sqlite.oo1.DB(":memory:"), {
      record: (...x: any[]) => events.push(x),
    }),
    events,
  };
}
test("local quota evicts only local inference and preserves cloud, dictionary and corrections", async () => {
  const { cache } = create(),
    t = newTrace();
  const local = { ...input, scope: "local:rev1" },
    cloud = { ...input, scope: "cloud-rev" };
  try {
    await cache.enqueue([local, cloud], t);
    await cache.flush();
    assert.equal(cache.status().localModelEntries, 1);
    assert.equal(cache.status().modelEntries, 1);
    assert.equal(
      (await cache.lookupModels([{ ...local, scope: "local:rev2" }], t))
        .translations[0],
      null,
    );
    await cache.revision(
      { ...input, source: "correction", translation: "用户修订" },
      t,
    );
    const p = await pack(1, [
      { source: "dictionary", translation: "长期词库" },
    ]);
    await cache.startPack(p.manifest, t);
    await cache.appendPack("test", 1, "part.gz", p.data, t);
    await cache.activatePack("test", 1, t);
    cache.db.exec("UPDATE local_blocks SET bytes=268435457");
    await cache.enqueue([{ ...local, source: "new paragraph" }], t);
    await cache.flush();
    assert.equal((await cache.lookupModels([local], t)).translations[0], null);
    assert.equal(
      (await cache.lookupModels([cloud], t)).translations[0],
      input.translation,
    );
    assert.equal(
      (
        await cache.lookup(
          [
            { ...input, source: "correction" },
            { ...input, source: "dictionary" },
          ],
          t,
        )
      ).translations.join("|"),
      "用户修订|长期词库",
    );
    assert.ok(cache.status().localModelBytes <= 256 * 1024 * 1024);
    await cache.clearModels(t);
    assert.equal(cache.status().localModelEntries, 0);
    assert.equal(
      (await cache.lookup([{ ...input, source: "dictionary" }], t))
        .translations[0],
      "长期词库",
    );
  } finally {
    cache.dispose();
  }
});
async function pack(
  version: number,
  rows: any[],
  kind: "full" | "delta" = "full",
  baseVersion: number | null = null,
) {
  const raw = encodeLines(rows),
    data = await streamBytes(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
      raw.length + 1024,
    );
  const manifest: PackManifest = {
    format: "qingyi-pack-v1",
    id: "test",
    version,
    kind,
    baseVersion,
    sourceLang: "en",
    targetLang: "zh-CN",
    domain: "example.com",
    entries: rows.length,
    uncompressedBytes: raw.length,
    blocks: [
      {
        file: "part.gz",
        sha256: await sha256(data),
        bytes: data.length,
        uncompressedBytes: raw.length,
        entries: rows.length,
      },
    ],
  };
  return { manifest, data: base64(data) };
}
test("buffer, dedup, cache hit produces no persistent write; correction wins", async () => {
  const { cache } = create(),
    t = newTrace();
  try {
    await cache.enqueue([input, input], t);
    assert.equal(cache.status().pending, 1);
    assert.equal(cache.metrics.transactions, 0);
    await cache.flush();
    assert.equal(cache.metrics.modelRowsWritten, 1);
    const before = cache.metrics.submittedBytes;
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await cache.lookup([input], t)).translations[0],
        input.translation,
      );
    assert.equal(cache.metrics.submittedBytes, before);
    await cache.enqueue([{ ...input, translation: "暂存模型" }], t);
    await cache.revision({ ...input, translation: "用户修订" }, t);
    assert.equal((await cache.lookup([input], t)).translations[0], "用户修订");
    await cache.flush();
    assert.equal((await cache.lookup([input], t)).translations[0], "用户修订");
  } finally {
    cache.dispose();
  }
});

test("multi-block writeback commits once and a mid-batch failure retains the whole buffer", async () => {
  const { cache } = create(),
    t = newTrace();
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    ...input,
    source: `source ${i} ${"s".repeat(300)}`,
    translation: `译文 ${i} ${"译".repeat(100)}`,
  }));
  try {
    await cache.enqueue(rows, t);
    cache.db.exec(
      "CREATE TRIGGER reject_batch BEFORE INSERT ON model WHEN (SELECT v FROM totals WHERE k='model')>=500 BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    await assert.rejects(cache.flush());
    assert.equal(cache.status().modelEntries, 0);
    assert.equal(cache.status().blockBytes, 0);
    assert.equal(cache.status().pending, rows.length);
    assert.equal(cache.metrics.transactions, 0);
    cache.db.exec("DROP TRIGGER reject_batch");
    await cache.flush();
    assert.equal(cache.metrics.transactions, 1);
    assert.equal(cache.status().pending, 0);
    assert.equal(cache.status().modelEntries, rows.length);
    assert.ok(cache.db.selectValue("SELECT count(*) FROM blocks") > 1);
    const picked = [rows[0], rows[499], rows[1000], rows[1999]];
    assert.deepEqual(
      (await cache.lookup(picked, t)).translations,
      picked.map((r) => r.translation),
    );
    cache.hot.clear();
    cache.decoded.clear();
    const key = await entryKey(rows[0]);
    const broken = cache.db.selectValue(
      "SELECT block_id FROM model WHERE k=?",
      [Uint8Array.from(key.match(/../g)!, (h) => parseInt(h, 16))],
    );
    cache.db.exec({ sql: "DELETE FROM blocks WHERE id=?", bind: [broken] });
    let active = 0;
    const original = (cache as any).block.bind(cache);
    (cache as any).block = async (id: string) => {
      active++;
      try {
        return await original(id);
      } finally {
        active--;
      }
    };
    await assert.rejects(
      cache.lookup(rows.slice(0, 64), newTrace()),
      /MISSING_BLOCK/,
    );
    assert.equal(
      active,
      0,
      "failed reads must finish concurrent work before the next database operation",
    );
  } finally {
    cache.dispose();
  }
});
test("staging checksum failure preserves active snapshot, delta and rollback", async () => {
  const { cache } = create(),
    t = newTrace();
  try {
    const p1 = await pack(1, [{ source: input.source, translation: "词库一" }]);
    await cache.startPack(p1.manifest, t);
    await cache.appendPack("test", 1, "part.gz", p1.data, t);
    await cache.activatePack("test", 1, t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库一");
    const p2 = await pack(
      2,
      [{ source: input.source, translation: "词库二" }],
      "delta",
      1,
    );
    await cache.startPack(p2.manifest, t);
    await assert.rejects(
      cache.appendPack("test", 2, "part.gz", p1.data, t),
      /CHECKSUM/,
    );
    assert.equal((await cache.lookup([input], t)).translations[0], "词库一");
    await cache.appendPack("test", 2, "part.gz", p2.data, t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库一");
    await cache.activatePack("test", 2, t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库二");
    cache.rollback("test", t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库一");
    cache.rollback("test", t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库二");
    const p3 = await pack(
      3,
      [{ source: input.source, deleted: true }],
      "delta",
      2,
    );
    await cache.startPack(p3.manifest, t);
    await cache.appendPack("test", 3, "part.gz", p3.data, t);
    await cache.activatePack("test", 3, t);
    assert.equal((await cache.lookup([input], t)).translations[0], null);
    cache.rollback("test", t);
    assert.equal((await cache.lookup([input], t)).translations[0], "词库二");
  } finally {
    cache.dispose();
  }
});
test("revision retains 20 versions and separate clearing preserves corrections", async () => {
  const { cache } = create(),
    t = newTrace();
  try {
    for (let i = 0; i < 25; i++)
      await cache.revision({ ...input, translation: "修订" + i }, t);
    assert.equal((await cache.revisionHistory(input)).length, 20);
    await cache.clearModels(t);
    assert.equal((await cache.lookup([input], t)).translations[0], "修订24");
  } finally {
    cache.dispose();
  }
});
test("trace redaction, W3C propagation and read never flushes", async () => {
  let now = 1000000,
    writes = 0;
  const stored: any[] = [];
  const b = new TraceBuffer(
      {
        append: async (e) => {
          writes++;
          stored.push(...e);
        },
        read: async () => stored,
        clear: async () => {},
      },
      () => now,
    ),
    t = newTrace();
  b.record(t, "operation.start", {
    apiKey: "secret",
    sourceText: "private",
  } as any);
  assert.match(traceparent(t), /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  assert.equal((await b.read())[0] && "apiKey" in (await b.read())[0], false);
  assert.equal(writes, 0);
  await b.flush();
  b.record(t, "operation.end");
  await b.flush();
  assert.equal(writes, 1);
  now += 60000;
  await b.flush();
  assert.equal(writes, 2);
  await b.clear();
});

test("failed flush retains bounded entries, pauses timer, manual retry resumes and links contributors", async () => {
  const { cache, events } = create(),
    a = newTrace(),
    b = newTrace();
  try {
    await cache.enqueue([input], a);
    await cache.enqueue([{ ...input, source: "Second paragraph" }], b);
    const check = (cache as any).checkSpace;
    (cache as any).checkSpace = async () => {
      throw Error("DEVICE_SPACE_LOW");
    };
    await assert.rejects(cache.flush(), /DEVICE_SPACE_LOW/);
    assert.equal(cache.status().pending, 2);
    assert.equal(cache.status().writeError, "DEVICE_SPACE_LOW");
    assert.equal((cache as any).timer, undefined);
    await cache.enqueue([{ ...input, source: "Third paragraph" }], b);
    assert.equal((cache as any).timer, undefined);
    assert.ok(cache.status().pendingBytes < 8 * 1024 * 1024);
    (cache as any).checkSpace = check;
    await cache.flush();
    assert.equal(cache.status().pending, 0);
    assert.equal(cache.status().writeError, "");
    for (const t of [a, b])
      assert.ok(
        events.some(
          ([trace, event]) =>
            trace.traceId === t.traceId && event === "cache.persist",
        ),
      );
    assert.equal(cache.status(b).operations.length, 1);
    cache.hot.clear();
    cache.decoded.clear();
    const before = cache.metrics.transactions;
    await cache.enqueue([input], a);
    await cache.flush();
    assert.equal(cache.metrics.transactions, before);
  } finally {
    cache.dispose();
  }
});

test("unchanged delta retains one interval; rollback cannot branch a delta; abort is bounded", async () => {
  const { cache } = create(),
    t = newTrace();
  try {
    const install = async (
      version: number,
      rows: any[],
      kind: "full" | "delta" = "full",
      base: number | null = null,
    ) => {
      const p = await pack(version, rows, kind, base);
      await cache.startPack(p.manifest, t);
      await cache.appendPack("test", version, "part.gz", p.data, t);
      await cache.activatePack("test", version, t);
    };
    await install(1, [{ source: input.source, translation: "相同" }]);
    await install(
      2,
      [{ source: input.source, translation: "相同" }],
      "delta",
      1,
    );
    assert.equal(cache.db.selectValue("SELECT count(*) FROM pack_rows"), 1);
    cache.rollback("test", t);
    const bad = await pack(
      3,
      [{ source: input.source, translation: "新" }],
      "delta",
      1,
    );
    await assert.rejects(cache.startPack(bad.manifest, t), /ROLL_FORWARD/);
    cache.rollback("test", t);
    const many = await pack(
      3,
      Array.from({ length: 600 }, (_, i) => ({
        source: "pending " + i,
        translation: "待撤销 " + i,
      })),
      "delta",
      2,
    );
    await cache.startPack(many.manifest, t);
    await cache.appendPack("test", 3, "part.gz", many.data, t);
    const first = await cache.abortPack("test", t);
    assert.equal(first.more, true);
    assert.equal(
      cache.db.selectValue("SELECT count(*) FROM pack_rows WHERE vfrom=3"),
      344,
    );
    while ((await cache.abortPack("test", t)).more) {}
    assert.equal((await cache.lookup([input], t)).translations[0], "相同");
  } finally {
    cache.dispose();
  }
});

test("maintenance obeys hourly budget and cancellation performs no transaction", async () => {
  const { cache } = create(),
    t = newTrace();
  try {
    await cache.enqueue([input], t);
    await cache.flush();
    await cache.clearModels(t);
    const before = cache.metrics.transactions;
    await cache.collect(t, () => true);
    assert.equal(cache.metrics.transactions, before);
    const hour = Math.floor(Date.now() / 3600000);
    cache.db.exec({
      sql: "INSERT INTO maintenance VALUES('gc',?)",
      bind: [JSON.stringify({ hour, bytes: 8 * 1024 * 1024 - 1024 })],
    });
    assert.equal((await cache.collect(t)).bytes, 0);
    assert.equal(cache.metrics.transactions, before);
  } finally {
    cache.dispose();
  }
});
