import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpApp } from "../src/http/app.mjs";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";

// One synthetic traveler, real configured model and read-only travel providers.
// Never a load test, purchase, user-data migration or production deployment.
if (process.env.TRAVEL_EXECUTION_LIVE_SMOKE !== "true") throw new Error("live_smoke_explicit_opt_in_required");
const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/travel_execution_test") throw new Error("isolated_local_test_database_required");
const admin = new Pool({ connectionString: url.toString() });
const schema = `live_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
const original = await loadTravelRuntimeEnv();
const app = createHttpApp({ runtimeEnv: { ...original, DATABASE_URL: url.toString(), NODE_ENV: "test", TRAVEL_AGENT_EXECUTION_ROLE: "combined", TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE: "postgres_run", TRAVEL_AGENT_INSTANCE_COUNT: "2", TRAVEL_AGENT_WORKER_RUNS: "1", TRAVEL_AGENT_MAX_ACTIVE_RUNS: "1", TRAVEL_AGENT_RUN_MODEL_CALLS: "32", TRAVEL_AGENT_RUN_TOKEN_BUDGET: "400000" }, developmentAuthEnabled: false });
const server = await new Promise((resolveReady) => { const server = app.listen(0, "127.0.0.1", () => resolveReady(server)); });
const base = `http://127.0.0.1:${server.address().port}`;
const began = Date.now();
let cookie;
async function api(path, body) {
  const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.code ?? "http_failure"), { code: result.code });
  return result;
}
let output;
try {
  await api("/api/auth/guest-session", {});
  const conversation = await api("/api/conversations", {});
  const date = new Date(); date.setUTCDate(date.getUTCDate() + 14);
  const start = date.toISOString().slice(0, 10); date.setUTCDate(date.getUTCDate() + 2);
  const end = date.toISOString().slice(0, 10);
  const run = await api(`/api/conversations/${conversation.conversationId}/runs`, { requestId: randomUUID(), text: `${start}到${end}，我和父母从北京坐高铁去上海玩三天，总预算12000元。父亲需要少走路、避开楼梯，希望住市中心靠近地铁，吃本地菜。请保存要求，查找有来源的吃住行玩候选并尝试安排日程。没有任何已确认的住宿、车次或门票；只生成待比较方案，不确认、不购买。` });
  let final;
  let cursor = 0;
  const events = [];
  while (Date.now() - began < 250_000) {
    const snapshot = await api(`/api/runs/${run.runId}?after=${cursor}`);
    for (const event of snapshot.events) { cursor = event.sequence; events.push(event); process.stdout.write(`${JSON.stringify({ event: event.type, tool: event.toolName, lane: event.lane, status: event.status })}\n`); }
    if (["completed", "failed", "interrupted", "cancelled", "awaiting_input"].includes(snapshot.status)) { final = snapshot; break; }
    await delay(1000);
  }
  const currentConversation = await api(`/api/conversations/${conversation.conversationId}`);
  const tripId = final?.result?.tripId ?? currentConversation.tripId;
  const plan = tripId ? await api(`/api/trips/${tripId}/plan`) : null;
  const proposal = plan?.pendingProposals?.at(-1);
  const accounting = await admin.query(`SELECT scope,COUNT(*)::integer AS calls,SUM(reserved_tokens)::bigint AS reserved_tokens,SUM(input_tokens)::bigint AS input_tokens,SUM(output_tokens)::bigint AS output_tokens FROM ${schema}.travel_model_calls GROUP BY scope`);
  const checkpoint = (await app.locals.executionService.repository.get(run.runId))?.checkpoint;
  const toolErrors = checkpoint?.entries?.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).map((entry) => ({ tool: entry.message.toolName, message: entry.message.content.filter((item) => item.type === "text").map((item) => item.text).join(" ").slice(0, 1800) })) ?? [];
  output = { testedAt: new Date().toISOString(), status: final?.status ?? "deadline", code: final?.result?.code ?? null, elapsedMs: Date.now() - began,
    activities: final?.result?.activities ?? [], planningStatus: final?.result?.itineraryTrial?.status ?? final?.result?.outcome?.planningStatus ?? null,
    planningAvailability: plan?.planningAvailability ?? null,
    analysis: proposal?.analysis ? { coverage: proposal.analysis.coverage, completedLanes: proposal.analysis.completedLanes, failedLanes: proposal.analysis.failedLanes, joinCount: proposal.analysis.joinCount } : null,
    candidateCounts: proposal?.byDomain ? Object.fromEntries(Object.entries(proposal.byDomain).map(([key, rows]) => [key, rows.length])) : {},
    accounting: accounting.rows, evidenceScope: "One real model/provider request through authenticated HTTP, PostgreSQL run ownership, native Pi sessions and product persistence. No purchase or confirmation. This does not establish 500-user external capacity." };
  output.acceptance = { nativeAgentExecution: ["completed", "awaiting_input"].includes(final?.status) && proposal?.analysis?.coverage === "complete", completePlanning: final?.status === "completed" && final?.result?.outcome?.status === "ready" && final?.result?.itineraryTrial?.status === "trial_ready" };
  if (!output.acceptance.nativeAgentExecution) process.exitCode = 1;
  output.toolErrors = toolErrors;
  output.outcome = final?.result?.outcome ?? null;
  output.question = final?.result?.question ?? null;
  output.trialIssues = final?.result?.itineraryTrial?.issues ?? [];
  output.proposals = (plan?.pendingProposals ?? []).map((item) => ({
    candidateCounts: Object.fromEntries(Object.entries(item.byDomain ?? {}).map(([key, rows]) => [key, rows.length])),
    domainStatuses: item.domainStatuses ?? null,
    analysis: item.analysis ? { coverage: item.analysis.coverage, degradedReasons: item.analysis.degradedReasons, events: item.analysis.events, conditionRevision: item.analysis.conditionRevision } : null,
  }));
  output.events = events;
  output.reply = final?.result?.conversation?.messages?.at(-1)?.text ?? null;
} catch (error) { output = { testedAt: new Date().toISOString(), status: "failed", code: error.code ?? "live_smoke_failed", elapsedMs: Date.now() - began }; process.exitCode = 1; }
finally {
  await app.locals.executionService.close(); server.closeAllConnections(); await new Promise((done) => server.close(done));
  await app.locals.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
const destination = resolve(process.env.TRAVEL_EXECUTION_TEST_OUTPUT ?? "/tmp/travel-native-execution-live.json");
await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output)}\n`);
