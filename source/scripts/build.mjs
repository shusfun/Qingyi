import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  out = path.resolve(root, "../extension");
await fs.mkdir(out, { recursive: true });
for (const entry of [
  "background",
  "content",
  "options",
  "offscreen",
  "db-worker",
  "shadow-hook",
])
  await build({
    entryPoints: [path.join(root, "src", entry + ".ts")],
    outfile: path.join(out, entry + ".js"),
    bundle: true,
    format: ["content", "shadow-hook"].includes(entry) ? "iife" : "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
    legalComments: "eof",
  });
await fs.cp(path.join(root, "static"), out, { recursive: true });
await fs.mkdir(path.join(out, "sqlite"), { recursive: true });
for (const file of ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"])
  await fs.copyFile(
    path.join(root, "node_modules/@sqlite.org/sqlite-wasm/dist", file),
    path.join(out, "sqlite", file),
  );
const key = (
  await fs.readFile(path.join(root, "manifest-key.txt"), "utf8")
).trim();
const { version } = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const manifest = {
  manifest_version: 3,
  name: "轻译 · AI 网页翻译",
  version,
  description: "右键翻译、压缩词库、低写入本地缓存与脱敏诊断。",
  key,
  minimum_chrome_version: "120",
  permissions: [
    "activeTab",
    "scripting",
    "storage",
    "contextMenus",
    "offscreen",
    "unlimitedStorage",
    "webNavigation",
  ],
  host_permissions: ["https://api.github.com/*"],
  optional_host_permissions: [
    "https://*/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],
  background: { service_worker: "background.js", type: "module" },
  options_ui: { page: "options.html", open_in_tab: true },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  commands: {
    "translate-page": {
      suggested_key: { default: "Alt+Q" },
      description: "翻译当前页面",
    },
  },
};
await fs.writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await fs.copyFile(path.join(root, "README.md"), path.join(out, "README.md"));
console.log(out);
