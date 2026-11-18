import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "../shared/paragraph-fixtures.json";
import { rebuildParagraphs } from "../src/paragraph-rebuild";

test("shared paragraph reconstruction fixtures pass in TypeScript", () => {
  for (const item of fixtures) {
    const actual = rebuildParagraphs(item.input, {
      preserveLineBreaks: item.preserveLineBreaks,
    });
    assert.deepEqual(actual, item.expected, `fixture failed: ${item.id}`);
  }
});
