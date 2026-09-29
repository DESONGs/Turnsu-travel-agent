import assert from "node:assert/strict";
import { createTravelAnalysisFanout } from "../src/agent/travel-analysis-fanout.mjs";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";

const env = await loadTravelRuntimeEnv();
const checkedAt = new Date().toISOString();

function candidate(domain, index) {
  return {
    candidateId: `${domain}_${index}`,
    domain,
    title: `${domain} fixture ${index}`,
    summary: `Normalized ${domain} fixture evidence for semantic analysis`,
    cost: 100 * index,
    sourceId: `source_${domain}_${index}`,
    claimId: `claim_${domain}_${index}`,
    operability: domain === "transport" ? { transportType: "TRAIN", serviceNumber: "G100", inventoryVerified: true } : { rating: 4.5 },
  };
}

const providerResult = {
  status: "completed",
  checkedAt,
  weather: null,
  byDomain: {
    play: [candidate("play", 1)],
    food: [candidate("food", 1)],
    stay: [candidate("stay", 1)],
    transport: [candidate("transport", 1)],
  },
};

const events = [];
const fanout = createTravelAnalysisFanout(env, { onEvent: (event) => events.push(event) });
const result = await fanout({ tripId: "trip_live_analysis", baseRevision: 0, brief: { destination: "上海", dates: "2026-10-03 至 2026-10-05", totalBudget: 8000 }, travelers: [{ travelerId: "traveler_1", displayName: "父亲", careNeeds: { mobility: { reduceWalking: true } } }], providerResult, objective: "比较完整旅行候选并指出预算、当地体验和可执行性问题" });

assert.ok(result.lanes.length >= 2, JSON.stringify(result));
assert.equal(result.joinCount, 1);
const starts = events.filter((event) => event.type === "analysis_lane_started");
const ends = events.filter((event) => event.type === "analysis_lane_completed");
assert.ok(starts.length >= 2);
assert.ok(ends.length >= 2);
assert.ok(new Date(starts[1].at).getTime() <= Math.min(...ends.map((event) => new Date(event.at).getTime())), "lanes did not overlap");

const status = result.coverage === "complete" ? "passed_live_model_smoke" : `${result.coverage}_live_model_smoke`;
if (result.coverage !== "complete") process.stdout.write(`${JSON.stringify({ failureDetails: result.events.filter((event) => event.error).map((event) => ({ lane: event.lane, code: /travel_analysis_output_truncated|invalid_travel_analysis_output|normalized_schema_invalid|timed out|timeout/.exec(event.error)?.[0] ?? "child_execution_failed" })) })}\n`);
process.stdout.write(`${JSON.stringify({ status, coverage: result.coverage, analysisId: result.analysisId, lanes: result.lanes.map((lane) => ({ lane: lane.lane, skillId: lane.skillId, reasonCodes: lane.reasonCodes })), failedLanes: result.failedLanes, timedOutLanes: result.timedOutLanes, degradedReasons: result.degradedReasons, modelFallback: result.modelFallback, joinCount: result.joinCount, durationMs: new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime() })}\n`);
if (result.coverage !== "complete") process.exitCode = 1;
