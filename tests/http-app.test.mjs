import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { FileConversationRepository, createConversationRecord } from "../src/persistence/conversation-repository.mjs";
import { InMemorySessionStore } from "../src/http/session.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";

async function httpFixture({ conversationAgent, service: suppliedService, conversationRepository: suppliedConversationRepository } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-http-"));
  const store = new TripStore({ rootDir });
  store.mode = "file";
  const clock = () => new Date("2026-08-24T12:00:00.000Z");
  const service = suppliedService ?? new TravelService({ store, clock });
  const conversationRepository = suppliedConversationRepository ?? new FileConversationRepository({ rootDir: join(rootDir, "conversations") });
  const app = createHttpApp({ travelService: service, conversationRepository, conversationAgent, sessionStore: new InMemorySessionStore({ clock }), developmentAuthEnabled: true, runtimeEnv: { NODE_ENV: "test", TRAVEL_AGENT_EVIDENCE_DATA_DIR: join(rootDir, "evidence-presentations") }, clock });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const request = async (path, { method = "GET", body, token, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const value = response.status === 204 ? null : await response.json();
    return { response, value };
  };
  return { request, service, conversationRepository, close: async () => { await app.locals.close(); await new Promise((resolveClose) => server.close(resolveClose)); } };
}

function transitProposal(tripId) {
  return {
    schemaVersion: "trip-patch-proposal-v1",
    proposalId: "proposal_transit_http",
    tripId,
    baseRevision: 0,
    writeSet: ["transport_http"],
    writeContract: { allowedNodeIds: ["transport_http"] },
    readSet: [],
    operations: [{
      kind: "add_candidate",
      nodeId: "transport_http",
      node: {
        nodeId: "transport_http",
        domain: "transport",
        title: "从酒店前往外滩",
        selected: true,
        sourceStatus: "user_input",
        sourceRefs: ["amap_web_service:transport_http"],
        claimRefs: ["claim_transport_http"],
        operability: {
          transitSegment: {
            segmentId: "segment_http",
            status: "needs_refresh",
            originLabel: "酒店",
            destinationLabel: "外滩",
            totalMinutes: 25,
            source: "user_input",
            travelerFit: { summary: "适合行李与长辈同行", tradeoff: "比最快路线慢 4 分钟", stepFree: true },
            steps: [
              { kind: "walk", title: "步行至 2 号口", durationMinutes: 8 },
              { kind: "enter_station", title: "2 号口进站", accessible: true, facilities: [{ kind: "elevator", area: "outside_station", label: "2号口电梯", source: "user_input" }] },
              { kind: "ride", title: "乘坐地铁 10 号线", durationMinutes: 8, line: "10号线", direction: "待实时核验" },
              { kind: "exit_station", title: "1 号口出站", facilities: [{ kind: "toilet", area: "paid_area", label: "站内卫生间", source: "user_input" }, { kind: "locker", area: "outside_station", label: "1号口寄存柜", source: "user_input" }] },
              { kind: "arrive", title: "步行抵达外滩", durationMinutes: 5, facilities: [{ kind: "power_bank", area: "outside_station", label: "2号口外充电宝", source: "user_input" }] },
            ],
          },
        },
      },
    }],
    evidenceBundle: {
      contentItems: [{ contentItemId: "amap_web_service:transport_http", provider: "amap_web_service", sourceType: "official_map_provider", providerRef: "transport_http", checkedAt: "2026-08-24T12:00:00.000Z", documentationUrl: "https://lbs.amap.com/", independenceGroup: "amap_transport_http", commercialBias: "provider_ranking_unknown", title: "从酒店前往外滩", originalLanguage: "zh-CN", access: "public" }],
      entities: [{ entityId: "entity_transport_http", kind: "route", canonicalName: "酒店至外滩", providerRefs: ["amap_web_service:transport_http"] }],
      claims: [{ claimId: "claim_transport_http", entityId: "entity_transport_http", nodeId: "transport_http", kind: "route", statement: "路线需要在出发前重新核验。", sourceRefs: ["amap_web_service:transport_http"], sourceIndependence: "official_provider", commercialBias: "provider_ranking_unknown", confidence: 0.9 }],
    },
  };
}

function httpNaturalProvider() {
  const checkedAt = "2026-08-26T11:00:00.000Z";
  const candidate = (domain, candidateId, title, location, operability = {}) => ({ candidateId, domain, title, summary: `${title} · ${checkedAt} 核验`, checkedAt, location, operability: { provider: "http_fixture", ...operability } });
  return {
    status: "configured",
    research: async ({ domains }) => ({ status: "completed", provider: "http_fixture", providerLabel: "HTTP Fixture", checkedAt, byDomain: { play: domains.includes("play") ? [candidate("play", "play_http", "上海市历史博物馆", { coordinates: { longitude: 121.47, latitude: 31.235 } })] : [], food: domains.includes("food") ? [candidate("food", "food_http", "本帮菜馆", { coordinates: { longitude: 121.48, latitude: 31.236 } })] : [], stay: domains.includes("stay") ? [candidate("stay", "stay_http", "全季酒店（上海人民广场南京路步行街店）", { address: "福建中路225号" }, { inventoryVerified: true })] : [], transport: domains.includes("transport") ? [candidate("transport", "transport_http_inventory", "动态航班库存对照", null, { mobilityRole: "intercity_inventory", transportType: "FLIGHT" })] : [] }, partial: false, weather: { status: "SOURCE_UNAVAILABLE" }, caveats: [], fabricatedResults: false }),
    planMobility: async ({ selectedNodes }) => {
      const arrival = selectedNodes.find((node) => node.operability?.mobilityRole === "user_confirmed_arrival");
      const stay = selectedNodes.find((node) => node.domain === "stay");
      return { schemaVersion: "trip-mobility-v1", status: "completed", destination: "上海", source: "amap_routes_v5", checkedAt, freshUntil: "2026-08-26T14:00:00.000Z", coverage: { routedNodeIds: [arrival.nodeId, stay.nodeId], unresolvedNodeIds: [], unscheduled: false }, legs: [{ legId: "http_arrival_stay", origin: { nodeId: arrival.nodeId, label: "浦东机场 T2", coordinates: { longitude: 121.8079, latitude: 31.1528 } }, destination: { nodeId: stay.nodeId, label: stay.title, coordinates: { longitude: 121.4804, latitude: 31.2382 } }, recommendedMode: "taxi", rationale: "公交步行 1128 米，超过当前 600 米目标；公交需换乘 2 次，超过当前 1 次目标。打车约 52 分钟、步行 0 米、换乘 0 次，因此优先打车。电梯与连续无台阶状态仍待核验；该未知项不是本次推荐打车的直接触发条件。", recommendationAudit: { thresholds: { walkingMeters: 600, transfers: 1, walkingSource: "traveler_explicit", transferSource: "reduced_mobility_default" }, transit: { totalMinutes: 163, walkingMeters: 1128, transfers: 2, estimatedFareCny: 26, walkingExceeded: true, transfersExceeded: true, hasStairs: false, hasEscalator: true, stepFreeContinuity: "not_verified" }, taxi: { totalMinutes: 52, walkingMeters: 0, transfers: 0, estimatedFareCny: 151 }, triggers: ["transit_walking_exceeds_target", "transit_transfers_exceed_target"], accessibilityEvidence: { status: "not_verified", directTrigger: false } }, alternatives: [{ mode: "transit", totalMinutes: 163, walkingMeters: 1128, transfers: 2, estimatedFareCny: 26, scheduleBasis: "scheduled_service", realTimeArrival: false, navigationUrl: "https://uri.amap.com/navigation?mode=bus", polyline: [], steps: [] }, { mode: "taxi", totalMinutes: 52, walkingMeters: 0, transfers: 0, estimatedFareCny: 151, scheduleBasis: "query_time_estimate", realTimeArrival: false, navigationUrl: "https://uri.amap.com/navigation?mode=car", polyline: [], steps: [] }] }], travelerFit: { constrainedTravelerIds: ["traveler_2"], maxContinuousWalkMeters: 600, planningWalkingTarget: 600, planningTransferTarget: 1, walkingTargetSource: "traveler_explicit", transferTargetSource: "reduced_mobility_default", avoidStairs: true, accessibilityEvidence: "unverified" }, reason: null, caveats: [], sourceDocumentation: "https://lbs.amap.com/api/webservice/guide/api/newroute", fabricatedResults: false };
    },
  };
}

function httpLatestToolJson(context) {
  for (const message of [...context.messages].reverse()) {
    for (const item of Array.isArray(message.content) ? message.content : []) {
      if (typeof item?.text !== "string" || !item.text.trim().startsWith("{")) continue;
      try { return JSON.parse(item.text); } catch { /* continue */ }
    }
  }
  return null;
}

test("HTTP API authenticates development sessions, enforces trip membership, and serves accepted transit details", async () => {
  const { request, close } = await httpFixture();
  try {
    const firstSession = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "owner@example.com" } });
    assert.equal(firstSession.response.status, 201);
    const ownerToken = firstSession.value.accessToken;

    const created = await request("/api/trips", { method: "POST", token: ownerToken, body: { tripId: "trip_http", brief: { destination: "上海", dates: "2026-10-02–06" }, travelers: [{ travelerId: "traveler_1" }] } });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.tripId, "trip_http");

    const proposal = transitProposal("trip_http");
    const staged = await request("/api/trips/trip_http/proposals", { method: "POST", token: ownerToken, body: { proposal } });
    assert.equal(staged.value.status, "proposed");
    const accepted = await request("/api/trips/trip_http/proposals/proposal_transit_http/accept", { method: "POST", token: ownerToken });
    assert.equal(accepted.value.status, "committed");

    const transit = await request("/api/trips/trip_http/transit/transport_http", { token: ownerToken });
    assert.equal(transit.response.status, 200);
    assert.equal(transit.value.segment.destinationLabel, "外滩");
    assert.equal(transit.value.segment.steps[1].facilities[0].label, "2号口电梯");
    assert.equal(transit.value.segment.steps[3].facilities[0].area, "paid_area");
    const plan = await request("/api/trips/trip_http/plan", { token: ownerToken });
    assert.equal(plan.response.status, 200);
    assert.equal(plan.value.transitSegments[0].nodeId, "transport_http");
    assert.equal(plan.value.transitSegments[0].segment.segmentId, "segment_http");
    assert.equal(plan.value.transitSegments[0].segment.steps[0].detail, null);
    const evidence = await request("/api/trips/trip_http/evidence/nodes/transport_http?targetLanguage=zh-CN", { token: ownerToken });
    assert.equal(evidence.response.status, 200);
    assert.equal(evidence.value.schemaVersion, "evidence-presentation-bundle-v1");
    assert.equal(evidence.value.claimGroups[0].claimRefs[0], "claim_transport_http");
    const mobility = await request("/api/trips/trip_http/mobility/refresh", { method: "POST", token: ownerToken });
    assert.equal(mobility.response.status, 200);
    assert.equal(mobility.value.status, "provider_unavailable");
    assert.equal(mobility.value.fabricatedResults, false);
    const currentPlan = await request("/api/trips/trip_http/plan", { token: ownerToken });
    const feedback = await request("/api/trips/trip_http/feedback", { method: "POST", token: ownerToken, body: { baseRevision: currentPlan.value.revision, category: "personal_experience", nodeId: "transport_http", text: "换乘指引清楚，带行李也比较从容。", visibility: "anonymous_travelers", verdict: "recommend", tags: ["comfortable_pace"] } });
    assert.equal(feedback.response.status, 201);
    assert.equal(feedback.value.status, "committed");
    const planWithFeedback = await request("/api/trips/trip_http/plan", { token: ownerToken });
    assert.equal(planWithFeedback.value.byDomain.transport[0].visitFeedback.experienceCount, 1);
    assert.equal(planWithFeedback.value.byDomain.transport[0].visitFeedback.topTags[0].key, "comfortable_pace");

    const secondSession = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "other@example.com" } });
    const strangerTrips = await request("/api/trips", { token: secondSession.value.accessToken });
    assert.deepEqual(strangerTrips.value.trips, []);
    const denied = await request("/api/trips/trip_http/plan", { token: secondSession.value.accessToken });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.value.code, "trip_access_denied");
  } finally {
    await close();
  }
});

test("HTTP conversation entrypoint preserves the user request but never fabricates an Agent reply without a configured model", async () => {
  const { request, close } = await httpFixture();
  try {
    const session = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "chat@example.com" } });
    const token = session.value.accessToken;
    const conversation = await request("/api/conversations", { method: "POST", token, body: { modelId: "kimi-k3" } });
    assert.equal(conversation.response.status, 201);
    assert.equal(conversation.value.modelId, "kimi-k3");

    const turn = await request(`/api/conversations/${conversation.value.conversationId}/messages`, { method: "POST", token, body: { text: "国庆和父母去大理五天，轻松一点", modelId: "kimi-k3" } });
    assert.equal(turn.response.status, 200);
    assert.equal(turn.value.status, "agent_unavailable");
    assert.equal(turn.value.configuration.code, "model_credentials_not_configured");
    assert.equal(turn.value.conversation.modelId, "kimi-k3");
    assert.equal(turn.value.conversation.tripId, null);
    assert.equal(turn.value.conversation.messages[0].role, "user");
    assert.equal(turn.value.conversation.messages[1].role, "status");
    assert.match(turn.value.conversation.messages[1].text, /服务恢复后可以从这里继续/);

    const unsupported = await request("/api/conversations", { method: "POST", token, body: { modelId: "kimi-k2.7-code" } });
    assert.equal(unsupported.response.status, 400);
    assert.equal(unsupported.value.code, "model_selection_unsupported");

    const other = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "chat-other@example.com" } });
    const denied = await request(`/api/conversations/${conversation.value.conversationId}`, { token: other.value.accessToken });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.value.code, "conversation_access_denied");
  } finally {
    await close();
  }
});

test("conversation management soft-deletes and restores a conversation without deleting its linked trip", async () => {
  const { request, close } = await httpFixture();
  try {
    const session = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "conversation-manager@example.com" } });
    const token = session.value.accessToken;
    const trip = await request("/api/trips", { method: "POST", token, body: { tripId: "trip_conversation_management", brief: { destination: "上海" }, travelers: [{ travelerId: "traveler_1" }] } });
    assert.equal(trip.response.status, 201);
    const first = await request("/api/conversations", { method: "POST", token, body: { tripId: trip.value.tripId } });
    const second = await request("/api/conversations", { method: "POST", token, body: {} });
    const before = await request("/api/conversations", { token });
    assert.equal(before.value.conversations.length, 2);

    const removed = await request(`/api/conversations/${first.value.conversationId}`, { method: "DELETE", token });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.value.status, "deleted");
    assert.equal(removed.value.tripPreserved, true);
    assert.ok(removed.value.conversation.deletedAt);
    const hidden = await request(`/api/conversations/${first.value.conversationId}`, { token });
    assert.equal(hidden.response.status, 404);
    const active = await request("/api/conversations", { token });
    assert.deepEqual(active.value.conversations.map((item) => item.conversationId), [second.value.conversationId]);
    const withDeleted = await request("/api/conversations?includeDeleted=true", { token });
    assert.equal(withDeleted.value.conversations.length, 2);
    assert.equal(withDeleted.value.conversations.find((item) => item.conversationId === first.value.conversationId).deletedAt != null, true);
    const preservedTrip = await request(`/api/trips/${trip.value.tripId}/control`, { token });
    assert.equal(preservedTrip.response.status, 200);

    const restored = await request(`/api/conversations/${first.value.conversationId}/restore`, { method: "POST", token });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.value.status, "restored");
    assert.equal(restored.value.conversation.deletedAt, null);
    const after = await request("/api/conversations", { token });
    assert.equal(after.value.conversations.length, 2);
  } finally {
    await close();
  }
});

test("HTTP natural conversation keeps stay-only confirmation, TripState and route explanation consistent", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-http-natural-confirm-"));
  const tripStore = new TripStore({ rootDir: join(rootDir, "trips") });
  tripStore.mode = "file";
  const clock = () => new Date("2026-08-26T11:00:00.000Z");
  const service = new TravelService({ store: tripStore, clock, researchProvider: httpNaturalProvider() });
  const conversationRepository = new FileConversationRepository({ rootDir: join(rootDir, "conversations") });
  const faux = fauxProvider({ provider: "http-fixture-pi", models: [{ id: "fixture-parent" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const conversationAgent = new TravelConversationAgent({ travelService: service, conversationRepository, modelRuntime: { models, model: faux.getModel("fixture-parent") }, clock });
  const { request, close } = await httpFixture({ service, conversationRepository, conversationAgent });
  try {
    const session = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "natural-confirm@example.com" } });
    const token = session.value.accessToken;
    const conversation = await request("/api/conversations", { method: "POST", token, body: { modelId: "deepseek-v4-flash" } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "上海", dates: "2026-08-27 至 2026-08-29", origin: "广州", arrivalAirport: "浦东机场", arrivalTerminal: "T2", arrivalTime: "14:00", travelerCount: 3, lodgingPreference: "人民广场或南京东路", totalBudget: 8000, travelerProfiles: [{ displayName: "你" }, { displayName: "父亲", relationship: "父亲", careNeeds: { mobility: { maxContinuousWalkMeters: 600, avoidStairs: true } } }, { displayName: "母亲" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("research_trip_options", { domains: ["play", "food", "stay", "transport"], question: "先给候选，不替我确认" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("候选已出现，尚未确认。"),
    ]);
    const first = await request(`/api/conversations/${conversation.value.conversationId}/messages`, { method: "POST", token, body: { text: "8月27日至29日和父母从广州飞上海，14:00到浦东T2；父亲步行不超过600米并避开楼梯；先给候选，不替我确认。" } });
    assert.equal(first.value.status, "completed");
    const tripId = first.value.tripId;

    faux.setResponses([fauxAssistantMessage(fauxToolCall("confirm_user_arrival", { airport: "浦东机场", terminal: "T2", time: "14:00", intercityBooked: true, explicitUserConfirmation: true }), { stopReason: "toolUse" }), fauxAssistantMessage("已记录。")]);
    await request(`/api/conversations/${conversation.value.conversationId}/messages`, { method: "POST", token, body: { text: "机票已经买好，以14:00浦东T2为事实，不选库存航班。" } });

    const beforePreview = await request(`/api/trips/${tripId}/plan`, { token });
    const previewSelections = Object.fromEntries(["stay", "play", "food"].map((domain) => [domain, beforePreview.value.pendingProposals[0].byDomain[domain][0].nodeId]));
    const routePreview = await request(`/api/trips/${tripId}/mobility/preview`, { method: "POST", token, body: { baseRevision: beforePreview.value.revision, selections: previewSelections } });
    assert.equal(routePreview.response.status, 200);
    assert.equal(routePreview.value.committed, false);
    assert.equal(routePreview.value.impact.stopCount, 4);
    const afterPreview = await request(`/api/trips/${tripId}/plan`, { token });
    assert.equal(afterPreview.value.byDomain.stay.some((node) => node.selected), false, "HTTP route preview must not commit a tentative hotel");
    assert.equal(afterPreview.value.mobility, null, "HTTP route preview must not persist route observations");

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_trip_plan_view", {}), { stopReason: "toolUse" }),
      (context) => {
        const plan = httpLatestToolJson(context);
        return fauxAssistantMessage(fauxToolCall("confirm_trip_selection", { domain: "stay", nodeId: plan.pendingProposals[0].domains.stay.options[0].nodeId, explicitUserConfirmation: true }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("住宿已经锁定。"),
    ]);
    const confirmed = await request(`/api/conversations/${conversation.value.conversationId}/messages`, { method: "POST", token, body: { text: "选择全季酒店（上海人民广场南京路步行街店）为住宿锚点，只确认住宿，吃玩暂不确认；立即核验机场到酒店。" } });
    assert.equal(confirmed.response.status, 200);
    assert.match(confirmed.value.conversation.messages.at(-1).text, /已只确认住宿/);
    assert.match(confirmed.value.conversation.messages.at(-1).text, /1128 米/);

    const plan = await request(`/api/trips/${tripId}/plan`, { token });
    assert.equal(plan.value.byDomain.stay.filter((node) => node.selected).length, 1);
    assert.equal(plan.value.byDomain.play.filter((node) => node.selected).length, 0);
    assert.equal(plan.value.byDomain.food.filter((node) => node.selected).length, 0);
    assert.equal(plan.value.pendingProposals[0].byDomain.play.length, 1);
    assert.equal(plan.value.pendingProposals[0].byDomain.food.length, 1);
    assert.equal(plan.value.pendingProposals[0].byDomain.stay.length, 0);
    assert.equal(plan.value.mobility.legs[0].origin.label, "浦东机场 T2");
    assert.equal(plan.value.mobility.legs[0].destination.nodeId, plan.value.byDomain.stay.find((node) => node.selected).nodeId);
    const control = await request(`/api/trips/${tripId}/control`, { token });
    assert.deepEqual(control.value.openDecisions.map((decision) => decision.domain).sort(), ["food", "play"]);
  } finally {
    await close();
  }
});

test("HTTP API does not issue a development session when provider callbacks are not configured", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-http-auth-"));
  const store = new TripStore({ rootDir });
  store.mode = "file";
  const app = createHttpApp({ travelService: new TravelService({ store }), developmentAuthEnabled: false });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email_otp", identity: "ignored" }) });
    const value = await response.json();
    assert.equal(response.status, 503);
    assert.equal(value.code, "auth_provider_not_configured");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("default file repositories keep trips and conversations under the configured data root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-http-shared-root-"));
  const app = createHttpApp({
    developmentAuthEnabled: true,
    runtimeEnv: {
      NODE_ENV: "development",
      TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH: "true",
      TRAVEL_AGENT_DATA_DIR: rootDir,
    },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email_otp", identity: "shared-root@example.com" }) });
    const session = await sessionResponse.json();
    const headers = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
    const tripResponse = await fetch(`http://127.0.0.1:${port}/api/trips`, { method: "POST", headers, body: JSON.stringify({ tripId: "trip_shared_root", brief: { destination: "大理" } }) });
    assert.equal(tripResponse.status, 201);
    const conversationResponse = await fetch(`http://127.0.0.1:${port}/api/conversations`, { method: "POST", headers, body: "{}" });
    assert.equal(conversationResponse.status, 201);
    assert.deepEqual((await readdir(rootDir)).filter((name) => !name.startsWith("auth.sqlite-")).sort(), ["auth.sqlite", "conversations", "executions", "trip_shared_root.json"]);
    assert.equal((await readdir(join(rootDir, "conversations"))).length, 1);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("HTTP API permits a local development Web origin but rejects an unknown origin", async () => {
  const { request, close } = await httpFixture();
  try {
    const local = await request("/api/health", { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(local.response.status, 200);
    assert.equal(local.response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    const foreign = await request("/api/health", { headers: { origin: "https://untrusted.example" } });
    assert.equal(foreign.response.status, 403);
    assert.equal(foreign.value.code, "cors_origin_not_allowed");
  } finally {
    await close();
  }
});

test("provider status exposes configuration readiness without exposing keys", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-http-provider-"));
  const store = new TripStore({ rootDir });
  store.mode = "file";
  const sessionStore = new InMemorySessionStore();
  const app = createHttpApp({
    travelService: new TravelService({ store }),
    sessionStore,
    developmentAuthEnabled: true,
    runtimeEnv: {
      NODE_ENV: "development",
      TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH: "true",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      MOONSHOT_API_KEY: "moonshot-test-key",
      AMAP_API_KEY: "amap-test-key",
      TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS: "not_run",
      TRAVEL_AGENT_KIMI_SMOKE_STATUS: "not_run",
    },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const session = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email_otp", identity: "providers@example.com" }) });
    const token = (await session.json()).accessToken;
    const response = await fetch(`http://127.0.0.1:${port}/api/provider-status`, { headers: { authorization: `Bearer ${token}` } });
    const status = await response.json();
    assert.equal(status.model.deepseek, "credential_configured_pending_smoke");
    assert.equal(status.model.kimiVision, "credential_configured_pending_smoke");
    assert.equal(status.data.amapOfficialMcp, "credential_configured_pending_smoke");
    assert.equal(JSON.stringify(status).includes("test-key"), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("visual evidence endpoint rejects unsupported media before any model request", async () => {
  const { request, close } = await httpFixture();
  try {
    const session = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "vision@example.com" } });
    const response = await request("/api/visual-evidence/inspect", {
      method: "POST",
      token: session.value.accessToken,
      body: { text: "看看这张图的旅行信息", images: [{ mimeType: "image/gif", data: "not-supported" }] },
    });
    assert.equal(response.response.status, 400);
    assert.equal(response.value.code, "invalid_visual_evidence");
  } finally {
    await close();
  }
});

test("conversation message HTTP contract forwards image and text into one Agent turn", async () => {
  let received = null;
  const conversation = { schemaVersion: "travel-conversation-view-v1", conversationId: "conversation_visual_http", tripId: null, modelId: "deepseek-v4-flash", messages: [], updatedAt: "2026-08-24T08:00:00.000Z" };
  const conversationAgent = {
    getConversation: async () => conversation,
    reply: async (input) => {
      received = input;
      return { schemaVersion: "travel-conversation-turn-v1", status: "completed", conversation, activities: [{ toolName: "interpret_visual_context", status: "completed" }], multimodal: { status: "completed", persistence: "none" } };
    },
  };
  const { request, close, conversationRepository } = await httpFixture({ conversationAgent });
  try {
    const session = await request("/api/auth/session", { method: "POST", body: { provider: "email_otp", identity: "visual-turn@example.com" } });
    await conversationRepository.create({ ...createConversationRecord({ userId: session.value.userId }), conversationId: conversation.conversationId });
    const image = { mimeType: "image/png", data: "iVBORw0KGgo=" };
    const response = await request("/api/conversations/conversation_visual_http/messages", {
      method: "POST",
      token: session.value.accessToken,
      body: { text: "请结合这张菜单继续规划", modelId: "deepseek-v4-flash", images: [image] },
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.value.multimodal.persistence, "none");
    assert.equal(received.text, "请结合这张菜单继续规划");
    assert.deepEqual(received.images, [image]);
  } finally {
    await close();
  }
});

test("guest travelers can plan before login and claim trips and conversations after authentication", async () => {
  const { request, close } = await httpFixture();
  try {
    const guest = await request("/api/auth/guest-session", { method: "POST" });
    assert.equal(guest.response.status, 201);
    assert.equal(guest.value.guest, true);
    assert.equal(guest.value.accessToken, undefined);
    const guestCookie = guest.response.headers.get("set-cookie").split(";")[0];

    const conversation = await request("/api/conversations", { method: "POST", headers: { cookie: guestCookie }, body: {} });
    assert.equal(conversation.response.status, 201);
    const trip = await request("/api/trips", {
      method: "POST",
      headers: { cookie: guestCookie },
      body: { tripId: "trip_guest_claim", brief: { destination: "上海", dates: "2026-09-20 至 2026-09-23" }, travelers: [{ travelerId: "traveler_1", language: "en", hardConstraints: [{ type: "foreign_guest_required" }] }] },
    });
    assert.equal(trip.response.status, 201);
    assert.equal(trip.value.readiness.status, "needs_attention");

    const readiness = await request("/api/trips/trip_guest_claim/readiness", { method: "POST", headers: { cookie: guestCookie }, body: { signalId: "mobile_access", status: "ready" } });
    assert.equal(readiness.response.status, 200);
    assert.equal(readiness.value.readiness.items.find((item) => item.itemId === "mobile_access").status, "ready");

    const authenticated = await request("/api/auth/session", { method: "POST", headers: { cookie: guestCookie }, body: { provider: "email_otp", identity: "claimed@example.com" } });
    assert.equal(authenticated.response.status, 201);
    assert.equal(authenticated.value.guest, false);
    assert.equal(authenticated.value.claim.transferredTrips, 1);
    assert.equal(authenticated.value.claim.transferredConversations, 1);

    const claimedTrips = await request("/api/trips", { token: authenticated.value.accessToken });
    assert.deepEqual(claimedTrips.value.trips.map((item) => item.tripId), ["trip_guest_claim"]);
    const claimedConversations = await request("/api/conversations", { token: authenticated.value.accessToken });
    assert.equal(claimedConversations.value.conversations[0].conversationId, conversation.value.conversationId);
    const claimedPlan = await request("/api/trips/trip_guest_claim/plan", { token: authenticated.value.accessToken });
    assert.equal(claimedPlan.value.readiness.items.find((item) => item.itemId === "china_account_continuity").status, "needs_verification");

    const oldGuestAccess = await request("/api/trips/trip_guest_claim/plan", { headers: { cookie: guestCookie } });
    assert.equal(oldGuestAccess.response.status, 401);
    assert.equal(oldGuestAccess.value.code, "authentication_required");
  } finally {
    await close();
  }
});
