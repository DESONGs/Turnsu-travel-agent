import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { loadTravelRuntimeEnv, parseTravelEnvFile } from "../src/http/runtime-env.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { createTravelService } from "../src/api/create-travel-service.mjs";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { PostgresConversationRepository } from "../src/persistence/postgres-conversation-repository.mjs";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { planningProvider } from "../tests/fixtures/jev-planning.mjs";

if (process.env.TRAVEL_JEV_PRODUCT_EVAL !== "true") throw new Error("live_product_evaluation_opt_in_required");
const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/travel_execution_test") throw new Error("isolated_local_test_database_required");
const configured = await loadTravelRuntimeEnv();
const supplied = process.env.TRAVEL_JEV_TEST_ENV_FILE ? parseTravelEnvFile(await readFile(process.env.TRAVEL_JEV_TEST_ENV_FILE, "utf8")) : {};
const key = configured.TYPESAFE_API_KEY ?? supplied.TYPESAFE_API_KEY;
if (!key || !configured.DEEPSEEK_API_KEY) throw new Error("live_model_credentials_required");
const admin = new Pool({ connectionString: url.toString(), max: 2 });
const schema = `jevcompare_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: url.toString(), max: 8 });
const store = new PostgresTripRepository({ pool }); await store.migrate();
const conversations = new PostgresConversationRepository({ pool });
const repository = new ExecutionRepository({ pool }); await repository.migrate();
const text = "2026年10月15日，我一个人从杭州去上海玩一天，总预算6000元，喜欢安静的室内活动和本地菜。请查找吃住行玩并做完整行程草案，保留未知项，不能确认或购买。";
const expected = { destination: "上海", totalBudget: 6000, confirmedNodes: 0, allStopReferencesKnown: true, maxRepairAttempts: 2 };
const datasetHash = createHash("sha256").update(JSON.stringify({ text, expected, fixture: await readFile("tests/fixtures/jev-planning.mjs", "utf8") })).digest("hex");
const output = { testedAt: new Date().toISOString(), datasetHash, text, expected,
  evidenceScope: "Real Parent/Child/Jev through authenticated HTTP and PostgreSQL; travel facts and routes are explicitly controlled fixtures. These mode comparisons do not isolate every causal effect, calibrate auto decisions or establish real travel-provider quality.",
  automaticCalibration: "not_enabled", billingUsd: null, billingNote: "Record measured calls and tokens; account billing and prices not verified by this script.", rows: [] };
const destination = resolve(process.env.TRAVEL_JEV_PRODUCT_OUTPUT ?? "/tmp/travel-jev-product.json");
const save = async () => { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`); };
try {
  for (const mode of ["off", "shadow", "auto"]) {
    const env = { ...configured, DATABASE_URL: url.toString(), NODE_ENV: "test", TYPESAFE_API_KEY: key, TRAVEL_AGENT_JEV_MODE: mode, TRAVEL_AGENT_JEV_CALIBRATION_FILE: "", TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE: "postgres_run", TRAVEL_AGENT_EXECUTION_ROLE: "combined", TRAVEL_AGENT_WORKER_RUNS: "1", TRAVEL_AGENT_MAX_ACTIVE_RUNS: "1" };
    let providerCalls = 0, routeCalls = 0;
    const service = createTravelService(env, { store, researchProvider: planningProvider({ onResearch: () => providerCalls++, onRoute: () => routeCalls++ }) });
    const agent = new TravelConversationAgent({ travelService: service, conversationRepository: conversations, env });
    const app = createHttpApp({ runtimeEnv: env, travelService: service, conversationRepository: conversations, conversationAgent: agent, executionRepository: repository });
    const server = await new Promise(done => { const value = app.listen(0, "127.0.0.1", () => done(value)); });
    const base = `http://127.0.0.1:${server.address().port}`; let cookie;
    const api = async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      const value = await response.json(); if (!response.ok) throw new Error(value.code); return value;
    };
    try {
      await api("/api/auth/guest-session", {});
      const conversation = await api("/api/conversations", {});
      const began = Date.now();
      const run = await api(`/api/conversations/${conversation.conversationId}/runs`, { requestId: randomUUID(), text });
      let final, cursor = 0, firstUsefulMs = null;
      while (Date.now() - began < 250000) {
        const current = await api(`/api/runs/${run.runId}?after=${cursor}`); cursor = current.events.at(-1)?.sequence ?? cursor;
        const useful = current.events.find(event => event.toolName === "research_trip_options" && event.status === "proposed");
        if (firstUsefulMs === null && useful) firstUsefulMs = useful.at - began;
        if (["completed", "failed", "interrupted", "cancelled", "awaiting_input"].includes(current.status)) { final = current; break; }
        await delay(500);
      }
      if (!final) { await api(`/api/runs/${run.runId}/cancel`, {}); throw new Error("evaluation_deadline"); }
      const persisted = await repository.get(run.runId);
      const currentConversation = await conversations.get(conversation.conversationId);
      const trip = currentConversation.tripId ? await store.get(currentConversation.tripId) : null;
      const known = new Set([...(trip?.nodes ?? []).map(node => node.nodeId), ...(trip?.pendingProposals ?? []).flatMap(proposal => proposal.operations.map(operation => operation.nodeId))]);
      const stops = final.result?.itineraryTrial?.itinerary?.stops ?? [];
      const accounting = (await pool.query("SELECT scope,COUNT(*)::integer AS calls,SUM(input_tokens)::bigint AS input_tokens,SUM(output_tokens)::bigint AS output_tokens FROM travel_model_calls WHERE run_id=$1 GROUP BY scope", [run.runId])).rows;
      const toolErrors = (persisted.checkpoint?.entries ?? []).filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).map(entry => ({ tool: entry.message.toolName, text: entry.message.content.filter(item => item.type === "text").map(item => item.text).join(" ").slice(0, 1200) }));
      const row = { mode, status: final.status, code: final.result?.code ?? null, firstUsefulMs, totalMs: Date.now() - began, draftStatus: final.result?.itineraryTrial?.status ?? null,
        checks: { briefPreserved: trip?.brief.destination === expected.destination && trip?.brief.totalBudget === expected.totalBudget, noUnrequestedCommit: (trip?.nodes ?? []).filter(node => node.selected).length === 0, knownStops: stops.length > 0 && stops.every(stop => known.has(stop.nodeId)) },
        questions: final.result?.question ? 1 : 0, question: final.result?.question?.question ?? null, providerCalls, routeCalls, accounting, toolErrors, reply: final.result?.conversation?.messages.at(-1)?.text ?? null };
      output.rows.push(row); await save(); process.stdout.write(`${JSON.stringify({ mode, status: row.status, draftStatus: row.draftStatus, totalMs: row.totalMs, firstUsefulMs })}\n`);
    } finally { await app.locals.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); /* shared repositories close after all arms */ }
  }
} catch (error) { output.error = error.message; process.exitCode = 1; }
finally { await save(); await repository.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
