import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTravelService } from "../../src/api/create-travel-service.mjs";
import { createHttpApp } from "../../src/http/app.mjs";
import { AccountService } from "../../src/http/account-service.mjs";
import { AuthRepository } from "../../src/persistence/auth-repository.mjs";
import { FileConversationRepository, createConversationRecord } from "../../src/persistence/conversation-repository.mjs";
import { createTravelMcpApp, createBackendClient, WORKSPACE_URI } from "../../src/mcp/app-server.mjs";
import { token } from "../fixtures/workspace-grant.mjs";

const place = { nodeId: "huangshan_scenic", title: "黄山风景区", domain: "play", selected: false,
  sourceStatus: "user_input", sourceRefs: [], claimRefs: [],
  location: { coordinates: { longitude: 118.17, latitude: 30.13, coordinateSystem: "WGS-84" } } };
const tripId = "huangshan_ui_test", userId = "journal_tester";
const uiRoot = fileURLToPath(new URL("../../dist-mcp/", import.meta.url));
export const landscape = fileURLToPath(new URL("landscape.png", import.meta.url));

// Only the host shell and drawing provider are doubles. The embedded bundle,
// MCP operations, authenticated HTTP service and trip repository are real.
export async function createJournalHost() {
  const root = await mkdtemp(join(tmpdir(), "travel-journal-browser-"));
  const env = { NODE_ENV: "test", TRAVEL_AGENT_DATA_DIR: root, TRAVEL_AGENT_PUBLIC_ORIGIN: "https://travel.test",
    TRAVEL_AGENT_OPEN_METEO_ENABLED: "false" };
  const account = new AccountService({ repository: new AuthRepository({ filename: ":memory:" }) });
  const service = createTravelService(env, { researchProvider: null, analysisFanout: false });
  const conversations = new FileConversationRepository({ rootDir: join(root, "conversations") });
  await service.createTrip({ tripId, ownerUserId: userId, brief: { destination: "安徽黄山", durationDays: 1, totalBudget: 1200 } });
  const proposal = { schemaVersion: "trip-patch-proposal-v1", proposalId: "huangshan_candidate", tripId, baseRevision: 0,
    writeSet: [place.nodeId], writeContract: { allowedNodeIds: [place.nodeId] }, readSet: [],
    operations: [{ kind: "add_candidate", nodeId: place.nodeId, node: place }], evidence: { sources: [], entities: [], claims: [] } };
  assert.equal((await service.proposeTripChange({ tripId, proposal })).status, "proposed");
  await conversations.create(createConversationRecord({ conversationId: "journal_browser_chat", userId, tripId }));
  const api = createHttpApp({ travelService: service, accountService: account, conversationRepository: conversations, runtimeEnv: env });
  const listener = api.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const origin = "http://127.0.0.1:" + listener.address().port;
  const client = new Client({ name: "journal-browser", version: "1" });
  async function close() {
    await client.close();
    await new Promise(resolve => listener.close(resolve));
    await api.locals.close();
    await account.repository.close();
    await service.store.close?.();
    await rm(root, { recursive: true, force: true });
  }
  try {
    const grant = await token(api.locals.mcpOAuth, userId);
    const backend = createBackendClient({ origin, token: grant.access_token });
    const mcp = createTravelMcpApp({ backend, uiRoot });
    const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(appTransport);
    await client.connect(hostTransport);
    const resource = (await client.readResource({ uri: WORKSPACE_URI })).contents[0].text;
    const image = (await readFile(landscape)).toString("base64");
    const shapes = [{ depth: 3, points: [[0,.65],[.45,.38],[1,.75],[1,1],[0,1]] }];
    return { close, async open(page) {
      await page.exposeFunction("hostCall", async ({ method, params }) => {
        if (method === "tools/call") return client.callTool(params);
        if (method === "ui/initialize") return { hostContext: { theme: "light" }, hostCapabilities: { sampling: {} } };
        if (method === "sampling/createMessage") {
          const depth = params.messages[0].content.some(block => block.text?.includes("Return JSON only"));
          return { role: "assistant", content: depth ? { type: "text", text: JSON.stringify({ shapes }) } :
            { type: "image", mimeType: "image/png", data: image } };
        }
        return {};
      });
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === "/workspace") return route.fulfill({ contentType: "text/html", body: resource });
        if (url.pathname !== "/") return route.abort();
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>*{margin:0}iframe{width:100%;height:100dvh;border:0}</style>
          <iframe title="旅行插件" sandbox="allow-scripts allow-same-origin" src="/workspace?lang=zh"></iframe>
          <script>addEventListener("message", async event => {
            if (event.source !== document.querySelector("iframe").contentWindow || event.origin !== location.origin || !event.data.id) return;
            const {id, method, params} = event.data;
            try {event.source.postMessage({jsonrpc:"2.0", id, result:await window.hostCall({method,params})}, location.origin)}
            catch {event.source.postMessage({jsonrpc:"2.0", id, error:{code:-32000,message:"Test host call failed"}}, location.origin)}
          });</script>` });
      });
      await page.goto(origin);
      return page.frameLocator("iframe");
    }};
  } catch (error) { await close(); throw error; }
}
