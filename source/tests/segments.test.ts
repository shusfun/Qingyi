import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSegments } from "../src/segments";
import { placeholders, configFrom, DEFAULTS } from "../src/types";
test("long paragraphs split at sentence or word boundaries without losing text or placeholders", () => {
  const source =
    "__QY0__" +
    "A paragraph about browser performance and translation. ".repeat(70) +
    "__QY1__https://example.com/docs {{name}} ${value} %s 😀 最后一段。";
  const chunks = splitSegments(source);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 900));
  assert.equal(chunks.join(""), source);
  assert.deepEqual(chunks.flatMap(placeholders).sort(), placeholders(source));
  const url = "https://example.com/" + "a".repeat(1200);
  assert.deepEqual(splitSegments(url), [url]);
  const emoji = "😀".repeat(1400);
  assert.equal(splitSegments(emoji).join(""), emoji);
  assert.ok(splitSegments(emoji).every((c) => !/[\uD800-\uDBFF]$/.test(c)));
  const legacy = { ...DEFAULTS } as any;
  delete legacy.timeoutMs;
  assert.equal(configFrom({}, legacy).timeoutMs, 60000);
  assert.throws(() => configFrom({ timeoutMs: 1 }), /INVALID_TIMEOUT/);
});
