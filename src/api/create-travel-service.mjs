import { createTripRepository } from "../persistence/trip-repository.mjs";
import { createTravelResearchProvider } from "../providers/travel-research-provider.mjs";
import { createTravelAnalysisFanout } from "../agent/travel-analysis-fanout.mjs";
import { createTravelAnalysisRunCoordinator } from "../agent/travel-analysis-run-coordinator.mjs";
import { TravelService } from "./travel-service.mjs";
import { currentTravelExecution, assertTravelExecutionCurrent } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { createTravelJudgment, buildJudgmentSnapshot } from "../../travel-agent-pi-package/src/host/travel-judgment.ts";

export function workflowExecutionPolicy(env = process.env) {
  const configuredWorkers = Math.max(1, Number(env.TRAVEL_AGENT_INSTANCE_COUNT ?? env.WEB_CONCURRENCY ?? 1) || 1);
  const coordinatorRequested = Boolean(String(env.TRAVEL_AGENT_WORKFLOW_COORDINATOR ?? "").trim());
  const requestedMode = String(env.TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE ?? "single_process").trim();
  const singleProcess = requestedMode === "single_process" && configuredWorkers === 1;
  const leased = requestedMode === "postgres_run" && Boolean(env.DATABASE_URL);
  return {
    workflowExecutionMode: leased ? "postgres_run" : "single_process",
    configuredWorkers,
    coordinatorRequested,
    coordinatorSupported: leased,
    semanticFanoutEnabled: singleProcess || leased,
    backgroundResumeSupported: leased ? "read_only_once" : false,
    crossInstanceSteerSupported: false,
    status: singleProcess || leased ? "enabled" : "blocked_multi_instance_without_coordinator",
  };
}

export function createTravelService(env = process.env, options = {}) {
  const store = options.store ?? createTripRepository({
    databaseUrl: env.DATABASE_URL,
    rootDir: env.TRAVEL_AGENT_DATA_DIR,
  });
  const researchProvider = options.researchProvider ?? createTravelResearchProvider(env, options.providerOptions);
  const executionPolicy = workflowExecutionPolicy(env);
  const analysisRunCoordinator = options.analysisRunCoordinator ?? createTravelAnalysisRunCoordinator();
  const planningRunCoordinator = options.planningRunCoordinator ?? createTravelAnalysisRunCoordinator();
  const judgment = createTravelJudgment(env, options.judgmentOptions);
  const boundedFanout = options.analysisFanout === false || !executionPolicy.semanticFanoutEnabled
    ? null
    : options.analysisFanout ?? createTravelAnalysisFanout(env, { clock: options.clock, coordinator: analysisRunCoordinator, childConcurrency: options.analysisOptions?.childConcurrency ?? env.TRAVEL_AGENT_ANALYSIS_CHILD_CONCURRENCY, ...(options.analysisOptions ?? {}) });
  const selectedFanout = judgment && executionPolicy.semanticFanoutEnabled ? async input => {
    const result = await judgment.evaluate(buildJudgmentSnapshot(input));
    if (judgment.mode === "shadow") {
      const legacy = boundedFanout ? await boundedFanout(input) : null;
      if (legacy) return { ...legacy, judgment: result };
    }
    const now = new Date().toISOString();
    // Legacy lane coverage stays empty: independent questions are not three Child runs.
    return { schemaVersion: "travel-analysis-fanout-v1", analysisId: `analysis_${input.runId}`.slice(0, 128),
      runId: input.runId, tripId: input.tripId, baseRevision: input.baseRevision, criteriaFingerprint: input.criteriaFingerprint,
      status: result.status === "evaluated" ? "completed" : "partial", engine: "jev", lanes: [], requiredLanes: [], startedLanes: [], completedLanes: [], failedLanes: [], timedOutLanes: [],
      coverage: result.status === "evaluated" ? "complete" : "partial", degradedReasons: result.code ? [result.code] : [], joinCount: 1, joinArtifactId: `join_${input.runId}`.slice(0, 128),
      taskCount: result.judgments.length * 2 + 1, childConcurrency: 1, modelFallback: { primaryStatus: result.status, fallbackStatus: "parent_owned", fallbackModel: null },
      startedAt: now, completedAt: now, deadlineAt: input.deadlineAt ?? now,
      conditionRevision: { status: "not_needed", reasonCodes: [result.automatic ? "judgment_within_bounds" : "parent_review_required"] }, judgment: result, events: [] };
  } : boundedFanout;
  const analysisFanout = selectedFanout && executionPolicy.workflowExecutionMode === "postgres_run" ? async (input) => {
    if (store.mode !== "postgres" || !currentTravelExecution()) throw Object.assign(new Error("analysis_durable_run_required"), { code: "analysis_durable_run_required" });
    await assertTravelExecutionCurrent();
    return selectedFanout(input);
  } : selectedFanout;
  const service = new TravelService({
    store,
    researchProvider,
    clock: options.clock,
    analysisFanout,
    analysisRunCoordinator,
    planningRunCoordinator,
    analysisDegradedReason: executionPolicy.semanticFanoutEnabled ? null : executionPolicy.status,
  });
  service.workflowExecution = executionPolicy;
  service.judgment = judgment;
  return service;
}
