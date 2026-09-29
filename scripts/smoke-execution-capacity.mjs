import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const databaseUrl = process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL;
const users = Math.min(500, Number(process.env.TRAVEL_EXECUTION_TEST_USERS ?? 500));
if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname) || !new URL(databaseUrl).pathname.endsWith("/travel_execution_test")) throw new Error("isolated_local_test_database_required");
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const schema = `load_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const scopedUrl = new URL(databaseUrl); scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
const children = [];
const endpoints = [];
const allEndpoints = [];
const reports = new Map();
const start = Date.now();
let openStreams = 0;
let peakStreams = 0;
let peakActive = 0;
let reconnectedClients = 0;
const requestTimes = [];
let output;
const send = async (base, path, body, token) => {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { cookie: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, `${response.status}: ${value.code}`);
  if (path === "/api/auth/guest-session") value.testCookie = response.headers.get("set-cookie")?.split(";")[0];
  return value;
};
async function stream(base, runId, token, { after = 0, reconnectTo = null } = {}) {
  const response = await fetch(`${base}/api/runs/${runId}/events?after=${after}`, { headers: { cookie: token } });
  assert.equal(response.status, 200);
  openStreams++; peakStreams = Math.max(peakStreams, openStreams);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ""; let final; let counted = true; let cursor = after;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data && frame.includes("event: progress")) {
          final = JSON.parse(data);
          assert.ok(final.events.every(event => event.sequence > cursor), "reconnect must not replay already consumed events");
          cursor = final.events.at(-1)?.sequence ?? cursor;
          if (reconnectTo) {
            await reader.cancel(); openStreams--; counted = false;
            reconnectedClients++;
            return stream(reconnectTo, runId, token, { after: cursor });
          }
        }
      }
    }
    assert.equal(final?.status, "completed", JSON.stringify({ status: final?.status, code: final?.result?.code }));
    assert.equal(final.result.conversation.messages.filter((message) => message.role === "user").length, 1);
    return final;
  } finally { if (counted) openStreams--; await reader.cancel().catch(() => {}); }
}
try {
  for (let index = 0; index < 4; index++) {
    const child = fork(resolve("tests/fixtures/execution-worker.mjs"), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, TRAVEL_EXECUTION_TEST_DATABASE_URL: scopedUrl.toString(), TRAVEL_EXECUTION_TEST_ROLE: index < 2 ? "api" : "worker" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let errorOutput = "";
    child.stderr.on("data", (data) => { errorOutput = `${errorOutput}${data}`.slice(-3000); });
    const port = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker_start_timeout ${errorOutput}`)), 30_000);
      child.on("message", (message) => {
        if (message.type === "ready") { clearTimeout(timeout); resolveReady(message.port); }
        if (message.type === "progress") { reports.set(index, message); peakActive = Math.max(peakActive, [...reports.values()].reduce((sum, row) => sum + row.activeModels, 0)); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`worker_exit_${code} ${errorOutput}`)); });
    });
    allEndpoints.push(`http://127.0.0.1:${port}`);
    if (index < 2) endpoints.push(`http://127.0.0.1:${port}`);
  }
  process.stdout.write(`Running ${users} users against two API and two Worker processes with native Pi and a controlled model.\n`);
  const clients = [];
  // Keep startup traffic bounded; the acceptance target is concurrent sessions/runs.
  for (let offset = 0; offset < users; offset += 25) {
    clients.push(...await Promise.all(Array.from({ length: Math.min(25, users - offset) }, async (_, step) => {
      const index = offset + step; const base = endpoints[index % 2];
      const account = await send(base, "/api/auth/guest-session", {});
      const conversation = await send(base, "/api/conversations", {}, account.testCookie);
      return { base, conversationId: conversation.conversationId, token: account.testCookie, requestId: randomUUID() };
    })));
  }
  const streams = [];
  const submissions = clients.map(async (client) => {
    const began = performance.now();
    const run = await send(client.base, `/api/conversations/${client.conversationId}/runs`, { requestId: client.requestId, text: "杭州三天，预算6000。先保存要求。" }, client.token);
    requestTimes.push(performance.now() - began);
    for (const [index, base] of endpoints.entries()) {
      const observation = stream(base, run.runId, client.token, base === client.base ? { reconnectTo: endpoints[1 - index] } : {});
      observation.catch(() => {});
      streams.push(observation);
    }
    return run;
  });
  const submitted = await Promise.all(submissions);
  const readyDeadline = Date.now() + 45_000;
  while (peakActive < users || openStreams < users * 2) {
    if (Date.now() > readyDeadline) throw new Error(`concurrency_target_not_reached active=${peakActive} streams=${openStreams}`);
    await delay(100);
  }
  assert.equal(new Set(submitted.map((run) => run.runId)).size, users);
  process.stdout.write(`Observed ${peakStreams} concurrent event streams and ${peakActive} concurrent native Parent model calls. Releasing model responses.\n`);
  for (const child of children) child.send({ type: "release" });
  const results = await Promise.all(streams);
  assert.equal(reconnectedClients, users);
  assert.equal(new Set(results.map((run) => run.result.tripId)).size, users);
  const stored = await admin.query(`SELECT COUNT(*) AS trips FROM ${schema}.trip_states`);
  assert.equal(Number(stored.rows[0].trips), users);
  requestTimes.sort((a, b) => a - b);
  const memory = await Promise.all(allEndpoints.map((base) => send(base, "/__fixture/metrics")));
  output = { schemaVersion: "travel-capacity-evidence-v1", testedAt: new Date().toISOString(), status: "passed_controlled_load", users, apiInstances: 2, workerInstances: 2,
    peakEventStreams: peakStreams, peakConcurrentNativeParents: peakActive, reconnectedClients, completedRuns: new Set(results.map((row) => row.runId)).size, persistedTrips: Number(stored.rows[0].trips),
    submitP95Ms: Math.round(requestTimes[Math.floor(requestTimes.length * .95)]), submitP99Ms: Math.round(requestTimes[Math.floor(requestTimes.length * .99)]), submitMaxMs: Math.round(requestTimes.at(-1)), elapsedMs: Date.now() - start,
    processRssMiB: memory.map((row) => Math.round(row.rss / 1024 / 1024)),
    evidenceScope: "Real HTTP auth, cross-process PostgreSQL queue, native Pi tool turns, SSE and product persistence. Model responses are controlled; no external model or travel Provider capacity is established.",
  };
  output.intakeLatencyTargetMet = output.submitP95Ms <= 2000 && output.submitP99Ms <= 3000;
  output.status = output.intakeLatencyTargetMet ? "passed_controlled_load" : "capacity_reached_intake_latency_failed";
  if (!output.intakeLatencyTargetMet) process.exitCode = 1;
  const destination = resolve(process.env.TRAVEL_EXECUTION_TEST_OUTPUT ?? "/tmp/travel-execution-capacity.json");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output)}\nEvidence: ${destination}\n`);
} catch (error) {
  const counts = await admin.query(`SELECT status,COUNT(*) AS count FROM ${schema}.travel_runs GROUP BY status`).catch(() => ({ rows: [] }));
  const failure = { status: "failed_controlled_load", users, peakStreams, peakActive, code: error.message, runStatuses: counts.rows, elapsedMs: Date.now() - start };
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  if (process.env.TRAVEL_EXECUTION_TEST_OUTPUT) {
    const destination = resolve(process.env.TRAVEL_EXECUTION_TEST_OUTPUT);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(failure, null, 2)}\n`);
  }
  throw error;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => { child.once("exit", resolveExit); setTimeout(() => { child.kill("SIGKILL"); }, 5000).unref(); })));
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
