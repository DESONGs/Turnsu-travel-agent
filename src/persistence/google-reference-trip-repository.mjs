import { googlePlaceId, stripGoogleContent, containsGoogleContent } from "../../travel-agent-pi-package/src/core/provider-content.ts";

/** Decorates the existing repository; IDs, ownership, versions and CAS stay in that repository. */
export function withGoogleReferences(repository, google) {
  if (!google || google.status !== "configured") return repository;
  const enrich = async state => {
    if (!state) return state;
    const ids = new Set();
    const scan = value => { if (Array.isArray(value)) return value.forEach(scan); if (!value || typeof value !== "object") return; const id = googlePlaceId(value); if (id && value.domain) ids.add(id); Object.values(value).forEach(scan); };
    scan(state);
    if (!ids.size) return state;
    const facts = new Map();
    // Bound concurrent calls, without a durable or cross-request Google content cache.
    const pending = [...ids];
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) { const id = pending.shift(); try { const place = await google.placeDetails(id); facts.set(id, place); } catch { facts.set(id, null); } }
    }));
    const apply = value => {
      if (Array.isArray(value)) return value.map(apply);
      if (!value || typeof value !== "object") return value;
      const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, apply(item)]));
      const id = googlePlaceId(value), place = facts.get(id);
      if (id && place && value.domain) {
        const googleOnly = value.operability?.provider === "google_maps";
        const title = String(place.displayName?.text ?? "").slice(0, 200);
        if (googleOnly) { next.title = title; next.summary = String(place.formattedAddress ?? "").slice(0, 900); next.sourceStatus = "verified_provider"; }
        next.location = { ...value.location, name: title, address: place.formattedAddress, ...(place.location ? { coordinates: { longitude: place.location.longitude, latitude: place.location.latitude, coordinateSystem: "WGS-84" } } : {}) };
        next.operability = { ...next.operability, providerPoiId: id, contentRefreshRequired: false, googleMapsUri: place.googleMapsUri, attribution: "Google Maps", photos: (place.photos ?? []).slice(0, 4), accessibilityOptions: place.accessibilityOptions ?? null, openWeek: place.regularOpeningHours?.weekdayDescriptions?.join("; ") ?? "", businessStatus: place.businessStatus, checkedAt: google.clock().toISOString() };
      }
      if (value.provider === "google_maps" && value.contentItemId) { const found = facts.get(value.providerRef); if (found) { next.title = found.displayName?.text; next.checkedAt = google.clock().toISOString(); } }
      if (value.entityId && value.providerRefs?.some?.(r => String(r).startsWith("google_maps:"))) { const found = facts.get(value.providerRefs.find(r => r.startsWith("google_maps:")).slice(12)); if (found) next.canonicalName = found.displayName?.text ?? ""; }
      if (value.claimId && value.sourceRefs?.some?.(r => String(r).startsWith("google_maps:"))) { const found = facts.get(value.sourceRefs.find(r => r.startsWith("google_maps:")).slice(12)); if (found) { next.statement = String(found.formattedAddress ?? found.displayName?.text).slice(0, 1000); next.observedAt = google.clock().toISOString(); next.confidence = 0.9; } }
      return next;
    };
    const result = apply(state);
    const nodes = new Map(result.nodes.map(n => [n.nodeId, n]));
    const titles = value => { if (Array.isArray(value)) return value.forEach(titles); if (!value || typeof value !== "object") return; if (value.stopId && nodes.has(value.nodeId)) value.title = nodes.get(value.nodeId).title; Object.values(value).forEach(titles); };
    titles(result);
    return result;
  };
  return new Proxy(repository, { get(target, key) {
    if (key === "create" || key === "save") return async (state, options) => { const persisted = await target[key](stripGoogleContent(state), options); return { ...state, storageVersion: persisted.storageVersion }; };
    if (key === "get") return async id => enrich(await target.get(id));
    if (key === "list") return async () => target.list(); // Listings need references, not place details.
    if (key === "saveMobilityPreview" && target.saveMobilityPreview) return async (id, record, ...args) => target.saveMobilityPreview(id, stripGoogleContent(record), ...args);
    if (key === "getMobilityPreview" && target.getMobilityPreview) return async (...args) => { const record = await target.getMobilityPreview(...args); return record && containsGoogleContent(record) ? null : record; };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}
