import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const raw = process.argv.find(value => value.startsWith("--origin="))?.slice(9) ?? process.env.TRAVEL_AGENT_PUBLIC_ORIGIN;
if (!raw) throw new Error("Provide --origin=https://your-public-service to produce installable plugin packages.");
const origin = new URL(raw);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("A canonical public HTTPS origin is required.");
const base = origin.origin;
await mkdir("dist-plugins", { recursive: true });
for (const host of ["openai", "claude", "workbuddy", "dsh"]) {
  const name = `travel-agent-${host}`;
  const target = resolve("dist-plugins", name);
  await rm(target, { recursive: true, force: true });
  await cp(resolve("plugins", name), target, { recursive: true });
  for (const configName of host === "dsh" ? [] : host === "workbuddy" ? ["mcp.json"] : [".mcp.json", ...(host === "openai" ? ["mcp.json"] : [])]) {
    const config = JSON.parse(await readFile(resolve(target, configName), "utf8"));
    config.mcpServers["travel-agent"].url = `${base}/mcp`;
    await writeFile(resolve(target, configName), `${JSON.stringify(config, null, 2)}\n`);
  }
  if (host === "dsh") {
    const patch = resolve(target, "cordis.patch.yml");
    await writeFile(patch, (await readFile(patch, "utf8")).replaceAll("__TRAVEL_MCP_URL__", `${base}/mcp`));
    execFileSync("npm", ["pack", target, "--ignore-scripts", "--pack-destination", resolve("dist-plugins")], { stdio: "pipe" });
  }
  await mkdir(resolve(target, "assets"), { recursive: true });
  const resource = host === "claude" ? "artifact.html" : "workspace.html";
  const page = (await readFile(resolve("dist-mcp", resource), "utf8")).replaceAll("__TRAVEL_PUBLIC_ORIGIN__", base);
  await writeFile(resolve(target, "assets", resource), page);
  const archive = resolve("dist-plugins", `${name}.zip`);
  execFileSync("python3", ["-m", "zipfile", "-c", archive, name], { cwd: resolve("dist-plugins"), stdio: "pipe" });
  process.stdout.write(`${archive}\n`);
}
