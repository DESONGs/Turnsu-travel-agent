import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TravelService } from "../src/api/travel-service.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { itineraryPlanToDraft } from "../travel-agent-pi-package/src/core/itinerary-schedule.ts";
import { journeyExecutionIssues, selectRoute, selectedRoute, transportFacts, explicitPriceTotal } from "../travel-agent-pi-package/src/core/journey-execution.ts";
import { normalizeTripMobility } from "../travel-agent-pi-package/src/contracts/mobility.ts";
import { TuniuTravelResearchProvider } from "../src/providers/tuniu-travel-research.mjs";

// Explicit simulation of transport sources. No claim of real schedules or fares.
const at = (day, time) => `2026-10-${day}T${time}:00+08:00`;
const clock = () => new Date("2026-09-30T02:00:00Z");
const source = "simulation:operator";
const price = (amount, unit = "per_person", extra = {}) => ({ amount, currency: "CNY", quality: "reference", unit, ...extra });
const node = (nodeId, domain, amount = 0, operability = {}) => ({ nodeId, domain, title: nodeId, selected: false, sourceRefs: [source], sourceStatus: "verified", price: price(amount, domain === "stay" ? "per_room_night" : "per_person"), operability: { checkedAt: clock().toISOString(), openWeek: "00:00-23:59", ...operability } });
const train = (id, day, from, to, depart, arrive) => node(id, "transport", 100, { journeyId: id, serviceDate: `2026-10-${day}`, departureCity: from, arrivalCity: to, transportType: "TRAIN", mobilityRole: "intercity_inventory", departureAt: at(day, depart), arrivalAt: at(day, arrive), departurePlace: { label: `${from}站`, city: from }, arrivalPlace: { label: `${to}站`, city: to }, scheduleVerified: true, transportTiming: { beforeMinutes: 30, afterMinutes: 15, boardingClosesAt: at(day, depart === "09:00" ? "08:55" : "16:55"), source } });
const brief = { destination: "上海", origin: "杭州", dates: "2026-10-15 至 2026-10-16", durationDays: 2, lodgingNights: 1, totalBudget: 8000,
  journeys: [{ journeyId: "out", origin: "杭州", destination: "上海", date: "2026-10-15", purpose: "outbound", scope: "plan", mode: "train" }, { journeyId: "back", origin: "上海", destination: "杭州", date: "2026-10-16", purpose: "return", scope: "plan", mode: "train", arriveBy: at(16, "19:00") }] };
const nodes = [train("out", 15, "杭州", "上海", "09:00", "10:00"), train("back", 16, "上海", "杭州", "17:00", "18:00"), node("home", "transport"), node("hotel", "stay", 200), node("museum", "play", 50), node("garden", "play", 50), node("food", "food", 30)];
const stop = (id, role, day, time, minutes = 30) => ({ stopId: `${id}_${role}_${day}_${time.replace(":", "")}`, nodeId: id, role, timeWindow: { startAt: at(day, time) }, durationMinutes: minutes, fixed: true, preferredModes: ["taxi"], rationale: "模拟来源下保留明确的行程时间" });
const plan = () => ({ schemaVersion: "itinerary-plan-v1", scope: "complete_trip", tripId: "round_trip", runId: "roundtrip_run", baseRevision: 0, attempt: 1, objective: "两天往返并保留接驳", priorities: [], lockedNodeIds: [], fixedAnchors: [], assumptions: [], needsContext: [], evidenceRefs: [source], days: [
  { dayIndex: 1, date: "2026-10-15", stops: [stop("home", "local_transport", 15, "07:30", 10), stop("out", "transport_departure", 15, "08:30"), stop("out", "transport_arrival", 15, "10:00", 15), stop("museum", "activity", 15, "11:00", 60), stop("food", "meal", 15, "12:30", 60), stop("hotel", "stay_check_in", 15, "15:00"), stop("food", "meal", 15, "18:00", 60), stop("hotel", "stay_return", 15, "20:00")] },
  { dayIndex: 2, date: "2026-10-16", stops: [stop("hotel", "stay_departure", 16, "09:00"), stop("garden", "activity", 16, "10:00", 60), stop("food", "meal", 16, "12:00", 60), stop("back", "transport_departure", 16, "16:30"), stop("back", "transport_arrival", 16, "18:00", 15), stop("home", "local_transport", 16, "19:00")] },
] });
const alternative = (mode, totalMinutes = 20, fare = 10) => ({ mode, totalMinutes, distanceMeters: 5000, walkingMeters: 100, transfers: 0, estimatedFareCny: fare, scheduleBasis: "query_time_estimate", realTimeArrival: false, navigationUrl: null, polyline: [], steps: [], accessibilityFeatures: [], accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false } });
const provider = { status: "configured", async planMobility({ itineraryStops }) {
  const place = s => ({ nodeId: s.nodeId, stopId: s.stopId, label: s.title, coordinates: null, dayIndex: s.dayIndex, date: s.date, role: s.role, startAt: s.startAt, endAt: s.endAt });
  return { schemaVersion: "trip-mobility-v1", status: "completed", destination: "上海", source: "explicit_simulation", checkedAt: clock().toISOString(), freshUntil: "2026-09-30T04:00:00Z", fabricatedResults: false, caveats: ["模拟路线"], sourceDocumentation: null, travelerFit: {}, reason: null, coverage: { routedNodeIds: nodes.map(n => n.nodeId), unresolvedNodeIds: [], routedStopIds: itineraryStops.map(s => s.stopId), unresolvedStopIds: [], unscheduled: false }, legs: itineraryStops.slice(1).map((next, index) => ({ legId: `leg_${index}`, origin: place(itineraryStops[index]), destination: place(next), recommendedMode: "taxi", rationale: "模拟", alternatives: [alternative("taxi"), alternative("transit", 25, 4), alternative("transit", 35, 2)] })) };
} };

test("two-day return travel keeps both rides, transfers, prices and adoption after reopening the service", async t => {
  const dir = await mkdtemp(join(tmpdir(), "journey-roundtrip-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const service = new TravelService({ store: new TripStore({ rootDir: dir }), clock, researchProvider: provider, planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  await service.createTrip({ tripId: "round_trip", brief, travelers: [{ travelerId: "one" }, { travelerId: "two" }] });
  await service.proposeTripChange({ tripId: "round_trip", proposal: { schemaVersion: "trip-patch-proposal-v1", proposalId: "sources", tripId: "round_trip", baseRevision: 0, writeSet: nodes.map(n => n.nodeId), writeContract: { allowedNodeIds: nodes.map(n => n.nodeId) }, readSet: [], operations: nodes.map(n => ({ kind: "add_candidate", nodeId: n.nodeId, node: n })) } });
  const trial = await service.planItineraryTrial({ tripId: "round_trip", plan: plan() });
  assert.equal(trial.status, "trial_ready", JSON.stringify(trial.issues));
  const rides = trial.mobility.legs.filter(leg => leg.recommendedMode === "train");
  assert.equal(rides.length, 2); assert.deepEqual(rides.map(leg => selectedRoute(leg).totalMinutes), [60, 60]);
  assert.equal(trial.impact.budget.domains.transport.estimated, 400, "two people pay once for each ticket, not once per station visit and route leg");
  assert.equal((await service.acceptTripChange({ ...trial.accept, tripId: "round_trip" })).status, "committed");
  const reopened = new TravelService({ store: new TripStore({ rootDir: dir }), clock });
  const view = await reopened.getTripPlanView("round_trip");
  assert.equal(view.mobility.itinerary.stops.length, 14);
  assert.equal(view.mobility.legs.filter(leg => leg.recommendedMode === "train").length, 2);
  await reopened.updateTripScope({ tripId: "round_trip", brief: { totalBudget: 9000 } });
  assert.deepEqual((await reopened.getTripPlanView("round_trip")).mobility.itinerary, view.mobility.itinerary);
});

test("return direction/date is queried independently and both candidate groups survive", async () => {
  const calls = [];
  const inventory = new TuniuTravelResearchProvider({ clock, client: { status: "configured", async callReadTool(service, tool, args) {
    calls.push(args); return { data: [{ trainNumber: "SIM01", departureTime: "09:00", arrivalTime: "10:00", departureStationName: `${args.departureCityName}站`, arrivalStationName: `${args.arrivalCityName}站`, duration: "1小时", secondSeatPrice: 100 }] };
  } } });
  const result = await inventory.research({ brief, domains: ["transport"] });
  assert.deepEqual(calls.map(call => [call.departureCityName, call.arrivalCityName, call.departureDate]), [["杭州", "上海", "2026-10-15"], ["上海", "杭州", "2026-10-16"]]);
  assert.deepEqual(result.byDomain.transport.map(n => n.operability.journeyId).sort(), ["back", "out"]);
  assert.notEqual(result.byDomain.transport[0].candidateId, result.byDomain.transport[1].candidateId);
});

test("selected alternatives of the same mode retain their identity and estimate through normalization", () => {
  const leg = { legId: "leg", origin: { nodeId: "a", label: "a", coordinates: null }, destination: { nodeId: "b", label: "b", coordinates: null }, recommendedMode: "transit", rationale: "原建议", alternatives: [alternative("transit", 25, 4), alternative("transit", 35, 2)] };
  const choices = selectRoute(leg);
  const selected = selectRoute(choices, choices.alternatives[1].alternativeId);
  const normalized = normalizeTripMobility({ status: "completed", source: "explicit_simulation", legs: [selected] });
  assert.equal(selectedRoute(normalized.legs[0]).totalMinutes, 35);
  assert.match(normalized.legs[0].rationale, /35/);
});

test("a scenic last-service conflict and a missing return stay actionable without erasing the draft", () => {
  const draft = itineraryPlanToDraft(plan(), brief, nodes);
  const later = structuredClone(nodes); later[1].operability.transportTiming.lastDepartureAt = at(16, "16:00");
  const problems = journeyExecutionIssues(brief, draft.itinerary, later, { legs: [] });
  assert.ok(problems.some(item => item.code === "last_service_missed"));
  const outboundOnly = { ...draft.itinerary, stops: draft.itinerary.stops.filter(s => s.nodeId !== "back") };
  assert.ok(journeyExecutionIssues(brief, outboundOnly, nodes, { legs: [] }).some(item => item.code === "journey_missing"));
  assert.equal(draft.itinerary.stops.length, 14);
});

test("walking away from a parked car cannot teleport it to the next driving origin", () => {
  const stops = [stop("a", "parking", 15, "09:00"), stop("b", "activity", 15, "10:00"), stop("c", "vehicle_return", 15, "12:00")].map((s, i) => ({ ...s, title: s.nodeId, domain: "transport", date: "2026-10-15", dayIndex: 1, startAt: s.timeWindow.startAt, endAt: s.timeWindow.startAt }));
  const mobility = { legs: stops.slice(1).map((s, i) => ({ legId: `leg${i}`, origin: { stopId: stops[i].stopId }, destination: { stopId: s.stopId }, recommendedMode: i ? "drive" : "walk", alternatives: [alternative(i ? "drive" : "walk")] })) };
  const problems = journeyExecutionIssues({ vehicle: { vehicleId: "car", originNodeId: "a", returnNodeId: "c", returnBy: at(15, "11:00"), seats: 4 } }, { stops }, [], mobility, [{ travelerId: "one" }]);
  assert.ok(problems.some(item => item.code === "vehicle_continuity_conflict"));
  assert.ok(problems.some(item => item.code === "vehicle_return_deadline"));
});

test("source-declared bundled scenic tickets do not charge the shuttle twice", () => {
  const ticket = node("ticket", "play", 120), shuttle = node("shuttle", "transport", 40);
  ticket.price.includes = ["shuttle"]; shuttle.price.includedByNodeId = "ticket";
  assert.equal(explicitPriceTotal(shuttle, [ticket, shuttle], {}, 2).amount, 0);
  shuttle.sourceRefs = ["another_source"];
  assert.equal(explicitPriceTotal(shuttle, [ticket, shuttle], {}, 2).amount, 80, "unrelated source claims cannot authorize subtracting a fee");
});
