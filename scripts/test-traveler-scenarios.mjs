import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { createHttpApp } from "../src/http/app.mjs";
import { loadTravelRuntimeEnv, parseTravelEnvFile } from "../src/http/runtime-env.mjs";
import { createTravelService } from "../src/api/create-travel-service.mjs";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { PostgresConversationRepository } from "../src/persistence/postgres-conversation-repository.mjs";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { planningProvider } from "../tests/fixtures/jev-planning.mjs";
import { travelerCases, additionalCases } from "../tests/fixtures/traveler-acceptance-cases.mjs";
import { travelerBusinessCases } from "../tests/fixtures/traveler-business-cases.mjs";

if (process.env.TRAVEL_USER_LIVE_TEST !== "true") throw new Error("explicit_live_test_opt_in_required");
const databaseUrl = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || databaseUrl.pathname !== "/travel_execution_test") throw new Error("isolated_local_test_database_required");
const outputDir = resolve(process.env.TRAVEL_USER_TEST_OUTPUT ?? "/tmp/traveler-acceptance");
const selectedIds = process.env.TRAVEL_USER_TEST_CASES?.split(",").map(id => id.trim()).filter(Boolean);
const casesToRun = selectedIds ? [...travelerCases, ...travelerBusinessCases].filter(item => selectedIds.includes(item.id)) : travelerCases;
if (!casesToRun.length) throw new Error("no_matching_traveler_cases");
await mkdir(outputDir, { recursive: true });
const specification = { schemaVersion: "traveler-acceptance-cases-v1", frozenAt: new Date().toISOString(), cases: [...travelerCases, ...additionalCases] };
const datasetHash = createHash("sha256").update(JSON.stringify(specification.cases)).digest("hex");
await writeFile(`${outputDir}/frozen-cases.json`, JSON.stringify({ ...specification, datasetHash }, null, 2) + "\n");
await writeFile(`${outputDir}/business-cases.json`, JSON.stringify({ frozenAt: new Date().toISOString(), cases: travelerBusinessCases, providerVariant: process.env.TRAVEL_USER_TEST_SOURCE_VARIANT ?? "original", scope: "Fictional source facts; real Parent, Jev, HTTP and database." }, null, 2) + "\n");
const providerFollowup = process.env.TRAVEL_USER_TEST_PROVIDER_FOLLOWUP === "true" ? "2人，我和一位家人，其他要求不变。请继续查真实资料并排草案。" : null;
await writeFile(`${outputDir}/execution-recipe.json`, JSON.stringify({ selectedIds: casesToRun.map(item => item.id), providerFollowup, frozenAt: new Date().toISOString() }, null, 2) + "\n");
const configured = await loadTravelRuntimeEnv();
const supplied = process.env.TRAVEL_JEV_TEST_ENV_FILE ? parseTravelEnvFile(await readFile(process.env.TRAVEL_JEV_TEST_ENV_FILE, "utf8")) : {};
const key = configured.TYPESAFE_API_KEY ?? supplied.TYPESAFE_API_KEY;
if (!key || !configured.DEEPSEEK_API_KEY) throw new Error("live_model_credentials_required");
const admin = new Pool({ connectionString: databaseUrl.toString(), max: 2 });
const schema = `traveler_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
const store = new PostgresTripRepository({ pool }); await store.migrate();
const conversations = new PostgresConversationRepository({ pool });
const repository = new ExecutionRepository({ pool }); await repository.migrate();
const apps = [], servers = [], extraPools = [], extraSchemas = [], contextByBase = new Map();
const results = { schemaVersion: "traveler-acceptance-results-v1", startedAt: new Date().toISOString(), datasetHash, node: process.version,
  evidenceScope: "Real native Pi Parent and Jev, authenticated HTTP and PostgreSQL. T08 uses configured travel Providers; other model scenarios use explicitly fictional reference travel facts. Browser scenarios are recorded separately. No purchases or third-party posts.",
  sourceHashes: Object.fromEntries(await Promise.all(["src/agent/travel-conversation-agent.mjs", "src/agent/travel-execution-service.mjs", "src/api/travel-service.mjs", "src/persistence/execution-repository.mjs", "travel-agent-pi-package/src/host/travel-judgment.ts", "tests/fixtures/traveler-acceptance-cases.mjs", "tests/fixtures/traveler-business-cases.mjs", "scripts/test-traveler-scenarios.mjs", "travel-agent-pi-package/src/contracts/index.ts", "travel-agent-pi-package/src/core/trip-feasibility.ts", "travel-agent-pi-package/src/core/itinerary-proposal.ts", "travel-agent-pi-package/src/core/itinerary-schedule.ts", "travel-agent-pi-package/src/runtime/trip-runtime-implementation.ts", "travel-agent-pi-package/src/host/travel-agent-session.ts", "travel-agent-pi-package/src/host/travel-decision-policy.ts", "plugins/travel-agent/skills/plan-trip/SKILL.md", "src/web/travel-app.jsx"].map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")]))),
  configured: { parent: !!configured.DEEPSEEK_API_KEY, child: !!configured.MOONSHOT_API_KEY, jev: !!key, amap: !!configured.AMAP_API_KEY }, rows: [] };
const save = async () => writeFile(`${outputDir}/results.json`, JSON.stringify(results, null, 2) + "\n");
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "awaiting_input"]);
const env = { ...configured, DATABASE_URL: databaseUrl.toString(), NODE_ENV: "test", TYPESAFE_API_KEY: key, TRAVEL_AGENT_JEV_MODE: "auto", TRAVEL_AGENT_JEV_CALIBRATION_FILE: "", TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE: "postgres_run", TRAVEL_AGENT_WORKER_RUNS: "2", TRAVEL_AGENT_MAX_ACTIVE_RUNS: "3", TRAVEL_AGENT_INSTANCE_COUNT: "3", TRAVEL_AGENT_SESSION_SECRET: randomUUID()+randomUUID(), TRAVEL_AGENT_AUTH_STATE_SECRET: randomUUID()+randomUUID() };
const providerReads = [];
const reference = planningProvider();
const referenceResearch = reference.research.bind(reference);
reference.research = async input => {
  const value = await referenceResearch(input);
  // Match requested destination/domains at the Provider boundary, without
  // changing the model's decisions or inventing verified accessibility.
  const destination = input.brief.destination;
  value.destination = destination;
  value.byDomain = Object.fromEntries(Object.entries(value.byDomain).filter(([domain]) => input.domains.includes(domain)).map(([domain, rows]) => [domain, rows.map(row => ({ ...row, location: { ...row.location, address: destination } }))]));
  if (process.env.TRAVEL_USER_TEST_SOURCE_VARIANT === "business") {
    const names = { stay: ["测试·高价安静酒店", "测试·经济安静酒店", "测试·街区酒店"], food: ["测试·本地菜馆", "测试·家常菜馆", "测试·面馆"], play: ["测试·城市历史馆", "测试·室内工艺展", "测试·文化展馆"], transport: ["测试·早班高铁", "测试·上午高铁", "测试·午间高铁"] };
    for (const [domain, rows] of Object.entries(value.byDomain)) rows.forEach((row, index) => {
      row.title = names[domain][index]; row.location.name = row.title;
      row.cost = domain === "stay" ? [1200, 160, 180][index] : domain === "food" ? 40 : domain === "play" ? 20 : 100;
      row.summary = domain === "play" ? "有独立来源的室内文化活动，环境安静。这是明确的虚构测试资料。" : "安静环境，参考价格有来源；实际库存待预订时核验。这是明确的虚构测试资料。";
    });
  }
  providerReads.push({ tripId: input.tripId, domains: input.domains, destination, at: Date.now() });
  return value;
};
async function startApp({ port = 0, configuredProvider = false, role = "combined" } = {}) {
  let localPool = pool, localStore = store, localConversations = conversations, localRepository = repository, localUrl = databaseUrl.toString();
  if (configuredProvider) {
    // Provider mode is not a run attribute: isolate queues so a real-Provider
    // Worker cannot claim a reference-data scenario, or the other way around.
    const realSchema = `${schema}_real`; await admin.query(`CREATE SCHEMA ${realSchema}`); extraSchemas.push(realSchema);
    const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${realSchema}`); localUrl = url.toString();
    localPool = new Pool({ connectionString: localUrl, max: 6 }); extraPools.push(localPool);
    localStore = new PostgresTripRepository({ pool: localPool }); await localStore.migrate();
    localConversations = new PostgresConversationRepository({ pool: localPool });
    localRepository = new ExecutionRepository({ pool: localPool }); await localRepository.migrate();
  }
  const localEnv = { ...env, DATABASE_URL: localUrl, TRAVEL_AGENT_EXECUTION_ROLE: role };
  const service = createTravelService(localEnv, { store: localStore, ...(configuredProvider ? {} : { researchProvider: reference }) });
  const agent = new TravelConversationAgent({ travelService: service, conversationRepository: localConversations, env: localEnv });
  const allowedOrigins = new Set();
  const app = createHttpApp({ runtimeEnv: localEnv, travelService: service, conversationRepository: localConversations, conversationAgent: agent, executionRepository: localRepository, allowedOrigins });
  const server = await new Promise(done => { const value = app.listen(port, "127.0.0.1", () => done(value)); });
  apps.push(app); servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  // Randomly allocated QA ports must also load browser module assets through
  // the same origin checks as the fixed-port reference app.
  allowedOrigins.add(base);
  contextByBase.set(base, { pool: localPool, store: localStore, repository: localRepository });
  return base;
}
async function request(client, path, body, { allowError = false } = {}) {
  const response = await fetch(`${client.base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(client.cookie ? { cookie: client.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.headers.get("set-cookie")) client.cookie = response.headers.get("set-cookie").split(";")[0];
  const value = await response.json();
  if (!response.ok && !allowError) throw Object.assign(new Error(value.code ?? "http_error"), { code: value.code, httpStatus: response.status });
  return allowError ? { httpStatus: response.status, value } : value;
}
async function actor(base) {
  const client = { base, ...contextByBase.get(base) }; await request(client, "/api/auth/guest-session", {});
  client.conversationId = (await request(client, "/api/conversations", {})).conversationId;
  return client;
}
async function readState(client) {
  const conversation = await request(client, `/api/conversations/${client.conversationId}`);
  const state = conversation.tripId ? await client.store.get(conversation.tripId) : null;
  const plan = conversation.tripId ? await request(client, `/api/trips/${conversation.tripId}/plan`) : null;
  return { conversation, state, plan };
}
async function startTurn(client, text, extra = {}) {
  const began = Date.now();
  const run = await request(client, `/api/conversations/${client.conversationId}/runs`, { requestId: randomUUID(), text, ...extra });
  return { run, began, admissionMs: Date.now() - began };
}
async function finishTurn(client, started) {
  let final, cursor = 0;
  const events = [];
  while (Date.now() - started.began < 250_000) {
    const current = await request(client, `/api/runs/${started.run.runId}?after=${cursor}`);
    events.push(...current.events); cursor = current.events.at(-1)?.sequence ?? cursor;
    if (terminal.has(current.status)) { final = current; break; }
    await delay(500);
  }
  if (!final) { await request(client, `/api/runs/${started.run.runId}/cancel`, {}); throw new Error("scenario_deadline"); }
  const snapshot = await readState(client);
  const accounting = (await client.pool.query("SELECT scope,COUNT(*)::integer AS calls,SUM(input_tokens)::bigint AS input_tokens,SUM(output_tokens)::bigint AS output_tokens FROM travel_model_calls WHERE run_id=$1 GROUP BY scope", [final.runId])).rows;
  const saved = await client.repository.get(final.runId);
  const toolErrors = (saved.checkpoint?.entries ?? []).filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).map(entry => ({ tool: entry.message.toolName, text: entry.message.content.filter(item => item.type === "text").map(item => item.text).join(" ").slice(0, 1800) }));
  return { ...snapshot, final, events, accounting, toolErrors, admissionMs: started.admissionMs, totalMs: Date.now() - started.began };
}
const turn = async (client, text, extra) => finishTurn(client, await startTurn(client, text, extra));
const check = (row, name, passed, actual) => row.checks.push({ name, passed: !!passed, ...(actual === undefined ? {} : { actual }) });
const selected = state => (state?.nodes ?? []).filter(n => n.selected).map(n => ({ nodeId: n.nodeId, title: n.title, lock: n.lock }));
function recordTurn(value) {
  return { runId: value.final.runId, status: value.final.status, code: value.final.result?.code, admissionMs: value.admissionMs, totalMs: value.totalMs,
    firstUsefulMs: value.events.find(e => e.toolName === "research_trip_options" && e.status === "proposed")?.at - value.final.createdAt || null,
    brief: value.state?.brief, travelers: value.state?.travelers, selected: selected(value.state), question: value.final.result?.question,
    trial: value.final.result?.itineraryTrial, outcome: value.final.result?.outcome, reply: value.conversation.messages.at(-1)?.text,
    userMessages: value.conversation.messages.filter(m => m.role === "user").map(m => m.text),
    candidateDomains: [...new Set((value.state?.pendingProposals ?? []).flatMap(p => p.operations.map(op => op.node?.domain).filter(Boolean)))],
    planningAvailability: value.plan?.planningAvailability, providerReads: providerReads.filter(p => p.tripId === value.state?.tripId),
    accounting: value.accounting, toolErrors: value.toolErrors, events: value.events };
}
let referenceBase, peerBase, liveBase;
const completed = new Map();
async function runCase(item) {
  const row = { id: item.id, title: item.title, travelFacts: item.configuredProvider ? "configured_real_providers" : "fictional_reference_provider", checks: [], turns: [], manualReview: "pending" };
  const client = await actor(item.configuredProvider ? liveBase : referenceBase);
  try {
    let value;
    if (item.id === "T10") {
      const started = await startTurn(client, item.text);
      const activeDeadline = Date.now() + 15000;
      let entered = false;
      while (Date.now() < activeDeadline) {
        const running = (await client.pool.query("SELECT COUNT(*) AS count FROM travel_model_calls WHERE run_id=$1 AND status='running'", [started.run.runId])).rows[0];
        if (Number(running.count) > 0) { entered = true; break; }
        await delay(100);
      }
      check(row, "真实模型已开始执行后再取消", entered);
      await request({ ...client, base: peerBase }, `/api/runs/${started.run.runId}/cancel`, {});
      value = await finishTurn(client, started);
      const before = JSON.stringify(value.state);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && apps.some(app => app.locals.executionService.active.has(started.run.runId))) await delay(100);
      const after = await readState(client);
      check(row, "取消状态持久化", value.final.status === "cancelled", value.final.status);
      check(row, "执行资源释放", apps.every(app => !app.locals.executionService.active.has(started.run.runId)));
      check(row, "取消后未写入新行程状态", before === JSON.stringify(after.state));
    } else value = await turn(client, item.text);
    row.turns.push(recordTurn(value));
    if (item.id !== "T10") check(row, "完成或等待一个用户回答", ["completed", "awaiting_input"].includes(value.final.status), value.final.status);
    check(row, "未擅自确认安排", selected(value.state).length === 0, selected(value.state));
    if (["B03", "B04"].includes(item.id)) {
      const trial = value.final.result?.itineraryTrial;
      check(row, "先形成可采用完整草案", trial?.status === "trial_ready", trial?.status);
      if (!trial?.accept) throw new Error("checked_draft_required_before_traveler_change");
      const accepted = await request(client, `/api/trips/${value.state.tripId}/proposals/${trial.accept.proposalId}/accept`, trial.accept);
      check(row, "用户明确采用后写入", accepted.status === "committed");
      const before = await readState(client);
      value = await turn(client, item.adjustment); row.turns.push(recordTurn(value));
      check(row, "调整请求完成交付", value.final.status === "completed", { status: value.final.status, code: value.final.result?.code });
      check(row, "已采用项目没有丢失或替换", JSON.stringify(selected(before.state)) === JSON.stringify(selected(value.state)));
      if (item.id === "B04") {
        const adjustment = value.final.result?.itineraryTrial;
        check(row, "调整草案可采用", adjustment?.status === "trial_ready", adjustment?.issues ?? adjustment?.status);
        const previousStops = before.state.environment.mobility.itinerary.stops;
        const meals = previousStops.filter(stop => stop.role === "meal").sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
        const changedStops = adjustment?.itinerary?.stops ?? [];
        const newMeals = changedStops.filter(stop => stop.role === "meal").sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
        check(row, "午餐保留且只替换晚餐", newMeals[0]?.nodeId === meals[0]?.nodeId && newMeals.at(-1)?.nodeId !== meals.at(-1)?.nodeId);
        check(row, "酒店使用其他候选", changedStops.some(stop => stop.role === "stay_check_in" && !previousStops.some(old => old.role === "stay_check_in" && old.nodeId === stop.nodeId)));
        check(row, "其他高铁与游玩保持", previousStops.filter(stop => ["intercity_arrival", "activity"].includes(stop.role)).every(old => changedStops.some(stop => stop.role === old.role && stop.nodeId === old.nodeId)));
        if (!adjustment?.accept) throw new Error("adjustment_not_adoptable");
        const adopted = await request(client, `/api/trips/${value.state.tripId}/proposals/${adjustment.accept.proposalId}/accept`, adjustment.accept);
        const after = await readState(client);
        const expected = [...new Set(changedStops.map(stop => stop.nodeId))].sort();
        check(row, "采用成功且选中集合与审阅草案一致", adopted.status === "committed" && JSON.stringify(selected(after.state).map(node => node.nodeId).sort()) === JSON.stringify(expected), { status: adopted.status, selectedCount: selected(after.state).length, plannedCount: expected.length });
        check(row, "采用后预算与试排相同", after.plan.budget.estimated === adjustment.impact.budget.estimated, { actual: after.plan.budget.estimated, reviewed: adjustment.impact.budget.estimated });
        check(row, "采用后保存完整站序", isDeepStrictEqual(after.state.environment.mobility.itinerary, adjustment.itinerary));
      } else {
      check(row, "原站序保留用于对照", isDeepStrictEqual(before.state.environment.mobility.itinerary, value.state.environment.mobility?.itinerary));
      check(row, "旧路线证据失效且不能继续采用", value.state.environment.mobility?.status === "needs_context" && value.state.environment.mobility?.feasibility?.canConfirm === false);
      check(row, "最新失败草案可从持久状态恢复", value.plan.itineraryTrial?.itinerary?.stops.length > 0 && !value.plan.itineraryTrial.accept);
      check(row, "只有一版活动试排且结果如实交接", value.state.pendingProposals.filter(p => p.itineraryPlan).length === 1 && value.final.result?.itineraryTrial?.savedState?.activeDraftCount === 1 && value.final.result?.itineraryTrial?.savedState?.adoptedTimelineAvailable === true);
      check(row, "没有让用户证明设施或放宽硬要求", !value.final.result?.question && value.state.travelers.some(t => t.careNeeds?.mobility?.stepFreeRequired === true));
      }
    }
    if (item.id === "T01") {
      check(row, "一次呈现一个必要问题", value.final.status === "awaiting_input" && !!value.final.result?.question?.question);
      check(row, "不编造目的地或预算", !value.state?.brief?.destination && !value.state?.brief?.totalBudget, value.state?.brief);
    }
    if (item.id === "T02") {
      value = await turn(client, item.correction); row.turns.push(recordTurn(value));
      check(row, "更正目的地和预算", value.state?.brief?.destination === "苏州" && value.state?.brief?.totalBudget === 1500, value.state?.brief);
      check(row, "更正为两天", value.state?.brief?.durationDays === 2, value.state?.brief);
      check(row, "两条原始要求完整保留", value.conversation.messages.filter(m => m.role === "user").length === 2);
      check(row, "没有研究或完整试排", !value.final.result?.itineraryTrial && providerReads.every(p => p.tripId !== value.state?.tripId));
    }
    if (item.id === "T03") {
      const domains = row.turns.at(-1).candidateDomains;
      check(row, "仅有住宿候选", domains.length === 1 && domains[0] === "stay", domains);
      check(row, "没有完整试排", !value.final.result?.itineraryTrial);
    }
    if (item.id === "T04") {
      const trial = value.final.result?.itineraryTrial;
      check(row, "形成核验后草案", trial?.status === "trial_ready", trial?.status ?? null);
      check(row, "保留6000元预算与杭州出发", value.state?.brief?.totalBudget === 6000 && value.state?.brief?.origin === "杭州", value.state?.brief);
      check(row, "覆盖两天", new Set((trial?.itinerary?.stops ?? []).map(s => s.date)).size === 2, [...new Set((trial?.itinerary?.stops ?? []).map(s => s.date))]);
      const activities = (trial?.itinerary?.stops ?? []).filter(stop => stop.role === "activity");
      check(row, "两个日期都有实质游玩且不重复充数", new Set(activities.map(stop => stop.date)).size === 2 && new Set(activities.map(stop => stop.nodeId)).size === activities.length);
      check(row, "没有把自动选候选留成用户问题", !value.final.result?.question && (trial?.planSummary?.needsContext ?? []).length === 0);
    }
    if (["T05", "T09"].includes(item.id)) {
      const q = value.final.result?.question;
      check(row, "形成稳定问题", q?.status === "open" && !!q.questionId, q ?? null);
      if (item.id === "T05") check(row, "优先询问缺失的出发日期", /日期|哪天|出发/.test(q?.question ?? ""), q ?? null);
      if (q) {
        const restored = await request({ ...client, base: peerBase }, `/api/runs/${value.final.runId}`);
        check(row, "另一API恢复同一问题", restored.result?.question?.questionId === q.questionId);
        if (item.id === "T05") {
          const answerTo = { runId: value.final.runId, questionId: q.questionId };
          const [a, b] = await Promise.all([startTurn(client, item.answer, { answerTo }), startTurn({ ...client, base: peerBase }, item.answer, { answerTo })]);
          check(row, "双击只创建一个回答任务", a.run.runId === b.run.runId);
          value = await finishTurn(client, a); row.turns.push(recordTurn(value));
          check(row, "回答只写入一次", value.conversation.messages.filter(m => m.role === "user" && m.text === item.answer).length === 1);
          check(row, "日期回答后自动形成草案", value.final.result?.itineraryTrial?.status === "trial_ready", value.final.result?.itineraryTrial?.status ?? null);
          check(row, "预算和目的地保留", value.state?.brief?.totalBudget === 6000 && value.state?.brief?.destination === "上海", value.state?.brief);
        } else if (value.state) {
          await request({ ...client, base: peerBase }, `/api/trips/${value.state.tripId}/scope`, { brief: { totalBudget: 8000 } });
          const updated = await request(client, `/api/runs/${value.final.runId}`);
          check(row, "原问题标记失效", updated.result?.question?.status === "stale");
          const oldAnswer = await request(client, `/api/conversations/${client.conversationId}/runs`, { requestId: randomUUID(), text: "2026年10月15日", answerTo: { runId: value.final.runId, questionId: q.questionId, ...(q.options[0] ? { optionId: q.options[0].optionId } : {}) } }, { allowError: true });
          check(row, "拒绝旧答案", oldAnswer.httpStatus >= 400 && oldAnswer.value.code === "question_stale", oldAnswer);
          check(row, "新预算不被覆盖", (await readState(client)).state?.brief?.totalBudget === 8000);
        }
      }
    }
    if (item.id === "T06") {
      check(row, "持久化无台阶或轮椅约束", (value.state?.travelers ?? []).some(t => t.careNeeds?.mobility?.avoidStairs === true || t.careNeeds?.mobility?.stepFreeRequired === true), value.state?.travelers);
      check(row, "未知无障碍路线不能标记可采用", value.final.result?.itineraryTrial?.status !== "trial_ready", value.final.result?.itineraryTrial?.status ?? null);
    }
    if (item.id === "T07") {
      check(row, "不提高100元预算", value.state?.brief?.totalBudget === 100, value.state?.brief);
      check(row, "超预算不能生成可采用草案", value.final.result?.itineraryTrial?.status !== "trial_ready", value.final.result?.itineraryTrial?.status ?? null);
      const budget = value.final.result?.itineraryTrial?.impact?.budget;
      const question = value.final.result?.question;
      check(row, "预算取舍问题使用包含市内交通的完整账本", Number.isFinite(budget?.estimated) && question?.question.includes(new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(budget.estimated)), { estimated: budget?.estimated, question: question?.question });
    }
    if (item.id === "T08") {
      if (providerFollowup && value.final.result?.question) {
        const question = value.final.result.question;
        check(row, "补充人数前是必要问题", /人|位|人数|同行/.test(question.question));
        value = await turn(client, providerFollowup, { answerTo: { runId: value.final.runId, questionId: question.questionId } });
        row.turns.push(recordTurn(value));
      }
      check(row, "用户目的地与预算已保存", value.state?.brief?.destination === "上海" && value.state?.brief?.totalBudget === 6000, value.state?.brief);
      check(row, "未使用测试Provider", providerReads.every(p => p.tripId !== value.state?.tripId));
      check(row, "缺少路线时不伪报完整核验", configured.AMAP_API_KEY || value.final.result?.itineraryTrial?.status !== "trial_ready", value.final.result?.outcome);
    }
    if (["B01", "B02"].includes(item.id)) {
      const trial = value.final.result?.itineraryTrial;
      const stops = trial?.itinerary?.stops ?? [];
      check(row, "形成实际可采用草案", trial?.status === "trial_ready" && trial.feasibility?.canConfirm === true, trial?.issues ?? trial?.status);
      check(row, "没有向用户转嫁候选比较", !value.final.result?.question && trial?.planSummary?.needsContext?.length === 0);
      check(row, "去程住宿与两餐齐备", stops.some(s => s.role === "intercity_arrival") && stops.some(s => s.role === "stay_check_in") && stops.filter(s => s.role === "meal").length === 2);
      if (item.id === "B01") {
        check(row, "保留600元且全部已排费用在预算内", value.state?.brief.totalBudget === 600 && trial?.impact?.budget?.estimated <= 600, trial?.impact?.budget);
        check(row, "选了更便宜的酒店并保留游玩", trial?.selectedNodes?.some(n => n.title === "测试·经济安静酒店" || n.title === "测试·街区酒店") && stops.some(s => s.role === "activity"));
      } else check(row, "不添加未受托的景点", stops.every(s => s.role !== "activity") && !(value.state?.brief.planningDomains ?? ["play"]).includes("play"));
    }
    completed.set(item.id, { client, value });
  } catch (error) { row.error = { code: error.code ?? error.message, httpStatus: error.httpStatus }; }
  row.automatedStatus = row.error || row.checks.some(c => !c.passed) ? "failed" : "passed";
  results.rows.push(row); await save();
  process.stdout.write(`${JSON.stringify({ id: row.id, status: row.automatedStatus, failedChecks: row.checks.filter(c => !c.passed).map(c => c.name), error: row.error, elapsedMs: row.turns.reduce((n, t) => n + t.totalMs, 0) })}\n`);
}
try {
  referenceBase = await startApp({ port: Number(process.env.TRAVEL_USER_TEST_PORT ?? 18900) });
  peerBase = await startApp({ role: "api" });
  liveBase = await startApp({ configuredProvider: true });
  await save();
  process.stdout.write(`${JSON.stringify({ ready: true, browserUrl: referenceBase, peerBase, liveBase, fixtureTravelOnlyOnBrowser: true, pid: process.pid })}\n`);
  // Two independent travelers at a time; no parallel writes to one conversation.
  for (let i = 0; i < casesToRun.length; i += 2) await Promise.all(casesToRun.slice(i, i + 2).map(runCase));
  const target = completed.get("T04") ?? completed.get("T02");
  if (target) {
    const stranger = await actor(peerBase), id = target.value.final.runId;
    const accesses = await Promise.all([request(stranger, `/api/runs/${id}`, undefined, { allowError: true }), request(stranger, `/api/trips/${target.value.state.tripId}/plan`, undefined, { allowError: true })]);
    const stream = await fetch(`${peerBase}/api/runs/${id}/events`, { headers: { cookie: stranger.cookie } }); await stream.body?.cancel();
    results.rows.push({ id: "T11", title: additionalCases[0].title, automatedStatus: accesses.every(a => a.httpStatus === 403) && stream.status === 403 ? "passed" : "failed", checks: [...accesses.map((a, i) => ({ name: i ? "跨用户计划被拒绝" : "跨用户运行记录被拒绝", passed: a.httpStatus === 403, actual: a.httpStatus })), { name: "跨用户事件被拒绝", passed: stream.status === 403, actual: stream.status }] });
  }
  const ready = [completed.get("T05"), completed.get("T04")].find(item => item?.value.final.result?.itineraryTrial?.status === "trial_ready");
  if (ready) {
    const row = { id: "T12", title: additionalCases[1].title, checks: [], turns: [], manualReview: "pending" };
    try {
      const { client, value } = ready, trial = value.final.result.itineraryTrial, tripId = value.state.tripId;
      const accepted = await request(client, `/api/trips/${tripId}/proposals/${trial.accept.proposalId}/accept`, trial.accept);
      const before = await readState(client);
      check(row, "明确采用已持久化", accepted.status === "committed" && selected(before.state).length > 0, accepted.status);
      const repeated = await request({ ...client, base: peerBase }, `/api/trips/${tripId}/proposals/${trial.accept.proposalId}/accept`, trial.accept, { allowError: true });
      const afterRepeat = await readState(client);
      check(row, "重复采用不重复新增", JSON.stringify(selected(before.state)) === JSON.stringify(selected(afterRepeat.state)), repeated.httpStatus);
      const adjustment = await turn(client, "把总预算改成3000元，已经采用的安排全部保留，只保存预算调整，不要重新排整个行程。");
      row.turns.push(recordTurn(adjustment));
      check(row, "预算更新到3000", adjustment.state.brief.totalBudget === 3000, adjustment.state.brief);
      check(row, "采用过的安排完整保留", JSON.stringify(selected(before.state)) === JSON.stringify(selected(adjustment.state)));
      check(row, "仅改预算保留已核验路线与站序", JSON.stringify(before.state.environment.mobility) === JSON.stringify(adjustment.state.environment.mobility));
      check(row, "仅改预算不把已排费用退回粗估", before.plan.budget.estimated === adjustment.plan.budget.estimated, { before: before.plan.budget.estimated, after: adjustment.plan.budget.estimated });
    } catch (error) { row.error = { code: error.code ?? error.message }; }
    row.automatedStatus = row.error || row.checks.some(c => !c.passed) ? "failed" : "passed"; results.rows.push(row);
  } else if (!selectedIds) results.rows.push({ id: "T12", automatedStatus: "blocked", reason: "No checked itinerary available from T04/T05; cannot claim adoption was tested." });
  results.apiFinishedAt = new Date().toISOString(); await save();
  process.stdout.write(`API scenarios complete: ${outputDir}/results.json\n`);
  if (process.env.TRAVEL_USER_TEST_KEEP_OPEN === "true") await new Promise(done => { process.once("SIGTERM", done); process.once("SIGINT", done); });
} finally {
  // Never export credentials, cookies, native hidden reasoning or private model context.
  await save();
  for (const app of apps) await app.locals.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await pool.end(); for (const extra of extraPools) await extra.end();
  for (const name of [schema, ...extraSchemas]) await admin.query(`DROP SCHEMA ${name} CASCADE`);
  await admin.end();
}
// A completed collection is not a passed acceptance run. Semantic judgments
// still require reviewing replies against the frozen user expectations.
if (results.rows.some(row => row.automatedStatus === "failed")) process.exitCode = 1;
