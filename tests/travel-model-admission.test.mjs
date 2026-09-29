import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionRepository } from "../src/persistence/execution-repository.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "travel-admission-"));
  let now = 1_000_000;
  const repository = new ExecutionRepository({ filename: join(root, "runs.sqlite"), clock: () => now });
  t.after(async () => { await repository.close(); await rm(root, { recursive: true, force: true }); });
  await repository.submit({ conversationId: "conversation", userId: "user", requestId: "request", requestHash: "hash", input: { text: "规划" } });
  const run = await repository.claim({ workerId: "worker", leaseMs: 240000, globalLimit: 5, perUserLimit: 2 });
  return { repository, run, advance: ms => { now += ms; }, limits: { scope: "parent", reservedTokens: 800, concurrency: 2, rpm: 10, tpm: 1000, runCalls: 20, runTokens: 10000 } };
}

test("known model usage frees unused token reservation for the next planning step", async t => {
  const { repository, run, limits } = await fixture(t);
  const first = await repository.reserveModel(run, limits);
  await repository.finishModel(typeof first === "string" ? first : first.callId, { input: 100, output: 50 });
  const next = await repository.reserveModel(run, limits);
  assert.ok(typeof next === "string" || next?.callId, "150 used + 800 reserved fits a 1000-token account window");
});

test("quota wait points to window expiry and unknown usage is never refunded", async t => {
  const { repository, run, limits, advance } = await fixture(t);
  const first = await repository.reserveModel(run, limits);
  await repository.finishModel(typeof first === "string" ? first : first.callId);
  const wait = await repository.reserveModel(run, limits);
  assert.equal(wait?.notBefore, 1_060_001);
  assert.equal(wait.waitReason, "model_capacity");
  advance(60_001);
  assert.ok((await repository.reserveModel(run, limits)).callId);
});
