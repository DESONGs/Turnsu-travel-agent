import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { syncContract } from "../../../scripts/sync-workbench-contract.mjs";
import { validateRenderers } from "./src/render-contract.mjs";
const root = fileURLToPath(new URL("./", import.meta.url));
const { contract, bytes } = await syncContract(); validateRenderers(contract);
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const hash = value => createHash("sha256").update(value).digest("hex");
const manifest = { version, contractSha256: hash(bytes), pages: {} };
for (const target of ["mcp", "codex"]) {
  const modules = [];
  await build({ configFile: false, root, plugins: [viteSingleFile(), { name: "travel-host-boundary", generateBundle() {
    for (const id of this.getModuleIds()) modules.push(id);
    if (target === "mcp" && modules.some(id => id.includes("@openai/mcp-extensions"))) throw new Error("Standard MCP build must not contain OpenAI extensions");
  } }], esbuild: { jsx: "automatic", jsxImportSource: "preact" }, resolve: { alias: [
    { find: /^three$/, replacement: resolve(root, "node_modules/three/build/three.module.js") },
    { find: /^three\/addons\//, replacement: resolve(root, "node_modules/three/examples/jsm") + "/" },
  ], dedupe: ["three"] },
    build: { emptyOutDir: target === "mcp", cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rolldownOptions: { input: resolve(root, `${target}.html`) } } });
  const html = await readFile(resolve(root, `dist/${target}.html`)); const sha256 = hash(html);
  manifest.pages[target] = { sha256, resourceUri: `ui://travel/workbench/${version}/${target}/${sha256.slice(0, 16)}.html` };
}
await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/build.json"), JSON.stringify(manifest, null, 2) + "\n");
