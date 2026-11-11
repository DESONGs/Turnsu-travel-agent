import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, copyFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { catalog } from "../src/catalog.mjs";
import { validateRenderers } from "../src/render-contract.mjs";
const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("published components have the same definitions in the source contract and renderer", async () => {
  assert.deepEqual(catalog, JSON.parse(await readFile(resolve(root, "contracts/travel-workbench.json"), "utf8")));
  validateRenderers(catalog);
  assert.throws(() => validateRenderers({ ...catalog, components: [...catalog.components, { type: "unsupported", version: 1 }] }));
});

test("release packages contain only installable files, exact callbacks and the served UI fingerprints", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "travel-release-test-"));
  const files = ["scripts/package-travel-plugins.mjs", "contracts/travel-workbench.json", "LICENSE", "plugins/travel-agent-openai/plugin.json",
    "plugins/travel-agent-openai/.codex-plugin/plugin.json", "plugins/travel-agent-openai/skills/travel-workspace/SKILL.md",
    "plugins/travel-agent-openai/workbench/package.json", ...["codex.html", "mcp.html", "build.json"].map(name => `plugins/travel-agent-openai/workbench/dist/${name}`)];
  try {
    for (const file of files) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await copyFile(resolve(root, file), resolve(directory, file)); }
    await mkdir(resolve(directory, "plugins/travel-agent-openai/node_modules"), { recursive: true });
    await writeFile(resolve(directory, "plugins/travel-agent-openai/node_modules/private.txt"), "must never be packaged");
    await writeFile(resolve(directory, "plugins/travel-agent-openai/.env"), "must never be packaged");
    const run = (...args) => spawnSync(process.execPath, [resolve(directory, "scripts/package-travel-plugins.mjs"), "--origin=https://travel.example.com", ...args], { encoding: "utf8" });
    const portable = resolve(directory, "portable");
    let result = run(`--out=${portable}`); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(portable)).sort(), ["LICENSE", "build.json", "mcp.json", "plugin.json", "skills"]);
    assert.equal(JSON.parse(await readFile(resolve(portable, "mcp.json"))).mcpServers["travel-agent"].url, "https://travel.example.com/mcp");
    const native = resolve(directory, "codex");
    result = run("--format=codex", `--out=${native}`, "--callback-url=http://127.0.0.1:4321/callback/registered", "--callback-port=4321");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(resolve(native, ".mcp.json"))).mcpServers["travel-agent"].oauth,
      { callbackUrl: "http://127.0.0.1:4321/callback/registered", callbackPort: 4321 });
    const manifest = JSON.parse(await readFile(resolve(native, "build.json")));
    const expectedVersion = JSON.parse(await readFile(resolve(root, "plugins/travel-agent-openai/workbench/package.json"))).version;
    assert.ok(manifest.pages.codex.resourceUri.startsWith(`ui://travel/workbench/${expectedVersion}/codex/`));
    assert.match(manifest.pages.codex.resourceUri, /\/codex\/[0-9a-f]{16}\.html$/);
    await writeFile(resolve(directory, "plugins/travel-agent-openai/workbench/dist/codex.html"), "tampered page");
    result = run(`--out=${resolve(directory, "tampered")}`);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /fingerprint mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
