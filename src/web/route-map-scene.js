const ROUTE_MODES = new Set(["walk", "transit", "taxi", "drive", "bicycle", "train", "flight", "ferry", "shuttle", "cable_car"]);

function coordinate(value) {
  if (!value || !Number.isFinite(Number(value.longitude)) || !Number.isFinite(Number(value.latitude))) return null;
  if (!["WGS-84", "GCJ-02"].includes(value.coordinateSystem)) return null;
  return {
    longitude: Number(value.longitude),
    latitude: Number(value.latitude),
    coordinateSystem: value.coordinateSystem === "WGS-84" ? "WGS-84" : "GCJ-02",
  };
}

function placeCoordinate(place, nodesById, mobilityPlacesByStopId, mobilityPlacesByNodeId) {
  return coordinate(place?.coordinates)
    ?? coordinate(nodesById.get(place?.nodeId)?.location?.coordinates)
    ?? coordinate(mobilityPlacesByStopId.get(place?.stopId)?.coordinates)
    ?? coordinate(mobilityPlacesByNodeId.get(place?.nodeId)?.coordinates);
}

function stopIdentity(place, index) {
  return place?.stopId || `${place?.nodeId || "unknown"}:${place?.dayIndex || 0}:${index}`;
}

function availableDayIndexes(itinerary, mobility) {
  const values = [
    ...(itinerary?.days ?? []).filter((day) => !Array.isArray(day?.stopIds) || day.stopIds.length > 0).map((day) => day?.dayIndex),
    ...(itinerary?.stops ?? []).map((stop) => stop?.dayIndex),
    ...(mobility?.legs ?? []).flatMap((leg) => [leg?.origin?.dayIndex, leg?.destination?.dayIndex]),
  ].map(Number).filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(values)].sort((left, right) => left - right);
}

function legDayIndex(leg) {
  const origin = Number(leg?.origin?.dayIndex);
  if (Number.isInteger(origin) && origin > 0) return origin;
  const destination = Number(leg?.destination?.dayIndex);
  return Number.isInteger(destination) && destination > 0 ? destination : null;
}

function selectedAlternative(leg, routeModes) {
  const requested = routeModes?.[leg?.legId];
  const mode = ROUTE_MODES.has(requested) && leg?.alternatives?.some((item) => item.mode === requested)
    ? requested
    : leg?.recommendedMode;
  return leg?.alternatives?.find((item) => item.mode === mode) ?? null;
}

/**
 * A transient, deterministic projection for map renderers. It never plans a
 * route, mutates Mobility, or fills missing geometry with endpoint lines.
 */
export function buildRouteMapScene({
  itinerary = null,
  mobility = null,
  nodes = [],
  routeRole = "current",
  activeDay = undefined,
  activeLegId = null,
  routeModes = {},
} = {}) {
  const nodesById = new Map(nodes.map((node) => [node?.nodeId, node]).filter(([nodeId]) => nodeId));
  const sourceItinerary = itinerary ?? mobility?.itinerary ?? null;
  const availableDays = availableDayIndexes(sourceItinerary, mobility);
  const resolvedDay = activeDay === "all"
    ? "all"
    : Number.isInteger(Number(activeDay)) && Number(activeDay) > 0
      ? Number(activeDay)
      : availableDays[0] ?? "all";
  const sourceLegs = mobility?.legs ?? [];
  const mobilityPlaces = sourceLegs.flatMap((leg) => [leg?.origin, leg?.destination]).filter(Boolean);
  const mobilityPlacesByStopId = new Map(mobilityPlaces.map((place) => [place?.stopId, place]).filter(([stopId]) => stopId));
  const mobilityPlacesByNodeId = new Map(mobilityPlaces.map((place) => [place?.nodeId, place]).filter(([nodeId]) => nodeId));
  const visibleLegs = sourceLegs.filter((leg) => resolvedDay === "all" || legDayIndex(leg) === resolvedDay);
  const itineraryStops = sourceItinerary?.stops ?? [];
  const sourceStops = itineraryStops.length
    ? itineraryStops
    : sourceLegs.length
      ? [sourceLegs[0]?.origin, ...sourceLegs.map((leg) => leg?.destination)]
      : nodes.map((node) => ({ nodeId: node.nodeId, label: node.title, coordinates: node.location?.coordinates }));
  const visibleStopIds = new Set(visibleLegs.flatMap((leg) => [leg?.origin?.stopId, leg?.destination?.stopId]).filter(Boolean));
  const visibleNodeIds = new Set(visibleLegs.flatMap((leg) => [leg?.origin?.nodeId, leg?.destination?.nodeId]).filter(Boolean));
  const stops = sourceStops.map((stop, index) => {
    const coordinates = placeCoordinate(stop, nodesById, mobilityPlacesByStopId, mobilityPlacesByNodeId);
    if (!coordinates) return null;
    const dayIndex = Number.isInteger(Number(stop?.dayIndex)) ? Number(stop.dayIndex) : null;
    if (resolvedDay !== "all" && dayIndex != null && dayIndex !== resolvedDay) return null;
    if (resolvedDay !== "all" && visibleLegs.length && !visibleStopIds.has(stop?.stopId) && !visibleNodeIds.has(stop?.nodeId)) return null;
    const node = nodesById.get(stop?.nodeId);
    return {
      sceneStopId: stopIdentity(stop, index),
      nodeId: stop?.nodeId ?? node?.nodeId ?? null,
      stopId: stop?.stopId ?? null,
      dayIndex,
      index: index + 1,
      title: stop?.title ?? stop?.label ?? node?.title ?? "地点",
      role: stop?.role ?? null,
      coordinates,
    };
  }).filter(Boolean);
  const legs = visibleLegs.map((leg) => {
    const alternative = selectedAlternative(leg, routeModes);
    const polyline = (alternative?.polyline ?? []).map(coordinate).filter(Boolean);
    const dayIndex = legDayIndex(leg);
    return {
      legId: String(leg?.legId ?? ""),
      dayIndex,
      originNodeId: leg?.origin?.nodeId ?? null,
      destinationNodeId: leg?.destination?.nodeId ?? null,
      originStopId: leg?.origin?.stopId ?? null,
      destinationStopId: leg?.destination?.stopId ?? null,
      originLabel: leg?.origin?.label ?? "起点",
      destinationLabel: leg?.destination?.label ?? "终点",
      mode: alternative?.mode ?? leg?.recommendedMode ?? null,
      routeRole: routeRole === "trial" ? "trial" : "current",
      selected: Boolean(activeLegId && leg?.legId === activeLegId),
      drawable: polyline.length >= 2,
      unavailableReason: polyline.length >= 2 ? null : "geometry_unavailable",
      polyline,
      minutes: Number.isFinite(Number(alternative?.totalMinutes)) ? Number(alternative.totalMinutes) : null,
      walkingMeters: Number.isFinite(Number(alternative?.walkingMeters)) ? Number(alternative.walkingMeters) : null,
      transfers: Number.isFinite(Number(alternative?.transfers)) ? Number(alternative.transfers) : null,
      fare: alternative?.fare ?? null,
      estimatedFareCny: alternative?.estimatedFareCny != null && Number.isFinite(Number(alternative.estimatedFareCny)) ? Number(alternative.estimatedFareCny) : null,
      steps: alternative?.steps ?? [],
      navigationUrl: alternative?.navigationUrl ?? null,
      rationale: leg?.rationale ?? "",
    };
  });
  return {
    schemaVersion: "route-map-scene-v1",
    routeRole: routeRole === "trial" ? "trial" : "current",
    activeDay: resolvedDay,
    activeLegId,
    availableDays,
    stops,
    legs,
    checkedAt: mobility?.checkedAt ?? null,
  };
}

/**
 * Map markers represent physical places, while an itinerary may visit the
 * same place more than once. Keep one marker per node and retain every visit
 * number from the displayed route (prefer the trial route during comparison).
 */
export function mergeRouteMapSceneStops(...scenes) {
  const merged = new Map();
  for (const scene of scenes.filter(Boolean)) {
    const role = scene.routeRole === "trial" ? "trial" : "current";
    for (const stop of scene.stops ?? []) {
      const key = stop.nodeId
        ? `node:${stop.nodeId}`
        : `coordinate:${stop.coordinates.longitude}:${stop.coordinates.latitude}`;
      const existing = merged.get(key) ?? {
        ...stop,
        visitIndexesByRole: { current: [], trial: [] },
      };
      const indexes = new Set(existing.visitIndexesByRole[role]);
      if (Number.isFinite(Number(stop.index))) indexes.add(Number(stop.index));
      existing.visitIndexesByRole = {
        ...existing.visitIndexesByRole,
        [role]: [...indexes].sort((left, right) => left - right),
      };
      merged.set(key, existing);
    }
  }
  return [...merged.values()].map((stop) => {
    const visibleIndexes = stop.visitIndexesByRole.trial.length
      ? stop.visitIndexesByRole.trial
      : stop.visitIndexesByRole.current;
    return {
      ...stop,
      index: visibleIndexes[0] ?? stop.index,
      visitIndexes: visibleIndexes,
      sequenceLabel: visibleIndexes.join("·") || String(stop.index),
    };
  });
}

export function routeMapSceneTotals(scene) {
  return (scene?.legs ?? []).reduce((totals, leg) => ({
    minutes: totals.minutes + Number(leg.minutes ?? 0),
    walkingMeters: totals.walkingMeters + Number(leg.walkingMeters ?? 0),
    transfers: totals.transfers + Number(leg.transfers ?? 0),
    estimatedFareCny: totals.estimatedFareCny + Number(leg.estimatedFareCny ?? 0),
  }), { minutes: 0, walkingMeters: 0, transfers: 0, estimatedFareCny: 0 });
}
