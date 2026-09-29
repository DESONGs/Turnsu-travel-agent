import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";
import { executionWrite } from "../src/persistence/execution-write.mjs";
import { withTravelExecution } from "../travel-agent-pi-package/src/host/execution-context.ts";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { PostgresConversationRepository } from "../src/persistence/postgres-conversation-repository.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { TravelExecutionService } from "../src/agent/travel-execution-service.mjs";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const databaseUrl = process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL;
async function database(t) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/travel_execution_test", "only the isolated local test database is allowed");
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  const schema = `fault_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const a = new ExecutionRepository({ databaseUrl: url.toString() });
  const b = new ExecutionRepository({ databaseUrl: url.toString() });
  await a.migrate(); await b.migrate();
  await a.query("CREATE TABLE write_observer(value TEXT)");
  t.after(async () => { await a.close(); await b.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return { a, b };
}
const command = (id) => ({ conversationId: `conversation_${id}`, userId: "owner", requestId: id, requestHash: id, input: { text: "请查看当前计划" }, workerId: "api_1" });
const claim = (workerId) => ({ workerId, leaseMs: 30_000, globalLimit: 500, perUserLimit: 2 });

test("PostgreSQL: independent workers share Jev starts, cooldown and a persisted deferred step", { skip: !databaseUrl }, async t => {
  const { a, b } = await database(t);
  await a.submit(command("jev_a")); await b.submit({ ...command("jev_b"), userId: "second_owner" });
  const [one, two] = await a.claimMany({ ...claim("worker_a"), count: 2 });
  // Leave exactly one account slot. Wall-clock scheduling is not guaranteed to
  // start two promises within the 56 ms pacing interval on a loaded machine.
  await a.query("INSERT INTO travel_model_calls(call_id,run_id,scope,created_at,lease_until,reserved_tokens,status) SELECT 'prefill_'||n,$1,'typesafe_account',FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-2000,0,1,'finished' FROM generate_series(1,1079) n", [one.runId]);
  const starts = await Promise.all([a.reserveJudgment(one, { reservedTokens: 12000, runCalls: 2000 }), b.reserveJudgment(two, { reservedTokens: 12000 })]);
  assert.equal(starts.filter(item => item.callId).length, 1);
  const call = starts.find(item => item.callId);
  await b.finishModel(call.callId);
  const until = Date.now() + 10000;
  await a.cooldownJudgment(until);
  assert.ok((await b.reserveJudgment(two, { reservedTokens: 100, retry: true })).notBefore >= until);
  await a.defer(one, { notBefore: until, waitReason: "jev_capacity", checkpoint: null, continuation: { schemaVersion: "travel-continuation-v1", steps: { evidence: { value: "already_read" } }, turn: {} } });
  const saved = await b.get(one.runId);
  assert.equal(saved.status, "queued"); assert.equal(saved.workerId, null);
  assert.equal(saved.continuation.steps.evidence.value, "already_read");
  await assert.rejects(a.assertCurrent(one), { code: "execution_ownership_lost" });
  assert.equal((await b.claimMany({ ...claim("worker_b"), count: 5 })).length, 0);
  await b.cancel(one.runId);
  assert.equal((await a.get(one.runId)).status, "cancelled");
});

test("PostgreSQL: two independent pools admit one command, preserve cancellation and reject a fenced writer", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  const accepted = await Promise.all([a.submit(command("once")), b.submit(command("once"))]);
  assert.equal(accepted[0].run.runId, accepted[1].run.runId);
  assert.deepEqual(accepted.map((row) => row.duplicate).sort(), [false, true]);
  const run = await a.claim(claim("worker_a"));
  const context = { ...run, signal: new AbortController().signal, assertCurrent: () => a.assertCurrent(run), emit: (event) => a.event(run, event) };
  await withTravelExecution(context, () => executionWrite(a.pool, (db) => db.query("INSERT INTO write_observer(value) VALUES('before_cancel')")));
  await b.cancel(run.runId);
  await assert.rejects(withTravelExecution(context, () => executionWrite(a.pool, (db) => db.query("INSERT INTO write_observer(value) VALUES('late_write')"))), { code: "execution_ownership_lost" });
  assert.equal((await a.finish(run, "completed", { status: "completed" })).status, "cancelled");
  assert.deepEqual((await b.query("SELECT value FROM write_observer")).rows, [{ value: "before_cancel" }]);
  assert.equal((await b.get(run.runId)).result, null, "cancelled work must not publish a late successful result");
});

test("PostgreSQL: expired ownership cannot publish success even before a replacement Worker polls", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  await a.submit(command("expiry"));
  const run = await a.claim(claim("worker_a"));
  await b.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [run.runId, Date.now() - 1]);
  await assert.rejects(a.assertCurrent(run), { code: "execution_ownership_lost" });
  assert.equal((await a.finish(run, "completed", { status: "completed" })).status, "interrupted");
  assert.equal((await b.get(run.runId)).result, null);
});

test("PostgreSQL: Parent, Child and compaction share account capacity and a durable run budget", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  await a.submit(command("parent")); await a.submit(command("child"));
  const [parent, child] = await a.claimMany({ ...claim("worker_a"), count: 2 });
  const limits = { scope: "same_paid_account", reservedTokens: 100, concurrency: 1, rpm: 2, tpm: 500, runCalls: 2, runTokens: 300 };
  const held = await a.reserveModel(parent, limits);
  assert.ok(held.callId);
  assert.equal((await b.reserveModel(child, limits)).waitReason, "model_capacity", "another process must see the held account permit");
  await b.finishModel(held.callId, { input: 20, output: 10 });
  const second = await b.reserveModel(child, limits);
  assert.ok(second.callId);
  await b.finishModel(second.callId);
  assert.equal((await a.reserveModel(parent, limits)).waitReason, "model_capacity", "completion frees concurrency but never refunds rolling RPM");
  const next = await a.reserveModel(parent, { ...limits, scope: "other_account", reservedTokens: 250 });
  assert.ok(next.callId, "a settled call consumes actual run tokens, while a running call reserves its maximum");
  await assert.rejects(b.reserveModel(parent, { ...limits, scope: "third_account", reservedTokens: 30, runCalls: 3 }), { code: "execution_model_budget_exhausted" });
  await b.finishModel(next.callId);
  await assert.rejects(b.reserveModel(parent, { ...limits, scope: "third_account", reservedTokens: 30, runCalls: 3 }), { code: "execution_model_budget_exhausted" }, "unknown usage retains the reservation after failure");
});

test("PostgreSQL: conversations on one trip serialize; a read-only expired run is recovered once with a new fence", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  const first = (await a.submit({ ...command("one"), tripId: "shared_trip" })).run;
  const second = (await b.submit({ ...command("two"), tripId: "shared_trip" })).run;
  const active = await a.claimMany({ ...claim("old_worker"), count: 2 });
  assert.equal(active.length, 1);
  assert.equal(active[0].runId, first.runId);
  await a.call(active[0], { callId: "read_before_crash", toolName: "get_trip_plan_view", argsHash: "read_only", status: "running" });
  await a.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [first.runId, Date.now() - 1]);
  const recovered = await b.claim(claim("new_worker"));
  assert.equal(recovered.runId, first.runId);
  assert.ok(recovered.fence > active[0].fence);
  await assert.rejects(a.assertCurrent(active[0]), { code: "execution_ownership_lost" });
  assert.equal((await b.get(second.runId)).status, "queued");
  await b.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [first.runId, Date.now() - 1]);
  assert.equal((await b.claim(claim("third_worker"))).runId, second.runId);
  assert.equal((await b.get(first.runId)).status, "interrupted", "recovery is bounded to one attempt");
});

test("PostgreSQL: an uncertain write is never automatically replayed", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  await a.submit(command("uncertain"));
  const run = await a.claim(claim("old_worker"));
  await a.call(run, { callId: "write_before_crash", toolName: "save_trip_understanding", argsHash: "write_hash", status: "running" });
  await a.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [run.runId, Date.now() - 1]);
  assert.equal(await b.claim(claim("new_worker")), null);
  assert.equal((await b.get(run.runId)).status, "interrupted");
});

test("PostgreSQL: a new user command recovers a committed Trip after a crash before conversation linking", { skip: !databaseUrl }, async (t) => {
  const { a, b } = await database(t);
  const store = new PostgresTripRepository({ pool: a.pool });
  const conversationRepository = new PostgresConversationRepository({ pool: a.pool });
  await store.migrate();
  const travelService = new TravelService({ store });
  const faux = fauxProvider({ provider: "fixture-recovery", models: [{ id: "parent" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const agent = new TravelConversationAgent({ travelService, conversationRepository, modelRuntime: { models, model: faux.getModel("parent") } });
  const conversation = await agent.createConversation({ userId: "owner" });
  await a.submit({ ...command("crash_after_trip"), conversationId: conversation.conversationId });
  const crashed = await a.claim(claim("old_worker"));
  const context = { ...crashed, signal: new AbortController().signal, assertCurrent: () => a.assertCurrent(crashed), emit: () => Promise.resolve() };
  await withTravelExecution(context, () => travelService.createTrip({ tripId: "trip_committed_before_crash", ownerUserId: "owner", brief: { destination: "杭州" } }));
  assert.equal((await conversationRepository.get(conversation.conversationId)).tripId, null);
  await b.query("UPDATE travel_runs SET lease_until=$2 WHERE run_id=$1", [crashed.runId, Date.now() - 1]);
  assert.equal(await b.claim(claim("new_worker")), null, "a committed product write must not be replayed");
  faux.setResponses([(modelContext) => {
    assert.match(modelContext.systemPrompt, /trip_committed_before_crash/);
    return fauxAssistantMessage("已找回保存的杭州草案，可以接着规划。");
  }]);
  const worker = new TravelExecutionService({ repository: b, conversationAgent: agent, pollMs: 10 });
  try {
    const accepted = await worker.submit({ conversationId: conversation.conversationId, userId: "owner", requestId: "manual_continue", text: "继续刚才保存的旅行" });
    const result = await worker.wait({ runId: accepted.runId, userId: "owner" });
    assert.equal(result.status, "completed");
    assert.equal(result.result.tripId, "trip_committed_before_crash");
    assert.equal((await conversationRepository.get(conversation.conversationId)).tripId, result.result.tripId);
    assert.equal((await store.list()).length, 1);
  } finally { await worker.close(); }
});
