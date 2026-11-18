import fs from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(sourceRoot, "..");
const checkOnly = process.argv.includes("--check");
const managerRoot = path.join(repoRoot, "mistral-gui");
try {
  await fs.access(path.join(managerRoot, "web", "package.json"));
} catch {
  if (!checkOnly)
    throw new Error("Manager checkout required for explicit shared-file sync");
  console.log(
    "Standalone extension checkout: cross-repository sync check skipped.",
  );
  process.exit(0);
}

const designSystemFiles = [
  "tokens.css",
  "components.css",
  "errors.ts",
  "feedback.ts",
  "components.tsx",
  "index.ts",
];

const mappings = [
  ...designSystemFiles.map((file) => ({
    from: path.join(sourceRoot, "design-system", file),
    to: path.join(
      repoRoot,
      "mistral-gui",
      "web",
      "src",
      "shared",
      "design-system",
      file,
    ),
  })),
  {
    from: path.join(sourceRoot, "shared", "translation-rules.json"),
    to: path.join(
      repoRoot,
      "mistral-gui",
      "web",
      "src",
      "shared",
      "translation-rules.json",
    ),
  },
  {
    from: path.join(sourceRoot, "shared", "translation-rules.json"),
    to: path.join(
      repoRoot,
      "mistral-gui",
      "internal",
      "app",
      "rules",
      "translation-rules.json",
    ),
  },
];

const normalizeBuf = (buf) =>
  Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

let mismatches = 0;

for (const { from, to } of mappings) {
  const srcBytes = normalizeBuf(await fs.readFile(from));
  if (checkOnly) {
    try {
      const dstBytes = normalizeBuf(await fs.readFile(to));
      if (!srcBytes.equals(dstBytes)) {
        console.error(`Out of sync: ${path.relative(repoRoot, to)}`);
        mismatches++;
      }
    } catch {
      console.error(`Missing synced file: ${path.relative(repoRoot, to)}`);
      mismatches++;
    }
  } else {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, srcBytes);
  }
}

if (checkOnly) {
  if (mismatches > 0) {
    console.error(
      `Shared design-system/rules check failed with ${mismatches} mismatch(es). Run: npm --prefix source run sync`,
    );
    process.exit(1);
  }
  console.log(
    `Shared design-system and rules verified (${mappings.length} targets).`,
  );
} else {
  console.log(`Synced ${mappings.length} shared design-system and rule files.`);
}
