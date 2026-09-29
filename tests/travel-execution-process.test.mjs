import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const databaseUrl = process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL;
test("a killed Worker is replaced within 60s without duplicating the user message; another user cannot replay its events", { skip: !databaseUrl, timeout: 80_000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/travel_execution_test");
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `restart_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const children = [];
  const progress = new Map();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => { child.once("exit", resolve); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); })));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  let base;
  for (let index = 0; index < 3; index++) {
    const child = fork(new URL("./fixtures/execution-worker.mjs", import.meta.url), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, TRAVEL_EXECUTION_TEST_DATABASE_URL: url.toString(), TRAVEL_EXECUTION_TEST_ROLE: index === 0 ? "api" : "worker" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture_start_timeout")), 15_000);
      child.on("message", (message) => {
        if (message.type === "ready") { clearTimeout(timeout); resolve(message.port); }
        if (message.type === "progress") progress.set(index, message);
      });
      child.once("exit", () => { clearTimeout(timeout); progress.delete(index); });
    });
    if (index === 0) base = `http://127.0.0.1:${port}`;
  }
  async function api(path, body, cookie) {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const owner = await api("/api/auth/guest-session", {});
  const conversation = await api("/api/conversations", {}, owner.cookie);
  const accepted = await api(`/api/conversations/${conversation.value.conversationId}/runs`, { requestId: "restart_command", text: "杭州三天，预算6000。先保存要求。" }, owner.cookie);
  assert.equal(accepted.status, 202);
  const runId = accepted.value.runId;
  const waitFor = async (predicate, milliseconds = 10_000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(100); }
    throw new Error("process_recovery_deadline_exceeded");
  };
  const killedIndex = await waitFor(() => [...progress].find(([, value]) => value.activeModels === 1)?.[0]);
  const failedAt = Date.now();
  children[killedIndex].kill("SIGKILL");
  await new Promise((resolve) => children[killedIndex].once("exit", resolve));
  const survivorIndex = await waitFor(() => [...progress].find(([index, value]) => index !== killedIndex && value.activeModels === 1)?.[0], 60_000);
  const recoveryMs = Date.now() - failedAt;
  assert.ok(recoveryMs < 60_000);
  children[survivorIndex].send({ type: "release" });
  const final = await waitFor(async () => {
    const result = await api(`/api/runs/${runId}`, undefined, owner.cookie);
    return result.value.status === "completed" ? result.value : null;
  });
  assert.equal(final.result.conversation.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(Number((await admin.query(`SELECT COUNT(*) AS total FROM ${schema}.trip_states`)).rows[0].total), 1);
  assert.ok(final.events.some((event) => event.type === "run_recovering"));
  const cursor = final.events[1].sequence;
  const replay = await fetch(`${base}/api/runs/${runId}/events?after=${cursor}`, { headers: { cookie: owner.cookie } });
  const frames = await replay.text();
  const snapshot = JSON.parse(frames.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.ok(snapshot.events.every((event) => event.sequence > cursor));
  const other = await api("/api/auth/guest-session", {});
  assert.equal((await api(`/api/runs/${runId}`, undefined, other.cookie)).status, 403);
  assert.equal((await api(`/api/runs/${runId}`)).status, 401);
  assert.doesNotMatch(frames, /checkpoint|thinking|apiKey|arguments/);
  t.diagnostic(`Actual Worker kill: native Pi recovered in ${recoveryMs} ms; exactly one trip and one accepted user message persisted.`);
});
