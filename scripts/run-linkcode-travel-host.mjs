import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const json = args.includes("--json");
// Upstream resource discovery runs in a dedicated process with no ambient user Pi configuration.
if (!args.includes("--isolated-child")) {
  const profileRoot = resolve(option("--profile", process.env.TRAVEL_LINKCODE_PROFILE_DIR ?? "runtime-data/linkcode-internal"));
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(tmpdir(), "travel-linkcode-home-"));
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TRAVEL_AGENT_API_BASE_URL", "TRAVEL_AGENT_API_ACCESS_TOKEN", "TRAVEL_HOST_MODEL", "TRAVEL_HOST_MODEL_API_KEY", "TRAVEL_HOST_MODEL_BASE_URL", "LINKCODE_SOURCE_DIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...args, "--profile", profileRoot, "--isolated-child"], {
    env: { ...env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "0" },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  const { createLinkcodeTravelHost } = await import("../src/agent/linkcode-travel-host.mjs");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = [];
  const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let host;
  let promptRunning = false;
  const onEvent = (event) => {
    if (json) output(event);
    else if (event.type === "agent-message-chunk" && event.content?.type === "text") process.stdout.write(event.content.text);
    else if (event.type === "session-ref") process.stderr.write(`\n会话：${event.historyId}\n`);
    else if (["permission-request", "question-request"].includes(event.type)) {
      pending.push(event);
      process.stderr.write(`\n${event.title ?? event.questions?.map((q) => q.prompt).join("\n") ?? "允许此操作"}\n输入 y 确认，其他输入拒绝：`);
    } else if (event.type === "error") output({ type: "host-error", code: event.code ?? "provider_error" });
  };
  try {
    host = await createLinkcodeTravelHost({
      sourceDir: option("--source", process.env.LINKCODE_SOURCE_DIR),
      profileRoot: option("--profile"), apiOrigin: process.env.TRAVEL_AGENT_API_BASE_URL,
      accessToken: process.env.TRAVEL_AGENT_API_ACCESS_TOKEN, model: process.env.TRAVEL_HOST_MODEL ?? "deepseek/deepseek-v4-flash",
      modelApiKey: process.env.TRAVEL_HOST_MODEL_API_KEY, modelBaseUrl: process.env.TRAVEL_HOST_MODEL_BASE_URL, resumeHistoryId: option("--resume"), onEvent,
    });
    output({ type: "host-ready", versions: host.versions, media: "web_only", scope: "internal" });
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; await host.send({ type: "cancel" }); await host.stop(); rl.close(); };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void (promptRunning ? host.send({ type: "cancel" }) : shutdown()));
    rl.on("line", (line) => {
      void (async () => {
        if (json) { await host.send(JSON.parse(line)); return; }
        if (line === "/stop") { await host.send({ type: "cancel" }); return; }
        if (line === "/exit") { await shutdown(); return; }
        if (line === "/history") { output(await host.listHistory()); return; }
        const ask = pending.shift();
        if (ask) {
          const yes = /^y(es)?$/i.test(line.trim());
          await host.send(ask.type === "permission-request"
            ? { type: "permission-response", requestId: ask.requestId, outcome: { outcome: "selected", optionId: yes ? "allow" : "reject" } }
            : { type: "question-response", requestId: ask.requestId, outcome: { outcome: "answered", answers: ask.questions.map((q) => ({ questionId: q.questionId, selectedOptionIds: [yes ? "yes" : "no"] })) } });
          return;
        }
        if (!line.trim()) return;
        promptRunning = true;
        try { await host.send({ type: "prompt", content: [{ type: "text", text: line }] }); }
        finally { promptRunning = false; process.stdout.write("\n"); }
      })().catch((error) => output({ type: "host-error", code: error?.code ?? "host_operation_failed" }));
    });
    rl.on("close", () => void shutdown());
  } catch (error) {
    output({ type: "host-error", code: error?.code ?? "host_start_failed" });
    await host?.stop();
    rl.close(); process.exitCode = 1;
  }
}
