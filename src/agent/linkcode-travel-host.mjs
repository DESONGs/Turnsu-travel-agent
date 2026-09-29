import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCompatiblePiHost } from "./pi-host-compatibility.mjs";
import { TRAVEL_HOST_TOOLS, createTravelHttpTools } from "../../travel-agent-pi-package/src/host/travel-http-tools.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const LINKCODE_TRAVEL_HOST = Object.freeze({
  release: "0.30.0", commit: "da9c0673f102a6cc6e1410b45044bb8e03e9afb8", pi: "0.85.1",
  adapter: "packages/host/agent-adapter/src/native/pi/adapter.ts",
  adapterSha256: "279ebe84f67f10dd56e5bfd30e180dc0c885ae0104726335ab54b478131201f3",
});
let started = false;

function fail(code) { return Object.assign(new Error(code), { code }); }

/** One isolated process per host profile: upstream Pi uses a process-wide agent directory. */
export async function createLinkcodeTravelHost({ sourceDir, profileRoot, apiOrigin, accessToken, model, modelApiKey, modelBaseUrl, resumeHistoryId, onEvent = () => {} }) {
  if (started) throw fail("linkcode_host_requires_separate_process");
  if (!sourceDir || !profileRoot || !model) throw fail("linkcode_host_configuration_required");
  createTravelHttpTools({ baseUrl: apiOrigin, accessToken }); // Validate before using the credential.
  const identityResponse = await fetch(`${new URL(apiOrigin).origin}/api/session`, {
    headers: { authorization: `Bearer ${accessToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!identityResponse.ok) throw fail("travel_api_session_required");
  const identity = await identityResponse.json();
  if (!identity.userId) throw fail("travel_api_session_required");
  const entry = resolve(sourceDir, LINKCODE_TRAVEL_HOST.adapter);
  if (createHash("sha256").update(await readFile(entry)).digest("hex") !== LINKCODE_TRAVEL_HOST.adapterSha256) throw fail("linkcode_release_mismatch");
  const scope = createHash("sha256").update(`${new URL(apiOrigin).origin}\n${identity.userId}`).digest("hex").slice(0, 24);
  const profile = resolve(profileRoot, scope);
  const cwd = resolve(profile, "workspace");
  const agentDir = resolve(profile, "agent");
  await mkdir(resolve(cwd, ".pi"), { recursive: true, mode: 0o700 });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const packageRoot = resolve(root, "travel-agent-pi-package");
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify({
    packages: [],
    extensions: [resolve(packageRoot, "extensions/host-compatibility.mjs"), resolve(packageRoot, "extensions/travel-business-runtime.ts")],
    skills: ["understand-trip", "research-trip", "plan-trip", "recover-trip"].map((name) => resolve(root, "plugins/travel-agent/skills", name)),
    enableSkillCommands: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  }, null, 2), { mode: 0o600 });
  await writeFile(resolve(cwd, ".pi/SYSTEM.md"), await readFile(resolve(root, ".pi/SYSTEM.md")), { mode: 0o600 });
  const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, PI_HOST_ENTRY: sdkEntry, PI_OFFLINE: "1", PI_TELEMETRY: "0",
    TRAVEL_AGENT_PI_MODE: "api", TRAVEL_AGENT_API_BASE_URL: new URL(apiOrigin).origin, TRAVEL_AGENT_API_ACCESS_TOKEN: accessToken,
  });
  started = true;
  const sdk = await import(pathToFileURL(sdkEntry).href);
  assertCompatiblePiHost({ version: sdk.VERSION, allowUnknown: false });
  const { PiAdapter } = await import(pathToFileURL(entry).href);
  const { AgentInputSchema } = await import(pathToFileURL(resolve(sourceDir, "packages/foundation/schema/src/model/agent/input.ts")).href);
  const { agentRuntimeProber } = await import(pathToFileURL(resolve(sourceDir, "packages/host/agent-adapter/src/probe/index.ts")).href);
  const hostSdkEntry = resolve(packageRoot, "src/host/linkcode-pi-085-sdk.ts");
  agentRuntimeProber.setManagedEntryResolver((kind) => kind === "pi" ? { path: hostSdkEntry, version: sdk.VERSION } : undefined);
  const adapter = new PiAdapter();
  const asks = new Map();
  let busy = false;
  adapter.onEvent((event) => {
    if (["permission-request", "question-request"].includes(event.type)) asks.set(event.requestId, event);
    if (["permission-resolved", "question-resolved"].includes(event.type)) asks.delete(event.requestId);
    onEvent(event);
  });
  const opts = { cwd, model, approvalPolicyId: "default", effort: "low", config: {
    tools: [...TRAVEL_HOST_TOOLS, "travel_read_skill"], ...(modelApiKey ? { apiKey: modelApiKey } : {}),
    ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
  } };
  try {
    if (resumeHistoryId) await adapter.resumeHistory({ historyId: resumeHistoryId }, opts);
    else await adapter.start(opts);
  } catch (error) { await adapter.stop(); throw error; }
  return {
    versions: LINKCODE_TRAVEL_HOST,
    async send(input) {
      const parsed = AgentInputSchema.safeParse(input);
      if (!parsed.success) throw fail("invalid_host_input");
      input = parsed.data;
      // Native Pi persists its transcript. Reject media and resource blocks before Pi sees them.
      if (input?.type === "prompt") {
        if (busy) throw fail("host_turn_in_progress");
        if (!Array.isArray(input.content) || !input.content.length || input.content.some((block) => block.type !== "text" || typeof block.text !== "string")
          || input.content.map((block) => block.text).join("\n").length > 12_000
          || input.content.some((block) => /data:image\//i.test(block.text))) throw fail("host_text_input_required_use_web_for_images");
        busy = true;
        try { await adapter.send(input); } finally { busy = false; }
      } else if (input?.type === "cancel") {
        await adapter.send({ type: "cancel" });
      } else if (["permission-response", "question-response"].includes(input?.type)) {
        const expected = input.type.replace("response", "request");
        const ask = asks.get(input.requestId);
        if (ask?.type !== expected) throw fail("unknown_host_approval_request");
        if (input.type === "permission-response" && input.outcome.outcome === "selected") {
          const option = ask.options.find((value) => value.optionId === input.outcome.optionId);
          if (!option || !["allow_once", "reject_once"].includes(option.kind)) throw fail("host_approval_must_be_per_call");
        }
        await adapter.send(input);
      } else throw fail("host_input_not_allowed");
    },
    listHistory: () => adapter.listHistory({ cwd }),
    stop: () => adapter.stop(),
  };
}
