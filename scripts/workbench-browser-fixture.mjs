import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../plugins/travel-agent-openai/workbench/node_modules/vite/dist/node/index.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(resolve(tmpdir(), "travel-browser-fixture-"));
await build({ configFile: false, root: resolve(root, "plugins/travel-agent-openai/workbench"),
  build: { outDir: temporary, emptyOutDir: false, lib: { entry: resolve(root, "plugins/travel-agent-openai/workbench/tests/browser-host.js"), formats: ["es"], fileName: () => "host.js" }, rolldownOptions: { output: { codeSplitting: false } } } });
const html = `<!doctype html><meta charset="utf-8"><title>Travel protocol validation</title><style>body{margin:0;font:14px sans-serif}nav{padding:10px;background:#eef;display:flex;gap:8px;flex-wrap:wrap}iframe{width:100%;height:1200px;border:0}</style><nav><strong>隔离协议夹具：账号 <span id="actor">A</span></strong><button id="switch">切换账号 B</button><button id="restore">恢复账号 A</button><button id="open">打开旅行 A</button><button id="link">关联旅行 A 对话</button><button id="revoke">撤销访问</button><button id="file-a">暂缓打开文件 A</button><button id="file-b">打开文件 B</button><button id="release">释放文件 A</button><span>发送数 <output id="sent">0</output> · 合成资料，无真实登录或来源</span></nav><iframe title="旅行工作台"></iframe><script type="module" src="/host.js"></script>`;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const file = url.pathname === "/host.js" ? resolve(temporary, "host.js") : url.pathname === "/app.html"
      ? resolve(root, "plugins/travel-agent-openai/workbench/dist/" + (url.searchParams.get("host") === "mcp" ? "mcp" : "codex") + ".html") : null;
    response.setHeader("Content-Type", url.pathname === "/host.js" ? "application/javascript" : "text/html; charset=utf-8");
    if (url.pathname === "/" || file) response.end(file ? await readFile(file) : html);
    else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 500; response.end("Build both workbench pages first."); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`TRAVEL_BROWSER_FIXTURE=http://127.0.0.1:${server.address().port}/\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(async () => { await rm(temporary, { recursive: true, force: true }); process.exit(0); }));
