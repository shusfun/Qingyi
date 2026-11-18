import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export function execute(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function runScenario(steps, run = execute, now = Date.now) {
  const results = [];
  for (const step of steps) {
    const start = now();
    const result = await run(step.command, step.args);
    results.push({ name: step.name, ...result, durationMs: now() - start });
  }
  return { passed: results.every((r) => r.code === 0), steps: results };
}

export function reportMarkdown(report) {
  return (
    [
      `# ${report.runId}`,
      `Result: ${report.passed ? "passed" : "failed"}`,
      ...report.steps.map(
        (s) => `- ${s.name}: exit ${s.code}, ${s.durationMs} ms`,
      ),
      `SCENARIO_END ${report.runId}`,
    ].join("\n") + "\n"
  );
}

async function main() {
  const [repo, workflowRun] = process.argv.slice(2);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo || "") ||
    !/^\d+$/.test(workflowRun || "")
  ) {
    throw new Error(
      "Usage: node scripts/scenario.mjs owner/repo workflow-run-id",
    );
  }
  const runId = `${Date.now()}-${randomUUID()}`;
  const dir = path.resolve(import.meta.dirname, "../.runs", runId);
  await fs.mkdir(dir, { recursive: true });
  const snapshot = [
    "run",
    "view",
    workflowRun,
    "--repo",
    repo,
    "--json",
    "status,conclusion,headSha,url,jobs",
  ];
  const result = await runScenario([
    { name: "before", command: "gh", args: snapshot },
    {
      name: "workflow",
      command: "gh",
      args: [
        "run",
        "watch",
        workflowRun,
        "--repo",
        repo,
        "--exit-status",
        "--interval",
        "30",
      ],
    },
    { name: "after", command: "gh", args: snapshot },
  ]);
  const report = { runId, repo, workflowRun, ...result };
  await fs.writeFile(
    path.join(dir, "result.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(path.join(dir, "report.md"), reportMarkdown(report));
  console.log(
    `SCENARIO_END ${runId} ${report.passed ? "passed" : "failed"} ${dir}`,
  );
  if (!report.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
