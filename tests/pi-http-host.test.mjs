import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TravelService } from "../src/api/travel-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { InMemorySessionStore } from "../src/http/session.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { createTravelHttpTools, travelHttpToolsFromEnv } from "../travel-agent-pi-package/src/host/travel-http-tools.ts";
import { registerTravelBusinessRuntime } from "../travel-agent-pi-package/extensions/travel-business-runtime.ts";

async function fixture(t, researchProvider) {
  const dir = await mkdtemp(join(tmpdir(), "travel-pi-http-test-"));
  const service = new TravelService({ store: new TripStore({ rootDir: join(dir, "trips") }), researchProvider });
  const sessions = new InMemorySessionStore();
  const owner = await sessions.issue({ userId: "host_owner", provider: "google" });
  const other = await sessions.issue({ userId: "host_other", provider: "google" });
  const app = createHttpApp({ travelService: service, sessionStore: sessions,
    conversationRepository: new FileConversationRepository({ rootDir: join(dir, "conversations") }),
    runtimeEnv: { NODE_ENV: "test", TRAVEL_AGENT_DATA_DIR: dir },
  });
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await app.locals.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { service, baseUrl, token: owner.opaqueToken,
    host: createTravelHttpTools({ baseUrl, accessToken: owner.opaqueToken }),
    other: createTravelHttpTools({ baseUrl, accessToken: other.opaqueToken }),
  };
}

test("Pi HTTP tools share API ownership and state, reject cross-trip access and require real confirmation", async (t) => {
  const { host, other, service, baseUrl, token } = await fixture(t);
  const trip = await host.invoke("create_trip", { tripId: "model_owned_id", ownerUserId: "host_other", brief: { destination: "杭州" } });
  assert.notEqual(trip.tripId, "model_owned_id");
  const stored = await service.store.get(trip.tripId);
  assert.deepEqual(stored.collaboration.memberUserIds, ["host_owner"]);
  await host.invoke("update_trip_scope", { tripId: trip.tripId, brief: { totalBudget: 6000 } });
  assert.equal((await service.getTripControlView(trip.tripId)).brief.totalBudget, 6000);
  for (const tool of ["get_trip_control_view", "update_trip_scope", "research_trip_options", "plan_itinerary_trial"]) {
    await assert.rejects(other.invoke(tool, { tripId: trip.tripId, brief: { destination: "被篡改" } }), { code: "trip_access_denied" });
  }
  await assert.rejects(host.invoke("bash", { tripId: trip.tripId }), { code: "travel_host_tool_not_allowed" });
  const alien = await other.invoke("create_trip", { brief: { destination: "苏州" } });
  const response = await fetch(`${baseUrl}/api/trips/${trip.tripId}/feedback`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tripId: alien.tripId, baseRevision: 0, category: "personal_experience", text: "访问记录", visibility: "trip_only" }),
  });
  assert.notEqual(response.status, 403);
  assert.equal((await service.getTripControlView(alien.tripId)).revision, 0, "body tripId must not redirect a write to another tenant");

  const tools = [];
  let apiCalls = 0;
  registerTravelBusinessRuntime({ registerTool: (tool) => tools.push(tool) }, { host: { invoke: async () => { apiCalls++; return { status: "committed" }; } } });
  const accept = tools.find((tool) => tool.name === "accept_trip_change");
  const args = { tripId: trip.tripId, proposalId: "proposal_x" };
  const absent = await accept.execute("call_1", args, undefined, undefined, { hasUI: false });
  const denied = await accept.execute("call_2", args, undefined, undefined, { hasUI: true, ui: { confirm: async () => false } });
  assert.equal(absent.isError, true); assert.equal(denied.isError, true); assert.equal(apiCalls, 0);
  const confirmed = await accept.execute("call_3", args, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
  assert.equal(confirmed.details.status, "committed"); assert.equal(apiCalls, 1);
});

test("cancelling an HTTP research discards provider results before a proposal is persisted", async (t) => {
  let started;
  let release;
  let providerSignal;
  const entered = new Promise((done) => { started = done; });
  const held = new Promise((done) => { release = done; });
  const { host, service } = await fixture(t, { status: "configured", async research({ signal }) {
    providerSignal = signal; started(); await held;
    return { status: "completed", byDomain: { play: [{ candidateId: "play_fixture", domain: "play", title: "fixture", sourceStatus: "verified" }] }, fabricatedResults: false };
  } });
  const trip = await host.invoke("create_trip", { brief: { destination: "杭州" } });
  const controller = new AbortController();
  const running = host.invoke("research_trip_options", { tripId: trip.tripId, domains: ["play"] }, controller.signal);
  await entered;
  const rejected = assert.rejects(running, { code: "travel_request_cancelled" });
  controller.abort(); await rejected;
  if (!providerSignal.aborted) await once(providerSignal, "abort");
  assert.equal(providerSignal.aborted, true);
  release();
  // Flush the held provider continuation, not an arbitrary wall-clock sleep.
  await new Promise((done) => setImmediate(done));
  assert.equal((await service.getTripControlView(trip.tripId)).pendingProposals.length, 0);
});

test("host transport fails closed on missing auth, unsafe origins, redirects and oversized output", async () => {
  assert.throws(() => travelHttpToolsFromEnv({ TRAVEL_AGENT_PI_MODE: "api" }), { code: "travel_api_session_required" });
  assert.throws(() => createTravelHttpTools({ baseUrl: "http://example.com", accessToken: "secret" }), { code: "invalid_travel_api_origin" });
  const host = createTravelHttpTools({ baseUrl: "https://example.com", accessToken: "secret", fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, "error");
    return new Response("x".repeat(2_000_001));
  } });
  await assert.rejects(host.invoke("get_trip_control_view", { tripId: "trip_x" }), { code: "travel_api_response_too_large" });
});
