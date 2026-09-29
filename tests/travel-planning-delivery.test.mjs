import assert from "node:assert/strict";
import test from "node:test";
import { planningTrialDigest, planningTrialText, routeAuditText } from "../src/agent/travel-conversation-agent.mjs";

const route = (overrides = {}) => ({
  status: "completed", source: "amap_routes_v5", checkedAt: "2026-09-22T01:00:00.000Z", freshUntil: "2026-09-22T02:00:00.000Z",
  coverage: { unresolvedNodeIds: [], unresolvedStopIds: [], unscheduled: false },
  caveats: ["查询时的估算，场所入口和下车后的通路未核验"],
  legs: [{ legId: "leg1", recommendedMode: "taxi", alternatives: [{ mode: "taxi", totalMinutes: 20, walkingMeters: 0, transfers: 0, estimatedFareCny: 25,
    accessibilityAssessment: { hasStairs: false, stepFreeContinuity: "not_verified", realTimeStatus: false } }] }],
  ...overrides,
});

test("Parent receives route source, query time and unknown accessibility alongside taxi estimates", () => {
  const value = planningTrialDigest({ status: "blocked", mobility: route(), selectedNodes: [{ nodeId: "stay1", title: "候选酒店", sourceStatus: "contract_fixture", sourceRefs: ["source1"] }] });
  assert.equal(value.route.source, "amap_routes_v5");
  assert.equal(value.route.checkedAt, "2026-09-22T01:00:00.000Z");
  assert.equal(value.route.walkingMeters, 0, "a reported zero stays a reported zero");
  assert.deepEqual(value.route.accessibility, [{ legId: "leg1", hasStairs: false, stepFreeContinuity: "not_verified", realTimeStatus: false }]);
  assert.deepEqual(value.route.caveats, ["查询时的估算，场所入口和下车后的通路未核验"]);
  assert.equal(value.selectedNodes[0].sourceStatus, "contract_fixture", "fixture identity must survive the handoff");
});

test("unknown route measurements never become zero minutes, zero walking or free transport in the delivery", () => {
  const missing = planningTrialDigest({ status: "blocked" });
  for (const key of ["totalMinutes", "walkingMeters", "transfers", "estimatedFareCny"]) assert.equal(missing.route[key], null, key);
  const partial = route();
  partial.legs[0].alternatives[0].walkingMeters = null;
  partial.legs[0].alternatives[0].estimatedFareCny = null;
  const value = planningTrialDigest({ status: "needs_repair", mobility: partial });
  assert.equal(value.route.totalMinutes, 20);
  assert.equal(value.route.walkingMeters, null);
  assert.equal(value.route.estimatedFareCny, null);
});

test("partial route coverage cannot be presented as the total for the whole itinerary", () => {
  const value = planningTrialDigest({ status: "blocked", mobility: route({ status: "partial", coverage: { unresolvedNodeIds: ["stay2"], unresolvedStopIds: ["s2"], unscheduled: false } }) });
  assert.equal(value.route.totalMinutes, null);
  assert.equal(value.route.estimatedFareCny, null);
  assert.deepEqual(value.route.coverage.unresolvedStopIds, ["s2"]);
});

test("a route with an unresolved recommended alternative does not silently disappear from the totals", () => {
  const mobility = route();
  mobility.legs.push({ legId: "leg2", recommendedMode: "transit", alternatives: [] });
  const value = planningTrialDigest({ status: "blocked", mobility });
  assert.equal(value.route.legCount, 2);
  assert.equal(value.route.totalMinutes, null);
});

test("a traveler asking why taxi is recommended sees unknown fares and walking, not invented zeroes", () => {
  const mobility = route();
  Object.assign(mobility.legs[0].alternatives[0], { walkingMeters: null, transfers: null, estimatedFareCny: null });
  mobility.legs[0].rationale = "当前只取得这一种路线资料。";
  const text = routeAuditText(mobility);
  assert.doesNotMatch(text, /¥0|步行\s*0|换乘\s*0/);
  assert.match(text, /待核实/);
  assert.match(text, /无台阶.*(?:未|待).*核/);
});

test("a missing model summary preserves unknown route measurements in the fallback receipt", () => {
  const mobility = route();
  mobility.legs[0].alternatives[0].estimatedFareCny = null;
  const text = planningTrialText({ status: "trial_ready", mobility });
  assert.match(text, /市内交通费用待核实/);
  assert.doesNotMatch(text, /¥0|费用约 0/);
});
