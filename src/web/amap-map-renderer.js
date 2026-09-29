import { api, apiPublicUrl } from "./api-client.js";

const MODE_COLORS = { walk: "#2c8053", transit: "#2268c7", taxi: "#c9443b" };
let amapApiPromise = null;
let rendererConfigPromise = null;

function rendererError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function loadAmapRendererConfig() {
  rendererConfigPromise ??= api.providerStatus().then((status) => {
    const config = status?.mapRenderer?.amapJs;
    if (!config?.publicKey || !config?.securityServicePath) throw rendererError("amap_js_renderer_not_configured");
    return { publicKey: config.publicKey, serviceHost: apiPublicUrl(config.securityServicePath), status: config.status };
  });
  return rendererConfigPromise;
}

export function resetAmapRendererForTests() {
  amapApiPromise = null;
  rendererConfigPromise = null;
}

export async function loadAmapJsApi() {
  if (window.AMap?.Map) return window.AMap;
  if (amapApiPromise) return amapApiPromise;
  amapApiPromise = loadAmapRendererConfig().then(({ publicKey, serviceHost }) => new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { serviceHost };
    const callbackName = `__travelAgentAmapReady_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(rendererError("amap_js_renderer_load_timeout"));
    }, 12_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.onerror = null;
    };
    window[callbackName] = () => {
      cleanup();
      if (window.AMap?.Map) resolve(window.AMap);
      else reject(rendererError("amap_js_renderer_invalid_response"));
    };
    script.charset = "utf-8";
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(publicKey)}&callback=${encodeURIComponent(callbackName)}`;
    script.onerror = () => {
      cleanup();
      reject(rendererError("amap_js_renderer_load_failed"));
    };
    document.head.appendChild(script);
  })).catch((error) => {
    amapApiPromise = null;
    throw error;
  });
  return amapApiPromise;
}

function markerElement(stop, active) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `amap-scene-marker${active ? " active" : ""}`;
  element.setAttribute("aria-label", `${stop.sequenceLabel} · ${stop.title}`);
  const number = document.createElement("b");
  number.textContent = String(stop.sequenceLabel);
  element.appendChild(number);
  return element;
}

function routeChipElement(leg, english) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `amap-scene-route-chip ${leg.routeRole}${leg.selected ? " active" : ""}`;
  const label = english ? ({ walk: "Walk", transit: "Transit", taxi: "Taxi" }[leg.mode] ?? leg.mode) : ({ walk: "步行", transit: "公交地铁", taxi: "打车" }[leg.mode] ?? leg.mode);
  element.textContent = `${label}${leg.minutes != null ? ` · ${Math.round(leg.minutes)}${english ? "m" : " 分"}` : ""}`;
  element.setAttribute("aria-label", `${leg.originLabel} → ${leg.destinationLabel}，${element.textContent}`);
  return element;
}

function legStyle(leg, hasComparison, active = leg.selected) {
  if (leg.routeRole === "current" && hasComparison) return { strokeColor: "#7d8f9b", strokeWeight: active ? 8 : 5, strokeOpacity: active ? 1 : 0.62, strokeStyle: "dashed" };
  return { strokeColor: MODE_COLORS[leg.mode] ?? "#2268c7", strokeWeight: active ? 9 : 6, strokeOpacity: active ? 1 : 0.86, strokeStyle: "solid" };
}

function pathForLeg(leg) {
  return leg.polyline.map((point) => [point.longitude, point.latitude]);
}

function midpoint(path) {
  return path[Math.max(0, Math.floor((path.length - 1) / 2))];
}

function position(point) {
  return [point.longitude, point.latitude];
}

function applyDestinationCamera(map, beat, smooth = true) {
  if (!beat?.center) return;
  const immediately = !smooth;
  map.setPitch?.(beat.pitch, immediately, beat.duration);
  map.setRotation?.(beat.rotation, immediately, beat.duration);
  if (typeof map.setZoomAndCenter === "function") {
    map.setZoomAndCenter(beat.zoom, position(beat.center), immediately, beat.duration);
  } else {
    map.setZoom?.(beat.zoom);
    map.setCenter?.(position(beat.center));
  }
}

export function createDestinationCameraPlayback({
  map,
  beats = [],
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
  reducedMotion = false,
} = {}) {
  const timers = new Set();
  let stopped = false;
  const clearTimers = () => {
    timers.forEach((timer) => clearTimer(timer));
    timers.clear();
  };
  const stop = () => {
    stopped = true;
    clearTimers();
  };
  const schedule = (callback, delay) => {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, delay);
    timers.add(timer);
  };
  const start = () => {
    if (!map || !beats.length) return;
    stopped = false;
    clearTimers();
    if (reducedMotion) {
      applyDestinationCamera(map, beats[0], false);
      return;
    }
    let elapsed = 0;
    beats.forEach((beat, index) => {
      schedule(() => applyDestinationCamera(map, beat, index > 0), elapsed);
      elapsed += Math.max(0, Number(beat.duration ?? 0));
    });
  };
  return { start, stop, get pendingTimers() { return timers.size; } };
}

function destinationMarkerElement(scene) {
  const element = document.createElement("span");
  element.className = "amap-scene-marker active destination";
  element.textContent = "目的地";
  element.setAttribute("aria-label", scene.title);
  return element;
}

async function createDestinationAmapRenderer({ container, destinationScene, reducedMotion = false }) {
  const AMap = await loadAmapJsApi();
  const firstBeat = destinationScene.cameraBeats?.[0] ?? { center: destinationScene.coordinates, zoom: 16, pitch: 58, rotation: 22 };
  const map = new AMap.Map(container, {
    viewMode: "3D",
    center: position(firstBeat.center),
    zoom: firstBeat.zoom,
    pitch: firstBeat.pitch,
    rotation: firstBeat.rotation,
    resizeEnable: true,
    dragEnable: true,
    zoomEnable: true,
    rotateEnable: true,
    pitchEnable: true,
    doubleClickZoom: true,
    scrollWheel: true,
    buildingAnimation: false,
    features: ["bg", "road", "building", "point"],
  });
  map.setFeatures?.(["bg", "road", "building", "point"]);
  const marker = new AMap.Marker({ position: position(destinationScene.coordinates), content: destinationMarkerElement(destinationScene), anchor: "bottom-center", title: destinationScene.title, zIndex: 260 });
  map.add(marker);
  const routeLine = destinationScene.routeRelation?.polyline?.length >= 2
    ? new AMap.Polyline({ path: destinationScene.routeRelation.polyline.map(position), strokeColor: "#2268c7", strokeWeight: 7, strokeOpacity: 0.82, lineJoin: "round", lineCap: "round", showDir: true, zIndex: 100 })
    : null;
  if (routeLine) {
    map.add(routeLine);
  }
  const playback = createDestinationCameraPlayback({ map, beats: destinationScene.cameraBeats, reducedMotion });
  const stopCamera = () => playback.stop();
  ["dragstart", "zoomstart", "rotatestart", "pitchstart", "mousewheel", "touchstart"].forEach((eventName) => map.on?.(eventName, stopCamera));
  playback.start();
  return {
    map,
    focusNode: () => applyDestinationCamera(map, destinationScene.cameraBeats?.[1] ?? firstBeat, !reducedMotion),
    focusLeg: () => routeLine && map.setFitView?.([routeLine], false, [72, 72, 72, 72], 16),
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    destroy: () => {
      playback.stop();
      ["dragstart", "zoomstart", "rotatestart", "pitchstart", "mousewheel", "touchstart"].forEach((eventName) => map.off?.(eventName, stopCamera));
      map.destroy();
    },
  };
}

export async function createAmapSceneRenderer({ container, stops, legs, activeNodeId = null, activeLegId = null, onFocusNode, onFocusLeg, locale = "zh-CN", presentation = "plan", destinationScene = null, reducedMotion = false }) {
  if (presentation === "destination" && destinationScene?.coordinates) return createDestinationAmapRenderer({ container, destinationScene, reducedMotion });
  const AMap = await loadAmapJsApi();
  const map = new AMap.Map(container, { viewMode: "2D", zoom: 12, resizeEnable: true, dragEnable: true, zoomEnable: true, doubleClickZoom: true, scrollWheel: true });
  const markerEntries = new Map();
  const legEntries = new Map();
  const overlays = [];
  const hasComparison = legs.some((leg) => leg.routeRole === "trial") && legs.some((leg) => leg.routeRole === "current");
  stops.forEach((stop) => {
    const content = markerElement(stop, stop.nodeId === activeNodeId);
    const marker = new AMap.Marker({ position: [stop.coordinates.longitude, stop.coordinates.latitude], content, anchor: "bottom-center", title: stop.title, zIndex: stop.nodeId === activeNodeId ? 220 : 120 });
    marker.on("click", () => onFocusNode?.(stop.nodeId));
    map.add(marker);
    overlays.push(marker);
    markerEntries.set(stop.nodeId, { marker, content });
  });
  legs.filter((leg) => leg.drawable).forEach((leg) => {
    const path = pathForLeg(leg);
    const line = new AMap.Polyline({ path, ...legStyle(leg, hasComparison), lineJoin: "round", lineCap: "round", showDir: leg.routeRole !== "current" || !hasComparison, zIndex: leg.selected ? 110 : 90 });
    line.on("click", () => onFocusLeg?.(leg.legId));
    map.add(line);
    overlays.push(line);
    const chipContent = routeChipElement(leg, locale === "en");
    const chip = new AMap.Marker({ position: midpoint(path), content: chipContent, anchor: "center", zIndex: leg.selected ? 240 : 180 });
    chip.on("click", () => onFocusLeg?.(leg.legId));
    map.add(chip);
    overlays.push(chip);
    legEntries.set(`${leg.routeRole}:${leg.legId}`, { line, chip, chipContent, leg });
  });
  if (overlays.length) map.setFitView(overlays, false, [42, 42, 42, 42], 16);

  const focusNode = (nodeId) => {
    markerEntries.forEach(({ marker, content }, key) => {
      const active = key === nodeId;
      content.classList.toggle("active", active);
      marker.setzIndex?.(active ? 220 : 120);
    });
    const entry = markerEntries.get(nodeId);
    if (entry) map.panTo(entry.marker.getPosition(), 260);
  };
  const focusLeg = (legId) => {
    let activeEntry = null;
    legEntries.forEach((entry) => {
      const active = entry.leg.legId === legId;
      entry.line.setOptions(legStyle(entry.leg, hasComparison, active));
      entry.chipContent.classList.toggle("active", active);
      if (active) activeEntry = entry;
    });
    if (activeEntry) map.setFitView([activeEntry.line], false, [72, 72, 72, 72], 16);
  };
  focusNode(activeNodeId);
  focusLeg(activeLegId);
  return { map, focusNode, focusLeg, zoomIn: () => map.zoomIn(), zoomOut: () => map.zoomOut(), destroy: () => map.destroy() };
}
