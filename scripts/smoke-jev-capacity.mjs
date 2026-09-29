import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

// Wall-clock load, real HTTP/PostgreSQL/native Pi, explicitly controlled models
// and travel providers. Never loads production credentials or external services.
const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/travel_execution_test") throw new Error("isolated_local_test_database_required");
const users = Math.max(1, Math.min(500, Number(process.env.TRAVEL_EXECUTION_TEST_USERS ?? 500)));
const durationMs = Math.max(1000, Number(process.env.TRAVEL_EXECUTION_TEST_DURATION_MS ?? 1800000));
const destination = resolve(process.env.TRAVEL_EXECUTION_TEST_OUTPUT ?? "/tmp/travel-jev-capacity.json");
const admin = new Pool({ connectionString: url.toString(), max: 2 });
const schema = `jevload_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
const children = [], endpoints = [], clients = [], waves = [], completions = [], waits = [];
const output = { testedAt: new Date().toISOString(), schemaVersion: "travel-jev-capacity-v1", users, durationMs,
  evidenceScope: "Controlled models and fictional travel Providers through real authenticated HTTP, native Pi, two API/two Worker processes and PostgreSQL. Not external model capacity or commercial travel quality.",
  modelLimits: { Jev: { normalRpm: 1080, retryRpm: 60, hardRpm: 1200, tps: 250000 }, Parent: { concurrent: 64, rpm: 10000, tpm: 100000000, controlled: true } }, waves };
output.sourceHashes = Object.fromEntries(await Promise.all(["src/agent/travel-conversation-agent.mjs", "src/agent/travel-execution-service.mjs", "src/persistence/execution-repository.mjs", "src/api/travel-service.mjs", "travel-agent-pi-package/src/host/travel-judgment.ts", "travel-agent-pi-package/src/host/jev-client.ts", "tests/fixtures/jev-planning.mjs"].map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "awaiting_input"]);
async function api(client, path, body) {
  const result = await fetch(`${client.base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(client.cookie ? { cookie: client.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await result.json();
  assert.ok(result.ok, `${result.status} ${value.code}`);
  if (result.headers.get("set-cookie")) client.cookie = result.headers.get("set-cookie").split(";")[0];
  return value;
}
const save = async () => { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`); };
try {
  for (let i = 0; i < 4; i++) {
    const child = fork(resolve("tests/fixtures/execution-worker.mjs"), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, TRAVEL_EXECUTION_TEST_DATABASE_URL: url.toString(), TRAVEL_EXECUTION_TEST_ROLE: i < 2 ? "api" : "worker", TRAVEL_EXECUTION_TEST_PROFILE: "planning" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let errorText = ""; child.stderr.on("data", value => { errorText = `${errorText}${value}`.slice(-3000); });
    const port = await new Promise((done, fail) => { const timeout = setTimeout(() => fail(new Error(`startup_timeout ${errorText}`)), 30000); child.on("message", event => { if (event.type === "ready") { clearTimeout(timeout); done(event.port); } }); child.once("exit", code => { clearTimeout(timeout); fail(new Error(`worker_exit_${code} ${errorText}`)); }); });
    endpoints.push(`http://127.0.0.1:${port}`);
  }
  for (let offset = 0; offset < users; offset += 20) await Promise.all(Array.from({ length: Math.min(20, users - offset) }, async (_, step) => {
    const index = offset + step, client = { index, base: endpoints[index % 2] };
    await api(client, "/api/auth/guest-session", {}); clients[index] = client;
  }));
  const started = Date.now();
  let wave = 0;
  do {
    const waveStarted = Date.now();
    const rows = [];
    for (let offset = 0; offset < users; offset += 25) await Promise.all(clients.slice(offset, offset + 25).map(async client => {
      const conversation = await api(client, "/api/conversations", {});
      rows.push({ client, conversationId: conversation.conversationId, cursor: 0, began: 0, answered: false });
    }));
    await Promise.all(rows.map(async row => {
      row.began = Date.now();
      row.run = await api(row.client, `/api/conversations/${row.conversationId}/runs`, { requestId: randomUUID(), text: "2026年10月15日从杭州去上海一天，预算6000，做完整行程。" });
      row.admissionMs = Date.now() - row.began;
    }));
    // Cancel queued/in-flight requests through the other API instance.
    await Promise.all(rows.filter(row => row.client.index % 20 === 19).map(async row => {
      const other = { ...row.client, base: endpoints[(row.client.index + 1) % 2] };
      await api(other, `/api/runs/${row.run.runId}/cancel`, {}); row.cancelRequested = true;
    }));
    let reportedAt = Date.now();
    while (rows.some(row => !row.final)) {
      const expired = Date.now() - waveStarted > 300000;
      for (let offset = 0; offset < rows.length; offset += 25) await Promise.all(rows.slice(offset, offset + 25).filter(row => !row.final).map(async row => {
        const value = await api(row.client, `/api/runs/${row.run.runId}?after=${row.cursor}`);
        row.cursor = value.events.at(-1)?.sequence ?? row.cursor;
        const first = value.events.find(event => event.type === "run_started");
        if (first && row.waitMs === undefined) row.waitMs = first.at - row.began;
        if (terminal.has(value.status) || expired) { row.final = value; row.elapsedMs = Date.now() - row.began; }
      }));
      if (Date.now() - reportedAt > 15000) {
        process.stdout.write(`${JSON.stringify({ wave: wave + 1, elapsedMs: Date.now() - waveStarted, finished: rows.filter(row => row.final).length, metrics: await Promise.all(endpoints.map(base => api({ base }, "/__fixture/metrics"))) })}\n`);
        reportedAt = Date.now();
      }
      if (rows.some(row => !row.final)) await delay(1000);
    }
    const expected = rows.filter(row => !row.cancelRequested);
    const completed = expected.filter(row => row.final.status === "completed" && row.final.result?.itineraryTrial?.status === "trial_ready");
    completions.push(...completed.map(row => row.elapsedMs)); waits.push(...expected.map(row => row.waitMs ?? row.elapsedMs));
    const report = { wave: ++wave, submitted: rows.length, checkedDrafts: completed.length, expected: expected.length, cancelled: rows.filter(row => row.final.status === "cancelled").length, completedBeforeCancellation: rows.filter(row => row.cancelRequested && row.final.status === "completed").length,
      elapsedMs: Date.now() - waveStarted, failures: expected.filter(row => !completed.includes(row)).map(row => ({ runId: row.run.runId, status: row.final.status, code: row.final.result?.code ?? null, planning: row.final.result?.itineraryTrial?.status ?? null })) };
    for (const failure of report.failures) {
      const stored = (await admin.query(`SELECT checkpoint_json,continuation_json FROM ${schema}.travel_runs WHERE run_id=$1`, [failure.runId])).rows[0];
      const entries = JSON.parse(stored?.checkpoint_json ?? "null")?.entries ?? [];
      failure.toolErrors = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).map(entry => ({ tool: entry.message.toolName, text: entry.message.content.filter(item => item.type === "text").map(item => item.text).join(" ").slice(0, 1500) }));
      failure.turn = JSON.parse(stored?.continuation_json ?? "null")?.turn;
    }
    waves.push(report); output.elapsedMs = Date.now() - started;
    process.stdout.write(`${JSON.stringify(report)}\n`); await save();
    if (report.failures.length) { output.status = "failed_controlled_planning"; process.exitCode = 1; break; }
    // Mid-load factual updates use the public shared service boundary.
    for (const row of completed.filter(row => row.client.index % 25 === 0)) {
      const other = { ...row.client, base: endpoints[(row.client.index + 1) % 2] };
      await api(other, `/api/trips/${row.final.result.tripId}/scope`, { brief: { totalBudget: 6500 } });
    }
  } while (Date.now() - started < durationMs);
  const usage = (await admin.query(`SELECT created_at,call_kind,reserved_tokens FROM ${schema}.travel_model_calls WHERE scope='typesafe_account' ORDER BY created_at`)).rows;
  let maxRolling = 0, maxNormal = 0, maxRetry = 0, start = 0;
  for (let i = 0; i < usage.length; i++) {
    while (Number(usage[start].created_at) <= Number(usage[i].created_at) - 60000) start++;
    const window = usage.slice(start, i + 1);
    maxRolling = Math.max(maxRolling, window.length); maxNormal = Math.max(maxNormal, window.filter(row => row.call_kind === "normal").length); maxRetry = Math.max(maxRetry, window.filter(row => row.call_kind === "retry").length);
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null;
  Object.assign(output, { status: output.status ?? "passed_controlled_planning", sustained30Minutes: output.elapsedMs >= 1800000, requests: usage.length, maxRolling60s: maxRolling, maxNormal60s: maxNormal, maxRetry60s: maxRetry,
    completionP50Ms: percentile(completions, .5), completionP95Ms: percentile(completions, .95), completionP99Ms: percentile(completions, .99), firstDispatchP95Ms: percentile(waits, .95),
    processMetrics: await Promise.all(endpoints.map(base => api({ base }, "/__fixture/metrics"))) });
  assert.ok(maxRolling <= 1200 && maxNormal <= 1080 && maxRetry <= 60);
  await save(); process.stdout.write(`Evidence: ${destination}\n`);
} catch (error) { output.status = "failed_controlled_load"; output.error = error.message; await save(); throw error; }
finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(done => { child.once("exit", done); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); })));
  await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
