import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf("="); if (!value.startsWith("--") || at < 3) throw new Error("Use --key=value arguments");
  return [value.slice(2, at), value.slice(at + 1)];
}));
const format = args.format || "portable";
if (!["portable", "codex"].includes(format)) throw new Error("Use --format=portable or codex");
const origin = new URL(args.origin || process.env.TRAVEL_AGENT_PUBLIC_ORIGIN || "invalid:");
if (origin.protocol !== "https:" || !origin.hostname || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("Provide a canonical --origin=https://your-public-service");
const endpoint = origin.origin + "/mcp";
const readJson = async file => JSON.parse(await readFile(resolve(root, file), "utf8"));
const plugin = await readJson("plugins/travel-agent-openai/plugin.json");
const build = await readJson("plugins/travel-agent-openai/workbench/dist/build.json");
const pkg = await readJson("plugins/travel-agent-openai/workbench/package.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (plugin.version !== build.version || pkg.version !== build.version) throw new Error("Build the same plugin and UI version before packaging");
if (build.contractSha256 !== hash(await readFile(resolve(root, "contracts/travel-workbench.json")))) throw new Error("UI contract has changed; rebuild before packaging");
for (const kind of ["mcp", "codex"]) {
  const bytes = await readFile(resolve(root, `plugins/travel-agent-openai/workbench/dist/${kind}.html`));
  if (hash(bytes) !== build.pages[kind]?.sha256 || build.pages[kind]?.resourceUri !== `ui://travel/workbench/${build.version}/${kind}/${hash(bytes).slice(0, 16)}.html`)
    throw new Error("UI fingerprint mismatch; rebuild before packaging");
}
const server = { type: format === "codex" ? "http" : "streamable-http", url: endpoint,
  extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" }, baseScopes: ["travel:read", "travel:write"] } } } };
if (format === "codex") {
  if (!args["callback-url"] || !args["callback-port"]) throw new Error("Codex requires its exact registered --callback-url and --callback-port");
  const callback = new URL(args["callback-url"]), port = Number(args["callback-port"]);
  if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname)
    || !Number.isInteger(port) || port < 1024 || port > 65535 || Number(callback.port) !== port
    || callback.username || callback.password || callback.hash || callback.search || callback.pathname === "/")
    throw new Error("Use an exact loopback callback and a matching listener port");
  server.oauth = { callbackUrl: callback.href, callbackPort: port };
}
const out = resolve(args.out || resolve(root, `dist-plugins/travel-agent-openai-${build.version}-${format}`));
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error("Choose an empty --out directory to avoid mixing release candidates");
if (format === "portable") {
  await writeFile(resolve(out, "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");
} else {
  await mkdir(resolve(out, ".codex-plugin"));
  const native = await readJson("plugins/travel-agent-openai/.codex-plugin/plugin.json");
  await writeFile(resolve(out, ".codex-plugin/plugin.json"), JSON.stringify(native, null, 2) + "\n");
}
await writeFile(resolve(out, format === "codex" ? ".mcp.json" : "mcp.json"), JSON.stringify({ mcpServers: { "travel-agent": server } }, null, 2) + "\n");
await mkdir(resolve(out, "skills/travel-workspace"), { recursive: true });
await copyFile(resolve(root, "plugins/travel-agent-openai/skills/travel-workspace/SKILL.md"), resolve(out, "skills/travel-workspace/SKILL.md"));
await copyFile(resolve(root, "LICENSE"), resolve(out, "LICENSE"));
await writeFile(resolve(out, "build.json"), JSON.stringify({ ...build, endpoint, format }, null, 2) + "\n");
const archive = out + ".zip";
execFileSync("python3", ["-m", "zipfile", "-c", archive, basename(out)], { cwd: dirname(out), stdio: "pipe" });
process.stdout.write(`Generated ${format} plugin: ${archive}\nRegister exactly the callback supplied to the Codex package in TRAVEL_MCP_REDIRECT_URIS.\n`);
