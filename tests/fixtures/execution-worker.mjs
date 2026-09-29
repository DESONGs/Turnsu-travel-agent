// Local test process only. No model or travel-provider network requests.
import http from "node:http";
import { Pool } from "pg";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHttpApp } from "../../src/http/app.mjs";
import { TravelService } from "../../src/api/travel-service.mjs";
import { PostgresTripRepository } from "../../src/persistence/postgres-trip-repository.mjs";
import { PostgresConversationRepository } from "../../src/persistence/postgres-conversation-repository.mjs";
import { TravelConversationAgent } from "../../src/agent/travel-conversation-agent.mjs";
import { ExecutionRepository } from "../../src/persistence/execution-repository.mjs";
import { createTravelService } from "../../src/api/create-travel-service.mjs";
import { planningProvider, planningResponse } from "./jev-planning.mjs";
import { judgmentResponse } from "./jev-travel.mjs";

const databaseUrl = process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL;
if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname) || !new URL(databaseUrl).pathname.endsWith("/travel_execution_test")) throw new Error("isolated_local_test_database_required");
const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const store = new PostgresTripRepository({ pool });
await store.migrate();
const conversations = new PostgresConversationRepository({ pool });
const repository = new ExecutionRepository({ pool });
await repository.migrate();
const complex = process.env.TRAVEL_EXECUTION_TEST_PROFILE === "planning";
let researchCalls = 0, routeCalls = 0, judgmentCalls = 0;
const travelService = complex ? createTravelService({ DATABASE_URL: databaseUrl, TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE: "postgres_run", TRAVEL_AGENT_JEV_MODE: "auto", TYPESAFE_API_KEY: "controlled-fixture" }, {
  store, researchProvider: planningProvider({ onResearch: () => researchCalls++, onRoute: () => routeCalls++ }),
  judgmentOptions: { fetchImpl: async (_url, options) => {
    judgmentCalls++;
    await new Promise(done => setTimeout(done, 100));
    return Response.json(judgmentResponse(JSON.parse(options.body), { scope: "planning" }));
  } },
}) : new TravelService({ store });
const faux = fauxProvider({ provider: "fixture-capacity", models: [{ id: "capacity-parent" }] });
const models = createModels(); models.setProvider(faux.provider);
let release;
const gate = new Promise((resolve) => { release = resolve; });
let activeModels = 0;
let peakModels = 0;
let started = 0;
const response = async (context, options) => {
  if (complex) return planningResponse(context);
  if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("已保存杭州旅行要求与预算。还没有确认或购买任何安排。");
  if (JSON.stringify(context.messages.at(-1)).includes("目的地还没有确定")) return fauxAssistantMessage(fauxToolCall("ask_travel_question", { question: "这次想去哪个城市？", choices: ["杭州", "上海"] }), { stopReason: "toolUse" });
  started++; activeModels++; peakModels = Math.max(peakModels, activeModels);
  process.send?.({ type: "progress", started, activeModels, peakModels });
  let abort;
  try {
    await Promise.race([gate, new Promise((_, reject) => { abort = () => reject(new Error("fixture_aborted")); options?.signal?.addEventListener("abort", abort, { once: true }); })]);
    return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州", totalBudget: 6000, durationDays: 3 }), { stopReason: "toolUse" });
  } finally { activeModels--; process.send?.({ type: "progress", started, activeModels, peakModels }); if (abort) options?.signal?.removeEventListener("abort", abort); }
};
faux.setResponses(Array.from({ length: complex ? 200_000 : 4000 }, () => response));
const conversationAgent = new TravelConversationAgent({ travelService, conversationRepository: conversations, modelRuntime: { models, model: faux.getModel("capacity-parent") } });
const app = createHttpApp({ travelService, conversationRepository: conversations, conversationAgent, executionRepository: repository,
  allowedOrigins: new Set(process.env.TRAVEL_EXECUTION_TEST_PORT ? [`http://127.0.0.1:${process.env.TRAVEL_EXECUTION_TEST_PORT}`] : []),
  runtimeEnv: { DATABASE_URL: databaseUrl, NODE_ENV: "test", TRAVEL_AGENT_EXECUTION_ROLE: process.env.TRAVEL_EXECUTION_TEST_ROLE ?? "combined", TRAVEL_AGENT_WORKER_RUNS: complex ? "32" : "500", TRAVEL_AGENT_MAX_ACTIVE_RUNS: complex ? "64" : "500", TRAVEL_AGENT_MODEL_LIMITS: JSON.stringify({ "fixture-capacity": { account: "controlled_model", concurrent: complex ? 64 : 500, rpm: 10000, tpm: 100000000 } }) },
});
const server = http.createServer((request, response) => {
  if (request.url === "/__fixture/release" && request.method === "POST") { release(); response.end("released"); return; }
  if (request.url === "/__fixture/metrics") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ started, activeModels, peakModels, researchCalls, routeCalls, judgmentCalls, activeRuns: app.locals.executionService.active.size, dispatchError: app.locals.executionService.lastError, rss: process.memoryUsage().rss })); return; }
  app(request, response);
});
server.listen(Number(process.env.TRAVEL_EXECUTION_TEST_PORT ?? 0), "127.0.0.1", () => {
  const message = { type: "ready", port: server.address().port };
  if (process.send) process.send(message); else process.stdout.write(`${JSON.stringify(message)}\n`);
});
process.on("message", (message) => { if (message.type === "release") release(); });
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  release(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await app.locals.close(); await repository.close(); await pool.end();
  process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
