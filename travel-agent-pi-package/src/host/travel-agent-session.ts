import { InMemoryCredentialStore, InMemoryModelsStore, type Models, type Model, type Api, type Context } from "@earendil-works/pi-ai";
import {
  compact, createAgentSession, createExtensionRuntime, createSyntheticSourceInfo, findCutPoint,
  ModelRuntime, SessionManager, SettingsManager,
  type Extension, type FileEntry, type ResourceLoader, type SessionBeforeCompactEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { assertTravelExecutionCurrent } from "./execution-context.js";
import { streamTravelModel } from "./model-budget.js";

export interface TravelSessionCheckpoint {
  schemaVersion: "travel-agent-session-v1";
  conversationId: string;
  entries: FileEntry[];
}

const runtimes = new WeakMap<Models, Promise<ModelRuntime>>();
// Native Pi compacts between completed tool rounds. Leave half the window for
// the next read/repair/delivery, rather than waiting until a single request fits
// but the cumulative run budget has no room left to finish.
const compactionSettings = { enabled: true, reserveTokens: 32_768, keepRecentTokens: 4096 };
// A planning request needs several model/tool rounds. Do not pay for a whole
// prior plan on each round merely because it fits in the provider's window.
// This triggers native summarization, never truncation of current Trip facts.
const reusableHistoryBytes = 32_768;

/** Project replaceable snapshots for a model call, not the audit checkpoint.
 * Earlier tool calls retain their IDs/status and point at the newer full result.
 * Research can cover disjoint domains, so its evidence is never replaced here. */
function currentToolContext(messages: Context["messages"]): Context["messages"] {
  const snapshots = new Set(["get_trip_control_view", "get_trip_plan_view", "plan_itinerary_trial", "estimate_costs"]);
  const latest = new Map<string, { callId: string; revision?: number }>();
  return [...messages].reverse().map(message => {
    if (message.role !== "toolResult" || message.isError || !snapshots.has(message.toolName)) return message;
    let value: Record<string, unknown>;
    try { value = JSON.parse(message.content.filter(block => block.type === "text").map(block => block.text).join("")) as Record<string, unknown>; }
    catch { return message; }
    if (!value || typeof value.tripId !== "string" || ["error", "stale_discarded", "deferred"].includes(String(value.status))) return message;
    // A partial/rejected trial cannot supersede the only complete plan. The
    // authoritative saved plan is separately reloaded for every model call.
    if (["input_rejected", "needs_recheck", "partial", "blocked", "needs_repair"].includes(String(value.status))) return message;
    const key = `${message.toolName}:${value.tripId}:${value.planId ?? "legacy"}`;
    const revision = typeof value.baseRevision === "number" ? value.baseRevision : typeof value.revision === "number" ? value.revision : undefined;
    const replacement = latest.get(key);
    if (!replacement) { latest.set(key, { callId: message.toolCallId, ...(revision !== undefined ? { revision } : {}) }); return message; }
    if (revision !== undefined && replacement.revision !== undefined && revision > replacement.revision) return message;
    return { ...message, details: undefined, content: [{ type: "text" as const, text: JSON.stringify({ tripId: value.tripId, status: value.status ?? "read", revision, operationId: message.toolCallId, supersededByToolCallId: replacement.callId, instruction: "This historical snapshot has a newer full result in this context. Use that result and current Trip facts. The original receipt remains in the execution checkpoint; do not repeat the operation." }) }] };
  }).reverse();
}

async function runtimeFor(models: Models): Promise<ModelRuntime> {
  let pending = runtimes.get(models);
  if (!pending) {
    pending = (async () => {
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      return runtime;
    })();
    runtimes.set(models, pending);
  }
  const runtime = await pending;
  for (const provider of models.getProviders()) {
    if (runtime.getRegisteredNativeProvider(provider.id) === provider) continue;
    runtime.registerNativeProvider(provider);
    const auth = await models.getAuth(provider.id);
    if (auth?.auth.apiKey) await runtime.setRuntimeApiKey(provider.id, auth.auth.apiKey);
  }
  return runtime;
}

/** No native filesystem session, hidden reasoning, images or credential discovery. */
export function travelCheckpoint(manager: SessionManager, conversationId: string, isSensitive: (text: string) => boolean): TravelSessionCheckpoint {
  let entries = manager.getBranch();
  const lastCompact = [...entries].reverse().find((entry) => entry.type === "compaction");
  if (lastCompact?.type === "compaction") {
    const first = entries.findIndex((entry) => entry.id === lastCompact.firstKeptEntryId);
    if (first >= 0) entries = entries.slice(first);
  }
  // A crash between the assistant tool call and its result must never restore an
  // incomplete protocol pair (nor implicitly repeat the side effect).
  const results = new Set(entries.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
  const orphaned = new Set<string>();
  entries = entries.filter((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return true;
    if (["error", "aborted"].includes(entry.message.stopReason)) return false;
    const calls = entry.message.content.filter((block) => block.type === "toolCall");
    if (!calls.some((call) => !results.has(call.id))) return true;
    for (const call of calls) orphaned.add(call.id);
    return false;
  }).filter((entry) => !(entry.type === "message" && entry.message.role === "toolResult" && orphaned.has(entry.message.toolCallId)));
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return isSensitive(value) ? "[private content omitted]" : value;
    if (Array.isArray(value)) return value.filter((item) => !(item && typeof item === "object" && "type" in item && item.type === "thinking")).map(clean);
    if (!value || typeof value !== "object") return value;
    if ("type" in value && value.type === "image") return { type: "text", text: "[image was request-only; attach it again if needed]" };
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["thinking", "thinkingSignature", "textSignature", "thoughtSignature", "reasoning", "reasoningContent", "providerMetadata"].includes(key)
      && !/^(?:cookie|token|authorization|password|secret|api[_ -]?key|passport|phone)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
  };
  const safeEntries = clean(entries) as typeof entries;
  for (let index = 0; index < safeEntries.length; index++) {
    const entry = safeEntries[index];
    if (entry) entry.parentId = safeEntries[index - 1]?.id ?? null;
  }
  const header = manager.getHeader();
  if (!header) throw new Error("travel_session_header_missing");
  return { schemaVersion: "travel-agent-session-v1", conversationId, entries: [{ ...header, cwd: "/travel" }, ...safeEntries] };
}

export async function createTravelAgentSession(options: {
  conversationId: string; models: Models; model: Model<Api>; systemPrompt: string | (() => string);
  thinkingLevel: ThinkingLevel; tools: ToolDefinition[];
  checkpoint?: TravelSessionCheckpoint | null;
  facts?: () => Promise<Record<string, unknown>>;
  isSensitive: (text: string) => boolean;
}) {
  const { conversationId, models, systemPrompt, isSensitive } = options;
  const currentSystemPrompt = () => typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;
  if (options.checkpoint && (options.checkpoint.schemaVersion !== "travel-agent-session-v1" || options.checkpoint.conversationId !== conversationId)) throw new Error("travel_session_identity_mismatch");
  const sessionManager = SessionManager.inMemory("/travel", { id: conversationId }, options.checkpoint?.entries);
  const modelRuntime = await runtimeFor(models);
  const runtime = createExtensionRuntime();
  const hook = async (value: unknown) => {
    const event = value as SessionBeforeCompactEvent;
    const facts = await options.facts?.() ?? {};
    const result = await compact(event.preparation, options.model, undefined, undefined,
      "Summarize the user's objective, unresolved questions, supported decisions and artifact references. Preserve per-traveler constraints and explicit confirmations. Never promote a suggestion, child inference or old price to a fact. Do not retain secrets, image data or hidden reasoning. Current authoritative travel facts will be reloaded separately on every turn.",
      event.signal, "off", (model, context, settings) => streamTravelModel(models, model, context, { ...settings, maxTokens: 4096 }));
    if (isSensitive(result.summary)) throw new Error("sensitive_compaction_rejected");
    return { compaction: { ...result, details: { schemaVersion: "travel-compaction-v1", factRevision: facts.revision ?? null, tripId: facts.tripId ?? null } } };
  };
  const extension: Extension = {
    path: "travel-context", resolvedPath: "travel-context", sourceInfo: createSyntheticSourceInfo("travel-context", { source: "Travel Agent" }),
    handlers: new Map([["session_before_compact", [hook]]]), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(), entryRenderers: new Map(),
  };
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: currentSystemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: "/travel", modelRuntime, resourceLoader: loader, sessionManager,
    model: { ...options.model, contextWindow: Math.min(options.model.contextWindow, 65_536) },
    thinkingLevel: options.thinkingLevel, tools: options.tools.map((tool) => tool.name), customTools: options.tools,
    settingsManager: SettingsManager.inMemory({ compaction: compactionSettings, retry: { enabled: false } }),
  });
  // The provider collection is scoped to this application's credential resolver.
  // It is also used by native compaction, avoiding personal Pi auth discovery.
  session.agent.streamFunction = async (selected, context, settings) => {
    await assertTravelExecutionCurrent();
    const facts = await options.facts?.();
    return streamTravelModel(models, selected, {
      ...context,
      messages: currentToolContext(context.messages),
      systemPrompt: `${currentSystemPrompt()}${facts ? `\n<current-travel-facts>${JSON.stringify(facts)}</current-travel-facts>\nThese facts were reloaded for this model call. They supersede older facts in conversation history or summaries. Confirmed state can change only through an authorized product tool.` : ""}`,
    }, { ...settings, maxTokens: 8192, maxRetries: 0 });
  };
  session.agent.toolExecution = "sequential";
  await session.bindExtensions({ mode: "json" });
  return {
    session,
    checkpoint: () => travelCheckpoint(sessionManager, conversationId, isSensitive),
    prepareNewTurn: async () => {
      if (!options.checkpoint || Buffer.byteLength(JSON.stringify(session.messages)) <= reusableHistoryBytes) return;
      if (!session.isIdle) throw new Error("travel_context_handoff_requires_idle_session");
      const branch = sessionManager.getBranch();
      if (branch.at(-1)?.type === "compaction") return;
      const lastCompact = [...branch].reverse().find(entry => entry.type === "compaction");
      const start = lastCompact?.type === "compaction" ? Math.max(0, branch.findIndex(entry => entry.id === lastCompact.firstKeptEntryId)) : 0;
      // Native compaction must have a valid prefix to summarize. Never break a
      // tool-call/result pair or replace a current operation with a new run.
      if (findCutPoint(branch, start, branch.length, compactionSettings.keepRecentTokens).firstKeptEntryIndex <= start) return;
      await session.compact();
    },
  };
}
