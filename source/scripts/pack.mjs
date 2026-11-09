import fs from "node:fs";
import readline from "node:readline";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
const [
  input,
  output,
  id = "dictionary",
  version = "1",
  sourceLang = "auto",
  targetLang = "zh-CN",
  domain = "*",
  base,
] = process.argv.slice(2);
if (!input || !output)
  throw Error(
    "Usage: node scripts/pack.mjs input.jsonl output.jsonl id version sourceLang targetLang domain [baseVersion]",
  );
const temp = output + ".blocks.tmp",
  writer = fs.createWriteStream(temp);
const blocks = [];
let rows = [],
  size = 0,
  total = 0,
  rawTotal = 0;
async function flush() {
  if (!rows.length) return;
  const raw = Buffer.from(rows.join("\n") + "\n"),
    data = gzipSync(raw),
    file = "block-" + blocks.length + ".jsonl.gz";
  blocks.push({
    file,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    uncompressedBytes: raw.length,
    entries: rows.length,
  });
  if (
    !writer.write(
      JSON.stringify({ file, data: data.toString("base64") }) + "\n",
    )
  )
    await once(writer, "drain");
  total += rows.length;
  rawTotal += raw.length;
  rows = [];
  size = 0;
}
for await (const line of readline.createInterface({
  input: fs.createReadStream(input),
  crlfDelay: Infinity,
})) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (
    typeof row.source !== "string" ||
    (!row.deleted && typeof row.translation !== "string")
  )
    throw Error("INVALID_ENTRY");
  const text = JSON.stringify(row),
    n = Buffer.byteLength(text) + 1;
  if (n > 1024 * 1024) throw Error("ENTRY_TOO_LARGE");
  if (rows.length && (size + n > 256 * 1024 || rows.length >= 2000))
    await flush();
  rows.push(text);
  size += n;
}
await flush();
writer.end();
await once(writer, "close");
const manifest = {
  format: "qingyi-pack-v1",
  id,
  version: Number(version),
  kind: base ? "delta" : "full",
  baseVersion: base ? Number(base) : null,
  sourceLang,
  targetLang,
  domain,
  entries: total,
  uncompressedBytes: rawTotal,
  blocks,
};
const dest = fs.createWriteStream(output);
dest.write(JSON.stringify({ manifest }) + "\n");
for await (const chunk of fs.createReadStream(temp)) {
  if (!dest.write(chunk)) await once(dest, "drain");
}
dest.end();
await once(dest, "close");
await fs.promises.unlink(temp);
console.log(path.resolve(output));
