import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, ".."),
  out = path.resolve(root, "../extension");

await fs.mkdir(out, { recursive: true });
await fs.rm(path.join(out, "assets"), { recursive: true, force: true });
for (const legacy of [
  "options.js",
  "components.css",
  "style.css",
  "tokens.css",
]) {
  await fs.rm(path.join(out, legacy), { force: true });
}

// Copy static assets first so Vite's built HTML/CSS/JS bundles win cleanly.
await fs.cp(path.join(root, "static"), out, {
  recursive: true,
  filter: (src) => !["options.html", "pdf.html"].includes(path.basename(src)),
});

// Build extension UI pages (Preact + Vite)
await viteBuild({
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "warn",
});

// Copy pdf.js Web Worker bundle for offline PDF extraction
await fs.mkdir(path.join(out, "assets"), { recursive: true });
await fs.copyFile(
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(out, "assets/pdf.worker.min.mjs"),
);

// Build MV3 background service worker, content scripts, and SQLite OPFS worker
for (const entry of [
  "background",
  "content",
  "offscreen",
  "db-worker",
  "shadow-hook",
]) {
  await esbuild({
    entryPoints: [path.join(root, "src", entry + ".ts")],
    outfile: path.join(out, entry + ".js"),
    bundle: true,
    loader: { ".css": "text" },
    format: ["content", "shadow-hook"].includes(entry) ? "iife" : "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    sourcemap: false,
    legalComments: "eof",
  });
}

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
  default_locale: "zh_CN",
  name: "__MSG_extName__",
  version,
  description: "__MSG_extDescription__",
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
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
      description: "__MSG_cmdTranslatePage__",
    },
    "toggle-mode": {
      suggested_key: { default: "Alt+Shift+B" },
      description: "__MSG_cmdToggleMode__",
    },
    "restore-original": {
      suggested_key: { default: "Alt+Shift+O" },
      description: "__MSG_cmdRestoreOriginal__",
    },
    "translate-selection": {
      suggested_key: { default: "Alt+Shift+S" },
      description: "__MSG_cmdTranslateSelection__",
    },
  },
};
await fs.writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await fs.copyFile(path.join(root, "README.md"), path.join(out, "README.md"));
console.log(out);
