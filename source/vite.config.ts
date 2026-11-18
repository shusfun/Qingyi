import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: "./",
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
    target: "chrome120",
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "../extension"),
    emptyOutDir: false,
    target: "chrome120",
    sourcemap: false,
    rollupOptions: {
      input: {
        options: path.resolve(import.meta.dirname, "options.html"),
        pdf: path.resolve(import.meta.dirname, "pdf.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
