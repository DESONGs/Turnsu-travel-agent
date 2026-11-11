import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const result = await build({ configFile: false, plugins: [react()], define: { "process.env.NODE_ENV": '"production"' },
  build: { write: false, minify: "esbuild", cssCodeSplit: false, sourcemap: false, assetsInlineLimit: Infinity,
    lib: { entry: resolve("src/web/embedded-main.jsx"), formats: ["iife"], name: "TravelWorkspace" }, rollupOptions: { output: { inlineDynamicImports: true } } } });
const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output;
const js = output.filter(item => item.type === "chunk").map(item => item.code).join("\n").replace(/<\/script/gi, "<\\/script");
const css = output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
const page = mode => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Travel Agent</title><style>${css}</style></head><body><div id="root"></div><script>globalThis.TRAVEL_APP_BUILD=${JSON.stringify(mode)};globalThis.TRAVEL_PUBLIC_ORIGIN="__TRAVEL_PUBLIC_ORIGIN__";</script><script>${js}</script></body></html>`;
await mkdir("dist-mcp", { recursive: true });
for (const mode of ["workspace", "artifact"]) await writeFile(`dist-mcp/${mode}.html`, page(mode));
process.stdout.write("Built shared MCP App and Claude Artifact from the same workbench.\n");
