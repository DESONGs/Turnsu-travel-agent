import test from "node:test";
import assert from "node:assert/strict";
import { token } from "./fixtures/workspace-grant.mjs";
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
    const opened = await client.callTool({name:"open_travel_workspace", arguments:{}});
    assert.equal(opened._meta?.ui?.resourceUri, resources.resources[0].uri);
    assert.equal(opened._meta["openai/outputTemplate"], opened._meta.ui.resourceUri);
    const actions = await client.callTool({ name: "travel_app_action", arguments: { action: "createConversation", body: {} } });
    assert.equal(actions.isError, undefined);
    const conversationId = actions.structuredContent.conversationId;
    assert.ok(conversationId);
    // The Artifact adapter calls the same tool against the same API, rather than holding its own trip copy.
    const artifact = createMcpTravelClient({ callTool: async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent });
    assert.equal((await artifact.request(`/api/conversations/${conversationId}`)).conversationId, conversationId);
    await service.createTrip({ tripId: "artwork_trip", ownerUserId: "user_one" });
    const requestId = crypto.randomUUID(), artPath = `/api/trips/artwork_trip/artwork/${requestId}`;
    const shapes = [{ depth: 4, points: [[0, .8], [.5, .65], [1, .8], [1, 1], [0, 1]] }];
    await artifact.request(artPath, { method: "POST" });
    const returned = await client.callTool({ name: "return_destination_artwork", arguments: { tripId: "artwork_trip", requestId, artwork: {
      file_id: "file_painted_scene", download_url: "https://example.invalid/unused-sensitive-url",
    }, shapes } });
    assert.equal(returned.isError, undefined);
    assert.deepEqual(await artifact.request(artPath), { status: "ready", fileId: "file_painted_scene", shapes });
    const otherView = await fetch(apiServer.origin + artPath, { headers: { Authorization: `Bearer ${other.access_token}` } });
    assert.equal(otherView.status, 403);
    await artifact.request(artPath, { method: "DELETE" });
    // Two actual trip members exercise the same private page through MCP and HTTP.
    const state = await service.store.get("artwork_trip");
    state.collaboration.memberUserIds.push("user_two");
    await service.store.save(state, { expectedStorageVersion: state.storageVersion });
    const memory = { tripId: "artwork_trip", placeTitle: "黄山", entryId: crypto.randomUUID(), note: "记得山脊上的松树。" };
    const write = input => client.callTool({ name: "write_travel_memory", arguments: input });
    const firstMemory = (await write(memory)).structuredContent;
    assert.equal(firstMemory.visibility, "author_only");
    assert.deepEqual((await write(memory)).structuredContent, firstMemory);
    const memoryPath = "/api/trips/artwork_trip/memories";
    const mine = (await client.callTool({ name: "list_my_travel_memories", arguments: {tripId: memory.tripId} })).structuredContent.entries;
    assert.deepEqual(mine.map(row => row.note), [memory.note]);
    const peerRequest = (path, method = "GET", body) => fetch(apiServer.origin + path, {
      method, headers: {Authorization: "Bearer " + other.access_token, "Content-Type":"application/json"},
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    assert.deepEqual((await (await peerRequest(memoryPath)).json()).entries, []);
    const art = {
      data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==",
      shapes, source: "图像验收"
    };
    const changes = { revision: 1, note: "傍晚的松树。", artwork: art };
    const revise = () => client.callTool({name:"travel_app_action", arguments:{action:"reviseMemory", args:{tripId:memory.tripId,entryId:memory.entryId}, body:changes}});
    assert.equal((await revise()).structuredContent.revision, 2);
    assert.equal((await revise()).structuredContent.revision, 2, "retry of the same illustrated revision is idempotent");
    assert.equal((await write({...memory, revision:1, note:"过期修改"})).isError, true);
    const path = memoryPath + "/" + memory.entryId;
    assert.equal((await peerRequest(path, "POST", changes)).status, 404);
    assert.equal((await peerRequest(path + "/art")).status, 404);
    const sharedPath = "/api/trips/artwork_trip/journal";
    assert.deepEqual((await (await peerRequest(sharedPath)).json()).entries, []);
    assert.equal((await peerRequest(sharedPath + "/" + memory.entryId + "/photos/0")).status, 404);
    await peerRequest(path, "DELETE");
    await peerRequest(sharedPath + "/" + memory.entryId, "DELETE");
    const privateArt = await fetch(apiServer.origin + path + "/art", {headers:{Authorization:"Bearer " + grant.access_token}});
    assert.equal(privateArt.status, 200);
    assert.match(privateArt.headers.get("Cache-Control"), /no-store/);
    const reopened = (await artifact.request(memoryPath)).entries[0];
    assert.equal(reopened.note, changes.note);
    assert.equal(reopened.photos[0].data, undefined);
    assert.equal(reopened.photos[0].digest, undefined);
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
