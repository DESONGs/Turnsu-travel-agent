import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { childModelFallbackLedger, createTravelAnalysisFanout } from "../src/agent/travel-analysis-fanout.mjs";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { TravelAnalysisFanoutResultSchema } from "../travel-agent-pi-package/src/contracts/index.ts";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { withTravelExecution } from "../travel-agent-pi-package/src/host/execution-context.ts";

const checkedAt = "2026-08-27T09:00:00.000Z";

function providerCandidate(domain, index) {
  const candidateId = `${domain}_${index}`;
  const sourceId = `source_${candidateId}`;
  const entityId = `entity_${candidateId}`;
  const claimId = `claim_${candidateId}`;
  return {
    candidateId,
    domain,
    title: `${domain} option ${index}`,
    summary: `Normalized ${domain} evidence`,
    cost: 100 * index,
    checkedAt,
    location: { name: `${domain} option ${index}`, address: `${domain} address` },
    media: [],
    operability: domain === "transport" ? { provider: "fanout_fixture", mobilityRole: "intercity_inventory", transportType: "TRAIN", serviceNumber: `G${index}`, inventoryVerified: true } : { provider: "fanout_fixture", rating: 4 + index / 10 },
    sourceId,
    entityId,
    claimId,
    source: { sourceId, provider: "fanout_fixture", sourceType: "fixture", providerPoiId: candidateId, checkedAt, documentationUrl: "https://example.com/fanout", independenceGroup: sourceId, commercialBias: "fixture" },
    entity: { entityId, kind: domain, canonicalName: `${domain} option ${index}`, providerRefs: [candidateId] },
    claim: { claimId, entityId, kind: "fixture_fact", statement: `${domain} option ${index} is fixture evidence`, sourceRefs: [sourceId], sourceIndependence: "fixture", commercialBias: "fixture", confidence: 0.9, observedAt: checkedAt },
  };
}

function providerResult() {
  return {
    schemaVersion: "travel-provider-result-v1",
    status: "completed",
    provider: "fanout_fixture",
    providerLabel: "Fanout fixture",
    destination: "Shanghai",
    checkedAt,
    byDomain: {
      play: [providerCandidate("play", 1)],
      food: [providerCandidate("food", 1)],
      stay: [providerCandidate("stay", 1)],
      transport: [providerCandidate("transport", 1)],
    },
    partial: false,
    errors: [],
    caveats: [],
    fabricatedResults: false,
    fixtureOnly: true,
  };
}

function fixtureRunner(trace) {
  return {
    async run(prompt) {
      const lane = prompt.match(/"lane":"([^"]+)"/)?.[1];
      const analysisId = prompt.match(/"analysisId":"([^"]+)"/)?.[1];
      const candidateIds = [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].map((match) => match[1]);
      const skill = prompt.match(/Active Skill ([^ ]+) version ([^:]+):/);
      const startedAt = Date.now();
      trace.active += 1;
      trace.maximumActive = Math.max(trace.maximumActive, trace.active);
      trace.prompts.push({ lane, prompt, startedAt });
      if (trace.beforeComplete) await trace.beforeComplete(lane);
      await new Promise((resolve) => setTimeout(resolve, lane === "inventory_budget" ? 45 : 30));
      trace.active -= 1;
      trace.completed.push({ lane, completedAt: Date.now() });
      return {
        schemaVersion: "travel-analysis-lane-v1",
        analysisId,
        lane,
        findings: [{ findingId: `finding_${lane}`, summary: `${lane} reviewed distinct normalized evidence`, reasonCode: `${lane}_reviewed`, candidateIds: candidateIds.slice(0, 2), evidenceRefs: [] }],
        recommendedCandidateIds: candidateIds.slice(0, 1),
        rejectedCandidateIds: [],
        reasonCodes: [`${lane}_reviewed`],
        unknowns: [],
        needsContext: [],
        evidenceRefs: [],
        skillId: skill?.[1] ?? "unknown",
        skillVersion: skill?.[2] ?? "unknown",
      };
    },
  };
}

test("dynamic travel analysis runs distinct read-only lanes concurrently and joins once", async () => {
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  let releaseFirst;
  const thirdStarted = new Promise((resolve) => { releaseFirst = resolve; });
  trace.beforeComplete = async (lane) => {
    if (lane === "operability_schedule") releaseFirst();
    if (lane === "inventory_budget") await thirdStarted;
  };
  const fanout = createTravelAnalysisFanout({}, { agentRunner: fixtureRunner(trace), engine: "fixture", agentTimeoutMs: 3000 });
  const result = await fanout({ tripId: "trip_fanout", baseRevision: 0, brief: { destination: "Shanghai" }, travelers: [{ travelerId: "traveler_1", careNeeds: {} }], providerResult: providerResult(), objective: "Compare the complete fixture trip" });

  assert.equal(result.status, "completed");
  assert.equal(Value.Check(TravelAnalysisFanoutResultSchema, result), true);
  assert.equal(result.coverage, "complete");
  assert.deepEqual([...result.requiredLanes], ["inventory_budget", "local_discovery", "operability_schedule"]);
  assert.deepEqual([...result.startedLanes], [...result.requiredLanes]);
  assert.deepEqual([...result.completedLanes], [...result.requiredLanes]);
  assert.equal(result.joinCount, 1);
  assert.equal(result.taskCount, 3);
  assert.deepEqual([...result.lanes].map((lane) => lane.lane), ["inventory_budget", "local_discovery", "operability_schedule"]);
  assert.equal(result.lanes.every((lane) => lane.runId === result.runId && lane.tripId === "trip_fanout" && lane.baseRevision === 0 && lane.attempt === 1 && lane.startedAt && lane.completedAt), true);
  assert.ok(trace.maximumActive >= 2, "at least two semantic lanes must overlap");
  assert.ok(trace.maximumActive <= 2, "the default child semaphore must cap concurrency at two");
  assert.ok(result.lanes.find((lane) => lane.lane === "operability_schedule").queueDurationMs >= 25, "the third lane must wait behind the two-slot semaphore");
  assert.ok(trace.prompts.find((item) => item.lane === "operability_schedule").startedAt < trace.completed.find((item) => item.lane === "inventory_budget").completedAt, "a successful lane must release its semaphore slot without waiting for the whole first wave");
  assert.equal(new Set(trace.prompts.map((item) => item.prompt)).size, 3, "lane prompts must not be clones");
  assert.match(trace.prompts.find((item) => item.lane === "local_discovery").prompt, /Skill research-trip/);
  assert.match(trace.prompts.find((item) => item.lane === "operability_schedule").prompt, /Skill plan-trip/);
});

test("one required lane is executed instead of being mislabeled complete without analysis", async () => {
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const fanout = createTravelAnalysisFanout({}, { agentRunner: fixtureRunner(trace), engine: "fixture" });
  const result = await fanout({
    runId: "run_one_lane",
    tripId: "trip_one_lane",
    baseRevision: 3,
    criteriaFingerprint: "fp_one_lane",
    requiredLanes: ["inventory_budget"],
    brief: { destination: "Shanghai", totalBudget: 8000 },
    providerResult: providerResult(),
  });

  assert.equal(result.coverage, "complete");
  assert.deepEqual([...result.requiredLanes], ["inventory_budget"]);
  assert.deepEqual([...result.startedLanes], ["inventory_budget"]);
  assert.deepEqual([...result.completedLanes], ["inventory_budget"]);
  assert.equal(result.taskCount, 1);
  assert.equal(result.joinCount, 1);
  assert.equal(result.lanes.length, 1);
});

test("one Provider pass feeds the fanout and only one parent-owned proposal is staged", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-analysis-service-"));
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const fanout = createTravelAnalysisFanout({}, { agentRunner: fixtureRunner(trace), engine: "fixture" });
  let providerCalls = 0;
  const researchProvider = { status: "configured", async research() { providerCalls += 1; return providerResult(); } };
  const service = new TravelService({ store: new TripStore({ rootDir }), researchProvider, analysisFanout: fanout, clock: () => new Date(checkedAt) });
  await service.createTrip({ tripId: "trip_analysis_service", brief: { destination: "Shanghai", dates: "2026-10-03 to 2026-10-05", totalBudget: 8000 }, travelers: [{ travelerId: "traveler_1", displayName: "Traveler" }] });

  const before = await service.getTripControlView("trip_analysis_service");
  const result = await service.researchTripOptions({ tripId: "trip_analysis_service", domains: ["play", "food", "stay", "transport"], question: "Build a complete linked plan" });
  const after = await service.getTripControlView("trip_analysis_service");
  const plan = await service.getTripPlanView("trip_analysis_service");

  assert.equal(providerCalls, 1, "semantic lanes must not multiply Provider calls");
  assert.equal(result.status, "proposed");
  assert.equal(result.analysis.joinCount, 1);
  assert.match(result.proposal.proposalId, new RegExp(result.analysis.runId));
  assert.equal(result.analysis.conditionRevision.status, "not_needed");
  assert.equal(after.pendingProposals.length, 1);
  assert.equal(Object.values(plan.byDomain).flat().filter((node) => node.selected).length, 0);
  assert.equal(after.revision, before.revision, "fanout and proposal staging must not commit TripState");
  const replay = await service.researchTripOptions({ tripId: "trip_analysis_service", domains: ["play", "food", "stay", "transport"], question: "Build a complete linked plan" });
  assert.equal(replay.reusedPendingProposal, true);
  assert.equal(replay.proposal.proposalId, result.proposal.proposalId);
  assert.equal((await service.getTripControlView("trip_analysis_service")).pendingProposals.length, 1);
});

test("one failed semantic lane degrades without discarding sibling findings or mutating accepted state", async () => {
  const baseTrace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const delegate = fixtureRunner(baseTrace);
  const agentRunner = {
    async run(prompt, options) {
      if (prompt.includes('"lane":"local_discovery"')) throw Object.assign(new Error("lane timeout"), { code: "AGENT_TIMEOUT" });
      return delegate.run(prompt, options);
    },
  };
  const fanout = createTravelAnalysisFanout({}, { agentRunner, engine: "fixture", agentTimeoutMs: 100 });
  const result = await fanout({ tripId: "trip_partial_fanout", baseRevision: 4, brief: { destination: "Shanghai" }, travelers: [], providerResult: providerResult(), objective: "Review with one failing lane" });

  assert.equal(result.status, "partial");
  assert.equal(result.coverage, "partial");
  assert.deepEqual([...result.requiredLanes], ["inventory_budget", "local_discovery", "operability_schedule"]);
  assert.deepEqual([...result.completedLanes], ["inventory_budget", "operability_schedule"]);
  assert.deepEqual([...result.failedLanes], ["local_discovery"]);
  assert.deepEqual([...result.lanes].map((lane) => lane.lane), ["inventory_budget", "operability_schedule"]);
  assert.equal(result.joinCount, 1);
});

for (const spoofed of [false, true]) test(`Child handoff ${spoofed ? "rejects a foreign run identity" : "discards non-contract fields"}`, async () => {
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const delegate = fixtureRunner(trace);
  const fanout = createTravelAnalysisFanout({}, { engine: "fixture", agentRunner: { async run(prompt) {
    return { ...await delegate.run(prompt), ...(spoofed ? { runId: "spoofed_run" } : {}), extraComment: "non-contract model text", stateMutation: { commit: true } };
  } } });
  const result = await fanout({ runId: "trusted_parent_run", tripId: "trip_child_contract", baseRevision: 2, providerResult: providerResult() });
  assert.equal(result.coverage, spoofed ? "failed" : "complete");
  if (spoofed) assert.equal(result.lanes.length, 0, "foreign identity must not be rewritten into an accepted handoff");
  for (const lane of result.lanes) {
    assert.equal(lane.runId, "trusted_parent_run");
    assert.equal(lane.extraComment, undefined);
    assert.equal(lane.stateMutation, undefined);
  }
});

test("missing source data does not trigger repeated research; invalid handoffs stay visibly failed", async () => {
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const delegate = fixtureRunner(trace);
  const events = [];
  const fanout = createTravelAnalysisFanout({}, { agentRunner: { async run(prompt) {
    const result = await delegate.run(prompt);
    if (result.lane === "inventory_budget") result.findings[0].reasonCode = "";
    result.needsContext = ["The source does not verify opening hours."];
    return result;
  } } });
  const execution = { runId: "run_receipt", workerId: "worker", fence: 1, signal: new AbortController().signal, assertCurrent: async () => {}, emit: async (event) => { events.push(event); } };
  const result = await withTravelExecution(execution, () => fanout({ tripId: "trip_invalid_child", baseRevision: 0, providerResult: providerResult() }));
  assert.equal(result.coverage, "partial");
  assert.equal(result.conditionRevision.status, "not_needed");
  assert.equal(events.find((event) => event.type === "analysis_lane_completed" && event.lane === "inventory_budget").status, "failed");
  assert.equal(events.some((event) => event.type === "analysis_handoff" && event.lane === "inventory_budget"), false);
});

test("Child handoff fills optional collections but rejects an empty or nested-fragment result", async () => {
  const run = (value) => createTravelAnalysisFanout({}, { engine: "fixture", agentRunner: { async run() { return value; } } })({
    tripId: "trip_minimal_child", baseRevision: 0, requiredLanes: ["inventory_budget"], providerResult: providerResult(),
  });
  const useful = await run({ findings: [{ summary: "The supplied reference prices still require fresh inventory verification.", reasonCode: "price_needs_verification" }] });
  assert.equal(useful.coverage, "complete");
  assert.deepEqual([...useful.lanes[0].recommendedCandidateIds], []);
  const empty = await run({ findings: [] });
  assert.equal(empty.coverage, "failed");
  const fragment = await run({ summary: "A nested object must not be accepted as the whole Child response." });
  assert.equal(fragment.coverage, "failed");
});

test("retrying identical research repairs incomplete Child analysis before reusing the proposal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-analysis-retry-"));
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const delegate = fixtureRunner(trace);
  let failLocal = true;
  let providerCalls = 0;
  const fanout = createTravelAnalysisFanout({}, { engine: "fixture", agentRunner: { async run(prompt) {
    if (failLocal && prompt.includes('"lane":"local_discovery"')) throw new Error("fixture_child_failed");
    return delegate.run(prompt);
  } } });
  const service = new TravelService({ store: new TripStore({ rootDir }),
    researchProvider: { status: "configured", async research() { providerCalls++; return providerResult(); } },
    analysisFanout: fanout, clock: () => new Date(checkedAt),
  });
  await service.createTrip({ tripId: "trip_retry_analysis", brief: { destination: "Shanghai" } });
  const input = { tripId: "trip_retry_analysis", domains: ["play", "food", "stay", "transport"], question: "Complete linked travel research", signal: new AbortController().signal };
  const first = await service.researchTripOptions(input);
  assert.equal(first.analysis.coverage, "partial");
  failLocal = false;
  const second = await service.researchTripOptions(input);
  assert.equal(second.analysis.coverage, "complete");
  assert.notEqual(second.reusedPendingProposal, true);
  assert.notEqual(first.analysis.runId, second.analysis.runId);
  const replay = await service.researchTripOptions(input);
  assert.equal(replay.reusedPendingProposal, true);
  assert.equal(providerCalls, 2);
  assert.equal((await service.getTripControlView(input.tripId)).pendingProposals.length, 1);
});

test("lane completions and Join are idempotent by run, lane and attempt", () => {
  const coordinator = createTravelAnalysisRunCoordinator();
  coordinator.begin({ runId: "run_idempotent", tripId: "trip_idempotent", baseRevision: 2, criteriaFingerprint: "fp_a", requiredLanes: ["inventory_budget"], deadlineAt: checkedAt });
  const first = coordinator.recordLaneCompletion("run_idempotent", { lane: "inventory_budget", attempt: 1, completedAt: checkedAt, status: "completed", result: { value: 1 } });
  const replay = coordinator.recordLaneCompletion("run_idempotent", { lane: "inventory_budget", attempt: 1, completedAt: "2026-08-27T09:01:00.000Z", status: "completed", result: { value: 2 } });
  assert.equal(replay, first);
  assert.deepEqual(replay.result, { value: 1 });
  const join = coordinator.tryJoin("run_idempotent");
  assert.equal(join.acquired, true);
  const artifact = { runId: "run_idempotent", joinCount: 1 };
  coordinator.completeJoin("run_idempotent", artifact);
  const duplicateJoin = coordinator.tryJoin("run_idempotent");
  assert.equal(duplicateJoin.acquired, false);
  assert.equal(duplicateJoin.reason, "already_joined");
  assert.equal(duplicateJoin.artifact, artifact);
  assert.throws(() => coordinator.begin({ runId: "run_idempotent", tripId: "trip_other", baseRevision: 2, criteriaFingerprint: "fp_a", requiredLanes: [], deadlineAt: checkedAt }), /analysis_run_identity_conflict/);
});

test("a superseded run is stale-discarded before Join", async () => {
  const coordinator = createTravelAnalysisRunCoordinator();
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const fanout = createTravelAnalysisFanout({}, { coordinator, agentRunner: fixtureRunner(trace), engine: "fixture" });
  const runA = fanout({ runId: "run_a", tripId: "trip_stale", baseRevision: 1, criteriaFingerprint: "fp_a", requiredLanes: ["inventory_budget", "local_discovery"], brief: { destination: "Shanghai" }, travelers: [], providerResult: providerResult(), validateCurrent: async () => false });
  coordinator.begin({ runId: "run_b", tripId: "trip_stale", baseRevision: 2, criteriaFingerprint: "fp_b", requiredLanes: ["inventory_budget", "local_discovery"], deadlineAt: "2026-08-27T09:10:00.000Z" });
  const result = await runA;
  assert.equal(result.status, "stale_discarded");
  assert.equal(result.joinCount, 0);
  assert.equal(result.coverage, "failed");
  assert.equal(coordinator.get("run_a").status, "stale_discarded");
});

test("only verified Kimi becomes the primary Child route, with the configured reasoning route as fallback", () => {
  const unavailable = childModelFallbackLedger({ MOONSHOT_API_KEY: "fixture", TRAVEL_AGENT_KIMI_CHILD_SMOKE_STATUS: "not_run", DEEPSEEK_API_KEY: "fixture" });
  assert.equal(unavailable.fallback.status, "fallback_unavailable");
  assert.notEqual(unavailable.primary.provider, "moonshotai-cn");
  const available = childModelFallbackLedger({ MOONSHOT_API_KEY: "fixture", TRAVEL_AGENT_KIMI_CHILD_SMOKE_STATUS: "passed_live_smoke", DEEPSEEK_API_KEY: "fixture", TRAVEL_AGENT_MODEL_PROVIDER: "deepseek", TRAVEL_AGENT_MODEL: "deepseek-v4-flash" });
  assert.equal(available.fallback.status, "available");
  assert.equal(available.primary.provider, "moonshotai-cn");
  assert.equal(available.primary.model, "kimi-k2.6");
});

test("all Child timeouts produce failed coverage without an automatic unverified fallback", async () => {
  const runner = { async run() { throw Object.assign(new Error("child timed out after 45s"), { code: "AGENT_TIMEOUT" }); } };
  const fanout = createTravelAnalysisFanout({ MOONSHOT_API_KEY: "fixture", TRAVEL_AGENT_KIMI_CHILD_SMOKE_STATUS: "not_run" }, { agentRunner: runner, engine: "fixture", agentTimeoutMs: 20 });
  const result = await fanout({ runId: "run_all_timeout", tripId: "trip_all_timeout", baseRevision: 0, criteriaFingerprint: "fp_timeout", requiredLanes: ["inventory_budget", "local_discovery", "operability_schedule"], brief: { destination: "Shanghai" }, providerResult: providerResult() });
  assert.equal(result.coverage, "failed");
  assert.deepEqual([...result.completedLanes], []);
  assert.deepEqual([...result.timedOutLanes].sort(), ["inventory_budget", "local_discovery"]);
  assert.equal(result.startedLanes.length, 2, "the timeout circuit breaker must prevent the queued third lane from starting");
  assert.equal(result.degradedReasons.filter((reason) => reason.endsWith("timed_out")).length, 2);
});

test("a newer trip scope prevents a late Provider and analysis result from staging a proposal", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-analysis-stale-service-"));
  const coordinator = createTravelAnalysisRunCoordinator();
  const trace = { active: 0, maximumActive: 0, prompts: [], completed: [] };
  const fanout = createTravelAnalysisFanout({}, { coordinator, agentRunner: fixtureRunner(trace), engine: "fixture" });
  const researchProvider = { status: "configured", async research() { await new Promise((resolve) => setTimeout(resolve, 35)); return providerResult(); } };
  const service = new TravelService({ store: new TripStore({ rootDir }), researchProvider, analysisFanout: fanout, analysisRunCoordinator: coordinator, clock: () => new Date(checkedAt) });
  await service.createTrip({ tripId: "trip_stale_service", brief: { destination: "Shanghai", dates: "2026-10-03 to 2026-10-05" }, travelers: [{ travelerId: "traveler_1", displayName: "Traveler" }] });

  const research = service.researchTripOptions({ tripId: "trip_stale_service", domains: ["stay", "play"], question: "Research the old area" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await service.updateTripScope({ tripId: "trip_stale_service", brief: { lodgingPreference: "New area" } });
  const result = await research;
  const control = await service.getTripControlView("trip_stale_service");

  assert.equal(result.status, "stale_discarded");
  assert.equal(control.pendingProposals.length, 0);
  assert.equal(control.revision, updated.revision);
});
