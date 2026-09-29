import { MobilityObservationSchema, TripFeasibilitySchema, TripItinerarySchema, assertSchema, type MobilityLeg, type MobilityObservation } from "./index.js";
import { selectedRoute, routeAlternativeId } from "../core/journey-execution.js";

const MODES = new Set(["walk", "transit", "taxi", "drive", "train", "flight", "shuttle", "cable_car", "ferry"]);
const STATUSES = new Set(["completed", "partial", "needs_context", "provider_unavailable"]);
const WALK_TYPES = {
  "0": { kind: "road", label: "普通道路" }, "1": { kind: "crosswalk", label: "人行横道" },
  "3": { kind: "underpass", label: "地下通道" }, "4": { kind: "footbridge", label: "过街天桥" },
  "5": { kind: "subway_passage", label: "地铁通道" }, "6": { kind: "park", label: "公园路段" },
  "7": { kind: "plaza", label: "广场路段" }, "8": { kind: "escalator", label: "扶梯" },
  "9": { kind: "elevator", label: "直梯" }, "10": { kind: "cable_car", label: "索道" },
  "11": { kind: "skybridge", label: "空中通道" }, "12": { kind: "building_passage", label: "建筑物穿越通道" },
  "13": { kind: "pedestrian_passage", label: "行人通道" }, "14": { kind: "boat_route", label: "游船路线" },
  "15": { kind: "sightseeing_vehicle", label: "观光车路线" }, "16": { kind: "slide", label: "滑道" },
  "18": { kind: "widened_road", label: "扩路" }, "19": { kind: "road_connector", label: "道路附属连接线" },
  "20": { kind: "stairs", label: "阶梯" }, "21": { kind: "ramp", label: "斜坡" },
  "22": { kind: "bridge", label: "桥" }, "23": { kind: "tunnel", label: "隧道" },
  "30": { kind: "ferry", label: "轮渡" },
} as const;
const ACCESSIBILITY_FEATURE_KINDS = new Set(["escalator", "elevator", "stairs", "ramp"]);

type UnknownObject = { [key: string]: unknown };

function fail(field: string): never {
  throw Object.assign(new Error("invalid_trip_mobility"), { code: "invalid_trip_mobility", details: { field } });
}

function objectValue(value: unknown, field: string): UnknownObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(field);
  return value as UnknownObject;
}

function optionalObject(value: unknown): UnknownObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : null;
}

function text(value: unknown, field: string, options: { optional: true; max?: number }): string | null;
function text(value: unknown, field: string, options?: { optional?: false; max?: number }): string;
function text(value: unknown, field: string, { optional = false, max = 500 }: { optional?: boolean; max?: number } = {}): string | null {
  if ((value == null || value === "") && optional) return null;
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) return fail(field);
  return normalized;
}

function nonNegativeNumber(value: unknown, field: string, options: { optional: true }): number | null;
function nonNegativeNumber(value: unknown, field: string, options?: { optional?: false }): number;
function nonNegativeNumber(value: unknown, field: string, { optional = false }: { optional?: boolean } = {}): number | null {
  if ((value == null || value === "") && optional) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) return fail(field);
  return normalized;
}

function timestamp(value: unknown, field: string, { optional = false }: { optional?: boolean } = {}): string | null {
  if ((value == null || value === "") && optional) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return fail(field);
  return date.toISOString();
}

function safeAmapUrl(value: unknown, field: string, { optional = true }: { optional?: boolean } = {}): string | null {
  if ((value == null || value === "") && optional) return null;
  let url: URL;
  try { url = new URL(String(value)); } catch { return fail(field); }
  if (url.protocol !== "https:" || !["uri.amap.com", "lbs.amap.com"].includes(url.hostname)) return fail(field);
  return url.toString();
}

function coordinates(input: unknown, field: string) {
  if (!input) return null;
  const value = objectValue(input, field);
  const longitude = Number(value.longitude);
  const latitude = Number(value.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return fail(field);
  return { longitude, latitude, coordinateSystem: "GCJ-02" as const };
}

export interface WalkTypeMetadata { code: string; kind: string; label: string }

export function amapWalkTypeMetadata(value: unknown): WalkTypeMetadata | null {
  if (value == null || value === "") return null;
  const code = String(value).trim();
  if (!/^\d{1,2}$/.test(code)) return null;
  const known = WALK_TYPES[code as keyof typeof WALK_TYPES];
  return known ? { code, ...known } : { code, kind: "other", label: `特殊步行路段（${code}）` };
}

export function accessibilityFeaturesForWalkType(walkType: unknown, source = "amap_routes_v5") {
  const value = optionalObject(walkType);
  const normalized = value?.code ? amapWalkTypeMetadata(value.code) : amapWalkTypeMetadata(walkType);
  if (!normalized || !ACCESSIBILITY_FEATURE_KINDS.has(normalized.kind)) return [];
  return [{
    kind: normalized.kind, label: normalized.label, status: "mapped_non_realtime" as const, source, realTime: false as const,
    guidance: normalized.kind === "stairs"
      ? "路线资料显示该路段包含阶梯；如需避开台阶，应改用其他路线。"
      : `路线资料显示该路段包含${normalized.label}；不代表当前正在运行或开放，建议现场确认。`,
  }];
}

function accessibilityFeature(input: unknown, index: number, field: string) {
  const value = objectValue(input, `${field}.${index}`);
  const kind = text(value.kind, `${field}.${index}.kind`, { max: 40 });
  if (!ACCESSIBILITY_FEATURE_KINDS.has(kind)) return fail(`${field}.${index}.kind`);
  return {
    kind, label: text(value.label, `${field}.${index}.label`, { max: 80 }), status: "mapped_non_realtime" as const,
    source: text(value.source ?? "amap_routes_v5", `${field}.${index}.source`, { max: 120 }), realTime: false as const,
    guidance: text(value.guidance, `${field}.${index}.guidance`, { optional: true, max: 300 }),
  };
}

function place(input: unknown, field: string) {
  const value = objectValue(input, field);
  return {
    nodeId: text(value.nodeId, `${field}.nodeId`, { optional: true, max: 128 }),
    stopId: text(value.stopId, `${field}.stopId`, { optional: true, max: 128 }),
    label: text(value.label, `${field}.label`, { max: 200 }),
    coordinates: coordinates(value.coordinates, `${field}.coordinates`),
    dayIndex: nonNegativeNumber(value.dayIndex, `${field}.dayIndex`, { optional: true }),
    date: text(value.date, `${field}.date`, { optional: true, max: 10 }),
    role: text(value.role, `${field}.role`, { optional: true, max: 40 }),
    startAt: timestamp(value.startAt, `${field}.startAt`, { optional: true }),
    endAt: timestamp(value.endAt, `${field}.endAt`, { optional: true }),
  };
}

function step(input: unknown, index: number, field: string) {
  const value = objectValue(input, `${field}.${index}`);
  const kind = text(value.kind, `${field}.${index}.kind`, { max: 40 });
  if (!["walk", "ride", "transfer", "taxi", "drive", "arrive"].includes(kind)) return fail(`${field}.${index}.kind`);
  const walkTypeValue = optionalObject(value.walkType);
  const walkType = walkTypeValue?.code ? amapWalkTypeMetadata(walkTypeValue.code) : amapWalkTypeMetadata(value.walkType ?? value.walkTypeCode);
  const suppliedFeatures = Array.isArray(value.accessibilityFeatures)
    ? value.accessibilityFeatures.slice(0, 8).map((item, featureIndex) => accessibilityFeature(item, featureIndex, `${field}.${index}.accessibilityFeatures`))
    : [];
  return {
    kind, instruction: text(value.instruction, `${field}.${index}.instruction`, { max: 500 }),
    line: text(value.line, `${field}.${index}.line`, { optional: true, max: 160 }),
    origin: text(value.origin, `${field}.${index}.origin`, { optional: true, max: 160 }),
    destination: text(value.destination, `${field}.${index}.destination`, { optional: true, max: 160 }),
    durationMinutes: nonNegativeNumber(value.durationMinutes, `${field}.${index}.durationMinutes`, { optional: true }),
    distanceMeters: nonNegativeNumber(value.distanceMeters, `${field}.${index}.distanceMeters`, { optional: true }),
    polyline: Array.isArray(value.polyline)
      ? value.polyline.map((point, pointIndex) => coordinates(point, `${field}.${index}.polyline.${pointIndex}`)).filter((point) => point !== null).slice(0, 300)
      : [],
    walkType,
    accessibilityFeatures: suppliedFeatures.length ? suppliedFeatures : accessibilityFeaturesForWalkType(walkType),
  };
}

function alternative(input: unknown, index: number, field: string) {
  const value = objectValue(input, `${field}.${index}`);
  const mode = text(value.mode, `${field}.${index}.mode`, { max: 20 });
  if (!MODES.has(mode)) return fail(`${field}.${index}.mode`);
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, 24).map((item, stepIndex) => step(item, stepIndex, `${field}.${index}.steps`)) : [];
  const accessibilityFeatures = [...new Map(steps.flatMap((item) => item.accessibilityFeatures).map((feature) => [feature.kind, feature])).values()];
  return {
    alternativeId: routeAlternativeId(value),
    ...(value.fareIncludedByNodeId ? { fareIncludedByNodeId: text(value.fareIncludedByNodeId, `${field}.${index}.fareIncludedByNodeId`, { max: 128 }) } : {}),
    ...(Array.isArray(value.sourceRefs) ? { sourceRefs: value.sourceRefs.map(String) } : {}),
    ...(value.departureAt ? { departureAt: timestamp(value.departureAt, `${field}.${index}.departureAt`) } : {}),
    ...(value.arrivalAt ? { arrivalAt: timestamp(value.arrivalAt, `${field}.${index}.arrivalAt`) } : {}),
    mode, totalMinutes: nonNegativeNumber(value.totalMinutes, `${field}.${index}.totalMinutes`),
    distanceMeters: nonNegativeNumber(value.distanceMeters, `${field}.${index}.distanceMeters`, { optional: true }),
    walkingMeters: nonNegativeNumber(value.walkingMeters, `${field}.${index}.walkingMeters`, { optional: true }),
    transfers: nonNegativeNumber(value.transfers, `${field}.${index}.transfers`, { optional: true }),
    estimatedFareCny: nonNegativeNumber(value.estimatedFareCny, `${field}.${index}.estimatedFareCny`, { optional: true }),
    scheduleBasis: value.scheduleBasis === "scheduled_service" ? "scheduled_service" as const : "query_time_estimate" as const,
    realTimeArrival: false as const,
    navigationUrl: safeAmapUrl(value.navigationUrl, `${field}.${index}.navigationUrl`),
    polyline: Array.isArray(value.polyline) ? value.polyline.map((point, pointIndex) => coordinates(point, `${field}.${index}.polyline.${pointIndex}`)).filter((point) => point !== null).slice(0, 600) : [],
    steps, accessibilityFeatures,
    accessibilityAssessment: {
      hasStairs: accessibilityFeatures.some((feature) => feature.kind === "stairs"),
      hasElevator: accessibilityFeatures.some((feature) => feature.kind === "elevator"),
      hasEscalator: accessibilityFeatures.some((feature) => feature.kind === "escalator"),
      hasRamp: accessibilityFeatures.some((feature) => feature.kind === "ramp"),
      stepFreeContinuity: "not_verified" as const, realTimeStatus: false as const,
    },
  };
}

function leg(input: unknown, index: number) {
  const value = objectValue(input, `legs.${index}`);
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.map((item, alternativeIndex) => alternative(item, alternativeIndex, `legs.${index}.alternatives`)) : [];
  if (!alternatives.length) return fail(`legs.${index}.alternatives`);
  const recommendedMode = text(value.recommendedMode, `legs.${index}.recommendedMode`, { max: 20 });
  if (!MODES.has(recommendedMode) || !alternatives.some((item) => item.mode === recommendedMode)) return fail(`legs.${index}.recommendedMode`);
  const audit = optionalObject(value.recommendationAudit);
  const thresholds = optionalObject(audit?.thresholds);
  const transitAudit = optionalObject(audit?.transit);
  const taxiAudit = optionalObject(audit?.taxi);
  const walkAudit = optionalObject(audit?.walk);
  const accessibilityEvidence = optionalObject(audit?.accessibilityEvidence);
  const recommendationAudit = audit ? {
    thresholds: {
      walkingMeters: nonNegativeNumber(thresholds?.walkingMeters, `legs.${index}.recommendationAudit.thresholds.walkingMeters`, { optional: true }),
      transfers: nonNegativeNumber(thresholds?.transfers, `legs.${index}.recommendationAudit.thresholds.transfers`, { optional: true }),
      walkingSource: text(thresholds?.walkingSource, `legs.${index}.recommendationAudit.thresholds.walkingSource`, { optional: true, max: 80 }),
      transferSource: text(thresholds?.transferSource, `legs.${index}.recommendationAudit.thresholds.transferSource`, { optional: true, max: 80 }),
    },
    transit: transitAudit ? {
      totalMinutes: nonNegativeNumber(transitAudit.totalMinutes, `legs.${index}.recommendationAudit.transit.totalMinutes`, { optional: true }),
      walkingMeters: nonNegativeNumber(transitAudit.walkingMeters, `legs.${index}.recommendationAudit.transit.walkingMeters`, { optional: true }),
      transfers: nonNegativeNumber(transitAudit.transfers, `legs.${index}.recommendationAudit.transit.transfers`, { optional: true }),
      estimatedFareCny: nonNegativeNumber(transitAudit.estimatedFareCny, `legs.${index}.recommendationAudit.transit.estimatedFareCny`, { optional: true }),
      walkingExceeded: transitAudit.walkingExceeded === true,
      transfersExceeded: transitAudit.transfersExceeded === true,
      hasStairs: transitAudit.hasStairs === true,
      hasElevator: transitAudit.hasElevator === true,
      hasEscalator: transitAudit.hasEscalator === true,
      hasRamp: transitAudit.hasRamp === true,
      stepFreeContinuity: text(transitAudit.stepFreeContinuity, `legs.${index}.recommendationAudit.transit.stepFreeContinuity`, { optional: true, max: 80 }),
    } : null,
    taxi: taxiAudit ? {
      totalMinutes: nonNegativeNumber(taxiAudit.totalMinutes, `legs.${index}.recommendationAudit.taxi.totalMinutes`, { optional: true }),
      walkingMeters: nonNegativeNumber(taxiAudit.walkingMeters, `legs.${index}.recommendationAudit.taxi.walkingMeters`, { optional: true }),
      transfers: nonNegativeNumber(taxiAudit.transfers, `legs.${index}.recommendationAudit.taxi.transfers`, { optional: true }),
      estimatedFareCny: nonNegativeNumber(taxiAudit.estimatedFareCny, `legs.${index}.recommendationAudit.taxi.estimatedFareCny`, { optional: true }),
    } : null,
    walk: walkAudit ? {
      totalMinutes: nonNegativeNumber(walkAudit.totalMinutes, `legs.${index}.recommendationAudit.walk.totalMinutes`, { optional: true }),
      distanceMeters: nonNegativeNumber(walkAudit.distanceMeters, `legs.${index}.recommendationAudit.walk.distanceMeters`, { optional: true }),
    } : null,
    triggers: Array.isArray(audit.triggers) ? audit.triggers.map(String).slice(0, 8) : [],
    accessibilityEvidence: {
      status: text(accessibilityEvidence?.status, `legs.${index}.recommendationAudit.accessibilityEvidence.status`, { optional: true, max: 80 }),
      directTrigger: accessibilityEvidence?.directTrigger === true,
    },
  } : null;
  return {
    legId: text(value.legId, `legs.${index}.legId`, { max: 128 }), origin: place(value.origin, `legs.${index}.origin`),
    destination: place(value.destination, `legs.${index}.destination`), recommendedMode,
    selectedAlternativeId: text(value.selectedAlternativeId, `legs.${index}.selectedAlternativeId`, { optional: true, max: 128 }) ?? alternatives.find(item => item.mode === recommendedMode)?.alternativeId,
    rationale: text(value.rationale, `legs.${index}.rationale`, { max: 800 }), alternatives, recommendationAudit,
  };
}

function travelerFit(input: unknown) {
  const value = optionalObject(input);
  if (!value) return { constrainedTravelerIds: [], maxContinuousWalkMeters: null, maxTransfers: null, stepFreeRequired: false, avoidStairs: false, accessibilityEvidence: "not_required" };
  const evidence = typeof value.accessibilityEvidence === "string" && ["verified", "partial", "unverified", "not_required"].includes(value.accessibilityEvidence)
    ? value.accessibilityEvidence : (value.stepFreeRequired || value.avoidStairs ? "unverified" : "not_required");
  const stayAnchorFits = Array.isArray(value.stayAnchorFits) ? value.stayAnchorFits.slice(0, 2).map((item, index) => {
    const fit = objectValue(item, `travelerFit.stayAnchorFits.${index}`);
    return {
      area: text(fit.area, `travelerFit.stayAnchorFits.${index}.area`, { max: 80 }),
      recommendedMode: text(fit.recommendedMode, `travelerFit.stayAnchorFits.${index}.recommendedMode`, { max: 20 }),
      checkedAt: timestamp(fit.checkedAt, `travelerFit.stayAnchorFits.${index}.checkedAt`, { optional: true }),
      source: text(fit.source, `travelerFit.stayAnchorFits.${index}.source`, { max: 120 }),
      alternatives: Array.isArray(fit.alternatives) ? fit.alternatives.slice(0, 3).map((alternativeValue, alternativeIndex) => {
        const candidate = objectValue(alternativeValue, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}`);
        return {
          mode: text(candidate.mode, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}.mode`, { max: 20 }),
          totalMinutes: nonNegativeNumber(candidate.totalMinutes, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}.totalMinutes`),
          walkingMeters: nonNegativeNumber(candidate.walkingMeters, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}.walkingMeters`, { optional: true }),
          transfers: nonNegativeNumber(candidate.transfers, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}.transfers`, { optional: true }),
          estimatedFareCny: nonNegativeNumber(candidate.estimatedFareCny, `travelerFit.stayAnchorFits.${index}.alternatives.${alternativeIndex}.estimatedFareCny`, { optional: true }),
        };
      }) : [],
    };
  }) : [];
  return {
    constrainedTravelerIds: Array.isArray(value.constrainedTravelerIds) ? [...new Set(value.constrainedTravelerIds.map(String))].slice(0, 12) : [],
    maxContinuousWalkMeters: nonNegativeNumber(value.maxContinuousWalkMeters, "travelerFit.maxContinuousWalkMeters", { optional: true }),
    maxTransfers: nonNegativeNumber(value.maxTransfers, "travelerFit.maxTransfers", { optional: true }),
    planningWalkingTarget: nonNegativeNumber(value.planningWalkingTarget, "travelerFit.planningWalkingTarget", { optional: true }),
    planningTransferTarget: nonNegativeNumber(value.planningTransferTarget, "travelerFit.planningTransferTarget", { optional: true }),
    walkingTargetSource: text(value.walkingTargetSource, "travelerFit.walkingTargetSource", { optional: true, max: 80 }),
    transferTargetSource: text(value.transferTargetSource, "travelerFit.transferTargetSource", { optional: true, max: 80 }),
    stepFreeRequired: value.stepFreeRequired === true, avoidStairs: value.avoidStairs === true, accessibilityEvidence: evidence, stayAnchorFits,
  };
}

export function normalizeTripMobility(input: unknown): MobilityObservation {
  const value = objectValue(input, "root");
  const status = text(value.status, "status", { max: 40 });
  if (!STATUSES.has(status)) return fail("status");
  // Route evidence is authoritative for every scheduled transition. Presentation
  // limits must never silently remove later days from the checked itinerary.
  const legs = ["completed", "partial"].includes(status) && Array.isArray(value.legs) ? value.legs.map(leg) : [];
  if (status === "completed" && !legs.length) return fail("legs");
  const coverage = optionalObject(value.coverage);
  return assertSchema(MobilityObservationSchema, {
    schemaVersion: "trip-mobility-v1", status,
    destination: text(value.destination, "destination", { optional: true, max: 120 }),
    source: text(value.source ?? "amap_routes_v5", "source", { max: 120 }),
    checkedAt: timestamp(value.checkedAt, "checkedAt", { optional: true }),
    freshUntil: timestamp(value.freshUntil, "freshUntil", { optional: true }),
    coverage: {
      routedNodeIds: Array.isArray(coverage?.routedNodeIds) ? [...new Set(coverage.routedNodeIds.map(String))] : [],
      unresolvedNodeIds: Array.isArray(coverage?.unresolvedNodeIds) ? [...new Set(coverage.unresolvedNodeIds.map(String))] : [],
      routedStopIds: Array.isArray(coverage?.routedStopIds) ? [...new Set(coverage.routedStopIds.map(String))] : [],
      unresolvedStopIds: Array.isArray(coverage?.unresolvedStopIds) ? [...new Set(coverage.unresolvedStopIds.map(String))] : [],
      unscheduled: coverage?.unscheduled !== false,
    },
    legs,
    itinerary: value.itinerary ? assertSchema(TripItinerarySchema, value.itinerary, "invalid_trip_itinerary") : null,
    feasibility: value.feasibility ? assertSchema(TripFeasibilitySchema, value.feasibility, "invalid_trip_feasibility") : null,
    travelerFit: travelerFit(value.travelerFit), reason: text(value.reason, "reason", { optional: true, max: 200 }),
    caveats: Array.isArray(value.caveats) ? value.caveats.map((item) => String(item).trim().slice(0, 500)).filter(Boolean).slice(0, 12) : [],
    sourceDocumentation: safeAmapUrl(value.sourceDocumentation, "sourceDocumentation"), fabricatedResults: false,
  }, "invalid_trip_mobility");
}

export function mobilityRecommendedAlternative(legValue: MobilityLeg) {
  return selectedRoute(legValue);
}
