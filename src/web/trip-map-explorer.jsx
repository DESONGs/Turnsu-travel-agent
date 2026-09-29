import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import { MapPin, MapTrifold, WarningCircle } from "@phosphor-icons/react";
import { coordinatesForWebMap } from "./map-coordinates.js";
import { buildRouteMapScene, mergeRouteMapSceneStops } from "./route-map-scene.js";
import { createAmapSceneRenderer } from "./amap-map-renderer.js";
import { destinationRenderPolicy } from "./destination-experience-scene.js";
import { AuthenticatedMapImage } from "./authenticated-map-image.jsx";

L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

const configuredTileUrl = String(import.meta.env.VITE_TRAVEL_MAP_TILE_URL ?? "").trim();
const configuredAttribution = String(import.meta.env.VITE_TRAVEL_MAP_ATTRIBUTION ?? "").trim();
const developmentOsmFallback = import.meta.env.DEV ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : "";
const tileUrl = configuredTileUrl || developmentOsmFallback;
const tileAttribution = configuredAttribution || (tileUrl.includes("openstreetmap.org") ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' : "地图底图服务");
const MODE_LABELS = { walk: "步行", transit: "公交地铁", taxi: "打车" };
const MODE_COLORS = { walk: "#2c8053", transit: "#2268c7", taxi: "#c9443b" };

function sceneKey(stops, legs) {
  return JSON.stringify({
    stops: stops.map((stop) => [stop.sceneStopId, stop.nodeId, stop.sequenceLabel, stop.coordinates.longitude, stop.coordinates.latitude]),
    legs: legs.map((leg) => [leg.legId, leg.routeRole, leg.mode, leg.drawable, leg.polyline.map((point) => [point.longitude, point.latitude])]),
  });
}

function numberedMarker(sequenceLabel, { active = false, trial = false, currentOnly = false } = {}) {
  return L.divIcon({
    className: "trip-map-marker-shell",
    html: `<span class="trip-map-marker ${active ? "active" : ""} ${trial ? "trial" : ""} ${currentOnly ? "current-only" : ""}"><b>${sequenceLabel}</b></span>`,
    iconSize: [42, 42], iconAnchor: [21, 38], tooltipAnchor: [0, -34],
  });
}

function routeChip(leg, english) {
  const label = english ? ({ walk: "Walk", transit: "Transit", taxi: "Taxi" }[leg.mode] ?? leg.mode) : (MODE_LABELS[leg.mode] ?? leg.mode);
  return L.divIcon({
    className: "trip-map-route-chip-shell",
    html: `<span class="trip-map-route-chip ${leg.routeRole} ${leg.selected ? "active" : ""}">${label}${leg.minutes != null ? ` · ${Math.round(leg.minutes)}${english ? "m" : " 分"}` : ""}</span>`,
    iconSize: [112, 28], iconAnchor: [56, 14],
  });
}

function webPath(leg) {
  return leg.polyline.map(coordinatesForWebMap).filter(Boolean).map((point) => [point.latitude, point.longitude]);
}

function pathStyle(leg, hasComparison) {
  if (leg.routeRole === "current" && hasComparison) {
    return { color: "#7d8f9b", weight: leg.selected ? 7 : 4, opacity: leg.selected ? 1 : 0.64, dashArray: "8 7", lineCap: "round", lineJoin: "round" };
  }
  return { color: MODE_COLORS[leg.mode] ?? "#2268c7", weight: leg.selected ? 8 : 5, opacity: leg.selected ? 1 : 0.84, lineCap: "round", lineJoin: "round" };
}

function midpoint(positions) {
  return positions[Math.max(0, Math.floor((positions.length - 1) / 2))] ?? null;
}

export function TripDecisionMap({
  nodes = [], comparisonNodes = [], activeNodeId = null, activeLegId = null, activeDay = undefined,
  onFocusNode, onFocusLeg, mobility = null, comparisonMobility = null, tripId = null,
  staticMapAvailable = false, label = "旅行地点地图", locale = "zh-CN",
}) {
  const english = locale === "en";
  const containerRef = useRef(null);
  const imperativeMountRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const pathsRef = useRef(new Map());
  const amapRendererRef = useRef(null);
  const focusNodeCallbackRef = useRef(onFocusNode);
  const focusLegCallbackRef = useRef(onFocusLeg);
  const [interactiveFailed, setInteractiveFailed] = useState(false);
  const [staticFailed, setStaticFailed] = useState(false);
  const [rendererMode, setRendererMode] = useState("resolving");
  const [rendererReason, setRendererReason] = useState(null);
  const [resolvedSceneKey, setResolvedSceneKey] = useState(null);
  const trialRole = comparisonMobility ? "trial" : "current";
  const trialScene = useMemo(() => buildRouteMapScene({ itinerary: mobility?.itinerary, mobility, nodes, routeRole: trialRole, activeDay, activeLegId }), [mobility, nodes, trialRole, activeDay, activeLegId]);
  const currentScene = useMemo(() => comparisonMobility ? buildRouteMapScene({ itinerary: comparisonMobility?.itinerary, mobility: comparisonMobility, nodes: comparisonNodes, routeRole: "current", activeDay, activeLegId }) : null, [comparisonMobility, comparisonNodes, activeDay, activeLegId]);
  const stops = useMemo(() => mergeRouteMapSceneStops(currentScene, trialScene), [currentScene, trialScene]);
  const legs = useMemo(() => [...(currentScene?.legs ?? []), ...(trialScene?.legs ?? [])], [currentScene, trialScene]);
  const drawableLegs = useMemo(() => legs.filter((leg) => leg.drawable), [legs]);
  const routePathGapCount = legs.length - drawableLegs.length;
  const key = useMemo(() => sceneKey(stops, legs), [stops, legs]);
  const trialNodeIds = useMemo(() => new Set(nodes.map((node) => node.nodeId).filter((nodeId) => !comparisonNodes.some((node) => node.nodeId === nodeId))), [nodes, comparisonNodes]);
  const currentOnlyNodeIds = useMemo(() => new Set(comparisonNodes.map((node) => node.nodeId).filter((nodeId) => !nodes.some((node) => node.nodeId === nodeId))), [nodes, comparisonNodes]);
  focusNodeCallbackRef.current = onFocusNode;
  focusLegCallbackRef.current = onFocusLeg;

  useEffect(() => {
    setInteractiveFailed(false);
    setRendererReason(null);
    setResolvedSceneKey(null);
    if (!containerRef.current || !stops.length) {
      setRendererMode("unavailable");
      return undefined;
    }
    const mainlandScene = stops.every((stop) => stop.coordinates.coordinateSystem === "GCJ-02")
      && drawableLegs.every((leg) => leg.polyline.every((point) => point.coordinateSystem === "GCJ-02"));
    if (!mainlandScene) {
      setRendererMode("leaflet");
      setRendererReason("amap_js_renderer_outside_mainland_scene");
      setResolvedSceneKey(key);
      return undefined;
    }
    let cancelled = false;
    const host = containerRef.current;
    const imperativeMount = document.createElement("div");
    imperativeMount.className = "trip-map-sdk-mount";
    host.replaceChildren(imperativeMount);
    imperativeMountRef.current = imperativeMount;
    setRendererMode("resolving");
    createAmapSceneRenderer({ container: imperativeMount, stops, legs: drawableLegs, activeNodeId, activeLegId, onFocusNode: (nodeId) => focusNodeCallbackRef.current?.(nodeId), onFocusLeg: (legId) => focusLegCallbackRef.current?.(legId), locale })
      .then((renderer) => {
        if (cancelled) return renderer.destroy();
        amapRendererRef.current = renderer;
        setRendererMode("amap");
        setResolvedSceneKey(key);
        return undefined;
      })
      .catch((error) => {
        if (cancelled) return;
        if (imperativeMount.parentNode === host) imperativeMount.remove();
        if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
        setRendererReason(error?.code ?? "amap_js_renderer_load_failed");
        setRendererMode("leaflet");
        setResolvedSceneKey(key);
      });
    return () => {
      cancelled = true;
      amapRendererRef.current?.destroy();
      amapRendererRef.current = null;
      if (imperativeMount.parentNode === host) imperativeMount.remove();
      if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
    };
  }, [key, locale]);

  useEffect(() => {
    if (rendererMode !== "leaflet" || resolvedSceneKey !== key || !containerRef.current || !tileUrl || !stops.length || interactiveFailed) return undefined;
    const host = containerRef.current;
    const imperativeMount = document.createElement("div");
    imperativeMount.className = "trip-map-sdk-mount";
    host.replaceChildren(imperativeMount);
    imperativeMountRef.current = imperativeMount;
    const hasFinePointer = window.matchMedia?.("(any-hover: hover) and (any-pointer: fine)")?.matches === true;
    const map = L.map(imperativeMount, { zoomControl: false, attributionControl: true, scrollWheelZoom: hasFinePointer, touchZoom: true, doubleClickZoom: true, dragging: true, keyboard: true });
    mapRef.current = map;
    markersRef.current = new Map();
    pathsRef.current = new Map();
    const tiles = L.tileLayer(tileUrl, { attribution: tileAttribution, maxZoom: 19, crossOrigin: true });
    tiles.on("tileerror", () => setInteractiveFailed(true));
    tiles.addTo(map);
    const bounds = [];
    stops.forEach((stop) => {
      const mapped = coordinatesForWebMap(stop.coordinates);
      if (!mapped) return;
      const position = [mapped.latitude, mapped.longitude];
      const state = { active: stop.nodeId === activeNodeId, trial: trialNodeIds.has(stop.nodeId), currentOnly: currentOnlyNodeIds.has(stop.nodeId) };
      const marker = L.marker(position, { title: stop.title, keyboard: true, riseOnHover: true, icon: numberedMarker(stop.sequenceLabel, state) })
        .bindTooltip(`${stop.sequenceLabel} · ${stop.title}`, { direction: "top", opacity: 0.95 })
        .on("click", () => focusNodeCallbackRef.current?.(stop.nodeId))
        .addTo(map);
      markersRef.current.set(stop.nodeId, { marker, sequenceLabel: stop.sequenceLabel });
      bounds.push(position);
    });
    drawableLegs.forEach((leg) => {
      const positions = webPath(leg);
      if (positions.length < 2) return;
      const line = L.polyline(positions, pathStyle(leg, Boolean(comparisonMobility)))
        .bindTooltip(`${leg.originLabel} → ${leg.destinationLabel} · ${MODE_LABELS[leg.mode] ?? leg.mode}${leg.minutes != null ? ` · ${Math.round(leg.minutes)} 分钟` : ""}`, { sticky: true, opacity: 0.96 })
        .on("click", () => focusLegCallbackRef.current?.(leg.legId))
        .addTo(map);
      const chipPosition = midpoint(positions);
      const chip = chipPosition ? L.marker(chipPosition, { keyboard: false, interactive: true, icon: routeChip(leg, english), zIndexOffset: leg.selected ? 500 : 100 }).on("click", () => focusLegCallbackRef.current?.(leg.legId)).addTo(map) : null;
      pathsRef.current.set(`${leg.routeRole}:${leg.legId}`, { line, chip, positions, leg });
      bounds.push(...positions);
    });
    if (bounds.length === 1) map.setView(bounds[0], 14);
    else map.fitBounds(bounds, { padding: [34, 34], maxZoom: 15 });
    const timer = setTimeout(() => map.invalidateSize(), 80);
    return () => {
      clearTimeout(timer);
      markersRef.current.clear();
      pathsRef.current.clear();
      map.remove();
      mapRef.current = null;
      if (imperativeMount.parentNode === host) imperativeMount.remove();
      if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
    };
  }, [key, interactiveFailed, rendererMode, resolvedSceneKey]);

  useEffect(() => {
    amapRendererRef.current?.focusNode(activeNodeId);
    markersRef.current.forEach(({ marker, sequenceLabel }, nodeId) => marker.setIcon(numberedMarker(sequenceLabel, { active: nodeId === activeNodeId, trial: trialNodeIds.has(nodeId), currentOnly: currentOnlyNodeIds.has(nodeId) })));
    const entry = activeNodeId ? markersRef.current.get(activeNodeId) : null;
    if (!entry || !mapRef.current) return;
    mapRef.current.panTo(entry.marker.getLatLng(), { animate: true, duration: 0.25 });
    entry.marker.openTooltip();
  }, [activeNodeId, key]);

  useEffect(() => {
    amapRendererRef.current?.focusLeg(activeLegId);
    pathsRef.current.forEach(({ line, chip, positions, leg }) => {
      const active = leg.legId === activeLegId;
      line.setStyle(pathStyle({ ...leg, selected: active }, Boolean(comparisonMobility)));
      chip?.setIcon(routeChip({ ...leg, selected: active }, english));
      chip?.setZIndexOffset(active ? 500 : 100);
      if (active && mapRef.current) {
        line.bringToFront();
        mapRef.current.fitBounds(positions, { padding: [56, 56], maxZoom: 16, animate: true, duration: 0.25 });
      }
    });
  }, [activeLegId, key, comparisonMobility, english]);

  const useInteractive = Boolean(stops.length && !interactiveFailed && (rendererMode === "amap" || (rendererMode === "leaflet" && tileUrl)));
  const useStatic = !useInteractive && staticMapAvailable && tripId && !staticFailed;
  const showInteractiveSurface = Boolean(stops.length && !interactiveFailed && (
    ["resolving", "amap", "unavailable"].includes(rendererMode)
    || (rendererMode === "leaflet" && tileUrl)
  ));
  const rendererLabel = rendererMode === "amap" ? (english ? "Amap interactive route map" : "高德互动路线地图") : rendererMode === "leaflet" ? (english ? "Fallback interactive route map" : "基础互动路线地图") : (english ? "Loading route map" : "正在载入路线地图");
  const rendererSummaryLabel = `${rendererLabel}${routePathGapCount ? (english ? ` · ${routePathGapCount} leg${routePathGapCount === 1 ? "" : "s"} without real geometry` : ` · ${routePathGapCount} 段缺少真实折线`) : ""}`;
  return <section className="trip-decision-map" aria-label={label} data-route-map-renderer={useInteractive ? rendererMode : useStatic ? "static" : "unavailable"} data-route-map-status={rendererReason ?? (rendererMode === "amap" ? "amap_js_renderer_ready" : rendererMode)} data-route-active-day={trialScene.activeDay} data-route-stop-count={stops.length} data-route-leg-count={legs.length} data-route-drawable-count={drawableLegs.length}>
    <div className="trip-map-surface">
      {showInteractiveSurface ? <div ref={containerRef} className={rendererMode === "amap" ? "amap-trip-map" : "leaflet-trip-map"} /> : useStatic ? <AuthenticatedMapImage tripId={tripId} alt={english ? (drawableLegs.length ? "Current places and recommended routes" : "Current trip places") : (drawableLegs.length ? "当前地点与推荐路线地图" : "当前旅行地点分布地图")} onError={() => setStaticFailed(true)} /> : <div className="trip-map-unavailable"><MapTrifold weight="duotone" /><span><strong>{english ? "No map is available for these options yet" : "这些候选暂时没有可展示的地图"}</strong><small>{english ? "Addresses and Amap navigation remain available. Places appear here when coordinates are returned." : "仍可查看地址与高德导航；取得坐标后会自动出现在这里。"}</small></span></div>}
      {rendererMode === "resolving" ? <div className="trip-map-resolving"><MapTrifold weight="duotone" />{english ? "Loading the route map" : "正在载入路线地图"}</div> : null}
      {["amap", "leaflet"].includes(rendererMode) ? <div className="trip-map-zoom-controls" aria-label={english ? "Map zoom" : "地图缩放"}><button type="button" onClick={() => rendererMode === "amap" ? amapRendererRef.current?.zoomIn() : mapRef.current?.zoomIn()} aria-label={english ? "Zoom in" : "放大地图"}>+</button><button type="button" onClick={() => rendererMode === "amap" ? amapRendererRef.current?.zoomOut() : mapRef.current?.zoomOut()} aria-label={english ? "Zoom out" : "缩小地图"}>−</button></div> : null}
      {rendererReason && rendererMode === "leaflet" ? <div className="trip-map-fallback-note"><WarningCircle weight="fill" />{rendererReason === "amap_js_renderer_not_configured" ? (english ? "The places and routes are verified; Amap interactive rendering is awaiting authorization, so the basic map is shown." : "路线与地点已核验；高德互动地图授权待配置，当前使用基础地图。") : (english ? "Amap did not load. The checked route remains visible on the basic map." : "高德互动地图未能载入，已在基础地图保留核验路线。")}</div> : null}
      {interactiveFailed ? <div className="trip-map-error"><WarningCircle weight="fill" />{english ? "The base map did not fully load. Place coordinates are still retained." : "底图暂时没有完整载入，地点坐标仍保留。"}</div> : null}
      {stops.length ? <span className="trip-map-count"><MapPin weight="fill" />{english ? `${stops.length} stops · ${drawableLegs.length} route legs${routePathGapCount ? ` · ${routePathGapCount} without drawable geometry` : ""}` : `${stops.length} 站 · ${drawableLegs.length} 段可绘制路线${routePathGapCount ? ` · ${routePathGapCount} 段缺少真实折线` : ""}`}</span> : null}
    </div>
    <footer><span>{useInteractive ? rendererSummaryLabel : useStatic ? (english ? "Amap map snapshot" : "高德地图快照") : (english ? "Map pending" : "地图待补")}</span><small>{useInteractive ? (english ? "Select a route on the map or in the timeline. Final navigation continues in Amap." : "点击地图路线或时间轴可定位同一段；正式导航仍使用高德。") : (english ? "Maps and routes show only data returned by named sources." : "地图与路线均只展示具名来源返回的资料。")}</small></footer>
  </section>;
}

function pointPosition(point) {
  const mapped = coordinatesForWebMap(point);
  return mapped ? [mapped.latitude, mapped.longitude] : null;
}

function destinationRoutePositions(scene) {
  return (scene?.routeRelation?.polyline ?? []).map(pointPosition).filter(Boolean);
}

function destinationFallbackReason(policy, english) {
  const labels = {
    reduced_motion: english ? "Reduced motion is on, so the still map is shown." : "已开启减少动态效果，当前显示静态节奏的地图。",
    save_data: english ? "Data saver is on, so the lightweight map is shown." : "已开启节省流量，当前显示轻量地图。",
    outside_amap_coordinate_system: english ? "This coordinate is outside the current Amap 3D scope." : "当前坐标不在本期高德 3D 预览范围内。",
    amap_js_renderer_load_failed: english ? "Amap 3D did not load; the existing map fallback remains available." : "高德 3D 未能载入，已保留现有地图降级视图。",
    destination_coordinates_missing: english ? "This place has no reliable coordinates yet." : "当前地点尚无可靠坐标。",
  };
  return labels[policy.reason] ?? (english ? "The lightweight map is shown for this preview." : "当前预览使用轻量地图。");
}

export function DestinationExperienceMap({ scene, label = "目的地沉浸预览地图", locale = "zh-CN" }) {
  const english = locale === "en";
  const containerRef = useRef(null);
  const imperativeMountRef = useRef(null);
  const mapRef = useRef(null);
  const amapRendererRef = useRef(null);
  const [rendererMode, setRendererMode] = useState("resolving");
  const [rendererReason, setRendererReason] = useState(null);
  const [amapFailed, setAmapFailed] = useState(false);
  const [interactiveFailed, setInteractiveFailed] = useState(false);
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const saveData = typeof navigator !== "undefined" && navigator.connection?.saveData === true;
  const policy = useMemo(() => destinationRenderPolicy({ scene, prefersReducedMotion: reducedMotion, saveData, amapFailed }), [scene, reducedMotion, saveData, amapFailed]);
  const sceneKeyValue = useMemo(() => JSON.stringify({
    nodeId: scene?.nodeId,
    coordinates: scene?.coordinates,
    beats: scene?.cameraBeats?.map((beat) => [beat.key, beat.center, beat.zoom, beat.pitch, beat.rotation, beat.duration]),
    route: scene?.routeRelation?.polyline?.map((point) => [point.longitude, point.latitude]),
  }), [scene]);

  useEffect(() => {
    setInteractiveFailed(false);
    setAmapFailed(false);
    setRendererReason(null);
  }, [sceneKeyValue]);

  useEffect(() => {
    if (!containerRef.current || !scene?.coordinates) {
      setRendererMode("unavailable");
      return undefined;
    }
    if (policy.mode !== "amap_3d") {
      setRendererMode("leaflet");
      setRendererReason(policy.reason);
      return undefined;
    }
    let cancelled = false;
    const host = containerRef.current;
    const imperativeMount = document.createElement("div");
    imperativeMount.className = "trip-map-sdk-mount";
    host.replaceChildren(imperativeMount);
    imperativeMountRef.current = imperativeMount;
    setRendererMode("resolving");
    createAmapSceneRenderer({ container: imperativeMount, presentation: "destination", destinationScene: scene, reducedMotion, locale })
      .then((renderer) => {
        if (cancelled) return renderer.destroy();
        amapRendererRef.current = renderer;
        setRendererMode("amap");
        return undefined;
      })
      .catch((error) => {
        if (cancelled) return;
        if (imperativeMount.parentNode === host) imperativeMount.remove();
        if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
        setAmapFailed(true);
        setRendererReason(error?.code ?? "amap_js_renderer_load_failed");
        setRendererMode("leaflet");
      });
    return () => {
      cancelled = true;
      amapRendererRef.current?.destroy();
      amapRendererRef.current = null;
      if (imperativeMount.parentNode === host) imperativeMount.remove();
      if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
    };
  }, [sceneKeyValue, policy.mode, policy.reason, reducedMotion, locale]);

  useEffect(() => {
    if (rendererMode !== "leaflet" || !containerRef.current || !tileUrl || !scene?.coordinates || interactiveFailed) return undefined;
    const host = containerRef.current;
    const imperativeMount = document.createElement("div");
    imperativeMount.className = "trip-map-sdk-mount";
    host.replaceChildren(imperativeMount);
    imperativeMountRef.current = imperativeMount;
    const hasFinePointer = window.matchMedia?.("(any-hover: hover) and (any-pointer: fine)")?.matches === true;
    const map = L.map(imperativeMount, { zoomControl: false, attributionControl: true, scrollWheelZoom: hasFinePointer, touchZoom: true, doubleClickZoom: true, dragging: true, keyboard: true });
    mapRef.current = map;
    const tiles = L.tileLayer(tileUrl, { attribution: tileAttribution, maxZoom: 19, crossOrigin: true });
    tiles.on("tileerror", () => setInteractiveFailed(true));
    tiles.addTo(map);
    const bounds = [];
    const position = pointPosition(scene.coordinates);
    if (position) {
      L.marker(position, { title: scene.title, icon: numberedMarker("1", { active: true }) }).addTo(map);
      bounds.push(position);
    }
    const routePositions = destinationRoutePositions(scene);
    if (routePositions.length >= 2) {
      L.polyline(routePositions, { color: "#2268c7", weight: 5, opacity: 0.78, lineCap: "round", lineJoin: "round" }).addTo(map);
      bounds.push(...routePositions);
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    else if (bounds.length === 1) map.setView(bounds[0], 16);
    const timer = setTimeout(() => map.invalidateSize(), 80);
    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      if (imperativeMount.parentNode === host) imperativeMount.remove();
      if (imperativeMountRef.current === imperativeMount) imperativeMountRef.current = null;
    };
  }, [sceneKeyValue, rendererMode, interactiveFailed]);

  const showMapMount = Boolean(scene?.coordinates && !interactiveFailed && (rendererMode === "resolving" || rendererMode === "amap" || (rendererMode === "leaflet" && tileUrl)));
  const useMap = Boolean(scene?.coordinates && !interactiveFailed && (rendererMode === "amap" || (rendererMode === "leaflet" && tileUrl)));
  return <section className="destination-experience-map trip-decision-map" aria-label={label} data-destination-renderer={useMap ? rendererMode : "unavailable"} data-destination-status={rendererReason ?? (rendererMode === "amap" ? "amap_destination_ready" : rendererMode)}>
    <div className="trip-map-surface destination-map-surface">
      {showMapMount ? <div ref={containerRef} className={rendererMode === "amap" ? "amap-trip-map destination-amap-map" : "leaflet-trip-map destination-leaflet-map"} /> : <div className="trip-map-unavailable"><MapTrifold weight="duotone" /><span><strong>{english ? "No spatial preview is available yet" : "暂时没有可展示的空间预览"}</strong><small>{english ? "This place needs reliable coordinates before it can enter the map preview." : "需要可靠坐标后，才能进入地图立体预览。"}</small></span></div>}
      {rendererMode === "resolving" ? <div className="trip-map-resolving"><MapTrifold weight="duotone" />{english ? "Loading the 3D spatial view" : "正在载入地图立体视图"}</div> : null}
      {rendererMode === "amap" ? <div className="destination-camera-note"><MapTrifold weight="fill" />{english ? "Amap 3D spatial view" : "地图立体视图（高德）"}</div> : null}
      {rendererReason && rendererMode === "leaflet" ? <div className="trip-map-fallback-note"><WarningCircle weight="fill" />{destinationFallbackReason({ reason: rendererReason }, english)}</div> : null}
      {interactiveFailed ? <div className="trip-map-error"><WarningCircle weight="fill" />{english ? "The map did not fully load. Source photos and facts remain available." : "地图暂时没有完整载入；来源照片与证据仍可查看。"}</div> : null}
      {["amap", "leaflet"].includes(rendererMode) ? <div className="trip-map-zoom-controls" aria-label={english ? "Spatial preview zoom" : "空间预览缩放"}><button type="button" onClick={() => rendererMode === "amap" ? amapRendererRef.current?.zoomIn() : mapRef.current?.zoomIn()} aria-label={english ? "Zoom in" : "放大空间预览"}>+</button><button type="button" onClick={() => rendererMode === "amap" ? amapRendererRef.current?.zoomOut() : mapRef.current?.zoomOut()} aria-label={english ? "Zoom out" : "缩小空间预览"}>−</button></div> : null}
    </div>
    <footer><span>{rendererMode === "amap" ? (english ? "Amap 3D spatial relation" : "高德 3D 空间关系") : (english ? "Lightweight spatial fallback" : "轻量空间降级视图")}</span><small>{english ? "The preview is read-only and never changes the trip." : "此预览只读，不会修改旅行状态。"}</small></footer>
  </section>;
}
