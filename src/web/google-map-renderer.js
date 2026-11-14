import L from "leaflet";
import { api } from "./api-client.js";
import { coordinatesForWebMap } from "./map-coordinates.js";

let scriptPromise;
function loadGoogleMaps(key) {
  if (globalThis.google?.maps?.Map) return Promise.resolve(globalThis.google.maps);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => { script.remove(); reject(new Error("google_map_load_timeout")); }, 20_000);
    const callback = `travelGoogleReady_${Date.now()}`;
    globalThis[callback] = () => { clearTimeout(timer); delete globalThis[callback]; resolve(globalThis.google.maps); };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=${callback}`;
    script.async = true;

    script.onerror = () => { clearTimeout(timer); reject(new Error("google_map_unavailable")); };
    document.head.append(script);
  }).catch(error => { scriptPromise = null; throw error; });
  return scriptPromise;
}
const point = value => { const p = coordinatesForWebMap(value); return p ? { lat: p.latitude, lng: p.longitude } : null; };
const color = mode => ({ walk: "#2c8053", transit: "#2268c7", taxi: "#c9443b", drive: "#9454b7", bicycle: "#398d83" })[mode] ?? "#2268c7";

export async function createGoogleSceneRenderer({ container, stops, legs, onFocusNode, onFocusLeg, locale = "en", region = "US", activeNodeId, activeLegId }) {
  const config = await api.mapConfig();
  if (config.google?.status !== "configured") throw Object.assign(new Error("google_maps_not_configured"), { code: "google_maps_not_configured" });
  if (!config.google.browserKey || globalThis.travelHost?.kind === "claude-artifact" || globalThis.TRAVEL_APP_BUILD === "artifact") return createGoogleTilesRenderer({ container, stops, legs, onFocusNode, onFocusLeg, locale, region, activeNodeId, activeLegId });
  const maps = await loadGoogleMaps(config.google.browserKey);
  const first = stops.map(stop => point(stop.coordinates)).find(Boolean);
  if (!first) throw new Error("map_coordinates_required");
  const map = new maps.Map(container, { center: first, zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, gestureHandling: "cooperative" });
  const markers = [], paths = [], listeners = []; const bounds = new maps.LatLngBounds();
  for (const stop of stops) {
    const position = point(stop.coordinates); if (!position) continue; bounds.extend(position);
    const marker = new maps.Marker({ map, position, title: `${stop.sequenceLabel} · ${stop.title}`, label: String(stop.sequenceLabel), zIndex: stop.nodeId === activeNodeId ? 10 : 1 });
    listeners.push(marker.addListener("click", () => onFocusNode?.(stop.nodeId))); markers.push({ stop, marker });
  }
  for (const leg of legs) {
    const path = leg.polyline.map(point).filter(Boolean); if (path.length < 2) continue;
    const polyline = new maps.Polyline({ map, path, strokeColor: color(leg.mode), strokeWeight: leg.legId === activeLegId ? 8 : 5, strokeOpacity: 0.85 });
    listeners.push(polyline.addListener("click", () => onFocusLeg?.(leg.legId))); paths.push({ leg, polyline });
  }
  map.fitBounds(bounds, 48);
  const observer = new ResizeObserver(() => maps.event.trigger(map, "resize")); observer.observe(container);
  return { kind: "google", zoomIn() { map.setZoom(map.getZoom() + 1); }, zoomOut() { map.setZoom(map.getZoom() - 1); }, updateFocus(nodeId, legId) { for (const { stop, marker } of markers) marker.setZIndex(stop.nodeId === nodeId ? 10 : 1); for (const { leg, polyline } of paths) polyline.setOptions({ strokeWeight: leg.legId === legId ? 8 : 5 }); },
    destroy() { observer.disconnect(); for (const listener of listeners) listener.remove(); for (const { marker } of markers) marker.setMap(null); for (const { polyline } of paths) polyline.setMap(null); maps.event.clearInstanceListeners(map); container.replaceChildren(); } };
}

export function createGoogleTilesRenderer({ container, stops, legs, onFocusNode, onFocusLeg, locale, region = "US", activeNodeId, activeLegId }) {
  const map = L.map(container, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  const pending = new Map(), controllers = new Set(); let timer = null, closed = false, attribution = "Google Maps";
  map.attributionControl.addAttribution(attribution);
  const Logo = L.Control.extend({ onAdd() { const box = L.DomUtil.create("div"); const logo = document.createElement("span"); logo.textContent = "Google Maps"; logo.setAttribute("translate", "no"); logo.style.cssText = "display:block;background:white;color:#1f1f1f;padding:5px 10px;font:400 12px sans-serif;white-space:nowrap"; box.append(logo); return box; } });
  new Logo({ position: "bottomleft" }).addTo(map);
  const flush = async () => {
    timer = null;
    if (closed || !pending.size) return;
    const batch = [...pending.values()].slice(0, 24); for (const item of batch) pending.delete(item.key);
    const controller = new AbortController(); controllers.add(controller);
    try {
      const bounds = map.getBounds();
      const result = await api.googleTiles({ tiles: batch.map(({ coords }) => ({ x: coords.x, y: coords.y, z: coords.z })), language: locale === "zh-CN" ? "zh-CN" : "en", region,
        viewport: { north: bounds.getNorth(), south: bounds.getSouth(), east: bounds.getEast(), west: bounds.getWest(), zoom: map.getZoom() } }, controller.signal);
      if (closed) return;
      map.attributionControl.removeAttribution(attribution);
      // Attribution is text supplied by Google, never executable HTML.
      const span = document.createElement("span"); span.textContent = result.attribution;
      attribution = span.innerHTML; map.attributionControl.addAttribution(attribution);
      for (const item of batch) {
        const tile = result.tiles.find(t => t.x === item.coords.x && t.y === item.coords.y && t.z === item.coords.z);
        if (!tile) item.done(new Error("google_tile_missing"), item.image);
        else { item.image.onload = () => item.done(null, item.image); item.image.src = `data:${tile.mimeType};base64,${tile.data}`; }
      }
    } catch (error) {
      for (const item of batch) item.done(error, item.image);
      container.setAttribute("data-map-status", "unavailable");
      let notice = container.querySelector(".google-map-error");
      if (!notice) { notice = document.createElement("button"); notice.type = "button"; notice.className = "google-map-error"; notice.style.cssText = "position:absolute;z-index:1000;top:12px;left:12px;background:white;padding:8px;border:1px solid #aaa"; notice.textContent = locale === "zh-CN" ? "地图加载失败 · 重试" : "Map unavailable · Retry"; notice.onclick = () => { notice.remove(); tiles.redraw(); }; container.append(notice); }
    }
    finally { controllers.delete(controller); if (pending.size && !closed) timer = setTimeout(flush, 50); }
  };
  const tiles = new (L.GridLayer.extend({ createTile(coords, done) {
    const image = document.createElement("img"); image.alt = ""; image.width = 256; image.height = 256; image.onerror = () => done(new Error("google_tile_unavailable"), image);
    const key = `${coords.z}:${coords.x}:${coords.y}`; pending.set(key, { key, coords, image, done });
    if (!timer) timer = setTimeout(flush, 50); return image;
  } }))({ maxZoom: 20, minZoom: 2, noWrap: true, keepBuffer: 1 });
  tiles.addTo(map);
  const markers = [], paths = [], bounds = [];
  for (const stop of stops) {
    const p = point(stop.coordinates); if (!p) continue; const latlng = [p.lat, p.lng]; bounds.push(latlng);
    const element = document.createElement("span"); element.textContent = String(stop.sequenceLabel);
    const tooltip = document.createElement("span"); tooltip.textContent = String(stop.title);
    const marker = L.marker(latlng, { icon: L.divIcon({ className: "trip-map-marker-shell", html: element, iconSize: [36, 36] }) }).addTo(map).bindTooltip(tooltip);
    marker.on("click", () => onFocusNode?.(stop.nodeId)); markers.push({ stop, marker });
  }
  for (const leg of legs) {
    const path = leg.polyline.map(point).filter(Boolean).map(p => [p.lat, p.lng]); if (path.length < 2) continue;
    const polyline = L.polyline(path, { color: color(leg.mode), weight: leg.legId === activeLegId ? 8 : 5 }).addTo(map); polyline.on("click", () => onFocusLeg?.(leg.legId)); paths.push({ leg, polyline });
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  const observer = new ResizeObserver(() => map.invalidateSize()); observer.observe(container);
  return { kind: "google-tiles", zoomIn() { map.zoomIn(); }, zoomOut() { map.zoomOut(); }, updateFocus(nodeId, legId) { for (const { marker, stop } of markers) marker.setZIndexOffset(stop.nodeId === nodeId ? 10 : 0); for (const { leg, polyline } of paths) polyline.setStyle({ weight: leg.legId === legId ? 8 : 5 }); },
    destroy() { closed = true; if (timer) clearTimeout(timer); for (const controller of controllers) controller.abort(); pending.clear(); observer.disconnect(); map.remove(); } };
}
