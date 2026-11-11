import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { AuthRepository } from "../src/persistence/auth-repository.mjs";
import { AccountService } from "../src/http/account-service.mjs";
import { TravelMcpOAuth } from "../src/mcp/oauth.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { createMcpHttpApp } from "../src/mcp/http-server.mjs";
import { createTravelService } from "../src/api/create-travel-service.mjs";
import { travelOperation } from "../src/mcp/operations.ts";
import { operationForPath, createMcpTravelClient } from "../src/web/travel-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function listen(app) { const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); return { server, origin: `http://127.0.0.1:${server.address().port}` }; }
async function token(oauth, userId, scopes = ["travel:read", "travel:write"]) {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const client = await oauth.registerClient({ client_name: "Workspace test", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  const verifier = "travel_test_verifier_abcdefghijklmnopqrstuvwxyz_123456789";
  let location;
  await oauth.authorize(client, { scopes, redirectUri: redirect, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: new URL(oauth.resource), state: "test_state" }, { redirect: value => { location = value; } });
  const pending = new URL(location).searchParams.get("request");
  const callback = await oauth.approve(pending, { userId, displayName: "Traveler", provider: "google" });
  const code = new URL(callback).searchParams.get("code");
  const tokens = await oauth.exchangeAuthorizationCode(client, code, verifier, redirect, new URL(oauth.resource));
  return { ...tokens, client, verifier, code, redirect };
}

test("OAuth grants persist across server objects, enforce scopes, rotate refresh and revoke a connection", async () => {
  const filename = join(await mkdtemp(join(tmpdir(), "travel-oauth-")), "auth.sqlite");
  const repository = new AuthRepository({ filename });
  const make = () => new TravelMcpOAuth({ repository, origin: "https://travel.test", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
  const oauth = make();
  try {
    const grant = await token(oauth, "user_one", ["travel:read"]);
    assert.equal((await make().session(grant.access_token)).userId, "user_one");
    assert.equal(await oauth.session(grant.access_token, true), null);
    await assert.rejects(oauth.exchangeAuthorizationCode(grant.client, grant.code, grant.verifier, grant.redirect, new URL(oauth.resource)), /authorization_code_invalid/);
    const rotated = await make().exchangeRefreshToken(grant.client, grant.refresh_token, undefined, new URL(oauth.resource));
    assert.equal(await oauth.session(grant.access_token), null);
    await assert.rejects(oauth.exchangeRefreshToken(grant.client, grant.refresh_token, undefined, new URL(oauth.resource)), /refresh_token_invalid/);
    await oauth.revokeToken(grant.client, { token: rotated.access_token });
    assert.equal(await oauth.session(rotated.access_token), null);
    await assert.rejects(oauth.registerClient({ redirect_uris: ["https://evil.test/callback"] }), /redirect_uri_not_allowed/);
  } finally { await repository.close(); }
});

test("MCP App and Artifact transports share real authenticated API state and reject another user's trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "travel-mcp-app-"));
  await writeFile(join(root, "workspace.html"), "<main>Travel workspace</main>"); await writeFile(join(root, "artifact.html"), "<main>Travel artifact</main>");
  const account = new AccountService({ repository: new AuthRepository({ filename: ":memory:" }) });
  const service = createTravelService({ TRAVEL_AGENT_DATA_DIR: join(root, "trips"), TRAVEL_AGENT_OPEN_METEO_ENABLED: "false" }, { researchProvider: null, analysisFanout: false });
  const env = { NODE_ENV: "test", TRAVEL_AGENT_PUBLIC_ORIGIN: "https://travel.test", TRAVEL_AGENT_DATA_DIR: root, TRAVEL_AGENT_OPEN_METEO_ENABLED: "false" };
  const api = createHttpApp({ travelService: service, accountService: account, runtimeEnv: env });
  const apiServer = await listen(api);
  const grant = await token(api.locals.mcpOAuth, "user_one");
  const other = await token(api.locals.mcpOAuth, "user_two");
  const mcpServer = await listen(createMcpHttpApp({ backendOrigin: apiServer.origin, publicOrigin: "https://travel.test", uiRoot: root }));
  const client = new Client({ name: "gpt-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpServer.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${grant.access_token}` } } }));
    const resources = await client.listResources(); assert.equal(resources.resources[0].uri, "ui://travel/workspace.html");
    const actions = await client.callTool({ name: "travel_app_action", arguments: { action: "createConversation", body: {} } });
    assert.equal(actions.isError, undefined);
    assert.deepEqual(actions.structuredContent, { status: "completed" });
    assert.equal(JSON.stringify(actions.content).includes("conversationId"), false);
    const conversationId = actions._meta["travel/uiData"].conversationId;
    assert.ok(conversationId);
    // The Artifact adapter calls the same tool against the same API, rather than holding its own trip copy.
    const artifact = createMcpTravelClient({ callTool: async (name, args) => (await client.callTool({ name, arguments: args }))._meta["travel/uiData"] });
    assert.equal((await artifact.request(`/api/conversations/${conversationId}`)).conversationId, conversationId);
    const workspace = await client.callTool({ name: "get_travel_workspace", arguments: { conversationId } });
    assert.equal(workspace.structuredContent.conversation.conversationId, conversationId);
    const stolen = await fetch(`${apiServer.origin}/api/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${other.access_token}` } });
    assert.equal(stolen.status, 403);
    await service.createTrip({ tripId: "legacy_unowned" });
    const legacy = await fetch(`${apiServer.origin}/api/trips/legacy_unowned/plan`, { headers: { Authorization: `Bearer ${grant.access_token}` } }); assert.equal(legacy.status, 403);
    const denied = await client.callTool({ name: "travel_app_action", arguments: { action: "shell", args: { url: "https://evil.test" } } }); assert.equal(denied.isError, true);
    const noAuth = await fetch(`${mcpServer.origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{}' }); assert.equal(noAuth.status, 401);
  } finally {
    await client.close(); await api.locals.close(); await account.repository.close(); await service.store.close?.();
    mcpServer.server.closeAllConnections(); apiServer.server.closeAllConnections();
    await Promise.all([new Promise(resolve => mcpServer.server.close(resolve)), new Promise(resolve => apiServer.server.close(resolve))]);
  }
});

test("shared UI routes preserve resource identities and never accept arbitrary paths", () => {
  for (const path of ["/api/trips/t1/plan", "/api/trips/t1/transit/n1", "/api/trips/t1/journal/j1/photos/0", "/api/runs/r1?after=7"]) {
    const operation = operationForPath(path); const actual = travelOperation(operation.action, operation.args); assert.equal(actual.path, path);
  }
  assert.throws(() => operationForPath("/api/auth/session", "POST"), /not_allowed/);
  assert.throws(() => travelOperation("plan", { tripId: "../someone" }), /invalid_resource_id/);
});

test('MCP host bridge retains an early tool result and follows host display-mode updates',async()=>{
 const {createMcpHostBridge}=await import('../src/web/host-bridge.js');let receive;const eventSource={addEventListener:(_n,f)=>{receive=f},removeEventListener:()=>{}};const target={postMessage:m=>{if(m.id)queueMicrotask(()=>receive({source:target,data:{jsonrpc:'2.0',id:m.id,result:m.method==='ui/initialize'?{hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}}:m.method==='ui/request-display-mode'?{mode:m.params.mode}:{}}}))}};const bridge=createMcpHostBridge({target,eventSource});try{await bridge.initialize();receive({source:target,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{conversationId:'saved-trip'}}}});let value;bridge.onResult(v=>{value=v});assert.equal(value.conversationId,'saved-trip');let context;bridge.onContext(v=>{context=v});assert.equal(context.displayMode,'inline');await bridge.requestDisplayMode('fullscreen');assert.equal(context.displayMode,'fullscreen');}finally{bridge.dispose()}
});

test('Codex DCR accepts a variable loopback port while preserving exact callback paths and token redirects',async()=>{
 const repository=new AuthRepository({filename:':memory:'});const oauth=new TravelMcpOAuth({repository,origin:'https://travel.test',redirectUris:['http://127.0.0.1/callback']});try{const redirect='http://127.0.0.1:39871/callback';const c=await oauth.registerClient({redirect_uris:[redirect]});assert.ok(c.client_id);for(const uri of ['http://127.0.0.1:39871/callback/evil','http://127.0.0.1:39871/callback?next=evil','http://127.0.0.2:39871/callback','http://localhost:39871/callback','http://user@127.0.0.1:39871/callback','https://evil.test/callback'])await assert.rejects(oauth.registerClient({redirect_uris:[uri]}),/redirect_uri_not_allowed/);const verifier='fixture-verifier-abcdefghijklmnopqrstuvwxyz-123456789';let consent;await oauth.authorize(c,{redirectUri:redirect,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),resource:new URL(oauth.resource),scopes:['travel:read'],state:'fixture'}, {redirect:v=>{consent=v}});const callback=new URL(await oauth.approve(new URL(consent).searchParams.get('request'),{userId:'fixture-owner',provider:'google'}));assert.equal(callback.origin,'http://127.0.0.1:39871');assert.equal(callback.searchParams.get('iss'),'https://travel.test/');const grant=await oauth.exchangeAuthorizationCode(c,callback.searchParams.get('code'),verifier,redirect,new URL(oauth.resource));assert.equal((await oauth.session(grant.access_token)).userId,'fixture-owner');}finally{await repository.close()}
});

test("the shared host operation contract bundles and executes in a browser without Node builtins", async () => {
  const { build } = await import("vite"), { runInNewContext } = await import("node:vm");
  const result = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false, target: "es2022", lib: { entry: new URL("../src/mcp/operations.ts", import.meta.url).pathname, name: "TravelOperations", formats: ["iife"] } } });
  const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output;
  const contract = runInNewContext(output.find(item => item.type === "chunk").code + ";TravelOperations;", {});
  const read = contract.travelOperation("workspace", { tripId: "trip_browser", tool: "list_trip_journal" });
  assert.equal(read.path, "/api/trips/trip_browser/workspace/list_trip_journal"); assert.equal(read.scope, "travel:read");
  assert.equal(contract.travelOperation("workspace", { tripId: "trip_browser", tool: "save_trip_photo_relief" }).scope, "travel:write");
  assert.throws(() => contract.travelOperation("workspace", { tripId: "trip_browser", tool: "shell" }), /workspace_operation_not_allowed/);
});
