import { test } from "node:test";
import assert from "node:assert/strict";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { CacheDatabase, validateManifest } from "../src/db-core";
import { newTrace } from "../src/trace";
import { MiB, sha256 } from "../src/types";
import { base64, streamBytes } from "../src/codec";
const sqlite = await sqlite3InitModule();
const input = {
  source: "Test",
  translation: "保留修订",
  scope: "test",
  sourceLang: "auto",
  targetLang: "zh-CN",
  domain: "*",
};
test("oversized pack, decompression bomb and incorrect base leave user data available", async () => {
  const db = new sqlite.oo1.DB(":memory:"),
    cache = new CacheDatabase(db, { record: () => {} }),
    t = newTrace();
  try {
    cache.setBudget(64 * MiB);
    await cache.revision(input, t);
    const raw = new TextEncoder().encode("x".repeat(100000)),
      gz = await streamBytes(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
        MiB,
      );
    const m: any = {
      format: "qingyi-pack-v1",
      id: "recovery",
      version: 1,
      baseVersion: null,
      kind: "full",
      sourceLang: "auto",
      targetLang: "zh-CN",
      domain: "*",
      entries: 1,
      uncompressedBytes: 16,
      blocks: [
        {
          file: "a.gz",
          sha256: await sha256(gz),
          bytes: gz.length,
          uncompressedBytes: 16,
          entries: 1,
        },
      ],
    };
    await cache.startPack(m, t);
    await assert.rejects(
      cache.appendPack("recovery", 1, "a.gz", base64(gz), t),
      /DECOMPRESS_LIMIT/,
    );
    assert.equal(
      (await cache.lookup([input], t)).translations[0],
      input.translation,
    );
    await cache.abortPack("recovery", t);
    await assert.rejects(
      cache.startPack({ ...m, kind: "delta", baseVersion: 1, version: 2 }, t),
      /BASE_VERSION/,
    );
    const large = {
      ...m,
      id: "big",
      entries: 500000,
      uncompressedBytes: 500000 * 16,
      blocks: Array.from({ length: 100 }, (_, i) => ({
        ...m.blocks[0],
        file: i + ".gz",
        entries: 5000,
        uncompressedBytes: 80000,
      })),
    };
    await assert.rejects(cache.startPack(large, t), /BUDGET/);
    assert.equal(
      (await cache.lookup([input], t)).translations[0],
      input.translation,
    );
    assert.throws(
      () =>
        validateManifest({
          ...m,
          blocks: [{ ...m.blocks[0], file: "../escape" }],
        }),
      /INVALID_BLOCK/,
    );
  } finally {
    cache.dispose();
  }
});
