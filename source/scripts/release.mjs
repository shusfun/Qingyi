import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
await import("./build.mjs");
const root = path.resolve(import.meta.dirname, ".."),
  release = path.resolve(root, "../releases");
await fs.mkdir(release, { recursive: true });
const source = path.resolve(root, "../extension");
const { version } = JSON.parse(
  await fs.readFile(path.join(source, "manifest.json"), "utf8"),
);
const zip = path.join(release, `qingyi-${version}-chromium.zip`);
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path ${quote(source + "/*")} -DestinationPath ${quote(zip)} -Force`,
  ],
  { stdio: "inherit" },
);
const bytes = await fs.readFile(zip),
  hash = createHash("sha256").update(bytes).digest("hex");
await fs.writeFile(zip + ".sha256", hash + "  " + path.basename(zip) + "\n");
console.log(zip);
console.log(hash);
