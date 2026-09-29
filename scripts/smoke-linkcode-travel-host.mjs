// Deterministic local wire smoke: real upstream adapter + real Pi SDK + real authenticated API.
// The model/provider responses are fixtures; this does not claim live model or provider quality.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { TravelService } from "../src/api/travel-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { InMemorySessionStore } from "../src/http/session.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";

const sourceDir = process.env.LINKCODE_SOURCE_DIR;
assert.ok(sourceDir, "Set LINKCODE_SOURCE_DIR to the audited upstream v0.30.0 source checkout");
const dir = await mkdtemp(join(tmpdir(), "travel-linkcode-wire-"));
const service = new TravelService({ store: new TripStore({ rootDir: join(dir, "trips") }) });
const sessions = new InMemorySessionStore();
const issued = await sessions.issue({ userId: "fixture_linkcode_owner", provider: "google" });
const app = createHttpApp({ travelService: service, sessionStore: sessions,
  conversationRepository: new FileConversationRepository({ rootDir: join(dir, "conversations") }),
  runtimeEnv: { NODE_ENV: "test", TRAVEL_AGENT_DATA_DIR: dir },
});
const api = http.createServer(app).listen(0, "127.0.0.1");
await once(api, "listening");
let phase = "create";
let modelCalls = 0;
let tripId;
let skillRead = false;
let resumedSawHistory = false;
const gateway = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  modelCalls++;
  const tools = body.messages.filter((message) => message.role === "tool");
  const lastTool = tools.at(-1);
  const parsed = lastTool ? JSON.parse(lastTool.content) : null;
  if (parsed?.tripId) tripId = parsed.tripId;
  const tool = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `fixture_call_${modelCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  let delta;
  if (phase === "create") {
    if (!tools.length) delta = tool("travel_read_skill", { skillId: "understand-trip" });
    else if (parsed?.skillId) { skillRead = /Trip|旅行/.test(parsed.content); delta = tool("create_trip", { brief: { destination: "杭州" } }); }
    else delta = { content: "已建立杭州旅行草案，尚未确认任何方案。" };
  } else if (phase === "cancel") {
    delta = tool("accept_trip_change", { tripId, proposalId: "fixture_pending" });
  } else {
    resumedSawHistory = tools.some((message) => message.content.includes(tripId));
    delta = parsed?.brief?.totalBudget === 7000 ? { content: "当前预算为 7000，已读取最新旅行状态。" } : tool("get_trip_control_view", { tripId });
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture_${modelCalls}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  frame(delta); frame({}, delta.tool_calls ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await once(gateway, "listening");

function client(resume) {
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-linkcode-travel-host.mjs", "--json", "--profile", join(dir, "profile"), ...(resume ? ["--resume", resume] : [])], {
    cwd: resolve(import.meta.dirname, ".."), stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, LINKCODE_SOURCE_DIR: sourceDir, TRAVEL_AGENT_API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
      TRAVEL_AGENT_API_ACCESS_TOKEN: issued.opaqueToken, TRAVEL_HOST_MODEL: "moonshotai-cn/kimi-k2.6",
      TRAVEL_HOST_MODEL_API_KEY: "fixture_host_model_key", TRAVEL_HOST_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
    },
  });
  const events = [];
  let stderr = "";
  const listeners = new Set();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const send = (input) => child.stdin.write(`${JSON.stringify(input)}\n`);
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "permission-request") send({ type: "permission-response", requestId: event.requestId, outcome: { outcome: "selected", optionId: "allow" } });
    for (const notify of listeners) notify();
  });
  const waitFor = (predicate, start = 0) => new Promise((done, reject) => {
    const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`host_fixture_timeout:${JSON.stringify(events.slice(-3))}:${stderr.slice(-1500)}`)); }, 30_000);
    function check() {
      const error = events.slice(start).find((event) => event.type === "host-error");
      const found = events.slice(start).find(predicate);
      if (!found && !error) return;
      clearTimeout(timeout); listeners.delete(check);
      if (error && !found) reject(new Error(JSON.stringify(error))); else done(found);
    }
    listeners.add(check); check();
  });
  return { events, send, waitFor, async stop() { child.stdin.end(); if (child.exitCode == null) await once(child, "exit"); lines.close(); } };
}

let first;
let second;
try {
  first = client();
  await first.waitFor((event) => event.type === "host-ready");
  for (const [input, code] of [
    [{ type: "shell-command", command: "touch forbidden" }, "host_input_not_allowed"],
    [{ type: "set-approval-policy", policyId: "bypassPermissions" }, "host_input_not_allowed"],
    [{ type: "prompt", content: [{ type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_MARKER" }] }, "host_text_input_required_use_web_for_images"],
  ]) {
    const marker = first.events.length;
    first.send(input);
    await first.waitFor((event) => event.type === "host-error" && event.code === code, marker);
  }
  const firstTurnMarker = first.events.length;
  first.send({ type: "prompt", content: [{ type: "text", text: "为我建立杭州旅行草案，先读取理解旅行 Skill。" }] });
  await first.waitFor((event) => event.type === "agent-message-chunk" && event.content?.text?.includes("已建立"), firstTurnMarker);
  await first.waitFor((event) => event.type === "status" && event.status === "idle", first.events.findIndex((event) => event.type === "agent-message-chunk"));
  assert.ok(skillRead, "The installed Travel Skill was not actually read");
  assert.ok(tripId);
  assert.equal((await service.getTripControlView(tripId)).brief.destination, "杭州");
  const historyId = first.events.find((event) => event.type === "session-ref")?.historyId;
  assert.ok(historyId);
  phase = "cancel";
  const marker = first.events.length;
  first.send({ type: "prompt", content: [{ type: "text", text: "我想确认候选，请先展示确认。" }] });
  await first.waitFor((event) => event.type === "question-request", marker);
  first.send({ type: "cancel" });
  await first.waitFor((event) => event.type === "status" && event.status === "idle", marker);
  assert.equal((await service.getTripControlView(tripId)).revision, 0, "cancelled confirmation must not commit");
  await first.stop(); first = null;
  await service.updateTripScope({ tripId, brief: { totalBudget: 7000 } });
  phase = "resume";
  second = client(historyId);
  await second.waitFor((event) => event.type === "host-ready");
  const resumedMarker = second.events.length;
  second.send({ type: "prompt", content: [{ type: "text", text: "继续，读取最新旅行预算。" }] });
  await second.waitFor((event) => event.type === "agent-message-chunk" && event.content?.text?.includes("7000"), resumedMarker);
  assert.equal(resumedSawHistory, true);
  await second.stop(); second = null;
  const profileFiles = await readdir(join(dir, "profile"), { recursive: true });
  for (const name of profileFiles.filter((name) => /\.(?:json|jsonl|md)$/.test(name))) {
    const content = await readFile(join(dir, "profile", name), "utf8");
    assert.equal(content.includes("PRIVATE_IMAGE_MARKER"), false, "rejected image persisted");
    assert.equal(content.includes(issued.opaqueToken), false, "API credential leaked into profile/history");
    assert.equal(content.includes("fixture_host_model_key"), false, "model credential leaked into profile/history");
  }
  console.log(JSON.stringify({ status: "passed_local_fixture_native_host", linkcode: "0.30.0", pi: "0.85.1", skillRead, resumedSawHistory, businessState: "shared_http_api", confirmationCancelled: true, shellAndBypassBlocked: true, imagePersistence: false, credentialPersistence: false, modelCalls, evidence: "real adapter/sdk/api; fixture model" }, null, 2));
} finally {
  await first?.stop(); await second?.stop();
  for (const server of [api, gateway]) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await app.locals.close();
}
