import { createHash } from "node:crypto";
import type { DecisionNodeInput, ItineraryPlanMode, JourneyRequest, MobilityLeg, MobilityObservation, TripBrief, TripFeasibility, TripItinerary, TripItineraryStop, Traveler } from "../contracts/index.js";

type Candidate = DecisionNodeInput & { nodeId: string };
type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const stamp = (value: unknown, date?: string): string | null => {
  const text = String(value ?? "");
  const full = /^20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) ? text.replace(" ", "T") : date && /^\d{2}:\d{2}$/.test(text) ? `${date}T${text}:00+08:00` : null;
  if (!full) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(full) ? full : `${full}+08:00`;
  return Number.isFinite(Date.parse(zoned)) ? zoned : null;
};
export const shiftTime = (value: string, minutes: number): string => new Date(Date.parse(value) + (minutes + 480) * 60_000).toISOString().replace("Z", "+08:00");

export function tagJourneyCandidate<T extends { candidateId: string; operability?: RecordValue }>(candidate: T, request: JourneyRequest): T {
  return { ...candidate, candidateId: `${candidate.candidateId}_${createHash("sha256").update(`${request.journeyId}:${request.origin}:${request.destination}:${request.date}`).digest("hex").slice(0, 12)}`,
    operability: { ...candidate.operability, journeyId: request.journeyId, journeyPurpose: request.purpose, serviceDate: request.date, departureCity: request.origin, arrivalCity: request.destination } };
}

/** Query direction/date is explicit. Old one-way briefs retain their old scope. */
export function journeyQueries(brief: TripBrief): JourneyRequest[] {
  if (brief.journeys) return brief.journeys.filter(item => item.scope === "plan");
  const date = String(brief.dates ?? "").match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  return brief.origin && brief.destination && date ? [{ journeyId: "outbound", origin: brief.origin, destination: brief.destination, date, purpose: "outbound", scope: "plan" }] : [];
}

export function transportFacts(node: Candidate) {
  const op = obj(node.operability);
  const timing = obj(op.transportTiming);
  const mode = ({ TRAIN: "train", FLIGHT: "flight", SHUTTLE: "shuttle", CABLE_CAR: "cable_car", FERRY: "ferry" } as Record<string, ItineraryPlanMode>)[String(op.transportType ?? "").toUpperCase()];
  const date = typeof op.serviceDate === "string" ? op.serviceDate : undefined;
  const departureAt = stamp(op.departureAt, date), arrivalAt = stamp(op.arrivalAt, date);
  const sourceRefs = (node.sourceRefs ?? []).filter(Boolean);
  return {
    journeyId: typeof op.journeyId === "string" ? op.journeyId : null,
    mode, departureAt, arrivalAt,
    departurePlace: obj(op.departurePlace), arrivalPlace: obj(op.arrivalPlace),
    beforeMinutes: number(timing.beforeMinutes), afterMinutes: number(timing.afterMinutes),
    boardingClosesAt: stamp(timing.boardingClosesAt, date), lastDepartureAt: stamp(timing.lastDepartureAt, date),
    timingSource: typeof timing.source === "string" && sourceRefs.includes(timing.source) ? timing.source : null,
    includedComponents: Array.isArray(timing.includedComponents) ? timing.includedComponents.map(String) : [],
    sourceRefs, checkedAt: typeof op.checkedAt === "string" ? op.checkedAt : null,
    serviceDates: Array.isArray(op.serviceDates) ? op.serviceDates.map(String) : [],
    valid: Boolean(mode && departureAt && arrivalAt && Date.parse(arrivalAt) > Date.parse(departureAt) && sourceRefs.length && op.scheduleVerified === true),
  };
}

export function transportStopWindow(node: Candidate, role: string, duration: number) {
  const facts = transportFacts(node);
  if (!facts.valid || !["transport_departure", "transport_arrival"].includes(role)) return null;
  const departure = role === "transport_departure";
  const sourcedMinutes = facts.timingSource ? departure ? facts.beforeMinutes : facts.afterMinutes : null;
  const minutes = Math.max(duration, sourcedMinutes ?? 0);
  const time = departure ? facts.departureAt! : facts.arrivalAt!;
  return { startAt: departure ? shiftTime(time, -minutes) : time, endAt: departure ? time : shiftTime(time, minutes), facts, assumedBuffer: sourcedMinutes == null };
}

export function routeAlternativeId(alternative: RecordValue): string {
  if (typeof alternative.alternativeId === "string") return alternative.alternativeId;
  return `route_${createHash("sha256").update(JSON.stringify([alternative.mode, alternative.totalMinutes, alternative.distanceMeters, alternative.walkingMeters, alternative.transfers, alternative.estimatedFareCny, alternative.steps])).digest("hex").slice(0, 24)}`;
}

export function selectedRoute(leg: MobilityLeg) {
  return leg.selectedAlternativeId
    ? leg.alternatives.find(item => item.alternativeId === leg.selectedAlternativeId) ?? null
    : leg.alternatives.find(item => item.mode === leg.recommendedMode) ?? null;
}

/** Choice and explanation are one value, including two routes of the same mode. */
export function selectRoute(leg: MobilityLeg, requested?: string): MobilityLeg {
  const alternatives = leg.alternatives.map(item => ({ ...item, alternativeId: routeAlternativeId(item) }));
  const selected = alternatives.find(item => item.alternativeId === requested) ?? alternatives.find(item => item.mode === requested)
    ?? alternatives.find(item => item.alternativeId === leg.selectedAlternativeId) ?? alternatives.find(item => item.mode === leg.recommendedMode);
  if (!selected) return { ...leg, alternatives };
  const changed = Boolean(requested && requested !== leg.selectedAlternativeId && requested !== leg.recommendedMode);
  return { ...leg, alternatives, selectedAlternativeId: selected.alternativeId, recommendedMode: selected.mode,
    ...(changed ? { rationale: `按本次选择采用${selected.mode}：约 ${selected.totalMinutes} 分钟，步行 ${selected.walkingMeters ?? "待核验"} 米，换乘 ${selected.transfers ?? "待核验"} 次；费用 ${selected.estimatedFareCny ?? "待核验"} 元。`, recommendationAudit: { selectedAlternativeId: selected.alternativeId, selectionSource: "requested", previousSelection: leg.selectedAlternativeId ?? leg.recommendedMode } } : {}) };
}

export function explicitPriceTotal(node: Candidate, nodes: Candidate[], brief: TripBrief, partySize: number, itinerary?: TripItinerary | null) {
  const price = node.price;
  if (!price?.unit) return null;
  if (price.includedByNodeId) {
    const bundle = nodes.find(item => item.nodeId === price.includedByNodeId);
    if (bundle?.price?.includes?.includes(node.nodeId) && bundle.sourceRefs?.some(ref => node.sourceRefs?.includes(ref))) return { amount: 0, quality: price.quality, basis: `已包含在${bundle.title ?? bundle.nodeId}报价内，不重复计费` };
  }
  const visits = itinerary?.stops.filter(stop => stop.nodeId === node.nodeId) ?? [];
  const occurrences = node.domain === "transport" ? Math.max(1, visits.filter(stop => stop.role === "transport_departure").length)
    : node.domain === "food" ? Math.max(1, visits.filter(stop => stop.role === "meal").length)
    : node.domain === "play" ? Math.max(1, visits.filter(stop => stop.role === "activity").length) : 1;
  const quantity = price.unit === "per_person" ? partySize * occurrences
    : price.unit === "per_room_night" ? (price.quantity ?? Math.ceil(partySize / 2)) * (brief.lodgingNights ?? Math.max(1, (brief.durationDays ?? 2) - 1))
    : price.unit === "per_vehicle" ? price.quantity ?? (brief.vehicle ? 1 : null) : price.quantity ?? 1;
  return { amount: price.amount == null || quantity == null ? null : Math.round(price.amount * quantity * 100) / 100,
    quality: quantity === 1 ? price.quality : "estimate", basis: `${price.unit} × ${quantity ?? "数量待核验"}${price.unit === "per_room_night" && price.quantity == null ? "（暂按两人一间，房型容量待核验）" : ""}；${price.basis ?? "报价条件待核验"}${price.includes?.length ? `；包含 ${price.includes.join("、")}` : ""}`.slice(0, 240) };
}

export function scheduledRideLeg(from: TripItineraryStop, to: TripItineraryStop, node: Candidate): MobilityLeg | null {
  const facts = transportFacts(node);
  if (!facts.valid) return null;
  const place = (stop: TripItineraryStop, endpoint: RecordValue) => ({ nodeId: stop.nodeId, stopId: stop.stopId, label: String(endpoint.label ?? stop.title), coordinates: null, dayIndex: stop.dayIndex, date: stop.date, role: stop.role, startAt: stop.startAt, endAt: stop.endAt });
  const minutes = (Date.parse(facts.arrivalAt!) - Date.parse(facts.departureAt!)) / 60_000;
  return selectRoute({ legId: `ride_${createHash("sha256").update(`${from.stopId}:${to.stopId}`).digest("hex").slice(0, 24)}`, origin: place(from, facts.departurePlace), destination: place(to, facts.arrivalPlace), recommendedMode: facts.mode!, rationale: "所选班次的来源时刻；出发前复核班次、检票与运营变化。", alternatives: [{
    mode: facts.mode!, totalMinutes: minutes, distanceMeters: null, walkingMeters: null, transfers: 0,
    estimatedFareCny: node.price?.amount ?? null, fareIncludedByNodeId: node.nodeId,
    sourceRefs: facts.sourceRefs, checkedAt: facts.checkedAt, departureAt: facts.departureAt, arrivalAt: facts.arrivalAt,
    scheduleBasis: "scheduled_service", realTimeArrival: false, navigationUrl: null, polyline: [],
    steps: [{ kind: "ride", instruction: String(node.title ?? "所选班次"), line: null, origin: String(facts.departurePlace.label ?? "出发站"), destination: String(facts.arrivalPlace.label ?? "抵达站"), distanceMeters: null, durationMinutes: minutes, walkType: null, accessibilityFeatures: [] }], accessibilityFeatures: [],
    accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false },
  }] });
}

/** Scheduled rides come from inventory; city routing must not turn a train into a taxi. */
export function withScheduledRides(mobility: MobilityObservation, itinerary: TripItinerary | null, nodes: Candidate[]): MobilityObservation {
  if (!itinerary) return mobility;
  const legs = [...(mobility.legs ?? [])];
  for (let index = 1; index < itinerary.stops.length; index++) {
    const from = itinerary.stops[index - 1]!, to = itinerary.stops[index]!;
    if (from.role !== "transport_departure" || to.role !== "transport_arrival" || from.nodeId !== to.nodeId) continue;
    const node = nodes.find(item => item.nodeId === from.nodeId);
    const ride = node ? scheduledRideLeg(from, to, node) : null;
    const old = legs.find(item => item.origin.stopId === from.stopId && item.destination.stopId === to.stopId);
    if (ride && old) { ride.origin.coordinates = old.origin.coordinates; ride.destination.coordinates = old.destination.coordinates; }
    const oldIndex = legs.findIndex(item => item.origin.stopId === from.stopId && item.destination.stopId === to.stopId);
    if (oldIndex >= 0) legs.splice(oldIndex, 1);
    if (ride) legs.push(ride);
  }
  return { ...mobility, legs: legs.map(leg => selectRoute(leg)) };
}

export function journeyExecutionIssues(brief: TripBrief, itinerary: TripItinerary | null, nodes: Candidate[], mobility: MobilityObservation, travelers: Traveler[] = []): TripFeasibility["issues"] {
  if (!itinerary) return [];
  const issues: TripFeasibility["issues"] = [];
  const add = (code: string, message: string, stops: TripItineraryStop[] = [], warning = false) => issues.push({ code, message, severity: warning ? "warning" : "blocking", scope: stops.length ? "visits" : "plan", stopIds: stops.map(stop => stop.stopId), dayIndex: stops[0]?.dayIndex ?? null, resolution: code.includes("unknown") ? "provider_evidence" : "plan_change", allowedRepairDirections: ["replace_candidate", "fetch_evidence"] });
  const rides = itinerary.stops.filter(stop => stop.role === "transport_departure");
  for (const request of brief.journeys ?? []) {
    if (request.scope === "self_arranged") continue;
    const ride = rides.find(stop => obj(nodes.find(node => node.nodeId === stop.nodeId)?.operability).journeyId === request.journeyId);
    if (!ride) { add("journey_missing", `${request.origin}至${request.destination}的${request.purpose === "return" ? "返程" : "交通"}尚未安排。`); continue; }
    const node = nodes.find(item => item.nodeId === ride.nodeId)!;
    const facts = transportFacts(node);
    const op = obj(node.operability);
    if (String(op.departureCity ?? "") !== request.origin || String(op.arrivalCity ?? "") !== request.destination || String(op.serviceDate ?? facts.departureAt?.slice(0, 10)) !== request.date) add("journey_direction_mismatch", "所选班次与该段的方向或日期不一致。", [ride]);
    if (request.arriveBy && facts.arrivalAt && Date.parse(facts.arrivalAt) > Date.parse(request.arriveBy)) add("journey_arrival_deadline", "所选班次晚于用户要求的最晚抵达时间。", [ride]);
  }
  for (const departure of rides) {
    const index = itinerary.stops.indexOf(departure), arrival = itinerary.stops[index + 1];
    const node = nodes.find(item => item.nodeId === departure.nodeId);
    if (!node) continue;
    const facts = transportFacts(node);
    if (!arrival || arrival.nodeId !== departure.nodeId || arrival.role !== "transport_arrival") { add("ride_end_missing", "一次实际乘坐必须连接该班次的出发端和抵达端。", [departure]); continue; }
    if (!facts.valid) { add("transport_schedule_unknown", "班次时刻或来源尚未核验，已保留乘坐意图。", [departure, arrival]); continue; }
    if (facts.serviceDates.length && !facts.serviceDates.includes(departure.date)) add("transport_not_operating", "该班次不在所选日期运营。", [departure]);
    if (facts.boardingClosesAt && (!departure.startAt || Date.parse(departure.startAt) > Date.parse(facts.boardingClosesAt))) add("boarding_deadline_missed", "到达办理地点的时间晚于停止办理或检票时间。", [departure]);
    if (facts.lastDepartureAt && facts.departureAt && Date.parse(facts.departureAt) > Date.parse(facts.lastDepartureAt)) add("last_service_missed", "所选景交或接驳时刻超过来源中的末班。", [departure]);
    if (!facts.timingSource) add("transport_processing_unknown", "进出站、托运或换乘余量为暂定安排，出行前需按运营方规则核验。", [departure, arrival], true);
    if (!departure.startAt || !departure.endAt || Date.parse(departure.startAt) >= Date.parse(departure.endAt)) add("departure_buffer_missing", "尚未给办理与候车留出时间。", [departure]);
  }
  const vehicle = brief.vehicle;
  let vehicleAt = vehicle?.originNodeId ?? null, returned = false;
  for (let index = 0; index < itinerary.stops.length; index++) {
    const stop = itinerary.stops[index]!, previous = itinerary.stops[index - 1];
    const leg = previous ? mobility.legs.find(item => item.origin.stopId === previous.stopId && item.destination.stopId === stop.stopId) : null;
    if (leg && selectedRoute(leg)?.mode === "drive") {
      if (!vehicle || returned || vehicleAt !== previous?.nodeId) add("vehicle_continuity_conflict", "车辆不在这段驾车路线的起点；先返回停车点或调整取车安排。", [previous!, stop]);
      else vehicleAt = stop.nodeId;
      if (vehicle?.seats != null && vehicle.seats < travelers.length) add("vehicle_capacity_conflict", "车辆座位不足以容纳同行人。", [stop]);
      if (vehicle?.luggageCount != null && (vehicle.luggageCapacity == null || vehicle.luggageCount > vehicle.luggageCapacity)) add("vehicle_luggage_unknown", "该车辆尚不能确认容纳本次全部行李。", [stop]);
    }
    if (stop.role === "vehicle_pickup") vehicleAt = stop.nodeId;
    if (stop.role === "vehicle_return") {
      if (vehicleAt !== stop.nodeId || (vehicle?.returnNodeId && stop.nodeId !== vehicle.returnNodeId)) add("vehicle_return_location", "车辆尚未到达约定还车地点。", [stop]);
      if (vehicle?.returnBy && (!stop.endAt || Date.parse(stop.endAt) > Date.parse(vehicle.returnBy))) add("vehicle_return_deadline", "还车完成时间晚于已保存期限。", [stop]);
      returned = true;
    }
  }
  if (vehicle?.returnNodeId && !returned) add("vehicle_return_missing", "尚未安排把车辆还到约定地点。");
  return issues;
}
