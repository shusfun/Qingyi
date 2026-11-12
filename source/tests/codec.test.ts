import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress } from "../src/codec";
import { configFrom, DEFAULTS, parseBatch } from "../src/types";
test("incompressible blocks stay raw and decompression is bounded", async () => {
  const raw = new Uint8Array(256 * 1024);
  for (let offset = 0; offset < raw.length; offset += 65536)
    crypto.getRandomValues(raw.subarray(offset, offset + 65536));
  const packed = await compress(raw);
  assert.equal(packed.codec, 0);
  assert.deepEqual(
    await decompress(packed.data, packed.codec, raw.length),
    raw,
  );
  const repeated = new TextEncoder().encode(
    "a common repeated paragraph. ".repeat(10000),
  );
  const zipped = await compress(repeated);
  assert.equal(zipped.codec, 1);
  assert.ok(zipped.data.length < repeated.length / 10);
  await assert.rejects(
    decompress(zipped.data, zipped.codec, 100),
    /DECOMPRESS_LIMIT/,
  );
});
test("configuration preserves blank keys without carrying command fields", () => {
  const old = { ...DEFAULTS, apiKey: "secret" };
  const saved = configFrom({ apiKey: "", clearKey: false }, old);
  assert.equal(saved.apiKey, "secret");
  assert.equal("clearKey" in saved, false);
  assert.equal(configFrom({ clearKey: true }, old).apiKey, "");
  assert.throws(() => configFrom({ model: "" }, old), /INVALID_MODEL/);
});
test("empty legacy update sources recover the official repository without changing credentials", () => {
  for (const releaseRepo of [undefined, "", "  "]) {
    const c = configFrom({
      ...DEFAULTS,
      releaseRepo,
      apiKey: "cloud",
      localToken: "local",
    });
    assert.equal(c.releaseRepo, "shusfun/Qingyi");
    assert.equal(c.apiKey, "cloud");
    assert.equal(c.localToken, "local");
  }
  assert.equal(
    configFrom({ releaseRepo: " custom/fork " }).releaseRepo,
    "custom/fork",
  );
  assert.throws(
    () => configFrom({ releaseRepo: "https://github.com/custom/fork" }),
    /INVALID_REPOSITORY/,
  );
});
test("partial batches salvage valid IDs while rejecting duplicate and missing placeholders", () => {
  assert.deepEqual(
    parseBatch(
      '[{"id":"t0","text":"一"},{"id":"t1","text":"二"},{"id":"t1","text":"重复"}]',
      ["one", "two"],
    ),
    ["一", undefined],
  );
  assert.equal(
    parseBatch('[{"id":"t0","text":"译文"}]', ["__QY0__text"])[0],
    undefined,
  );
});
