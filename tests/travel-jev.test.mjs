import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createJevClient, validateJevResponse } from "../travel-agent-pi-package/src/host/jev-client.ts";
import { buildJudgmentSnapshot, createTravelJudgment, judgmentBatches, JUDGMENT_TEMPLATE } from "../travel-agent-pi-package/src/host/travel-judgment.ts";
import { withTravelExecution } from "../travel-agent-pi-package/src/host/execution-context.ts";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { createTravelService } from "../src/api/create-travel-service.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { TravelExecutionService } from "../src/agent/travel-execution-service.mjs";
import { researchFixture, judgmentResponse } from "./fixtures/jev-travel.mjs";
import { planningProvider, planningResponse } from "./fixtures/jev-planning.mjs";

const command = id => ({ conversationId: `conversation_${id}`, userId: id, requestId: id, requestHash: id, input: { text: "比较" } });
const claim = { workerId: "worker_test", leaseMs: 240_000, globalLimit: 500, perUserLimit: 2 };
const snapshot = () => buildJudgmentSnapshot({ ownerId: "user_a", tripId: "trip_a", baseRevision: 1, criteriaFingerprint: "criteria", objective: "更喜欢当地体验", brief: { destination: "上海", totalBudget: 6000 }, providerResult: researchFixture() });

test("a changed candidate recomputes its batch while unrelated completed judgments remain reusable", async () => {
  const source = snapshot();
  const batches = judgmentBatches(source);
  assert.ok(batches.length > 1);
  const changed = structuredClone(source);
  changed.candidates[0].summary = "没有足够证据证明当地体验，需要重新判断";
  const cache = new Map(); let calls = 0;
  const judgment = createTravelJudgment({ TYPESAFE_API_KEY: "fixture", TRAVEL_AGENT_JEV_MODE: "shadow" }, {
    fetchImpl: async (_url, options) => { calls++; return Response.json(judgmentResponse(JSON.parse(options.body))); },
  });
  const context = { runId: "run_batch", userId: "user_a", workerId: "fixture", fence: 1, signal: new AbortController().signal, assertCurrent: async () => {}, emit: async () => {}, reserveJudgment: async () => async () => {},
    readStep: async (key, hash, execute) => { if (cache.get(key)?.hash === hash) return cache.get(key).value; const value = await execute(); cache.set(key, { hash, value }); return value; } };
  await withTravelExecution(context, async () => {
    assert.equal((await judgment.evaluate(source)).status, "evaluated");
    const before = calls;
    assert.equal((await judgment.evaluate(changed)).status, "evaluated");
    assert.equal(calls, before + 1);
    await judgment.evaluate(changed);
    assert.equal(calls, before + 1);
    await judgment.evaluate({ ...changed, ownerId: "another_user" });
    assert.equal(calls, before + 1 + batches.length, "another user cannot reuse these scoped judgments");
  });
});

test("a calibrated local comparison preserves facts, caches identical evidence and delegates changed hard requirements", async t => {
  const root = await mkdtemp(join(tmpdir(), "travel-jev-comparison-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createTravelService({}, { store: new TripStore({ rootDir: root }), analysisFanout: false, researchProvider: planningProvider() });
  await service.createTrip({ tripId: "trip_compare", ownerUserId: "owner", brief: { destination: "上海", totalBudget: 6000 }, travelers: [{ travelerId: "traveler_1", displayName: "你" }] });
  await service.researchTripOptions({ tripId: "trip_compare", question: "找吃住行玩候选", domains: ["play", "food", "stay", "transport"] });
  let calls = 0;
  service.judgment = createTravelJudgment({ TYPESAFE_API_KEY: "fixture", TRAVEL_AGENT_JEV_MODE: "auto" }, { calibration: { [JUDGMENT_TEMPLATE]: { zh: { model: "jev-1.13.0", validatedLive: true, datasetHash: "f".repeat(64), threshold: .95 } } },
    fetchImpl: async (_url, options) => { calls++; const body = JSON.parse(options.body); return Response.json(judgmentResponse(body, { scope: body.state.objective.includes("预算") ? "planning" : "compare" })); } });
  const context = { runId: "run_compare", userId: "owner", workerId: "fixture", fence: 1, signal: new AbortController().signal, assertCurrent: async () => {}, emit: async () => {}, reserveJudgment: async () => async () => {} };
  const original = await service.getTripControlView("trip_compare");
  const compare = objective => withTravelExecution(context, () => service.compareTripCandidates({ tripId: "trip_compare", objective }));
  assert.equal((await compare("更喜欢安静的"))?.status, "compared");
  const initialCalls = calls;
  assert.ok(initialCalls > 0);
  assert.equal((await compare("更喜欢安静的"))?.status, "compared");
  assert.equal(calls, initialCalls, "identical fresh comparison uses the persisted result");
  assert.equal(await compare("预算改成5000"), null);
  const current = await service.getTripControlView("trip_compare");
  assert.equal(current.revision, original.revision);
  assert.equal(current.brief.totalBudget, 6000);
  const plan = await service.getTripPlanView("trip_compare");
  assert.ok(Object.values(plan.byDomain).flat().every(node => !node.selected));
  assert.equal(Object.values(plan.pendingProposals[0].byDomain).flat().length, 12);
});

for (const needsAnswer of [false, true]) test(`native product path reaches a checked draft and adoption${needsAnswer ? " after one answer" : " without a question"}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "travel-jev-path-"));
  const repository = new ExecutionRepository({ filename: join(root, "execution.sqlite") });
  let jevCalls = 0, routeCalls = 0;
  const reserveModel = repository.reserveModel.bind(repository);
  let modelAttempts = 0;
  repository.reserveModel = (...args) => !needsAnswer && ++modelAttempts === 5 ? Promise.resolve(null) : reserveModel(...args);
  const service = createTravelService({ TYPESAFE_API_KEY: "fixture", TRAVEL_AGENT_JEV_MODE: "auto" }, {
    store: new TripStore({ rootDir: join(root, "trips") }), researchProvider: planningProvider({ onRoute: () => routeCalls++ }),
    judgmentOptions: { fetchImpl: async (_url, options) => { jevCalls++; return Response.json(judgmentResponse(JSON.parse(options.body), { scope: "planning" })); } },
  });
  const faux = fauxProvider({ provider: "fixture-planning", models: [{ id: "parent" }] });
  const models = createModels(); models.setProvider(faux.provider);
  let stoppedAtComparison = false;
  faux.setResponses(Array.from({ length: 25 }, () => context => {
    if (!needsAnswer && !stoppedAtComparison && (context.messages.at(-1)?.toolName === "research_trip_options" || JSON.stringify(context.messages.at(-1)).includes("deferred read has finished"))) {
      stoppedAtComparison = true;
      return fauxAssistantMessage("候选已比较，可以查看。");
    }
    return planningResponse(context);
  }));
  const agent = new TravelConversationAgent({ travelService: service, conversationRepository: new FileConversationRepository({ rootDir: join(root, "conversations") }), modelRuntime: { models, model: faux.getModel("parent") } });
  const worker = new TravelExecutionService({ repository, conversationAgent: agent, pollMs: 10 });
  t.after(async () => { await worker.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  const conversation = await agent.createConversation({ userId: "path_owner" });
  let run = await worker.submit({ conversationId: conversation.conversationId, userId: "path_owner", requestId: "initial", text: `上海一天预算6000，做完整行程。${needsAnswer ? "日期还没定" : "2026年10月15日出发"}` });
  let result = await worker.wait({ runId: run.runId, userId: "path_owner", signal: AbortSignal.timeout(20000) });
  if (needsAnswer) {
    assert.equal(result.status, "awaiting_input", JSON.stringify(result));
    const question = result.result.question;
    run = await worker.submit({ conversationId: conversation.conversationId, userId: "path_owner", requestId: "answer", answerTo: { runId: run.runId, questionId: question.questionId, optionId: question.options[0].optionId } });
    result = await worker.wait({ runId: run.runId, userId: "path_owner", signal: AbortSignal.timeout(20000) });
  }
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.result.itineraryTrial?.status, "trial_ready", JSON.stringify(result.result));
  const plan = await service.getTripPlanView(result.result.tripId);
  assert.ok(jevCalls > 0); assert.equal(routeCalls, 1);
  assert.equal(result.events.filter(event => event.type === "tool_started" && event.toolName === "get_trip_plan_view").length, 1, "model capacity resume reuses the completed planning context");
  assert.ok(Object.values(plan.byDomain).flat().every(node => !node.selected));
  const adopted = await service.acceptTripChange({ ...result.result.itineraryTrial.accept, tripId: plan.tripId });
  assert.equal(adopted.status, "committed", JSON.stringify(adopted));
  assert.equal(routeCalls, 1, "adoption reuses the reviewed route evidence");
});

test("HTTP contract rejects incomplete or invented answers; batches retain every candidate and hard requirement", () => {
  const source = snapshot();
  const batches = judgmentBatches(source);
  assert.equal(batches.flatMap(batch => batch.ids).length, 12);
  assert.ok(batches.every(batch => batch.state.brief.totalBudget === 6000));
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify({ model: "jev-1.13.0", state: batch.state, questions: batch.questions })) <= 12000));
  const body = batches[0];
  assert.equal(validateJevResponse(judgmentResponse(body), body.questions).model, "jev-1.13.0");
  const wrong = judgmentResponse(body); delete wrong.answers.scope;
  assert.throws(() => validateJevResponse(wrong, body.questions), { code: "jev_response_invalid" });
  const invented = judgmentResponse(body); invented.answers.scope.choice = "commit_trip";
  assert.throws(() => validateJevResponse(invented, body.questions), { code: "jev_response_invalid" });
});

test("one account smooths starts, records unknown usage, isolates trips and enforces rolling normal/retry budgets", async t => {
  let now = Date.now();
  const repo = new ExecutionRepository({ filename: ":memory:", clock: () => now });
  t.after(() => repo.close());
  await repo.submit(command("one")); await repo.submit(command("two"));
  const [a, b] = await repo.claimMany({ ...claim, count: 2 });
  const first = await repo.reserveJudgment(a, { reservedTokens: 12000 });
  assert.ok(first.callId);
  const waiting = await repo.reserveJudgment(b, { reservedTokens: 12000 });
  assert.ok(waiting.notBefore > now);
  await repo.finishModel(first.callId);
  now += 56;
  assert.ok((await repo.reserveJudgment(b, { reservedTokens: 12000 })).callId);
  const accounting = (await repo.query("SELECT input_tokens,reserved_tokens FROM travel_model_calls WHERE call_id=$1", [first.callId])).rows[0];
  assert.equal(accounting.input_tokens, null); assert.equal(accounting.reserved_tokens, 12000);
  await repo.cooldownJudgment(now + 20_000);
  assert.equal((await repo.reserveJudgment(a, { reservedTokens: 100, retry: true })).notBefore, now + 20_000);
  now += 21_000;
  await repo.query("UPDATE travel_model_calls SET status='finished',lease_until=0");
  for (let i = 0; i < 1078; i++) await repo.query("INSERT INTO travel_model_calls(call_id,run_id,scope,created_at,lease_until,reserved_tokens,status) VALUES($1,$2,'typesafe_account',$3,0,1,'finished')", [`filled_${i}`, a.runId, now - 1000]);
  const denied = await repo.reserveJudgment(b, { reservedTokens: 100, runCalls: 2000, runTokens: 1_000_000 });
  assert.ok(denied.notBefore > now, "normal requests cannot spend the reserved retry/margin budget");
  assert.ok((await repo.reserveJudgment(b, { reservedTokens: 100, retry: true, runCalls: 2000, runTokens: 1_000_000 })).callId);
});

test("Jev refuses calls outside durable accounting and a new template cannot auto-advance on confidence alone", async () => {
  const client = createJevClient({ apiKey: "fixture" });
  await assert.rejects(client({}, {}), { code: "jev_durable_run_required" });
  let calls = 0;
  const judgment = createTravelJudgment({ TYPESAFE_API_KEY: "fixture", TRAVEL_AGENT_JEV_MODE: "auto" }, { fetchImpl: async (_url, options) => { calls++; return Response.json(judgmentResponse(JSON.parse(options.body))); } });
  const result = await withTravelExecution({ runId: "run_fixture", workerId: "worker", fence: 1, signal: new AbortController().signal, assertCurrent: async () => {}, emit: async () => {}, reserveJudgment: async () => async () => {} }, () => judgment.evaluate(snapshot()));
  assert.ok(calls > 0); assert.equal(result.status, "evaluated"); assert.equal(result.automatic, false);
  assert.ok(result.judgments.every(item => !item.eligible));
});

test("native Parent resumes a deferred Jev step after restart, reuses Provider facts and continues the same question", async t => {
  const root = await mkdtemp(join(tmpdir(), "travel-jev-"));
  const repository = new ExecutionRepository({ filename: join(root, "execution.sqlite") });
  const store = new TripStore({ rootDir: join(root, "trips") });
  const conversationRepository = new FileConversationRepository({ rootDir: join(root, "conversations") });
  let providerCalls = 0, httpCalls = 0;
  const requestedIds = new Set();
  const travelService = createTravelService({ TYPESAFE_API_KEY: "fixture", TRAVEL_AGENT_JEV_MODE: "auto" }, { store, researchProvider: { status: "configured", research: async () => { providerCalls++; return researchFixture(); } }, judgmentOptions: { fetchImpl: async (_url, options) => {
    httpCalls++;
    if (httpCalls === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    const body = JSON.parse(options.body); body.state.candidates.forEach(item => requestedIds.add(item.candidateId));
    return Response.json(judgmentResponse(body));
  } } });
  const faux = fauxProvider({ provider: "fixture-jev-parent", models: [{ id: "parent" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const agent = new TravelConversationAgent({ travelService, conversationRepository, modelRuntime: { models, model: faux.getModel("parent") } });
  let worker = new TravelExecutionService({ repository, conversationAgent: agent, pollMs: 10 });
  t.after(async () => { await worker.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  const conversation = await agent.createConversation({ userId: "owner" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "上海", totalBudget: 6000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("research_trip_options", { question: "比较当地体验", domains: ["play", "food", "stay", "transport"] }), { stopReason: "toolUse" }),
    request => { assert.match(JSON.stringify(request.messages), /travel-operation-result|deferred read has finished/); return fauxAssistantMessage(fauxToolCall("ask_travel_question", { question: "具体哪天出发？", choices: ["10月1日", "10月2日"] }), { stopReason: "toolUse" }); },
  ]);
  const run = await worker.submit({ conversationId: conversation.conversationId, userId: "owner", requestId: "research", text: "去上海，预算6000，推荐吃住行玩" });
  const until = Date.now() + 5000;
  while ((await repository.get(run.runId)).waitReason !== "jev_rate_limited") { if (Date.now() > until) throw new Error(JSON.stringify(await repository.get(run.runId))); await delay(10); }
  await worker.close();
  worker = new TravelExecutionService({ repository, conversationAgent: agent, pollMs: 10 });
  const completed = await worker.wait({ runId: run.runId, userId: "owner", signal: AbortSignal.timeout(15_000) });
  assert.equal(completed.status, "awaiting_input", JSON.stringify(completed.result));
  assert.equal(providerCalls, 1, "capacity retry must not repeat successful research");
  assert.equal(requestedIds.size, 12, "third candidates must not disappear before comparison");
  assert.equal((await store.list()).length, 1);
  assert.equal(completed.result.conversation.messages.filter(item => item.role === "user").length, 1);
  const receipt = await repository.get(run.runId);
  assert.equal(receipt.expiresAt, run.expiresAt);
  assert.match(JSON.stringify(receipt.checkpoint), /travel-operation-result/);
  assert.equal((await repository.query("SELECT COUNT(*) AS n FROM travel_model_calls WHERE call_kind='retry'")).rows[0].n, 1);
  const facts = await travelService.getTripControlView(completed.result.tripId);
  assert.equal(facts.brief.totalBudget, 6000);
  assert.ok((await travelService.getTripPlanView(completed.result.tripId)).pendingProposals.length === 1);
});
