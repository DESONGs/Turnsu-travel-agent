import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { build } from "../plugins/travel-agent-openai/workbench/node_modules/vite/dist/node/index.js";
const path = process.argv[2];
if (!path) throw new Error("Provide the private connection.json printed by the isolated Java browser fixture.");
const connection = JSON.parse(await readFile(path, "utf8")), origin = new URL(connection.mcpUrl);
if (connection.format !== "travel-service-browser-fixture-v1" || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/mcp") throw new Error("Only the loopback Java test fixture is accepted");
const directory = dirname(resolve(path)), root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(resolve(tmpdir(), "travel-service-host-"));
await build({ configFile: false, root: resolve(root, "plugins/travel-agent-openai/workbench"), build: { outDir: temporary, emptyOutDir: false,
  lib: { entry: resolve(root, "plugins/travel-agent-openai/workbench/tests/service-host.js"), formats: ["es"], fileName: () => "host.js" }, rolldownOptions: { output: { codeSplitting: false } } } });
let requestId = 0;
async function rpc(method, params, peer = false) {
  const response = await fetch(origin, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + (peer ? connection.peerBearer : connection.bearer) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Isolated Java service is unavailable");
  const value = await response.json(); if (value.error) throw new Error("Isolated MCP request failed"); return value.result;
}
const html = `<!doctype html><meta charset="utf-8"><title>Travel service acceptance</title><style>body{margin:0;font:14px sans-serif;display:flex;flex-direction:column;height:100dvh}nav{padding:10px;background:#eef;display:flex;gap:12px;align-items:center;flex-wrap:wrap}iframe{width:100%;flex:1;min-height:0;border:0}</style><nav><strong>隔离验收：真实 Java／MCP／PostgreSQL，合成账号和旅行来源</strong><a href="/">拥有者测试账号</a><a href="/?account=peer">共享测试账号</a><button id="baseline">模拟天气基准</button><button id="rain">模拟天气变化</button><output id="control-status">没有真实 Google 登录或上游来源</output></nav><iframe title="旅行工作台"></iframe><script type="module" src="/host.js"></script>`;
const body = async request => { let text = ""; for await (const part of request) { text += part; if (text.length > 5000000) throw new Error("Request too large"); } return JSON.parse(text); };
const server = createServer(async (request, response) => {
  try {
    if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${server.address().port}`) { response.writeHead(403).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); }
    else if (url.pathname === "/host.js") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(resolve(temporary, "host.js"))); }
    else if (url.pathname === "/app.html") { const result = await rpc("resources/read", { uri: connection.uiUri }); response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(result.contents.find(item => item.uri === connection.uiUri).text); }
    else if (url.pathname === "/fixture-context") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ tripId: connection.tripId })); }
    else if (url.pathname === "/rpc" && request.method === "POST") {
      const input = await body(request); if (!["tools/call", "resources/read"].includes(input.method)) throw new Error("Unsupported test RPC");
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(await rpc(input.method, input.params, input.peer === true && Boolean(connection.peerBearer))));
    } else if (url.pathname === "/fixture-control" && request.method === "POST") {
      const { action } = await body(request); if (!["baseline", "rain"].includes(action)) throw new Error("Unsupported fixture action");
      const id = randomUUID(), commandPath = resolve(directory, "command.json");
      await writeFile(commandPath + ".pending", JSON.stringify({ id, action }), { mode: 0o600 });
      await rename(commandPath + ".pending", commandPath);
      const deadline = Date.now() + 20000; let ready = false;
      while (Date.now() < deadline) {
        try { const result = JSON.parse(await readFile(resolve(directory, "result.json"), "utf8")); if (result.id === id && result.ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error("Fixture control did not finish"); response.end("ok");
    } else response.writeHead(404).end();
  } catch { response.writeHead(503).end("The isolated fixture is unavailable; no production action was performed."); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`TRAVEL_SERVICE_BROWSER=http://127.0.0.1:${server.address().port}/\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(async () => { await rm(temporary, { recursive: true, force: true }); process.exit(0); }));
