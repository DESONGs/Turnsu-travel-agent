import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { TripStore, hydrateStoredTripState } from "../travel-agent-pi-package/src/core/index.ts";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { planningProvider } from "./fixtures/jev-planning.mjs";

const clock = () => new Date("2026-08-30T08:00:00.000Z");

function candidateProposal(tripId) {
  const checkedAt = "2026-08-30T08:00:00.000Z";
  const nodes = [
    { nodeId: "arrival_pvg", domain: "transport", title: "上海浦东国际机场 T2", selected: false, sourceStatus: "verified", sourceRefs: ["amap:arrival"], operability: { mobilityRole: "intercity_inventory", transportType: "FLIGHT", arrivalAt: "2026-10-15T09:00:00+08:00", arrivalPlace: { label: "上海浦东国际机场 T2" }, checkedAt } },
    { nodeId: "stay_people_square", domain: "stay", title: "人民广场酒店", selected: false, sourceStatus: "verified", sourceRefs: ["amap:stay"], operability: { openWeek: "00:00-23:59", checkedAt } },
    { nodeId: "play_museum", domain: "play", title: "上海博物馆", selected: false, sourceStatus: "verified", sourceRefs: ["amap:play"], operability: { openWeek: "09:00-17:00", checkedAt } },
    { nodeId: "food_local", domain: "food", title: "本帮菜馆", selected: false, sourceStatus: "verified", sourceRefs: ["amap:food"], operability: { openWeek: "11:00-21:00", checkedAt } },
  ];
  return {
    schemaVersion: "trip-patch-proposal-v1", proposalId: "proposal_candidates", tripId, baseRevision: 0,
    writeSet: nodes.map((node) => node.nodeId), writeContract: { allowedNodeIds: nodes.map((node) => node.nodeId) }, readSet: [],
    operations: nodes.map((node) => ({ kind: "add_candidate", nodeId: node.nodeId, node })),
  };
}

function routeAlternative(mode, minutes, walkingMeters = 0, transfers = 0, fare = 0) {
  return { mode, totalMinutes: minutes, distanceMeters: 5_000, walkingMeters, transfers, estimatedFareCny: fare, scheduleBasis: "query_time_estimate", realTimeArrival: false, navigationUrl: null, polyline: [], steps: [], accessibilityFeatures: [], accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false } };
}

function providerFixture({ delayFirst = false } = {}) {
  let calls = 0;
  return {
    status: "configured",
    get calls() { return calls; },
    async planMobility({ itineraryStops, signal }) {
      calls += 1;
      if (delayFirst && calls === 1) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("cancelled"), { code: "SOURCE_UNAVAILABLE" })); }, { once: true });
      });
      const place = (stop) => ({ nodeId: stop.nodeId, stopId: stop.stopId, label: stop.title, coordinates: null, dayIndex: stop.dayIndex, date: stop.date, role: stop.role, startAt: stop.startAt, endAt: stop.endAt });
      const legs = itineraryStops.slice(0, -1).map((stop, index) => {
        const next = itineraryStops[index + 1];
        return { legId: `plan_leg_${index}`, origin: place(stop), destination: place(next), recommendedMode: "transit", rationale: "fixture", alternatives: [routeAlternative("transit", 30, 300, 1, 4), routeAlternative("taxi", 20, 0, 0, 35), routeAlternative("walk", 70, 5_000, 0, 0)] };
      });
      return { schemaVersion: "trip-mobility-v1", status: "completed", destination: "上海", source: "fixture", checkedAt: "2026-08-30T08:00:00.000Z", freshUntil: "2026-08-30T11:00:00.000Z", coverage: { routedNodeIds: [...new Set(itineraryStops.map((stop) => stop.nodeId))], unresolvedNodeIds: [], routedStopIds: itineraryStops.map((stop) => stop.stopId), unresolvedStopIds: [], unscheduled: false }, legs, travelerFit: { maxContinuousWalkMeters: 600, maxTransfers: 1, avoidStairs: true }, reason: null, caveats: [], sourceDocumentation: null, fabricatedResults: false };
    },
  };
}

function itineraryPlan({ runId = "planrun_fixture", attempt = 1, activityStart = "2026-10-15T11:00:00+08:00", activityFixed = false } = {}) {
  return {
    schemaVersion: "itinerary-plan-v1", runId, tripId: "trip_plan_harness", baseRevision: 0, attempt,
    objective: "上午抵达后先寄存行李，再参观、用餐和入住", priorities: ["保留抵达", "减少步行", "不超过一次换乘"], lockedNodeIds: [],
    fixedAnchors: [{ nodeId: "arrival_pvg", kind: "arrival", startAt: "2026-10-15T09:00:00+08:00", endAt: "2026-10-15T09:00:00+08:00" }],
    days: [{ dayIndex: 1, date: "2026-10-15", stops: [
      { nodeId: "arrival_pvg", role: "intercity_arrival", timeWindow: { startAt: "2026-10-15T09:00:00+08:00", endAt: "2026-10-15T09:00:00+08:00" }, durationMinutes: 0, fixed: true, preferredModes: ["taxi"], rationale: "保留已确认抵达" },
      { nodeId: "stay_people_square", role: "bag_drop", timeWindow: { startAt: "2026-10-15T10:00:00+08:00", endAt: "2026-10-15T10:15:00+08:00" }, durationMinutes: 15, fixed: false, preferredModes: ["taxi", "transit"], rationale: "先放下行李" },
      { nodeId: "play_museum", role: "activity", timeWindow: { startAt: activityStart, endAt: "2026-10-15T13:00:00+08:00" }, durationMinutes: 120, fixed: activityFixed, preferredModes: ["transit", "taxi"], rationale: "白天参观" },
      { nodeId: "food_local", role: "meal", timeWindow: { startAt: "2026-10-15T13:30:00+08:00", endAt: "2026-10-15T15:00:00+08:00" }, durationMinutes: 90, fixed: false, preferredModes: ["taxi", "walk"], rationale: "就近用餐" },
      { nodeId: "stay_people_square", role: "stay_check_in", timeWindow: { startAt: "2026-10-15T16:00:00+08:00", endAt: "2026-10-15T16:30:00+08:00" }, durationMinutes: 30, fixed: false, preferredModes: ["taxi", "transit"], rationale: "活动后正式入住" },
    ] }], assumptions: [], needsContext: [], evidenceRefs: ["amap:arrival", "amap:stay", "amap:play", "amap:food"],
  };
}

async function harnessFixture(options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "itinerary-plan-harness-"));
  const provider = providerFixture(options);
  const service = new TravelService({ store: options.store ?? new TripStore({ rootDir }), clock: options.clock ?? clock, researchProvider: provider, planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  await service.createTrip({ tripId: "trip_plan_harness", brief: { destination: "上海", dates: "2026-10-15 至 2026-10-17", totalBudget: 8_000, ...options.brief }, travelers: options.travelers ?? [{ travelerId: "traveler_1", displayName: "父亲", careNeeds: { mobility: { maxContinuousWalkMeters: 600, maxTransfers: 1, avoidStairs: true } } }] });
  const proposal = candidateProposal("trip_plan_harness");
  if (options.candidateCost) for (const operation of proposal.operations) operation.node.cost = options.candidateCost;
  await service.proposeTripChange({ tripId: "trip_plan_harness", proposal });
  return { service, provider };
}

test("a traveler cannot adopt a plan exceeding the saved budget even when every route is feasible", async () => {
  const { service } = await harnessFixture({ brief: { totalBudget: 100 }, candidateCost: 100 });
  const selections = { transport: "arrival_pvg", stay: "stay_people_square", play: "play_museum", food: "food_local" };
  const preview = await service.previewTripMobility({ tripId: "trip_plan_harness", selections });
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan() });
  const adopted = await service.acceptTripChange({ tripId: "trip_plan_harness", proposalId: "proposal_candidates", selections, partial: true, previewId: preview.previewId });
  const persisted = await service.getTripPlanView("trip_plan_harness");
  assert.equal(preview.feasibility.canConfirm, false);
  assert.notEqual(trial.status, "trial_ready");
  assert.equal(adopted.status, "rejected");
  assert.equal(Object.values(persisted.byDomain).flat().filter(node => node.selected).length, 0);
  assert.equal(persisted.revision, 0);
});

test("mandatory step-free travel is blocked by unknown route evidence even if the provider omits traveler flags", async () => {
  const { service, provider } = await harnessFixture({ travelers: [{ travelerId: "traveler_1", careNeeds: { mobility: { stepFreeRequired: true, wheelchairSpaceRequired: true } } }] });
  const route = provider.planMobility.bind(provider);
  provider.planMobility = async input => ({ ...await route(input), travelerFit: {} });
  const selections = { transport: "arrival_pvg", stay: "stay_people_square", play: "play_museum", food: "food_local" };
  const preview = await service.previewTripMobility({ tripId: "trip_plan_harness", selections });
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ activityStart: "2026-10-15T10:20:00+08:00", activityFixed: true }) });
  const adopted = await service.acceptTripChange({ tripId: "trip_plan_harness", proposalId: "proposal_candidates", selections, partial: true, previewId: preview.previewId });
  assert.equal(preview.feasibility.canConfirm, false);
  assert.equal(trial.status, "needs_repair", "Parent may fetch evidence or replace a candidate, but cannot adopt unverified routes");
  assert.equal(trial.accept, null);
  assert.equal(adopted.status, "rejected");
  assert.equal((await service.store.get("trip_plan_harness")).nodes.filter(node => node.selected).length, 0);
});

test("adoption rechecks global constraints instead of trusting a cached canConfirm flag", async () => {
  const { service } = await harnessFixture({ brief: { totalBudget: 100 }, candidateCost: 100 });
  const selections = { transport: "arrival_pvg", stay: "stay_people_square", play: "play_museum", food: "food_local" };
  const preview = await service.previewTripMobility({ tripId: "trip_plan_harness", selections });
  const cached = await service.readMobilityPreview(preview.previewId);
  cached.preview.feasibility = { ...cached.preview.feasibility, canConfirm: true, status: "feasible", issues: [], primaryBlocker: null };
  await service.saveMobilityPreview(preview.previewId, cached);
  const adopted = await service.acceptTripChange({ tripId: "trip_plan_harness", proposalId: "proposal_candidates", selections, partial: true, previewId: preview.previewId });
  assert.equal(adopted.status, "rejected");
  assert.equal((await service.store.get("trip_plan_harness")).revision, 0);
});

test("an unavailable route service preserves a non-adoptable draft which can be checked after restoration", async () => {
  const { service, provider } = await harnessFixture();
  provider.canPlanMobility = false;
  const before = await service.getTripPlanView("trip_plan_harness");
  assert.equal(before.planningAvailability.status, "provider_unavailable");
  const blocked = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan() });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.issues[0].code, "route_provider_unavailable");
  assert.deepEqual(blocked.issues[0].allowedRepairDirections, []);
  assert.equal(blocked.providerCallCount, 0);
  assert.equal(provider.calls, 0);
  const partial = await service.getTripPlanView("trip_plan_harness");
  assert.ok(partial.itineraryTrial?.itinerary?.stops.length);
  assert.equal(partial.itineraryTrial.accept, null);
  assert.equal(partial.revision, before.revision);
  provider.canPlanMobility = true;
  const restored = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_after_source_recovery" }) });
  assert.equal(restored.status, "trial_ready");
  assert.equal(provider.calls, 1);
});

test("cancelling a planning request discards even a late successful route response", async () => {
  const { service } = await harnessFixture();
  const original = service.researchProvider.planMobility.bind(service.researchProvider);
  let entered;
  let release;
  const started = new Promise((done) => { entered = done; });
  const held = new Promise((done) => { release = done; });
  service.researchProvider.planMobility = async (input) => { entered(); await held; return original({ ...input, signal: undefined }); };
  const before = await service.getTripPlanView("trip_plan_harness");
  const controller = new AbortController();
  const running = service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan(), signal: controller.signal });
  await started;
  controller.abort(); release();
  const result = await running;
  assert.equal(result.status, "stale_discarded");
  const after = await service.getTripPlanView("trip_plan_harness");
  assert.deepEqual(after.pendingProposals, before.pendingProposals);
  assert.equal(after.revision, before.revision);
});

test("a model plan becomes one reversible Trial and confirmation reuses it with selected route modes", async () => {
  const { service, provider } = await harnessFixture();
  const before = await service.getTripPlanView("trip_plan_harness");
  const selections = { transport: "arrival_pvg", stay: "stay_people_square", play: "play_museum", food: "food_local" };
  const quickPreview = await service.previewTripMobility({ tripId: "trip_plan_harness", baseRevision: 0, selections });
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan(), baselinePreviewId: quickPreview.previewId });
  const staged = await service.getTripPlanView("trip_plan_harness");

  assert.equal(trial.status, "trial_ready", JSON.stringify(trial.feasibility));
  assert.deepEqual(trial.itinerary.stops.map((stop) => stop.role), ["intercity_arrival", "bag_drop", "activity", "meal", "stay_check_in"]);
  assert.equal(before.revision, staged.revision, "a Trial must not commit selected nodes or advance Trip revision");
  assert.equal(Object.values(staged.byDomain).flat().some((node) => node.selected), false);
  assert.equal(trial.impact.baseline.kind, "current_trial");
  assert.ok(trial.impact.deltaFromConfirmed);
  assert.equal(provider.calls, 2);

  const routeModes = Object.fromEntries(trial.mobility.legs.map((leg) => [leg.legId, "taxi"]));
  const accepted = await service.acceptTripChange({ ...trial.accept, tripId: "trip_plan_harness", routeModes });
  const confirmed = await service.getTripPlanView("trip_plan_harness");
  assert.equal(accepted.status, "committed");
  assert.equal(provider.calls, 2, "confirmation must reuse the checked Trial");
  assert.ok(confirmed.mobility.legs.every((leg) => leg.recommendedMode === "taxi"));
  assert.equal(confirmed.mobility.itinerary.planningSource, "model_plan");
});

test("a fixed conflict yields structured repair evidence and one repaired attempt succeeds", async () => {
  const { service } = await harnessFixture();
  const first = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_repair", activityStart: "2026-10-15T10:20:00+08:00", activityFixed: true }) });
  assert.equal(first.status, "needs_repair");
  const conflict = first.issues.find((issue) => issue.code === "chronology_conflict");
  assert.equal(conflict.observed.routeMinutes, 30);
  assert.ok(conflict.allowedRepairDirections.includes("reorder_flexible_stop"));
  assert.equal((await service.getTripPlanView("trip_plan_harness")).revision, 0);

  const repaired = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_repair", attempt: 2, activityStart: "2026-10-15T11:00:00+08:00", activityFixed: false }) });
  assert.equal(repaired.status, "trial_ready", JSON.stringify(repaired.feasibility));
});

test("a complete day spanning lunch must not silently omit the meal", async () => {
  const { service } = await harnessFixture();
  const plan = itineraryPlan({ runId: "planrun_missing_lunch" });
  plan.days[0].stops = plan.days[0].stops.filter(stop => stop.role !== "meal");
  plan.evidenceRefs = plan.evidenceRefs.filter(ref => ref !== "amap:food");
  const result = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan, requireCompletePlan: true });
  assert.equal(result.status, "needs_repair");
  assert.ok(result.issues.some(issue => issue.code === "meal_window_missing"));
  assert.equal((await service.getTripPlanView("trip_plan_harness")).revision, 0);
});

test("a two-day request cannot pass by submitting one day or a hotel-only second day", async () => {
  const { service } = await harnessFixture();
  const control = await service.updateTripScope({ tripId: "trip_plan_harness", brief: { dates: "2026-10-15至2026-10-16", durationDays: 2 } });
  // Date edits invalidate candidates: restage the same sourced records at the new revision.
  const proposal = candidateProposal("trip_plan_harness");
  proposal.baseRevision = control.revision;
  await service.proposeTripChange({ tripId: "trip_plan_harness", proposal });
  const plan = itineraryPlan({ runId: "planrun_missing_second_day" }); plan.baseRevision = control.revision;
  const first = await service.planItineraryTrial({ tripId: plan.tripId, plan, requireCompletePlan: true });
  assert.notEqual(first.status, "trial_ready");
  assert.ok(first.issues.some(issue => issue.code === "requested_day_missing"));
  const second = structuredClone(plan); second.attempt = 2;
  second.days.push({ dayIndex: 2, date: "2026-10-16", stops: [{ ...second.days[0].stops.find(stop => stop.role === "stay_check_in"), role: "stay_departure", timeWindow: { startAt: "2026-10-16T10:00:00+08:00", endAt: "2026-10-16T10:30:00+08:00" }, durationMinutes: 30 }] });
  const result = await service.planItineraryTrial({ tripId: plan.tripId, plan: second, requireCompletePlan: true });
  assert.notEqual(result.status, "trial_ready");
  assert.ok(result.issues.some(issue => issue.code === "day_without_activity"));
});

test("an over-budget draft remains reviewable and directs a same-budget candidate repair", async () => {
  const { service } = await harnessFixture({ brief: { totalBudget: 300 }, candidateCost: 100 });
  const plan = itineraryPlan({ runId: "planrun_budget_repair" });
  const result = await service.planItineraryTrial({ tripId: plan.tripId, plan });
  assert.equal(result.status, "needs_repair");
  assert.ok(result.issues.find(issue => issue.code === "trip_budget_exceeded")?.allowedRepairDirections.includes("replace_candidate"));
  const restored = await service.getTripPlanView(plan.tripId);
  assert.ok(restored.itineraryTrial?.itinerary?.stops.length, "keep the attempted itinerary and exact cost visible while fixing it");
  assert.equal(restored.itineraryTrial.feasibility.canConfirm, false);
  assert.equal(restored.itineraryTrial.accept, null);
  assert.equal((await service.getTripControlView(plan.tripId)).brief.totalBudget, 300);
});

test("targeted research can replace an expensive hotel in the same run without raising the budget", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15", durationDays: 1, totalBudget: 500 }, candidateCost: 100 });
  const plan = itineraryPlan({ runId: "planrun_affordable_replacement" });
  const first = await service.planItineraryTrial({ tripId: plan.tripId, plan });
  assert.equal(first.status, "needs_repair");
  const proposal = candidateProposal(plan.tripId);
  const stay = proposal.operations.find(op => op.node.domain === "stay").node;
  Object.assign(stay, { nodeId: "stay_affordable", title: "有来源的平价酒店", cost: 40 });
  proposal.proposalId = "proposal_research_affordable";
  proposal.operations = [{ kind: "add_candidate", nodeId: stay.nodeId, node: stay }];
  proposal.writeSet = [stay.nodeId]; proposal.writeContract.allowedNodeIds = [stay.nodeId];
  await service.proposeTripChange({ tripId: plan.tripId, proposal });
  const second = structuredClone(plan); second.attempt = 2;
  for (const day of second.days) for (const stop of day.stops) if (stop.nodeId === "stay_people_square") stop.nodeId = stay.nodeId;
  const repaired = await service.planItineraryTrial({ tripId: plan.tripId, plan: second });
  assert.equal(repaired.status, "trial_ready", JSON.stringify(repaired));
  assert.ok(repaired.impact.budget.estimated <= 500);
  assert.equal((await service.getTripControlView(plan.tripId)).brief.totalBudget, 500);
  const adopted = await service.acceptTripChange({ tripId: plan.tripId, ...repaired.accept });
  assert.equal(adopted.status, "committed");
  const state = await service.store.get(plan.tripId);
  assert.ok(state.nodes.some(node => node.nodeId === stay.nodeId && node.selected));
  assert.equal(state.nodes.some(node => node.nodeId === "stay_people_square" && node.selected), false);
});

test("full planning respects a business trip without attractions", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15", durationDays: 1, planningDomains: ["transport", "stay", "food"] } });
  const plan = itineraryPlan({ runId: "planrun_business_trip" });
  plan.days[0].stops = plan.days[0].stops.filter(stop => stop.role !== "activity");
  plan.evidenceRefs = plan.evidenceRefs.filter(ref => ref !== "amap:play");
  const lunch = plan.days[0].stops.find(stop => stop.role === "meal");
  plan.days[0].stops.push({ ...structuredClone(lunch), timeWindow: { startAt: "2026-10-15T18:00:00+08:00", endAt: "2026-10-15T19:00:00+08:00" }, durationMinutes: 60 });
  const result = await service.planItineraryTrial({ tripId: plan.tripId, plan, requireCompletePlan: true });
  assert.equal(result.status, "trial_ready", JSON.stringify(result.issues));
  assert.equal(result.itinerary.stops.some(stop => stop.role === "activity"), false);
});

function multiDayPlan(dayCount = 3) {
  const plan = itineraryPlan({ runId: "planrun_all_legs" });
  for (let dayIndex = 2; dayIndex <= dayCount; dayIndex++) {
    const date = `2026-10-${14 + dayIndex}`;
    plan.days.push({ dayIndex, date, stops: plan.days[0].stops.filter(stop => stop.role !== "intercity_arrival").map(stop => ({ ...structuredClone(stop), role: stop.role === "bag_drop" ? "stay_departure" : stop.role, timeWindow: { startAt: stop.timeWindow.startAt.replace("2026-10-15", date), endAt: stop.timeWindow.endAt.replace("2026-10-15", date) } })) });
  }
  return plan;
}

test("a multi-day itinerary keeps every returned route through checking, adoption and storage", async () => {
  const { service } = await harnessFixture();
  const plan = multiDayPlan();
  const expectedLegs = plan.days.flatMap(day => day.stops).length - 1;
  assert.ok(expectedLegs > 8);
  const trial = await service.planItineraryTrial({ tripId: plan.tripId, plan });
  assert.equal(trial.status, "trial_ready", JSON.stringify(trial.issues));
  assert.equal(trial.mobility.legs.length, expectedLegs);
  const accepted = await service.acceptTripChange({ tripId: plan.tripId, ...trial.accept });
  assert.equal(accepted.status, "committed");
  assert.equal((await service.getTripPlanView(plan.tripId)).mobility.legs.length, expectedLegs);
});

test("a week-long plan accepted by the planning contract is not rejected by a smaller display contract", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15 至 2026-10-21", durationDays: 7 } });
  const plan = multiDayPlan(7);
  for (const day of plan.days) {
    const lunch = day.stops.find(stop => stop.role === "meal");
    day.stops.push({ ...structuredClone(lunch), durationMinutes: 60, timeWindow: { startAt: `${day.date}T18:00:00+08:00`, endAt: `${day.date}T19:00:00+08:00` } });
  }
  const trial = await service.planItineraryTrial({ tripId: plan.tripId, plan });
  assert.equal(trial.status, "trial_ready", JSON.stringify(trial.issues));
  assert.equal(trial.itinerary.stops.length, 36);
  assert.equal(trial.mobility.legs.length, 35);
  assert.equal((await service.acceptTripChange({ tripId: plan.tripId, ...trial.accept })).status, "committed");
  assert.equal((await service.getTripPlanView(plan.tripId)).mobility.legs.length, 35);
});

test("an earlier visit's route cannot conceal missing evidence for later visits", async () => {
  const { service, provider } = await harnessFixture();
  const route = provider.planMobility.bind(provider);
  provider.planMobility = async input => {
    const observed = await route(input);
    return { ...observed, legs: observed.legs.slice(0, 8) };
  };
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: multiDayPlan() });
  assert.equal(trial.accept, null);
  assert.ok(trial.issues.some(issue => issue.code === "required_route_missing"));
});

test("lunch and dinner at one restaurant are separate visits, not a duplicate stop", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15", durationDays: 1 } });
  const plan = itineraryPlan({ runId: "planrun_two_meals" });
  const lunch = plan.days[0].stops.find(stop => stop.role === "meal");
  plan.days[0].stops.push({ ...structuredClone(lunch), timeWindow: { startAt: "2026-10-15T18:00:00+08:00", endAt: "2026-10-15T19:00:00+08:00" }, durationMinutes: 60, preferredModes: ["transit"] });
  const result = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan, requireCompletePlan: true });
  assert.equal(result.status, "trial_ready", JSON.stringify(result.issues));
  const meals = result.itinerary.stops.filter(stop => stop.role === "meal");
  assert.equal(meals.length, 2);
  assert.notEqual(meals[0].stopId, meals[1].stopId);
  assert.equal(result.mobility.legs.find(leg => leg.destination.stopId === meals[0].stopId).recommendedMode, "taxi");
  assert.equal(result.mobility.legs.find(leg => leg.destination.stopId === meals[1].stopId).recommendedMode, "transit");
});

test("compact start-time and duration plans still require dinner for an overnight stay", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15", durationDays: 1, lodgingNights: 1 } });
  const plan = itineraryPlan({ runId: "planrun_compact_missing_dinner" });
  for (const stop of plan.days[0].stops) delete stop.timeWindow.endAt;
  const result = await service.planItineraryTrial({ tripId: plan.tripId, plan, requireCompletePlan: true });
  assert.equal(result.accept, null);
  assert.ok(result.issues.some(issue => issue.code === "meal_window_missing" && issue.message.includes("晚餐")));
});

test("a complete itinerary adopts two restaurants and charges each actual meal once", async () => {
  const { service } = await harnessFixture({ candidateCost: 100, brief: { dates: "2026-10-15", durationDays: 1 } });
  const extra = candidateProposal("trip_plan_harness");
  extra.proposalId = "proposal_research_second_restaurant";
  const restaurant = structuredClone(extra.operations.find(op => op.node.domain === "food").node);
  Object.assign(restaurant, { nodeId: "food_dinner", title: "另一家餐厅", cost: 100 });
  extra.operations = [{ kind: "add_candidate", nodeId: restaurant.nodeId, node: restaurant }];
  extra.writeSet = [restaurant.nodeId]; extra.writeContract.allowedNodeIds = [restaurant.nodeId];
  await service.proposeTripChange({ tripId: extra.tripId, proposal: extra });
  const plan = itineraryPlan({ runId: "planrun_two_restaurants" });
  plan.days[0].stops.push({ nodeId: "food_dinner", role: "meal", timeWindow: { startAt: "2026-10-15T18:00:00+08:00", endAt: "2026-10-15T19:00:00+08:00" }, durationMinutes: 60, fixed: false, preferredModes: ["taxi"], rationale: "用不同餐厅覆盖晚餐" });
  const result = await service.planItineraryTrial({ tripId: extra.tripId, plan, requireCompletePlan: true });
  assert.equal(result.status, "trial_ready", JSON.stringify(result.issues));
  const accepted = await service.acceptTripChange({ tripId: extra.tripId, ...result.accept });
  assert.equal(accepted.status, "committed", JSON.stringify(accepted));
  const view = await service.getTripPlanView(extra.tripId);
  assert.deepEqual(view.byDomain.food.filter(node => node.selected).map(node => node.nodeId).sort(), ["food_dinner", "food_local"]);
  assert.equal(view.budget.domains.food.estimated, 200, "each scheduled meal is counted once rather than each restaurant multiplied across the entire trip");
});

test("local route fares are included in the same hard trip budget", async () => {
  const { service } = await harnessFixture({ brief: { dates: "2026-10-15", durationDays: 1, totalBudget: 410 }, candidateCost: 100 });
  const result = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_route_budget" }) });
  assert.notEqual(result.status, "trial_ready");
  assert.ok(result.issues.some(issue => issue.code === "trip_budget_exceeded"));
});

test("adopting a researched multi-restaurant itinerary keeps only its selected evidence and retains alternatives", async () => {
  const store = new TripStore({ rootDir: await mkdtemp(join(tmpdir(), "researched-itinerary-")) });
  const service = new TravelService({ store, researchProvider: planningProvider(), planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  const tripId = "trip_plan_harness";
  await service.createTrip({ tripId, brief: { destination: "上海", origin: "杭州", dates: "2026-10-15", totalBudget: 6000 }, travelers: [{ travelerId: "traveler_1" }] });
  await service.researchTripOptions({ tripId, question: "一天吃住行玩", domains: ["play", "food", "stay", "transport"] });
  const researched = await store.get(tripId);
  const candidates = researched.pendingProposals.flatMap(proposal => proposal.operations).filter(op => op.kind === "add_candidate").map(op => op.node);
  const find = domain => candidates.filter(node => node.domain === domain);
  const ids = { arrival_pvg: find("transport")[0].nodeId, stay_people_square: find("stay")[0].nodeId, play_museum: find("play")[0].nodeId, food_local: find("food")[0].nodeId };
  const plan = itineraryPlan({ runId: "planrun_researched_evidence" });
  plan.baseRevision = researched.revision;
  for (const stop of plan.days[0].stops) stop.nodeId = ids[stop.nodeId];
  plan.fixedAnchors[0].nodeId = ids.arrival_pvg;
  plan.days[0].stops.push({ ...structuredClone(plan.days[0].stops.find(stop => stop.role === "meal")), nodeId: find("food")[1].nodeId, timeWindow: { startAt: "2026-10-15T18:00:00+08:00", endAt: "2026-10-15T19:00:00+08:00" }, durationMinutes: 60 });
  plan.evidenceRefs = candidates.filter(node => plan.days[0].stops.some(stop => stop.nodeId === node.nodeId)).flatMap(node => node.sourceRefs);
  const trial = await service.planItineraryTrial({ tripId, plan, requireCompletePlan: true });
  assert.equal(trial.status, "trial_ready", JSON.stringify(trial.issues));
  const adopted = await service.acceptTripChange({ tripId, ...trial.accept });
  assert.equal(adopted.status, "committed", JSON.stringify(adopted.validation));
  const persisted = await store.get(tripId);
  assert.equal(persisted.nodes.filter(node => node.selected).length, 5);
  assert.equal(persisted.evidence.claims.length, 5);
  assert.ok(persisted.evidence.claims.every(claim => persisted.nodes.some(node => node.nodeId === claim.nodeId)));
  assert.ok(persisted.pendingProposals.some(proposal => proposal.operations.some(op => op.nodeId === find("food")[2].nodeId)), "unselected options remain available for later changes");

  // A later complete draft can replace one hotel and one meal while keeping
  // the other adopted visits. Previewing is not itself permission to replace.
  const revised = structuredClone(plan);
  revised.runId = "planrun_researched_replacement";
  revised.scope = "complete_trip";
  revised.baseRevision = persisted.revision;
  for (const stop of revised.days[0].stops) {
    if (stop.nodeId === find("stay")[0].nodeId) stop.nodeId = find("stay")[1].nodeId;
    if (stop.nodeId === find("food")[1].nodeId) stop.nodeId = find("food")[2].nodeId;
  }
  revised.evidenceRefs = candidates.filter(node => revised.days[0].stops.some(stop => stop.nodeId === node.nodeId)).flatMap(node => node.sourceRefs);
  const adjustment = await service.planItineraryTrial({ tripId, plan: revised });
  assert.equal(adjustment.status, "trial_ready", JSON.stringify(adjustment));
  assert.deepEqual((await store.get(tripId)).nodes.filter(node => node.selected).map(node => node.nodeId), persisted.nodes.filter(node => node.selected).map(node => node.nodeId));
  const replaced = await service.acceptTripChange({ tripId, ...adjustment.accept });
  assert.equal(replaced.status, "committed", JSON.stringify(replaced));
  const changed = await store.get(tripId);
  assert.deepEqual(changed.nodes.filter(node => node.selected).map(node => node.nodeId).sort(), [...new Set(revised.days[0].stops.map(stop => stop.nodeId))].sort(), "adoption replaces exactly the reviewed hotel and meal; it must not keep charging for the old ones or remove the retained lunch");
  assert.equal((await service.getTripPlanView(tripId)).budget.estimated, adjustment.impact.budget.estimated);
  assert.equal(changed.nodes.find(node => node.nodeId === find("stay")[0].nodeId).selected, false);
});

test("a checked itinerary survives another API instance and confirmation reuses its persisted route evidence", { skip: !process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL }, async (t) => {
  const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/travel_execution_test");
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `preview_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const storeA = new PostgresTripRepository({ databaseUrl: url.toString() });
  const storeB = new PostgresTripRepository({ databaseUrl: url.toString() });
  t.after(async () => { await storeA.close(); await storeB.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const { service, provider } = await harnessFixture({ store: storeA });
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: multiDayPlan() });
  assert.equal(trial.status, "trial_ready");
  const api = new TravelService({ store: storeB, clock, researchProvider: { status: "configured", planMobility: () => { throw new Error("must reuse the evidence the user reviewed"); } }, planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  const restored = await api.getTripPlanView("trip_plan_harness");
  assert.equal(restored.itineraryTrial.status, "trial_ready");
  assert.equal(restored.itineraryTrial.previewId, trial.previewId);
  assert.equal(restored.itineraryTrial.mobility.legs.length, 12, "all days survive the PostgreSQL preview roundtrip");
  const routeModes = Object.fromEntries(trial.mobility.legs.map((leg) => [leg.legId, "taxi"]));
  const accepted = await api.acceptTripChange({ ...trial.accept, tripId: "trip_plan_harness", routeModes });
  assert.equal(accepted.status, "committed");
  assert.ok(accepted.mobility.legs.every((leg) => leg.recommendedMode === "taxi"));
  const confirmed = await api.getTripPlanView("trip_plan_harness");
  assert.equal(confirmed.mobility.legs.length, 12, "adoption keeps every checked route");
  await api.updateTripScope({ tripId: "trip_plan_harness", brief: { totalBudget: 9000 } });
  const persisted = (await storeB.pool.query("SELECT state_json FROM trip_states WHERE trip_id=$1", ["trip_plan_harness"])).rows[0].state_json;
  try { hydrateStoredTripState(persisted); }
  catch (error) { assert.fail(`Budget-only update must leave the adopted plan readable after JSONB roundtrip: ${error.code ?? error.message} ${JSON.stringify(error.issues ?? [])}; affected visit counts: ${JSON.stringify(persisted.environment.mobility?.feasibility?.issues.map(issue => issue.stopIds.length))}`); }
  const budgetOnly = await api.getTripPlanView("trip_plan_harness");
  assert.deepEqual(budgetOnly.mobility, confirmed.mobility, "a JSONB key-order change is not a traveler requirement change");
  assert.equal(budgetOnly.budget.estimated, confirmed.budget.estimated);
  assert.equal(provider.calls, 1);
  assert.equal((await api.previewTripMobility({ tripId: "trip_plan_harness", baseRevision: 0, previewId: trial.previewId, routeModes })).status, "needs_refresh");
  await api.updateTripScope({ tripId: "trip_plan_harness", travelerProfiles: [{ travelerId: "traveler_1", careNeeds: { mobility: { stepFreeRequired: true } } }] });
  const changedNeeds = await api.getTripPlanView("trip_plan_harness");
  assert.deepEqual(changedNeeds.mobility?.itinerary, confirmed.mobility.itinerary, "new traveler needs invalidate route proof, not the already adopted timeline");
  assert.equal(changedNeeds.mobility.status, "needs_context");
  assert.equal(changedNeeds.mobility.feasibility.canConfirm, false);
  assert.equal(changedNeeds.mobility.legs.length, 0, "the former route is not still presented as verified for the new requirement");
  assert.equal(changedNeeds.budget.domains.other.quality, "unknown");
});

test("a second failed repair stops without a third route request", async () => {
  const { service, provider } = await harnessFixture();
  const firstPlan = itineraryPlan({ runId: "planrun_stops_after_repair", activityStart: "2026-10-15T10:20:00+08:00", activityFixed: true });
  assert.equal((await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: firstPlan })).status, "needs_repair");
  const secondPlan = itineraryPlan({ runId: "planrun_stops_after_repair", attempt: 2, activityStart: "2026-10-15T10:25:00+08:00", activityFixed: true });
  const blocked = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: secondPlan });
  assert.equal(blocked.status, "blocked");
  const callCount = provider.calls;
  const replay = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: secondPlan });
  assert.equal(replay.status, "blocked");
  assert.equal(provider.calls, callCount);
  assert.equal((await service.getTripPlanView("trip_plan_harness")).revision, 0);
});

test("invalid repair references can be corrected without consuming the one business repair", async () => {
  const { service, provider } = await harnessFixture();
  const first = itineraryPlan({ runId: "planrun_argument_repair", activityStart: "2026-10-15T10:20:00+08:00", activityFixed: true });
  assert.equal((await service.planItineraryTrial({ tripId: first.tripId, plan: first })).status, "needs_repair");
  const repair = itineraryPlan({ runId: first.runId, attempt: 2 });
  const invalid = structuredClone(repair);
  invalid.evidenceRefs.push("invented:source");
  const calls = provider.calls;
  await assert.rejects(service.planItineraryTrial({ tripId: first.tripId, plan: invalid }), error => error.code === "invalid_itinerary_plan_references");
  assert.equal(provider.calls, calls, "bad arguments cannot call the route provider");
  const fixed = await service.planItineraryTrial({ tripId: first.tripId, plan: repair });
  assert.equal(fixed.status, "trial_ready");
  assert.equal(provider.calls, calls + 1, "only the corrected business repair is executed");
});

test("a saved draft stays visible when later candidate evidence invalidates its preview", async () => {
  const { service } = await harnessFixture();
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_visible_recheck" }) });
  const state = await service.store.get("trip_plan_harness");
  const changed = structuredClone(state);
  const proposal = changed.pendingProposals.find(item => item.proposalId === "proposal_candidates");
  proposal.operations.find(op => op.nodeId === "play_museum").node.sourceRefs.push("amap:newly-checked");
  await service.store.save(changed, { expectedStorageVersion: state.storageVersion });
  const restored = (await service.getTripPlanView(state.tripId)).itineraryTrial;
  assert.equal(restored.status, "needs_recheck");
  assert.deepEqual(restored.itinerary, trial.itinerary, "stale proof must not erase the user's draft");
  assert.equal(restored.accept, null);
  assert.equal(restored.feasibility.canConfirm, false);
  assert.equal(restored.mobility.legs.length, 0, "stale travel minutes cannot be shown as a current route result");
});

test("keeping the current plan discards only the itinerary Trial and preserves candidate choices", async () => {
  const { service } = await harnessFixture();
  const trial = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_discard" }) });
  assert.equal(trial.status, "trial_ready");
  const discarded = await service.discardItineraryTrial({ tripId: "trip_plan_harness", proposalId: trial.proposalId, baseRevision: 0 });
  const plan = await service.getTripPlanView("trip_plan_harness");
  assert.equal(discarded.status, "discarded");
  assert.equal(plan.revision, 0);
  assert.equal(plan.pendingProposals[0].itineraryPlan, null);
  assert.equal(plan.pendingProposals[0].byDomain.stay.length, 1, "discarding an itinerary Trial must not discard researched candidates");
});

test("invalid nodes, replay, and a superseded late run cannot create competing Trials", async () => {
  const { service, provider } = await harnessFixture({ delayFirst: true });
  const invalid = itineraryPlan({ runId: "planrun_invalid" });
  invalid.days[0].stops[2].nodeId = "invented_museum";
  invalid.evidenceRefs.push("invented:evidence");
  await assert.rejects(service.planItineraryTrial({ tripId: "trip_plan_harness", plan: invalid }), error => {
    assert.equal(error.code, "invalid_itinerary_plan_references");
    assert.deepEqual(error.details.issues.map(issue => issue.code), ["plan_node_not_found", "plan_evidence_not_allowed"]);
    return true;
  });
  assert.equal(provider.calls, 0);

  const runA = service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_a" }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runB = service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_b" }) });
  const [a, b] = await Promise.all([runA, runB]);
  assert.equal(a.status, "stale_discarded");
  assert.equal(b.status, "trial_ready");
  const callsAfterB = provider.calls;
  const replay = await service.planItineraryTrial({ tripId: "trip_plan_harness", plan: itineraryPlan({ runId: "planrun_b" }) });
  assert.equal(replay.previewId, b.previewId);
  assert.equal(provider.calls, callsAfterB, "operation replay must reuse the first attempt result");
  assert.equal((await service.getTripPlanView("trip_plan_harness")).revision, 0);
});

// Continuous-planning acceptance: compare visits and their purpose/time, not
// only the selected place identities. Sources here are explicit route fixtures.
async function adoptedContinuousFixture() {
  const fixture = await harnessFixture();
  const trial = await fixture.service.planItineraryTrial({ tripId: 'trip_plan_harness', plan: itineraryPlan() });
  assert.equal(trial.status, 'trial_ready');
  assert.equal((await fixture.service.acceptTripChange({ tripId: 'trip_plan_harness', ...trial.accept })).status, 'committed');
  return { ...fixture, original: structuredClone(trial.itinerary) };
}

for (const unavailable of [false, true]) test(`CP01 route refresh preserves adopted visits when provider ${unavailable ? 'fails' : 'succeeds'}`, async () => {
  const {service, provider, original} = await adoptedContinuousFixture();
  if (unavailable) provider.canPlanMobility = false;
  await service.refreshTripMobility({tripId:'trip_plan_harness'});
  const restored = await service.getTripPlanView('trip_plan_harness');
  assert.deepEqual(restored.mobility?.itinerary, original);
  assert.deepEqual((await service.getTripControlView('trip_plan_harness')).itinerary, original);
});

test('CP02 a saved draft remains reviewable after its proof expires and the service restarts', async () => {
  let time = new Date('2026-08-30T08:00:00Z');
  const {service, provider} = await harnessFixture({clock:()=>time});
  const trial = await service.planItineraryTrial({tripId:'trip_plan_harness',plan:itineraryPlan()});
  time = new Date('2026-08-30T08:16:00Z');
  const restarted = new TravelService({store:service.store, researchProvider:provider,clock:()=>time,planningRunCoordinator:createTravelAnalysisRunCoordinator()});
  const view = await restarted.getTripPlanView('trip_plan_harness');
  assert.deepEqual(view.itineraryTrial?.itinerary,trial.itinerary);
  assert.equal(view.itineraryTrial.accept,null);
  assert.equal(view.itineraryTrial.status,'needs_recheck');
});

test('CP03 raising the budget keeps the existing working draft',async()=>{
  const {service}=await harnessFixture();
  const trial=await service.planItineraryTrial({tripId:'trip_plan_harness',plan:itineraryPlan()});
  await service.updateTripScope({tripId:'trip_plan_harness',brief:{totalBudget:9000}});
  const view=await service.getTripPlanView('trip_plan_harness');
  assert.deepEqual(view.itineraryTrial?.itinerary,trial.itinerary);
  assert.equal(view.budget.totalBudget,9000);
});

test('CP04 wheelchair requirements and arrival clarification preserve the adopted comparison',async()=>{
  const {service,original}=await adoptedContinuousFixture();
  await service.updateTripScope({tripId:'trip_plan_harness',brief:{arrivalMode:'飞机'},travelerProfiles:[{travelerId:'traveler_1',careNeeds:{mobility:{stepFreeRequired:true,wheelchairSpaceRequired:true}}}]});
  const view=await service.getTripPlanView('trip_plan_harness');
  assert.deepEqual(view.mobility?.itinerary,original);
  assert.notEqual(view.mobility.feasibility?.canConfirm,true);
  assert.equal(view.mobility.legs.length,0,'the old proof is no longer current');
});

test('CP10 restarting the coordinator reuses a saved semantic planning receipt',async()=>{
  const {service,provider}=await harnessFixture();
  const input={tripId:'trip_plan_harness',plan:itineraryPlan()};
  const trial=await service.planItineraryTrial(input);
  const restarted=new TravelService({store:service.store,researchProvider:provider,clock,planningRunCoordinator:createTravelAnalysisRunCoordinator()});
  const replay=await restarted.planItineraryTrial(input);
  assert.equal(replay.previewId,trial.previewId);
  assert.equal(provider.calls,1,'replay must not repeat the route request');
  assert.deepEqual(replay.itinerary,trial.itinerary);
});
