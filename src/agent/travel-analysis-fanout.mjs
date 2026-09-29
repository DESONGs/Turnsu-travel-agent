import { randomUUID } from "node:crypto";
import { runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
import { contentText, createModels, Type } from "@earendil-works/pi-ai";
import { createTravelAgentSession } from "../../travel-agent-pi-package/src/host/travel-agent-session.ts";
import { analysisAssignment, analysisContentIssue, acceptAnalysisHandoff } from "../../travel-agent-pi-package/src/host/analysis-handoff.ts";
import { emitTravelExecution, currentTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { TravelExecutionDeferred } from "../../travel-agent-pi-package/src/host/travel-decision-policy.ts";
import { streamTravelModel } from "../../travel-agent-pi-package/src/host/model-budget.ts";
import { Value } from "typebox/value";
import { TravelAnalysisLaneResultSchema } from "../../travel-agent-pi-package/src/contracts/index.ts";
import { childSkillForLane } from "./travel-skill-loader.mjs";
import { resolveConfiguredModel, visualCompletionOptions } from "./travel-conversation-agent.mjs";
import { TRAVEL_MODEL_PROVIDERS } from "./travel-model-providers.mjs";

const LANE_ORDER = Object.freeze(["inventory_budget", "local_discovery", "operability_schedule"]);
const WORKFLOW_SCRIPT = `
export const meta = { name: "travel-analysis-fanout", description: "One bounded read-only semantic analysis fan-out" };
const run = (task) => () => agent(task.prompt, {
  label: task.lane,
  schema: args.outputSchema,
  timeoutMs: task.timeoutMs,
  retries: 0,
});
const results = Array(args.tasks.length).fill(null);
let cursor = 0;
const worker = async () => {
  while (cursor < args.tasks.length) {
    const index = cursor++;
    const result = await run(args.tasks[index])();
    results[index] = result;
    if (result === null) return;
  }
};
await parallel(Array.from({ length: Math.min(args.childConcurrency, args.tasks.length) }, () => worker));
return results;
`;

function jsonValue(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  try { return JSON.parse(fenced); } catch { return null; }
}

function jsonObjectValue(text) {
  const direct = jsonValue(text);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const raw = String(text ?? "");
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const value = JSON.parse(raw.slice(start, index + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) return value;
        } catch { break; }
      }
    }
  }
  return null;
}

function compactOperability(value = {}) {
  return {
    ...Object.fromEntries(["type", "typeCode", "rating", "businessArea", "district", "priceHint", "transportType", "serviceNumber", "departureAt", "arrivalAt", "roomName", "roomType", "inventoryVerified", "scheduleVerified", "weatherFit", "foreignGuestEligibilityStatus"].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
    ...(value.departurePlace ? { departurePlace: { label: value.departurePlace.label ?? null, terminal: value.departurePlace.terminal ?? null } } : {}),
    ...(value.arrivalPlace ? { arrivalPlace: { label: value.arrivalPlace.label ?? null, terminal: value.arrivalPlace.terminal ?? null } } : {}),
    ...(value.researchFit ? { researchFit: { score: value.researchFit.score ?? null, namedMatches: (value.researchFit.namedMatches ?? []).slice(0, 4), areaMatches: (value.researchFit.areaMatches ?? []).slice(0, 4), arrivalTimeFit: value.researchFit.arrivalTimeFit ?? null } } : {}),
    ...(Array.isArray(value.mappedFacilities) ? { mappedFacilities: value.mappedFacilities.slice(0, 6).map((facility) => ({ kind: facility.kind ?? null, label: facility.label ?? null, status: facility.status ?? null })) } : {}),
  };
}

function analysisCandidates(providerResult) {
  return Object.entries(providerResult.byDomain ?? {}).flatMap(([domain, candidates]) => (candidates ?? []).map((candidate, index) => ({
    candidateId: candidate.candidateId ?? `${domain}_${index + 1}`,
    domain,
    title: candidate.title,
    summary: String(candidate.summary ?? "").slice(0, 180),
    cost: Number(candidate.cost ?? 0),
    price: candidate.price ?? null,
    operability: compactOperability(candidate.operability),
    evidenceRefs: [...new Set([candidate.sourceId, candidate.claimId, ...(candidate.additionalEvidence ?? []).flatMap((item) => [item.sourceId, item.claimId])].filter(Boolean))],
  })));
}

function runtimeSkillContent(skill) {
  return skill.content.split(/\nReferences retained from the previous micro Skills:/)[0].replace(/^---[\s\S]*?---\s*/m, "").trim();
}

function compactBrief(brief = {}) {
  return Object.fromEntries(["destination", "dates", "durationDays", "origin", "arrivalMode", "arrivalAirport", "arrivalTerminal", "arrivalTime", "totalBudget", "currency", "pace", "lodgingPreference", "foodPreferences"].filter((key) => brief[key] !== undefined).map((key) => [key, brief[key]]));
}

function compactTravelers(travelers = []) {
  return travelers.slice(0, 12).map((traveler) => ({ travelerId: traveler.travelerId, displayName: traveler.displayName, relationship: traveler.relationship ?? null, language: traveler.language ?? null, hardConstraints: (traveler.hardConstraints ?? []).slice(0, 8), careNeeds: traveler.careNeeds ?? {} }));
}

function compactWeather(weather) {
  if (!weather) return null;
  return { status: weather.status ?? null, coverage: weather.coverage ?? null, provider: weather.provider ?? null, checkedAt: weather.checkedAt ?? null, planningImpact: weather.planningImpact ? { active: weather.planningImpact.active === true, severity: weather.planningImpact.severity ?? null, affectedDomains: (weather.planningImpact.affectedDomains ?? []).slice(0, 4), guidance: weather.planningImpact.guidance ?? null } : null };
}

function laneCandidates(lane, candidates) {
  if (lane === "inventory_budget") return candidates.filter((candidate) => ["stay", "transport"].includes(candidate.domain));
  if (lane === "local_discovery") return candidates.filter((candidate) => ["food", "play"].includes(candidate.domain));
  return ["transport", "stay", "food", "play"].map((domain) => candidates.find((candidate) => candidate.domain === domain)).filter(Boolean);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

export function requiredTravelAnalysisLanes({ domains = [], travelers = [], weather = null } = {}) {
  const lanes = [];
  if (domains.some((domain) => ["stay", "transport"].includes(domain))) lanes.push("inventory_budget");
  if (domains.some((domain) => ["food", "play"].includes(domain))) lanes.push("local_discovery");
  if (domains.length >= 2 || travelers.length || weather) lanes.push("operability_schedule");
  return LANE_ORDER.filter((lane) => lanes.includes(lane)).slice(0, 3);
}

function lanePrompt(lane, input, skill) {
  const focus = {
    inventory_budget: "Compare transport and stay inventory, price quality, budget impact, and missing price information.",
    local_discovery: "Assess local character, source independence, entity conflicts, and unsupported long-tail claims for food and play.",
    operability_schedule: "Assess per-traveler operability, weather, spatial fit, schedule coherence, and execution gaps.",
  }[lane];
  const payload = {
    analysisId: input.analysisId,
    lane,
    objective: input.objective,
    brief: input.brief,
    travelers: input.travelers,
    candidates: laneCandidates(lane, input.candidates).map(({ candidateId, domain, title, evidenceRefs }) => ({ candidateId, domain, title, evidenceRefs })),
    weather: input.weather,
    locks: input.locks,
  };
  return `You are a read-only Travel Agent analysis child. ${focus}

The input already contains the assigned traveler context. Read candidate details with read_analysis_evidence; use read_analysis_context only if you need the full assignment. If both are needed, call them together in one parallel tool turn. You must not request Providers, credentials, URLs, shell access, purchases, state writes, commits, or further delegation. Use only the supplied normalized evidence. Return exactly one compact object matching travel-analysis-lane-v1, with at most 4 findings, 4 reason codes, 4 unknowns and 3 needsContext items. Candidate IDs and evidence refs must come from the input. If evidence is insufficient, use unknowns or needsContext instead of inventing facts. A missing source, forecast, room quote or user preference does not by itself justify searching again. Use a criteria_ reason code only when changing a specific search condition can address the mismatch.

Active Skill ${skill.skillId} version ${skill.version}:
${runtimeSkillContent(skill)}

Input:
${JSON.stringify(payload)}`;
}

function normalizeLaneResult(result, task, input) {
  if (!result || typeof result !== "object" || !task) return null;
  const candidates = laneCandidates(task.lane, input.candidates);
  const assignment = analysisAssignment({ runId: input.runId, tripId: input.tripId, baseRevision: input.baseRevision, criteriaFingerprint: input.criteriaFingerprint, lane: task.lane, candidateIds: candidates.map((candidate) => candidate.candidateId), evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs) });
  const issue = analysisContentIssue(result, assignment);
  if (issue) { task.error = `normalized_schema_invalid:${issue}`; return null; }
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const evidenceRefs = new Set(candidates.flatMap((candidate) => candidate.evidenceRefs));
  const normalized = {
    schemaVersion: "travel-analysis-lane-v1",
    analysisId: input.analysisId,
    runId: input.runId,
    tripId: input.tripId,
    baseRevision: input.baseRevision,
    criteriaFingerprint: input.criteriaFingerprint,
    lane: task.lane,
    attempt: task.attempt,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt ?? task.queuedAt,
    completedAt: task.completedAt ?? task.startedAt ?? task.queuedAt,
    status: "completed",
    model: result.__runtime?.model ?? null,
    queueDurationMs: Math.max(0, new Date(task.startedAt ?? task.queuedAt).getTime() - new Date(task.queuedAt).getTime()),
    executionDurationMs: Math.max(0, new Date(task.completedAt ?? task.startedAt ?? task.queuedAt).getTime() - new Date(task.startedAt ?? task.queuedAt).getTime()),
    tokenUsage: result.__runtime?.tokenUsage && [result.__runtime.tokenUsage.input, result.__runtime.tokenUsage.output, result.__runtime.tokenUsage.total].every(Number.isFinite) ? result.__runtime.tokenUsage : null,
    findings: arrayValue(result.findings).slice(0, 20).filter((finding) => finding && typeof finding === "object").map((finding, index) => ({
      findingId: String(finding.findingId || `finding_${task.lane}_${index + 1}`).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128),
      summary: String(finding.summary ?? "").slice(0, 800),
      reasonCode: String(finding.reasonCode ?? "analysis_finding").slice(0, 120),
      candidateIds: arrayValue(finding.candidateIds).filter((candidateId) => candidateIds.has(candidateId)).slice(0, 16),
      evidenceRefs: arrayValue(finding.evidenceRefs).filter((evidenceRef) => evidenceRefs.has(evidenceRef)).slice(0, 24),
    })).filter((finding) => finding.summary),
    recommendedCandidateIds: arrayValue(result.recommendedCandidateIds).filter((candidateId) => candidateIds.has(candidateId)).slice(0, 24),
    rejectedCandidateIds: arrayValue(result.rejectedCandidateIds).filter((candidateId) => candidateIds.has(candidateId)).slice(0, 24),
    reasonCodes: arrayValue(result.reasonCodes).map((code) => String(code).slice(0, 120)).slice(0, 24),
    unknowns: arrayValue(result.unknowns).map((item) => String(item).slice(0, 500)).slice(0, 20),
    needsContext: arrayValue(result.needsContext).map((item) => String(item).slice(0, 300)).slice(0, 12),
    evidenceRefs: arrayValue(result.evidenceRefs).filter((evidenceRef) => evidenceRefs.has(evidenceRef)).slice(0, 48),
    skillId: task.skill.skillId,
    skillVersion: task.skill.version,
  };
  if (Value.Check(TravelAnalysisLaneResultSchema, normalized)) return normalized;
  task.error = `normalized_schema_invalid:${[...Value.Errors(TravelAnalysisLaneResultSchema, normalized)].slice(0, 4).map((issue) => `${issue.instancePath || "/"}:${issue.message}`).join("|")}`.slice(0, 500);
  return null;
}

export function childModelFallbackLedger(env = process.env) {
  const kimiConfigured = Boolean(String(env.MOONSHOT_API_KEY ?? "").trim());
  const kimiVerified = env.TRAVEL_AGENT_KIMI_CHILD_SMOKE_STATUS === "passed_live_smoke";
  const parentRoute = resolveConfiguredModel(env, { role: "reasoning" });
  if (kimiConfigured && kimiVerified) return {
    primary: { provider: "moonshotai-cn", model: "kimi-k2.6", status: "configured" },
    fallback: { provider: parentRoute.provider, model: parentRoute.model, status: parentRoute.status === "checking" ? "available" : "fallback_unavailable", reason: parentRoute.status === "checking" ? null : "model_unavailable" },
  };
  return {
    primary: { provider: parentRoute.provider, model: parentRoute.model, status: parentRoute.status === "checking" ? "configured" : "unavailable" },
    fallback: { provider: "moonshotai-cn", model: "kimi-k2.6", status: kimiConfigured && kimiVerified ? "available" : "fallback_unavailable", reason: kimiVerified ? null : "child_structured_skill_smoke_required" },
  };
}

function modelRoutes(env, { forceRoute = null } = {}) {
  if (forceRoute) return [forceRoute];
  const ledger = childModelFallbackLedger(env);
  const routes = [ledger.primary, ledger.fallback].filter((route) => ["configured", "available"].includes(route.status)).map((route) => ({ ...route, status: "checking" }));
  return routes.filter((route, index, items) => route.status === "checking" && items.findIndex((item) => item.provider === route.provider && item.model === route.model) === index);
}

export async function createTravelAnalysisAgentRunner(env = process.env, options = {}) {
  const models = options.models ?? createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });
  const resolved = [];
  for (const route of modelRoutes(env, options)) {
    const provider = TRAVEL_MODEL_PROVIDERS[route.provider];
    if (!provider && !options.models) continue;
    if (!options.models) models.setProvider(provider.create());
    const auth = await models.checkAuth(route.provider).catch(() => undefined);
    const model = models.getModel(route.provider, route.model);
    if (auth && model) resolved.push({ route, model });
  }
  if (!resolved.length) return null;
  return {
    async run(prompt, runOptions = {}) {
      let lastError = null;
      const task = options.tasks?.find((item) => item.lane === runOptions.label);
      const input = options.input;
      const candidates = input && task ? laneCandidates(task.lane, input.candidates) : [];
      const assignment = input && task ? analysisAssignment({ runId: input.runId, tripId: input.tripId, baseRevision: input.baseRevision, criteriaFingerprint: input.criteriaFingerprint, lane: task.lane, candidateIds: candidates.map((item) => item.candidateId), evidenceRefs: candidates.flatMap((item) => item.evidenceRefs) }, { brief: input.brief, travelers: input.travelers, weather: input.weather, locks: input.locks, candidates }) : null;
      for (const { model, route } of resolved) {
        runOptions.signal?.throwIfAborted();
        let native;
        try {
          const readGuard = async () => {
            runOptions.signal?.throwIfAborted();
            if (options.validateCurrent && !await options.validateCurrent(input)) throw Object.assign(new Error("analysis_context_stale"), { code: "analysis_context_stale" });
          };
          const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: { status: "ready" } });
          const tools = assignment ? [
            { name: "read_analysis_context", label: "读取分工与约束", description: "Read the immutable task assignment, traveler requirements, weather and locks. This is the shared fact view, not another agent's conversation.", parameters: Type.Object({}), executionMode: "parallel", execute: async () => { await readGuard(); return result({ assignment, brief: input.brief, travelers: input.travelers, weather: input.weather, locks: input.locks }); } },
            { name: "read_analysis_evidence", label: "读取分工内的候选证据", description: "Read normalized evidence for candidate IDs in this assignment only. No network or state write is allowed.", parameters: Type.Object({ candidateIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }) }), executionMode: "parallel", execute: async (_callId, args) => { await readGuard(); if (args.candidateIds.some((id) => !assignment.candidateIds.includes(id))) throw new Error("analysis_context_scope_violation"); return result(candidates.filter((item) => args.candidateIds.includes(item.candidateId))); } },
          ] : [];
          const outputTemplate = '{"schemaVersion":"travel-analysis-lane-v1","analysisId":"copy from input","lane":"copy from input","findings":[{"findingId":"stable_id","summary":"supported finding","reasonCode":"reason_code","candidateIds":[],"evidenceRefs":[]}],"recommendedCandidateIds":[],"rejectedCandidateIds":[],"reasonCodes":[],"unknowns":[],"needsContext":[],"evidenceRefs":[],"skillId":"copy active skill","skillVersion":"copy active version"}';
          native = await createTravelAgentSession({ conversationId: `child_${input?.runId ?? randomUUID()}_${task?.lane ?? "analysis"}`, models, model,
            systemPrompt: `You are a bounded read-only Travel Agent child. Inspect only assigned context using the available tools. Do not delegate or commit. Finish with one compact JSON object: ${outputTemplate}`,
            thinkingLevel: "off", tools, isSensitive: (text) => /(?:cookie|authorization|password|api[_ -]?key)\s*[:=]/i.test(text),
          });
          const session = native.session;
          let modelCalls = 0;
          let toolCalls = 0;
          session.agent.toolExecution = "parallel";
          session.agent.streamFunction = (selected, context, settings) => {
            if (++modelCalls > 4) throw new Error("analysis_model_budget_exhausted");
            return streamTravelModel(models, selected, context, visualCompletionOptions(selected.id, { ...settings, reasoning: "minimal", maxTokens: 2200, maxRetries: 0 }));
          };
          const toolHook = session.agent.beforeToolCall;
          session.agent.beforeToolCall = async (event) => {
            if (++toolCalls > 4) return { block: true, reason: "analysis_tool_budget_exhausted", terminate: true };
            await emitTravelExecution({ type: "child_tool_started", lane: task?.lane ?? "analysis", toolName: event.toolCall.name, status: "running" });
            return toolHook?.(event);
          };
          const abort = () => { void session.abort(); };
          runOptions.signal?.addEventListener("abort", abort, { once: true });
          let parsed;
          try {
            await readGuard();
            await session.prompt(prompt, { expandPromptTemplates: false });
            for (let attempt = 0; attempt < 2; attempt++) {
              const response = [...session.agent.state.messages].reverse().find((message) => message.role === "assistant");
              if (["error", "aborted", "length"].includes(response?.stopReason)) throw Object.assign(new Error("travel_analysis_output_incomplete"), { code: "travel_analysis_output_incomplete" });
              parsed = jsonObjectValue(contentText(response?.content ?? []));
              const issue = analysisContentIssue(parsed, assignment);
              if (!issue) break;
              if (attempt > 0 || modelCalls >= 4) throw Object.assign(new Error(`invalid_travel_analysis_output:${issue}`), { code: "invalid_travel_analysis_output" });
              await readGuard();
              session.setActiveToolsByName([]);
              await session.prompt(`Your handoff was rejected: ${issue}. Correct its JSON format and references once using the evidence already read. Do not change facts, invoke tools, or invent missing evidence. Include findings as an array (empty is allowed when unknowns explains the gap), and string arrays for the other collections. Only use candidate IDs and evidence refs in your assignment. Return exactly one object: ${outputTemplate}`, { expandPromptTemplates: false });
            }
            runOptions.signal?.throwIfAborted();
            await readGuard();
          } finally { runOptions.signal?.removeEventListener("abort", abort); }
          const usage = session.agent.state.messages.filter((message) => message.role === "assistant").reduce((total, message) => ({ input: total.input + Number(message.usage?.input ?? 0), output: total.output + Number(message.usage?.output ?? 0), total: total.total + Number(message.usage?.totalTokens ?? 0) }), { input: 0, output: 0, total: 0 });
          return { ...parsed, __runtime: { model: `${route.provider}/${route.model}`, fallbackUsed: model !== resolved[0]?.model, tokenUsage: usage, toolCalls, modelCalls, contextHash: assignment?.contextHash } };
        } catch (error) {
          const waiting = currentTravelExecution()?.defer;
          if (waiting) throw new TravelExecutionDeferred(waiting.notBefore, waiting.waitReason);
          lastError = error; if (runOptions.signal?.aborted || error?.code === "analysis_context_stale") throw error;
        }
        finally { native?.session.dispose(); }
      }
      throw lastError ?? Object.assign(new Error("travel_analysis_model_unavailable"), { code: "travel_analysis_model_unavailable" });
    },
  };
}

export function createTravelAnalysisFanout(env = process.env, options = {}) {
  const clock = options.clock ?? (() => new Date());
  const coordinator = options.coordinator ?? null;
  const childConcurrency = Math.max(1, Math.min(3, Number(options.childConcurrency ?? 2) || 2));
  return async function travelAnalysisFanout({ runId = `run_${randomUUID().slice(0, 8)}`, tripId, baseRevision, criteriaFingerprint = "unscoped", requiredLanes = null, brief, travelers = [], providerResult, objective = "Review the linked trip candidates", locks = [], signal = null, deadlineAt: requestedDeadlineAt = null, validateCurrent = null } = {}) {
    const startedAt = new Date(clock()).toISOString();
    const maximumDeadline = Date.now() + (options.deadlineMs ?? 90_000);
    const requestedDeadline = new Date(requestedDeadlineAt ?? maximumDeadline).getTime();
    const deadlineAt = new Date(Number.isFinite(requestedDeadline) ? Math.min(maximumDeadline, requestedDeadline) : maximumDeadline).toISOString();
    const input = { analysisId: `analysis_${runId.replace(/[^A-Za-z0-9_.:-]/g, "_")}`.slice(0, 128), runId, tripId, baseRevision, criteriaFingerprint, brief: compactBrief(brief), travelers: compactTravelers(travelers), candidates: analysisCandidates(providerResult), weather: compactWeather(providerResult?.weather), locks, objective };
    const laneIds = (requiredLanes ?? requiredTravelAnalysisLanes({ domains: [...new Set(input.candidates.map((candidate) => candidate.domain))], travelers: input.travelers, weather: input.weather })).filter((lane) => LANE_ORDER.includes(lane));
    const runRecord = coordinator?.begin({ runId, tripId, baseRevision, criteriaFingerprint, requiredLanes: laneIds, deadlineAt }) ?? null;
    const fallbackLedger = childModelFallbackLedger(env);
    const base = { schemaVersion: "travel-analysis-fanout-v1", analysisId: input.analysisId, runId, tripId, baseRevision, criteriaFingerprint, engine: options.engine ?? "dynamic_workflow", requiredLanes: laneIds, childConcurrency, modelFallback: { primaryStatus: fallbackLedger.primary.status, fallbackStatus: fallbackLedger.fallback.status, fallbackModel: fallbackLedger.fallback.status === "available" ? `${fallbackLedger.fallback.provider}/${fallbackLedger.fallback.model}` : null }, startedAt, deadlineAt };
    if (laneIds.length === 0) {
      return { ...base, status: "skipped", lanes: [], startedLanes: [], completedLanes: [], failedLanes: [], timedOutLanes: [], coverage: "complete", degradedReasons: [], joinCount: 0, joinArtifactId: null, taskCount: 0, completedAt: new Date(clock()).toISOString(), conditionRevision: { status: "not_needed", reasonCodes: ["insufficient_independent_lanes"] }, events: [] };
    }
    const tasks = laneIds.map((lane) => {
      const skill = childSkillForLane(lane);
      return { lane, skill, attempt: 1, queuedAt: new Date(clock()).toISOString(), startedAt: null, completedAt: null, rawResult: null, error: null, timeoutMs: options.agentTimeoutMs ?? 45_000, prompt: lanePrompt(lane, input, skill) };
    });
    const agentRunner = options.agentRunner ?? await createTravelAnalysisAgentRunner(env, { ...options.analysisRunnerOptions, input, tasks, validateCurrent });
    if (!agentRunner) {
      return { ...base, status: "failed", lanes: [], startedLanes: [], completedLanes: [], failedLanes: laneIds, timedOutLanes: [], coverage: "failed", degradedReasons: laneIds.map((lane) => `${lane}_model_unavailable`), joinCount: 0, joinArtifactId: null, taskCount: laneIds.length, completedAt: new Date(clock()).toISOString(), conditionRevision: { status: "not_needed", reasonCodes: ["analysis_model_unavailable"] }, events: [] };
    }
    const events = [];
    const eventWrites = [];
    const persistEvent = (value) => { const pending = emitTravelExecution(value); void pending.catch(() => {}); eventWrites.push(pending); };
    const internalAbort = new AbortController();
    const signals = [signal, runRecord?.abortController.signal, internalAbort.signal].filter(Boolean);
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const deadlineTimer = setTimeout(() => internalAbort.abort("travel_analysis_parent_deadline"), Math.max(1, new Date(deadlineAt).getTime() - Date.now()));
    let workflow = null;
    let consecutiveTimeouts = 0;
    try {
      workflow = await runWorkflow(WORKFLOW_SCRIPT, {
        args: { tasks: tasks.map(({ lane, prompt, timeoutMs }) => ({ lane, prompt, timeoutMs })), childConcurrency, outputSchema: TravelAnalysisLaneResultSchema },
        agent: { run: (prompt, runOptions) => {
          const execution = currentTravelExecution();
          const task = tasks.find(item => item.lane === runOptions.label);
          const invoke = () => agentRunner.run(prompt, runOptions);
          return execution?.readStep ? execution.readStep(`child_${runId}_${runOptions.label}`, { input, lane: runOptions.label, skillVersion: task?.skill.version, routes: fallbackLedger }, invoke) : invoke();
        } },
        concurrency: Math.min(childConcurrency, tasks.length),
        maxAgents: tasks.length,
        agentRetries: 0,
        agentTimeoutMs: options.agentTimeoutMs ?? 45_000,
        tokenBudget: options.tokenBudget ?? null,
        persistLogs: false,
        signal: combinedSignal,
        onAgentStart: (event) => {
          const task = tasks.find((item) => item.lane === event.label);
          const at = new Date(clock()).toISOString();
          if (task) task.startedAt = at;
          coordinator?.recordLaneStarted(runId, { lane: event.label, attempt: task?.attempt ?? 1, queuedAt: task?.queuedAt ?? at, startedAt: at });
          const runtimeEvent = { type: "analysis_lane_started", lane: event.label, attempt: task?.attempt ?? 1, queuedAt: task?.queuedAt ?? at, queueDurationMs: Math.max(0, new Date(at).getTime() - new Date(task?.queuedAt ?? at).getTime()), at };
          events.push(runtimeEvent); options.onEvent?.(runtimeEvent);
          persistEvent({ type: runtimeEvent.type, lane: event.label, attempt: task?.attempt ?? 1, status: "running" });
        },
        onAgentEnd: (event) => {
          const task = tasks.find((item) => item.lane === event.label);
          const at = new Date(clock()).toISOString();
          const timedOut = /timed out|timeout/i.test(event.error ?? "");
          if (task) {
            task.completedAt = at; task.rawResult = event.result ?? null; task.error = event.error ?? null;
            if (!task.error && !normalizeLaneResult(task.rawResult, task, input)) task.error ??= "normalized_schema_invalid:child_result_shape";
          }
          const error = task?.error ?? event.error ?? null;
          consecutiveTimeouts = timedOut ? consecutiveTimeouts + 1 : 0;
          coordinator?.recordLaneCompletion(runId, { lane: event.label, attempt: task?.attempt ?? 1, completedAt: at, status: timedOut ? "timed_out" : error ? "failed" : "completed", result: error ? null : event.result ?? null });
          const runtimeEvent = { type: "analysis_lane_completed", lane: event.label, attempt: task?.attempt ?? 1, at, error, executionDurationMs: Math.max(0, new Date(at).getTime() - new Date(task?.startedAt ?? at).getTime()), model: event.model ?? event.result?.__runtime?.model ?? null };
          events.push(runtimeEvent); options.onEvent?.(runtimeEvent);
          persistEvent({ type: runtimeEvent.type, lane: event.label, attempt: task?.attempt ?? 1, status: timedOut || error ? "failed" : "completed" });
          if (consecutiveTimeouts >= childConcurrency && !tasks.some((item) => item.rawResult)) internalAbort.abort("travel_analysis_timeout_circuit_open");
        },
      });
    } catch (error) {
      if (!combinedSignal.aborted) throw error;
    } finally {
      clearTimeout(deadlineTimer);
      await Promise.all(eventWrites);
    }
    const waiting = currentTravelExecution()?.defer;
    if (waiting) throw new TravelExecutionDeferred(waiting.notBefore, waiting.waitReason);
    const rawResults = Array.isArray(workflow?.result) ? workflow.result : tasks.map((task) => task.rawResult);
    const lanes = rawResults.map((result, index) => normalizeLaneResult(result, tasks[index], input)).filter(Boolean);
    for (const task of tasks.filter((item) => item.error?.startsWith("normalized_schema_invalid:"))) {
      const completionEvent = [...events].reverse().find((event) => event.type === "analysis_lane_completed" && event.lane === task.lane && event.attempt === task.attempt);
      if (completionEvent && !completionEvent.error) completionEvent.error = task.error;
    }
    for (const lane of lanes) coordinator?.recordLaneCompletion(runId, { lane: lane.lane, attempt: lane.attempt, completedAt: lane.completedAt, status: "completed", result: lane });
    const startedLanes = laneIds.filter((lane) => tasks.find((task) => task.lane === lane)?.startedAt);
    const completedLanes = lanes.map((result) => result.lane);
    const timedOutLanes = laneIds.filter((lane) => /timed out|timeout/i.test(tasks.find((task) => task.lane === lane)?.error ?? ""));
    const failedLanes = laneIds.filter((lane) => !completedLanes.includes(lane));
    const coverage = completedLanes.length === laneIds.length ? "complete" : completedLanes.length ? "partial" : "failed";
    const degradedReasons = failedLanes.map((lane) => `${lane}_${timedOutLanes.includes(lane) ? "timed_out" : "failed"}`);
    const reasonCodes = [...new Set(lanes.flatMap((result) => result.reasonCodes))];
    const needsRevision = lanes.some((result) => result.reasonCodes.some((code) => /^(?:criteria_|wrong_area|hard_constraint)/i.test(code)));
    const isCurrent = validateCurrent ? await validateCurrent({ runId, tripId, baseRevision, criteriaFingerprint }) : true;
    if (!isCurrent) {
      coordinator?.markStale(runId, "revision_or_fingerprint_changed");
      return { ...base, status: "stale_discarded", lanes: [], startedLanes, completedLanes: [], failedLanes: laneIds, timedOutLanes, coverage: "failed", degradedReasons: ["revision_or_fingerprint_changed"], joinCount: 0, joinArtifactId: null, taskCount: tasks.length, completedAt: new Date(clock()).toISOString(), conditionRevision: { status: "not_needed", reasonCodes: ["stale_discarded"] }, events };
    }
    for (const lane of lanes) {
      const candidates = laneCandidates(lane.lane, input.candidates);
      const assignment = analysisAssignment({ runId, tripId, baseRevision, criteriaFingerprint, lane: lane.lane, candidateIds: candidates.map((candidate) => candidate.candidateId), evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs) }, { brief: input.brief, travelers: input.travelers, weather: input.weather, locks: input.locks, candidates });
      const receipt = acceptAnalysisHandoff(assignment, lane);
      await emitTravelExecution({ type: "analysis_handoff", status: receipt.status, lane: lane.lane, runId, revision: baseRevision });
    }
    const join = coordinator?.tryJoin(runId) ?? { acquired: true, reason: "no_coordinator", artifact: null };
    if (!join.acquired && join.artifact) return join.artifact;
    if (!join.acquired) {
      return { ...base, status: "stale_discarded", lanes: [], startedLanes, completedLanes: [], failedLanes: laneIds, timedOutLanes, coverage: "failed", degradedReasons: [join.reason], joinCount: 0, joinArtifactId: null, taskCount: tasks.length, completedAt: new Date(clock()).toISOString(), conditionRevision: { status: "not_needed", reasonCodes: [join.reason] }, events };
    }
    const result = {
      ...base,
      status: coverage === "complete" ? "completed" : coverage,
      lanes,
      startedLanes,
      completedLanes,
      failedLanes,
      timedOutLanes,
      coverage,
      degradedReasons,
      joinCount: 1,
      joinArtifactId: `join_${runId}`.slice(0, 128),
      taskCount: tasks.length,
      completedAt: new Date(clock()).toISOString(),
      conditionRevision: {
        status: needsRevision ? "recommended" : "not_needed",
        reasonCodes: needsRevision ? reasonCodes : lanes.length ? ["analysis_found_no_material_criteria_revision"] : ["analysis_unavailable_no_revision_decision"],
      },
      events,
    };
    coordinator?.completeJoin(runId, result);
    return result;
  };
}
