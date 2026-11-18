import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario, reportMarkdown } from "./scenario.mjs";

test("workflow failure retains final snapshot and report correlation", async () => {
  const seen = [];
  let time = 0;
  const result = await runScenario(
    ["before", "workflow", "after"].map((name) => ({
      name,
      command: name,
      args: [],
    })),
    async (command) => {
      seen.push(command);
      return { code: command === "workflow" ? 1 : 0, output: command };
    },
    () => (time += 5),
  );
  assert.deepEqual(seen, ["before", "workflow", "after"]);
  assert.equal(result.passed, false);
  assert.equal(result.steps[2].output, "after");
  assert.equal(result.steps[1].durationMs, 5);
  assert.match(
    reportMarkdown({ runId: "test-1", ...result }),
    /workflow: exit 1/,
  );
  assert.match(
    reportMarkdown({ runId: "test-1", ...result }),
    /SCENARIO_END test-1/,
  );
});
