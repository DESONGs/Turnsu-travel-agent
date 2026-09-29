import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TravelService } from "../src/api/travel-service.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { TravelExecutionService } from "../src/agent/travel-execution-service.mjs";
import { withTravelExecution } from "../travel-agent-pi-package/src/host/execution-context.ts";
import { createTravelAgentSession, travelCheckpoint } from "../travel-agent-pi-package/src/host/travel-agent-session.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TravelExecutionDeferred } from "../travel-agent-pi-package/src/host/travel-decision-policy.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "travel-execution-"));
  const store = new TripStore({ rootDir: join(root, "trips") });
  const travelService = new TravelService({ store });
  const conversationRepository = new FileConversationRepository({ rootDir: join(root, "conversations") });
  const repository = new ExecutionRepository({ filename: join(root, "runs.sqlite") });
  const faux = fauxProvider({ provider: "fixture-pi", models: [{ id: "fixture-parent", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(faux.provider);
  const agent = new TravelConversationAgent({ travelService, conversationRepository, modelRuntime: { models, model: faux.getModel("fixture-parent") } });
  const worker = new TravelExecutionService({ repository, conversationAgent: agent, pollMs: 10 });
  const conversation = await agent.createConversation({ userId: "user_owner" });
  t.after(async () => { await worker.close(); await repository.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, conversationRepository, agent, worker, conversation, store, travelService, faux, models };
}

async function until(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error("condition_not_reached");
}

test("a retried command runs one native Parent; its tool receipts and checkpoint survive repository reopening", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州", totalBudget: 6000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("旅行要求已保存，尚未确认任何候选。"),
  ]);
  const input = { conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "request_once", text: "去杭州，预算6000" };
  const [a, b] = await Promise.all([f.worker.submit(input), f.worker.submit(input)]);
  assert.equal(a.runId, b.runId);
  const final = await f.worker.wait({ runId: a.runId, userId: "user_owner" });
  assert.equal(final.status, "completed");
  assert.equal((await f.store.list()).length, 1);
  assert.equal(final.result.conversation.messages.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(final.events.filter((event) => event.toolName === "save_trip_understanding").map((event) => event.status), ["running", "saved"]);
  await assert.rejects(f.worker.snapshot({ runId: a.runId, userId: "different_user" }), { code: "conversation_access_denied" });
  await assert.rejects(f.worker.submit({ ...input, text: "改成北京" }), { code: "execution_request_id_conflict" });
  const reopened = new ExecutionRepository({ filename: join(f.root, "runs.sqlite") });
  t.after(() => reopened.close());
  const persisted = await reopened.get(a.runId);
  assert.equal(persisted.checkpoint.schemaVersion, "travel-agent-session-v1");
  assert.ok(persisted.checkpoint.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  const replay = await reopened.events(a.runId, final.events[1].sequence);
  assert.ok(replay.every((event) => event.sequence > final.events[1].sequence));
  assert.doesNotMatch(JSON.stringify(final), /thinking|toolCall.*arguments|apiKey/);
});

test("two workers serialize one conversation and continue with native history plus current travel facts", async (t) => {
  const f = await fixture(t);
  const second = new TravelExecutionService({ repository: f.repository, conversationAgent: f.agent, pollMs: 10 });
  t.after(() => second.close());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = false;
  f.faux.setResponses([
    async () => { entered = true; await gate; return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州", totalBudget: 6000 }), { stopReason: "toolUse" }); },
    fauxAssistantMessage("已保存。"),
    (request) => {
      assert.ok(request.messages.some((message) => message.role === "toolResult"), "native history must survive into the next run");
      assert.match(request.systemPrompt, /杭州/);
      return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { totalBudget: 8000 }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("已更新预算。"),
  ]);
  const first = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "first", text: "去杭州，预算6000" });
  await until(() => entered);
  const next = await second.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "next", text: "预算改成8000" });
  await delay(40);
  assert.equal((await f.repository.get(next.runId)).status, "queued");
  release();
  assert.equal((await f.worker.wait({ runId: first.runId, userId: "user_owner" })).status, "completed");
  const final = await second.wait({ runId: next.runId, userId: "user_owner" });
  assert.equal(final.status, "completed");
  const trip = await f.travelService.getTripControlView(final.result.tripId);
  assert.equal(trip.brief.totalBudget, 8000);
  assert.equal((await f.store.list()).length, 1);
});

test("a cancellation blocks a late tool mutation at the persistence boundary", async (t) => {
  const f = await fixture(t);
  await f.worker.close();
  const run = (await f.repository.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "late", requestHash: "hash", input: { text: "规划" } })).run;
  const claimed = await f.repository.claim({ workerId: "worker_test", leaseMs: 30_000, globalLimit: 10, perUserLimit: 2 });
  const controller = new AbortController();
  const context = { ...claimed, signal: controller.signal, assertCurrent: () => f.repository.assertCurrent(claimed), emit: () => Promise.resolve() };
  await f.repository.cancel(run.runId);
  await assert.rejects(withTravelExecution(context, () => f.travelService.createTrip({ tripId: "trip_late", brief: { destination: "杭州" } })), { code: "execution_ownership_lost" });
  assert.equal(await f.store.get("trip_late"), null);
});

test("negative confirmation language preserves planning tools and cannot trigger a confirmation", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    (context) => {
      assert.ok(context.tools.some((tool) => tool.name === "save_trip_understanding"));
      assert.ok(context.tools.some((tool) => tool.name === "research_trip_options"));
      return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "上海" }), { stopReason: "toolUse" });
    }, fauxAssistantMessage("要求已保存，候选仍待比较。"),
  ]);
  const run = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "negative_confirmation", text: "去上海，没有任何已确认的住宿、车次或门票。只生成待比较方案，不确认、不购买。" });
  const final = await f.worker.wait({ runId: run.runId, userId: "user_owner" });
  assert.equal(final.status, "completed");
  assert.ok(final.result.tripId);
  assert.ok(final.events.every((event) => !["confirm_trip_selection", "confirm_user_arrival"].includes(event.toolName)));
});

test("a rejected save tool cannot be reported as a completed run even when model prose claims success", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "上海", totalBudget: "invalid amount" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("已经保存了全部要求。"),
  ]);
  const run = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "invalid_save", text: "去上海，预算6000" });
  const final = await f.worker.wait({ runId: run.runId, userId: "user_owner" });
  assert.equal(final.status, "failed");
  assert.equal(final.result.code, "agent_tool_failed");
  assert.equal((await f.store.list()).length, 0);
  assert.ok(final.events.some((event) => event.type === "tool_rejected"));
  assert.ok(!final.result.conversation.messages.some((message) => message.role === "assistant" && message.text.includes("已经保存")));
});

test("a saved question releases its worker and the next turn sees the question and answer", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_travel_question", { question: "这次想去哪里？", choices: ["杭州", "上海"] }), { stopReason: "toolUse" }),
    (context) => {
      assert.match(JSON.stringify(context.messages), /这次想去哪里/);
      assert.match(JSON.stringify(context.messages.at(-1)), /杭州/);
      return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("杭州草案已保存。"),
  ]);
  const first = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "question", text: "帮我安排三天旅行" });
  const waiting = await f.worker.wait({ runId: first.runId, userId: "user_owner" });
  assert.equal(waiting.status, "awaiting_input");
  assert.deepEqual(waiting.result.question.choices, ["杭州", "上海"]);
  const next = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "answer", text: "杭州" });
  const final = await f.worker.wait({ runId: next.runId, userId: "user_owner" });
  assert.equal(final.status, "completed");
  assert.equal((await f.travelService.getTripControlView(final.result.tripId)).brief.destination, "杭州");
});

test("image admission is bounded, retries remain idempotent, and raw image bytes never enter durable input or native history", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  f.faux.setResponses(Array.from({ length: 4 }, () => async () => { await gate; return fauxAssistantMessage("图片中的旅行需求已经理解。还没有确认任何安排。"); }));
  const commands = [];
  for (let index = 0; index < 5; index++) {
    const conversation = await f.agent.createConversation({ userId: "user_owner" });
    commands.push({ conversationId: conversation.conversationId, userId: "user_owner", requestId: `image_${index}`, text: "请理解旅行图片", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] });
  }
  const accepted = [];
  for (const command of commands.slice(0, 4)) accepted.push(await f.worker.submit(command));
  await assert.rejects(f.worker.submit(commands[4]), { code: "execution_image_capacity_full" });
  assert.equal((await f.worker.submit(commands[0])).runId, accepted[0].runId);
  release();
  for (const run of accepted) {
    const final = await f.worker.wait({ runId: run.runId, userId: "user_owner" });
    assert.equal(final.status, "completed");
    assert.doesNotMatch(JSON.stringify(await f.repository.get(run.runId)), /iVBORw0KGgo=/);
  }
});

test("lease expiration exposes an interruption and fences the old worker instead of replaying an uncertain tool", async (t) => {
  let now = Date.now();
  const repo = new ExecutionRepository({ filename: ":memory:", clock: () => now });
  t.after(() => repo.close());
  const original = (await repo.submit({ conversationId: "conversation_lease", userId: "user_1", requestId: "r1", requestHash: "h1", input: { text: "规划" } })).run;
  const claimed = await repo.claim({ workerId: "old_worker", leaseMs: 100, globalLimit: 2, perUserLimit: 2 });
  await repo.call(claimed, { callId: "uncertain_call", toolName: "save_trip_understanding", argsHash: "digest", status: "running" });
  now += 200;
  assert.equal(await repo.claim({ workerId: "replacement", leaseMs: 100, globalLimit: 2, perUserLimit: 2 }), null);
  assert.equal((await repo.get(original.runId)).status, "interrupted");
  await assert.rejects(repo.event(claimed, { type: "tool_finished", status: "completed" }), { code: "execution_ownership_lost" });
  const saved = await repo.get(original.runId);
  assert.equal(saved.result, null);
  assert.equal((await repo.query("SELECT status FROM travel_run_calls WHERE run_id=$1", [original.runId])).rows[0].status, "running");
});

test("API-only mode preserves ordinary queue waits and expires only the saved total deadline", async (t) => {
  let now = Date.now();
  const repository = new ExecutionRepository({ filename: ":memory:", clock: () => now });
  const run = (await repository.submit({ conversationId: "offline_workers", userId: "owner", requestId: "queued", requestHash: "hash", input: { text: "请规划" } })).run;
  const api = new TravelExecutionService({ repository, env: { TRAVEL_AGENT_EXECUTION_ROLE: "api" }, pollMs: 60_000, conversationAgent: { reply: () => { throw new Error("API must not execute a text run"); } } });
  t.after(async () => { await api.close(); await repository.close(); });
  now += 31_000;
  await api.pump();
  assert.equal((await repository.get(run.runId)).status, "queued");
  now += 210_000;
  await repository.claimMany({ workerId: "maintenance", leaseMs: 30_000, globalLimit: 10, perUserLimit: 2, count: 0 });
  assert.equal((await repository.get(run.runId)).status, "interrupted");
  assert.equal((await repository.events(run.runId)).at(-1).code, "execution_queue_timeout");
  assert.equal(api.active.size, 0);
});

test("question option IDs are consumed once across clients and a stale card cannot update new facts", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("ask_travel_question", { question: "预算包含往返交通吗？", choices: ["包含", "不包含"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("已记住预算范围，继续安排。"),
  ]);
  const first = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "ask_budget", text: "去杭州三天" });
  const waiting = await f.worker.wait({ runId: first.runId, userId: "user_owner" });
  const question = waiting.result.question;
  const answer = { conversationId: f.conversation.conversationId, userId: "user_owner", text: "untrusted client label", answerTo: { runId: first.runId, questionId: question.questionId, optionId: question.options[0].optionId } };
  const [a, b] = await Promise.all([f.worker.submit({ ...answer, requestId: "answer_a" }), f.worker.submit({ ...answer, requestId: "answer_b" })]);
  assert.equal(a.runId, b.runId);
  const done = await f.worker.wait({ runId: a.runId, userId: "user_owner" });
  assert.equal(done.result.conversation.messages.filter(x => x.role === "user" && x.text === "包含").length, 1);
  assert.equal((await f.worker.snapshot({ runId: first.runId, userId: "user_owner" })).result.question.status, "answered");
  await assert.rejects(f.worker.submit({ ...answer, requestId: "different_answer", answerTo: { ...answer.answerTo, optionId: question.options[1].optionId } }), { code: "question_already_answered" });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_travel_question", { question: "住市中心吗？", choices: ["是", "否"] }), { stopReason: "toolUse" })]);
  const next = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "ask_stay", text: "安排住宿" });
  const card = (await f.worker.wait({ runId: next.runId, userId: "user_owner" })).result.question;
  await f.travelService.updateTripScope({ tripId: done.result.tripId, brief: { destination: "上海" } });
  await assert.rejects(f.worker.submit({ ...answer, requestId: "old_card", answerTo: { runId: next.runId, questionId: card.questionId, optionId: card.options[0].optionId } }), { code: "question_stale" });
});

test("Parent capacity wait releases the Worker and resumes native history without repeating a saved mutation", async t => {
  const f = await fixture(t);
  let firstCall = true;
  const reserve = f.repository.reserveModel.bind(f.repository);
  f.repository.reserveModel = async (...args) => {
    if (firstCall) { firstCall = false; return null; }
    return reserve(...args);
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("杭州旅行要求已保存。"),
  ]);
  const run = await f.worker.submit({ conversationId: f.conversation.conversationId, userId: "user_owner", requestId: "capacity_wait", text: "去杭州" });
  await until(async () => (await f.repository.get(run.runId)).status === "queued" && (await f.repository.get(run.runId)).waitReason === "model_capacity");
  await until(() => f.worker.active.size === 0);
  const final = await f.worker.wait({ runId: run.runId, userId: "user_owner" });
  assert.equal(final.status, "completed");
  assert.equal((await f.store.list()).length, 1);
  assert.equal(final.result.conversation.messages.filter(x => x.role === "user").length, 1);
  assert.ok(final.events.some(x => x.type === "run_deferred"));
});

test("native checkpoints omit images and thinking and never restore half a tool transaction", () => {
  const manager = SessionManager.inMemory("/travel", { id: "conversation_private" });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "看这张风景" }, { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" }], timestamp: Date.now() });
  const output = fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州" }), { stopReason: "toolUse" });
  output.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
  manager.appendMessage(output);
  const checkpoint = travelCheckpoint(manager, "conversation_private", () => false);
  assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE_IMAGE_BYTES|PRIVATE_THINKING/);
  assert.ok(!checkpoint.entries.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
});

test("native compaction preserves a recoverable summary and its fact revision, then resumes", async () => {
  const faux = fauxProvider({ provider: "fixture-compact", models: [{ id: "compact" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("已记住杭州三日旅行，父亲需要少步行。"), fauxAssistantMessage("预算保持8000。"), fauxAssistantMessage("目标：杭州三日。父亲少步行。尚未确认住宿；下一步比较有来源的住宿。"), fauxAssistantMessage("我会沿用父亲少步行的要求。")]);
  const native = await createTravelAgentSession({ conversationId: "conversation_compact", models, model: faux.getModel("compact"), systemPrompt: "Current travel facts: Hangzhou; revision 7; no confirmed stay.", thinkingLevel: "off", tools: [], facts: async () => ({ tripId: "trip_compact", revision: 7 }), isSensitive: () => false });
  try {
    await native.session.prompt("杭州三天，父亲少步行。".repeat(2000), { expandPromptTemplates: false });
    await native.session.prompt("预算8000，不要自动确认。".repeat(1400), { expandPromptTemplates: false });
    await native.session.compact();
    const checkpoint = native.checkpoint();
    const summary = checkpoint.entries.find((entry) => entry.type === "compaction");
    assert.equal(summary.details.factRevision, 7);
    assert.match(summary.summary, /少步行/);
    const resumed = await createTravelAgentSession({ conversationId: "conversation_compact", models, model: faux.getModel("compact"), systemPrompt: "Current travel facts: Hangzhou; revision 8; budget 8000.", thinkingLevel: "off", tools: [], checkpoint, isSensitive: () => false });
    try {
      assert.match(JSON.stringify(resumed.session.agent.state.messages), /少步行/);
      assert.match(resumed.session.systemPrompt, /revision 8/);
      await resumed.session.prompt("继续", { expandPromptTemplates: false });
    } finally { resumed.session.dispose(); }
  } finally { native.session.dispose(); }
});

test("a new request carries the travel objective without replaying large historical tool reports", async () => {
  const faux = fauxProvider({ provider: "fixture-handoff", models: [{ id: "handoff" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const manager = SessionManager.inMemory("/travel", { id: "conversation_handoff" });
  manager.appendMessage({ role: "user", content: "杭州三天，父亲需要全程无台阶。只比较，不能擅自采用。", timestamp: Date.now() });
  const call = fauxToolCall("research_trip_options", { domains: ["stay"] });
  manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify({ status: "proposed", evidence: "SUPERSEDED_DETAIL ".repeat(3500) }) }], isError: false, timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("酒店候选已保存；无台阶设施尚未核验，没有采用。"));
  const original = travelCheckpoint(manager, "conversation_handoff", () => false);
  let compactions = 0;
  faux.setResponses([
    request => {
      compactions++;
      assert.match(JSON.stringify(request.messages), /全程无台阶/);
      return fauxAssistantMessage("目标：杭州三天，父亲全程无台阶。只比较，不得擅自采用。已完成酒店研究，设施仍未知；候选与证据以当前 Trip 为准。不要重复已完成的写入。");
    },
    request => {
      const text = JSON.stringify(request.messages);
      assert.doesNotMatch(text, /SUPERSEDED_DETAIL/);
      assert.match(text, /全程无台阶/);
      assert.match(text, /预算改成3000/);
      assert.match(request.systemPrompt, /"revision":8/);
      return fauxAssistantMessage("我会按新的3000元预算继续比较，保留无台阶要求，不会自动采用。");
    },
  ]);
  const options = { conversationId: "conversation_handoff", models, model: faux.getModel("handoff"), systemPrompt: "Travel Parent", thinkingLevel: "off", tools: [], facts: async () => ({ tripId: "trip_handoff", revision: 8, totalBudget: 3000 }), isSensitive: () => false };
  const native = await createTravelAgentSession({ ...options, checkpoint: original });
  try {
    await native.prepareNewTurn();
    assert.equal(compactions, 1);
    const compacted = native.checkpoint();
    assert.ok(compacted.entries.some(entry => entry.type === "compaction"));
    assert.match(JSON.stringify(original), /SUPERSEDED_DETAIL/, "the prior run's audit checkpoint is untouched");
    const resumed = await createTravelAgentSession({ ...options, checkpoint: compacted });
    try {
      await resumed.prepareNewTurn();
      assert.equal(compactions, 1, "an already compacted handoff needs no second summary call");
      await resumed.session.prompt("预算改成3000", { expandPromptTemplates: false });
    } finally { resumed.session.dispose(); }
  } finally { native.session.dispose(); }
});

test("a capacity wait during context handoff does not consume the new user request", async t => {
  const f = await fixture(t);
  const manager = SessionManager.inMemory("/travel", { id: f.conversation.conversationId });
  manager.appendMessage({ role: "user", content: "只比较杭州酒店，不要自动采用。", timestamp: Date.now() });
  const call = fauxToolCall("research_trip_options", { domains: ["stay"] });
  manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "OLD_REPORT ".repeat(5000) }], isError: false, timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("比较结果已保存，没有采用。"));
  const continuation = { schemaVersion: "travel-continuation-v1", steps: {}, turn: {}, pending: null };
  let checkpoint = travelCheckpoint(manager, f.conversation.conversationId, () => false);
  const signal = new AbortController().signal;
  let available = false;
  const context = {
    runId: "run_handoff_wait", workerId: "test", fence: 1, signal,
    assertCurrent: async () => {}, emit: async () => {},
    reserveModel: async () => {
      if (!available) {
        context.defer = { notBefore: Date.now() + 1000, waitReason: "model_capacity" };
        throw new TravelExecutionDeferred(context.defer.notBefore);
      }
      return async () => {};
    },
  };
  const reply = () => withTravelExecution(context, () => f.agent.reply({
    conversationId: f.conversation.conversationId, userId: "user_owner", text: "杭州预算改成3000元，只保存要求，不需要研究。",
    execution: { runId: context.runId, signal, checkpoint, continuation, saveContinuation: async () => {}, saveCheckpoint: async value => { checkpoint = value; }, call: async () => {}, emit: async () => {} },
  }));
  assert.equal((await reply()).status, "deferred");
  assert.equal(continuation.turn.hasPrompt, false);
  assert.doesNotMatch(JSON.stringify(checkpoint), /杭州预算改成3000元/);
  available = true;
  context.defer = null;
  f.faux.setResponses([
    fauxAssistantMessage("目标是比较杭州酒店，未授权采用。此前比较已完成；当前旅行事实须重新读取。"),
    request => {
      assert.match(JSON.stringify(request.messages), /杭州预算改成3000元/);
      assert.doesNotMatch(JSON.stringify(request.messages), /OLD_REPORT/);
      return fauxAssistantMessage(fauxToolCall("save_trip_understanding", { destination: "杭州", totalBudget: 3000, requestedWork: "save_only" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("预算已更新为3000元，没有研究或采用安排。"),
  ]);
  const result = await reply();
  assert.equal(result.status, "completed");
  assert.equal((await f.travelService.getTripControlView(result.tripId)).brief.totalBudget, 3000);
  assert.equal(result.conversation.messages.filter(message => message.role === "user").length, 1);
  assert.equal(result.activities.filter(activity => activity.toolName === "save_trip_understanding").length, 1);
});

test("a later planning snapshot supersedes old payloads in model context while both receipts remain recoverable", async () => {
  const faux = fauxProvider({ provider: "fixture-snapshots", models: [{ id: "snapshots" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const manager = SessionManager.inMemory("/travel", { id: "conversation_snapshots" });
  manager.appendMessage({ role: "user", content: "完整规划，预算不超过3000，午餐要保留。", timestamp: Date.now() });
  for (const [revision, evidence] of [[1, "OLD_CANDIDATE_DATA ".repeat(1200)], [2, "CURRENT_CANDIDATE_WITH_UNKNOWN_ACCESSIBILITY"]]) {
    const call = fauxToolCall("get_trip_plan_view", {});
    manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify({ tripId: "trip_snapshot", baseRevision: revision, status: "planning_context_ready", evidence }) }], isError: false, timestamp: Date.now() });
  }
  const native = await createTravelAgentSession({ conversationId: "conversation_snapshots", models, model: faux.getModel("snapshots"), systemPrompt: "Travel Parent", thinkingLevel: "off", tools: [], checkpoint: travelCheckpoint(manager, "conversation_snapshots", () => false), isSensitive: () => false });
  faux.setResponses([request => {
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD_CANDIDATE_DATA/);
    assert.match(JSON.stringify(request.messages), /CURRENT_CANDIDATE_WITH_UNKNOWN_ACCESSIBILITY/);
    assert.match(JSON.stringify(request.messages), /午餐要保留/);
    const old = request.messages.find(message => message.role === "toolResult");
    assert.match(JSON.stringify(old.content), /supersededByToolCallId/);
    return fauxAssistantMessage("继续使用当前候选，保留午餐与预算；无障碍仍未知。");
  }]);
  try {
    await native.session.prompt("请继续比较。", { expandPromptTemplates: false });
    assert.match(JSON.stringify(native.checkpoint()), /OLD_CANDIDATE_DATA/, "projection is not deletion of the execution's receipts");
  } finally { native.session.dispose(); }
});

test("native compaction between tool rounds leaves room to deliver without repeating completed reads", async () => {
  const faux = fauxProvider({ provider: "fixture-rounds", models: [{ id: "rounds" }] });
  const models = createModels(); models.setProvider(faux.provider);
  let reads = 0, summaries = 0, requests = 0;
  const parameters = { type: "object", properties: {}, required: [], additionalProperties: false };
  const tools = [{ name: "read_travel_evidence", label: "Read evidence", description: "Read travel evidence", parameters, execute: async () => { reads++; return { content: [{ type: "text", text: "OLDER_EVIDENCE ".repeat(4500) }] }; } },
    { name: "check_travel_plan", label: "Check plan", description: "Check travel plan", parameters, execute: async () => ({ content: [{ type: "text", text: "当前核验：预算内，电梯资料仍未知，草案已保存但不可采用。" }] }) }];
  const native = await createTravelAgentSession({ conversationId: "conversation_rounds", models, model: faux.getModel("rounds"), systemPrompt: "Travel Parent", thinkingLevel: "off", tools, isSensitive: () => false });
  const respond = request => {
    if (!request.tools?.length) {
      summaries++;
      return fauxAssistantMessage("用户要完整草案，预算3000且必须无台阶。读取已完成，只能用有来源证据，资料未知时不得采用。继续根据保留的核验回执交付，不重复读取。");
    }
    requests++;
    if (requests < 3) {
      const message = fauxAssistantMessage(fauxToolCall(requests === 1 ? "read_travel_evidence" : "check_travel_plan", {}), { stopReason: "toolUse" });
      message.usage.input = 34_000;
      return message;
    }
    assert.match(JSON.stringify(request.messages), /预算3000/);
    assert.match(JSON.stringify(request.messages), /电梯资料仍未知/);
    assert.doesNotMatch(JSON.stringify(request.messages), /OLDER_EVIDENCE/);
    return fauxAssistantMessage("草案已保留，预算在3000元内；电梯资料尚未核验，暂不能采用。");
  };
  faux.setResponses(Array.from({ length: 8 }, () => respond));
  try {
    await native.session.prompt("完整草案，预算3000，必须无台阶。", { expandPromptTemplates: false });
    assert.equal(reads, 1);
    assert.ok(summaries >= 1);
    assert.equal(requests, 3);
    assert.match(JSON.stringify(native.session.messages.at(-1)), /暂不能采用/);
    assert.ok(native.checkpoint().entries.some(entry => entry.type === "compaction"));
  } finally { native.session.dispose(); }
});
