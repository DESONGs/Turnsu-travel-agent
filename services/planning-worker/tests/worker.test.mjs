import test from "node:test";
import assert from "node:assert/strict";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiRunner } from "../src/pi-runner.mjs";
import { createWorkerClient } from "../src/client.mjs";
import { parseOutput } from "../src/output.mjs";
import { executeTask } from "../src/worker.mjs";

const resultId = "f918b50d-6d1a-4629-ad07-b4f47a84eae0";
const task = { taskId: "e3a513e2-6cba-4649-9f3f-ae71db91657a", generation: 1,
  leaseId: "81ee98b0-260c-44c5-bf90-4195fa8f25e0", objective: "检查旅行天气", checkpoint: null };

test("Pi uses the restricted source tool and returns a referenced suggestion", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("check_trip_weather", {}, { id: "call-1" })]),
    fauxAssistantMessage(JSON.stringify({ kind: "suggestion", summary: "天气结果可供旅行参考", evidenceIds: [resultId], unknowns: ["路线尚未核验"] })),
  ]);
  const runner = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
  const calls = [];
  const client = { async post(endpoint) { calls.push(endpoint); if (endpoint === "weather") return { resultId, expired: false, stale: false, data: { coverage: "partial" } }; throw Error("unexpected call"); } };
  const output = await runner(task, client, new AbortController().signal);
  assert.equal(output.kind, "suggestion");
  assert.deepEqual(output.evidenceIds, [resultId]);
  assert.deepEqual(calls, ["weather"]);
});

test("a saved fresh reference is reused instead of repeating the source request", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("check_trip_weather", {}, { id: "call-2" })]),
    fauxAssistantMessage(JSON.stringify({ kind: "suggestion", summary: "已有天气结果", evidenceIds: [resultId], unknowns: [] })),
  ]);
  const runner = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
  const calls = [];
  const client = { async post(endpoint) { calls.push(endpoint); if (endpoint === "result") return { resultId, expired: false, stale: false }; throw Error("unexpected call"); } };
  await runner({ ...task, checkpoint: { weatherResultId: resultId } }, client, new AbortController().signal);
  assert.deepEqual(calls, ["result"]);
});

test("Pi researches a place only through the restricted worker endpoint", async () => {
  const faux = fauxProvider();
  const query = { domain: "play", keyword: "博物馆", page: 1, pageSize: 10 };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_trip_places", query, { id: "place-call" })]),
    fauxAssistantMessage(JSON.stringify({ kind: "suggestion", summary: "已找到地图地点资料", evidenceIds: [resultId], unknowns: ["营业状态和库存未验证"] })),
  ]);
  const runner = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
  const calls = [];
  const client = { async post(endpoint, body) {
    calls.push({ endpoint, body });
    return { resultId, expired: false, stale: false, data: { domain: "play" } };
  } };
  const output = await runner(task, client, new AbortController().signal);
  assert.deepEqual(output.evidenceIds, [resultId]);
  assert.deepEqual(calls, [{ endpoint: "places", body: { taskId: task.taskId, generation: task.generation, leaseId: task.leaseId, ...query } }]);
});

test("Pi can check an explicit flight only through the restricted worker endpoint", async () => {
  const faux = fauxProvider();
  const query = { carrier: "MU", flight: "5101", departureAirportIata: "SHA", departureDateLocal: "2026-11-07" };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("check_trip_flight_status", query, { id: "flight-call" })]),
    fauxAssistantMessage(JSON.stringify({ kind: "suggestion", summary: "航班状态候选需要核对", evidenceIds: [resultId], unknowns: ["是否匹配预订"] })),
  ]);
  const runner = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
  const calls = [];
  const client = { async post(endpoint, body) {
    calls.push({ endpoint, body });
    return { resultId, expired: false, stale: false, data: { query, candidates: [{ bookingMatchConfirmed: false }] } };
  } };
  const output = await runner(task, client, new AbortController().signal);
  assert.deepEqual(output.evidenceIds, [resultId]);
  assert.deepEqual(calls, [{ endpoint: "flightstatus", body: { taskId: task.taskId, generation: task.generation, leaseId: task.leaseId, ...query } }]);
});

test("Pi requests walking using place references rather than arbitrary coordinates", async () => {
  const faux = fauxProvider();
  const endpoints = { origin: { resultId, sourceId: "museum" }, destination: { resultId, sourceId: "park" } };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("check_trip_walking_route", endpoints, { id: "walk-call" })]),
    fauxAssistantMessage(JSON.stringify({ kind: "suggestion", summary: "步行估算需重新核验", evidenceIds: [resultId], unknowns: ["无台阶通行"] })),
  ]);
  const runner = await createPiRunner({ provider: faux.provider, modelId: faux.getModel().id });
  const calls = [];
  const client = { async post(endpoint, body) { calls.push({ endpoint, body }); return { resultId, expired: false, stale: false }; } };
  const output = await runner(task, client, new AbortController().signal);
  assert.deepEqual(output.evidenceIds, [resultId]);
  assert.deepEqual(calls, [{ endpoint: "walking", body: { taskId: task.taskId, generation: task.generation, leaseId: task.leaseId, ...endpoints } }]);
});

test("output with an invented reference or missing source is rejected", () => {
  assert.throws(() => parseOutput(JSON.stringify({ kind: "suggestion", summary: "无来源", evidenceIds: [], unknowns: [] }), new Set()));
  assert.throws(() => parseOutput(JSON.stringify({ kind: "suggestion", summary: "错误来源", evidenceIds: [resultId], unknowns: [] }), new Set()));
});

test("a structured itinerary proposal references only researched places and cannot carry a commit", () => {
  const proposal = { kind: "itinerary_proposal", summary: "安排一次到访", evidenceIds: [resultId], unknowns: ["营业仍需核验"],
    stops: [{ stopId: "visit-1", sourceResultId: resultId, sourceId: "museum", role: "activity", startLocal: "2026-12-01T10:00", timeZone: "Asia/Shanghai", durationMinutes: 60 }] };
  assert.equal(parseOutput(JSON.stringify(proposal), new Set([resultId])).stops[0].sourceId, "museum");
  assert.throws(() => parseOutput(JSON.stringify({ ...proposal, adopted: true }), new Set([resultId])));
  assert.throws(() => parseOutput(JSON.stringify(proposal), new Set()));
  assert.throws(() => parseOutput(JSON.stringify({ ...proposal, stops: [{ ...proposal.stops[0], price: "invented" }] }), new Set([resultId])));
});

test("a fenced task never saves a late result", async () => {
  const calls = [];
  const client = { async post(endpoint) { calls.push(endpoint); if (endpoint === "heartbeat") throw Object.assign(Error("stale"), { code: "stale_execution" }); } };
  await executeTask(task, client, async () => ({ kind: "needs_context", summary: "未执行", evidenceIds: [], unknowns: [] }), new AbortController().signal);
  assert.deepEqual(calls, ["heartbeat"]);
});

test("the worker accepts HTTPS or loopback only and never follows redirects", async () => {
  assert.throws(() => createWorkerClient({ baseUrl: "http://example.com", token: "w".repeat(43) }));
  assert.throws(() => createWorkerClient({ baseUrl: "https://example.com/path", token: "w".repeat(43) }));
  let captured;
  const client = createWorkerClient({ baseUrl: "http://127.0.0.1:8798", token: "w".repeat(43), fetchImpl: async (url, options) => {
    captured = { url: String(url), redirect: options.redirect }; return new Response("{}", { status: 200 });
  } });
  await client.post("claim");
  assert.deepEqual(captured, { url: "http://127.0.0.1:8798/internal/worker/claim", redirect: "error" });
});
