import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createWorkerClient } from "./client.mjs";
import { createPiRunner } from "./pi-runner.mjs";

const stopped = new AbortController();
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => stopped.abort());

export async function executeTask(task, client, run, shutdownSignal) {
  const identity = { taskId: task.taskId, generation: task.generation, leaseId: task.leaseId };
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, shutdownSignal]);
  let heartbeatPending = false;
  const timer = setInterval(async () => {
    if (heartbeatPending || signal.aborted) return;
    heartbeatPending = true;
    try { await client.post("heartbeat", identity, signal); } catch { controller.abort(); }
    finally { heartbeatPending = false; }
  }, 15000);
  try {
    await client.post("heartbeat", identity, signal);
    const output = await run(task, client, signal);
    signal.throwIfAborted();
    await client.post("finish", { ...identity, output }, signal);
  } catch (error) {
    if (signal.aborted || ["stale_execution", "permission_revoked", "revision_conflict"].includes(error?.code)) return;
    const code = error?.message === "model_output_invalid" ? "model_output_invalid"
      : error?.message === "model_unavailable" ? "model_unavailable" : "worker_error";
    try { await client.post("fail", { ...identity, code }, shutdownSignal); } catch { /* lease recovery remains authoritative */ }
  } finally { clearInterval(timer); }
}

async function start() {
  const apiKey = process.env.TRAVEL_OPENAI_API_KEY || "";
  const modelId = process.env.TRAVEL_OPENAI_MODEL || "";
  if (!apiKey || !modelId) throw new Error("model_credentials_not_configured");
  const client = createWorkerClient({ baseUrl: process.env.TRAVEL_WORKER_SERVICE_URL, token: process.env.TRAVEL_WORKER_TOKEN });
  const run = await createPiRunner({ provider: openaiProvider(), modelId, apiKey });
  const concurrency = Number(process.env.TRAVEL_WORKER_CONCURRENCY || 1);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("invalid_worker_concurrency");
  async function loop() {
    while (!stopped.signal.aborted) {
      try {
        const task = await client.post("claim", {}, stopped.signal);
        if (task.status === "running") await executeTask(task, client, run, stopped.signal);
        else await delay(3000, undefined, { signal: stopped.signal });
      } catch { if (!stopped.signal.aborted) await delay(5000, undefined, { signal: stopped.signal }).catch(() => {}); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, loop));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(() => { process.stderr.write("Travel worker could not start; check service and model configuration.\n"); process.exitCode = 1; });
}
