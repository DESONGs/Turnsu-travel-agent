import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { destinationContext } from "../../travel-agent-pi-package/src/core/global-travel.ts";

const DOC = "https://developers.google.com/maps/ai/grounding-lite";
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const point = value => value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) ? { longitude: value.longitude, latitude: value.latitude, coordinateSystem: "WGS-84" } : null;
const id = value => /^[A-Za-z0-9_-]{1,200}$/.test(String(value)) ? String(value) : fail("invalid_google_place_id", 400);
const clean = (value, limit = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

export function decodeGooglePolyline(encoded) {
  const output = []; let index = 0, lat = 0, lng = 0;
  while (index < encoded.length && output.length < 20_000) {
    const number = () => { let result = 0, shift = 0, byte; do { if (index >= encoded.length || shift > 30) fail("invalid_route_geometry"); byte = encoded.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32); return result & 1 ? ~(result >> 1) : result >> 1; };
    lat += number(); lng += number(); output.push({ longitude: lng / 1e5, latitude: lat / 1e5, coordinateSystem: "WGS-84" });
  }
  return output;
}

export class GoogleMapsProvider {
  constructor({ apiKey, enabled = false, fetchImpl = fetch, clock = () => new Date(), groundingClient = null, timeoutMs = 20_000 } = {}) {
    this.apiKey = apiKey; this.enabled = enabled; this.fetchImpl = fetchImpl; this.clock = clock; this.timeoutMs = timeoutMs;
    this.groundingClient = groundingClient; this.regions = ["international"]; this.providerId = "google_maps";
    this.status = apiKey && enabled ? "configured" : "provider_unavailable";
  }
  async request(url, { method = "GET", body, fields, signal } = {}) {
    if (this.status !== "configured") fail(this.apiKey ? "google_maps_disabled" : "GOOGLE_MAPS_API_KEY_not_configured", 503);
    const parsed = new URL(url);
    if (!["places.googleapis.com", "routes.googleapis.com", "maps.googleapis.com", "tile.googleapis.com"].includes(parsed.hostname) || parsed.protocol !== "https:") fail("google_endpoint_not_allowed");
    const response = await this.fetchImpl(parsed, { method, headers: { "X-Goog-Api-Key": this.apiKey, ...(body ? { "Content-Type": "application/json" } : {}), ...(fields ? { "X-Goog-FieldMask": fields } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    if (!response.ok) fail(response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "AUTH_REQUIRED" : "SOURCE_UNAVAILABLE", response.status);
    return response.json();
  }
  async grounding(name, args) {
    if (!["search_places", "resolve_maps_urls", "resolve_names", "lookup_weather"].includes(name)) fail("google_tool_not_allowed");
    if (this.status !== "configured") fail("google_maps_not_configured", 503);
    if (this.groundingClient) return this.groundingClient.callTool({ name, arguments: args });
    const client = new Client({ name: "travel-agent", version: "0.2.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("https://mapstools.googleapis.com/mcp"), { requestInit: { headers: { "X-Goog-Api-Key": this.apiKey } }, fetch: this.fetchImpl }));
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      if (result.isError) fail("google_grounding_failed");
      return result;
    } finally { await client.close(); }
  }
  async searchPlaces(textQuery, { languageCode = "en", regionCode, signal, maxResultCount = 6 } = {}) {
    const data = await this.request("https://places.googleapis.com/v1/places:searchText", { method: "POST", body: { textQuery: clean(textQuery, 800), languageCode, maxResultCount, ...(regionCode ? { regionCode } : {}) },
      fields: "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.googleMapsUri,places.businessStatus,places.regularOpeningHours,places.accessibilityOptions,places.photos,places.attributions", signal });
    return data.places ?? [];
  }
  async placeDetails(placeId, languageCode = "en") {
    return this.request(`https://places.googleapis.com/v1/places/${id(placeId)}?languageCode=${encodeURIComponent(languageCode)}`, { fields: "id,displayName,formattedAddress,location,addressComponents,googleMapsUri,businessStatus,regularOpeningHours,accessibilityOptions,photos,attributions" });
  }
  async resolveDestination(brief) {
    const context = destinationContext(brief);
    if (context.countryCode && context.timeZone) return context;
    const places = await this.searchPlaces(brief.destination, { maxResultCount: 1, ...(context.countryCode ? { regionCode: context.countryCode } : {}) });
    const place = places[0]; if (!place?.location) fail("destination_not_resolved");
    const countryCode = place.addressComponents?.find(p => p.types?.includes("country"))?.shortText;
    if (!countryCode) fail("destination_country_unknown");
    if (context.countryCode && context.countryCode !== countryCode) fail("destination_country_conflict");
    const timezone = await this.request(`https://maps.googleapis.com/maps/api/timezone/json?location=${place.location.latitude},${place.location.longitude}&timestamp=${Math.floor(this.clock().getTime() / 1000)}&key=${encodeURIComponent(this.apiKey)}`);
    if (timezone.status !== "OK" || !timezone.timeZoneId) fail("destination_time_zone_unknown");
    return { countryCode, timeZone: timezone.timeZoneId, placeId: place.id, coordinates: point(place.location) };
  }
  async placeContext(place, signal) {
    const code = place.addressComponents?.find(p => p.types?.includes("country"))?.shortText;
    if (!place.location || !code) return { countryCode: code ?? null, timeZone: null };
    const zone = await this.request(`https://maps.googleapis.com/maps/api/timezone/json?location=${place.location.latitude},${place.location.longitude}&timestamp=${Math.floor(this.clock().getTime() / 1000)}&key=${encodeURIComponent(this.apiKey)}`, { signal });
    return { countryCode: code, timeZone: zone.status === "OK" ? zone.timeZoneId : null };
  }
  async research({ brief = {}, domains = ["food", "play", "stay"], criteria = {}, question, signal }) {
    const checkedAt = this.clock().toISOString(); const context = destinationContext(brief);
    const byDomain = { play: [], food: [], stay: [], transport: [] }; const errors = [];
    // Grounding preserves Google's source-bearing response; structured APIs serve the editor.
    let grounding = null;
    try { grounding = await this.grounding("search_places", { text_query: clean(`${brief.destination} ${question ?? "travel places"}`, 1000), language_code: brief.language ?? "en", ...(context.countryCode ? { region_code: context.countryCode } : {}) }); }
    catch (error) { errors.push({ code: error.code ?? "SOURCE_UNAVAILABLE", provider: "google_grounding_lite" }); }
    for (const domain of domains.filter(d => d !== "transport")) {
      try {
        const hints = criteria.byDomain?.[domain] ?? {};
        const query = [brief.destination, ...(hints.namedEntities ?? []), ...(hints.keywords ?? []), ({ food: "restaurants", stay: "hotels", play: "attractions" })[domain]].filter(Boolean).join(" ");
        const places = await this.searchPlaces(query, { languageCode: brief.language ?? "en", regionCode: context.countryCode, signal });
        byDomain[domain] = await Promise.all(places.map(async place => {
          const local = await this.placeContext(place, signal);
          const ref = `google_maps:${id(place.id)}`; const claimId = `claim_${hash(`${ref}:${checkedAt}`)}`; const entityId = `entity_${hash(ref)}`;
          const title = clean(place.displayName?.text); const summary = clean([place.formattedAddress, ...(place.regularOpeningHours?.weekdayDescriptions ?? [])].join(" · "), 900);
          return { candidateId: `${domain}_${hash(ref)}`, domain, title, summary, checkedAt, cost: 0, price: { amount: null, currency: brief.currency ?? context.localCurrency ?? "XXX", quality: "unknown", checkedAt },
            location: { name: title, address: clean(place.formattedAddress, 400), coordinates: point(place.location), countryCode: local.countryCode, timeZone: local.timeZone },
            media: [], sourceId: ref, claimId, entityId,
            source: { sourceId: ref, provider: "google_maps", sourceType: "official_map_provider", providerPoiId: place.id, sourceUrl: place.googleMapsUri, documentationUrl: DOC, checkedAt, independenceGroup: ref, commercialBias: "provider_ranking_unknown", attribution: "Google Maps", attributions: place.attributions ?? [], retention: { expiresAt: new Date(this.clock().getTime() + 86400_000).toISOString(), placeId: place.id } },
            entity: { entityId, kind: "place", canonicalName: title, providerRefs: [ref] },
            claim: { claimId, entityId, kind: "provider_fact", statement: summary || title, sourceRefs: [ref], sourceIndependence: "official_provider", commercialBias: "provider_ranking_unknown", confidence: 0.9, observedAt: checkedAt },
            operability: { provider: "google_maps", providerPoiId: place.id, sourceUrl: place.googleMapsUri, googleMapsUri: place.googleMapsUri, attribution: "Google Maps", countryCode: local.countryCode, timeZone: local.timeZone,
              photos: (place.photos ?? []).slice(0, 4).map(p => ({ name: p.name, authorAttributions: p.authorAttributions ?? [] })), accessibilityOptions: place.accessibilityOptions ?? null,
              openWeek: (place.regularOpeningHours?.weekdayDescriptions ?? []).join("; "), businessStatus: place.businessStatus, checkedAt, inventoryVerified: false,
              googleContentExpiresAt: new Date(this.clock().getTime() + 86400_000).toISOString() } };
        }));
      } catch (error) { errors.push({ code: error.code ?? "SOURCE_UNAVAILABLE", provider: "google_maps", domain }); }
    }
    return { schemaVersion: "travel-provider-result-v1", status: Object.values(byDomain).some(x => x.length) ? "completed" : errors.length ? "provider_unavailable" : "EMPTY_VERIFIED", provider: "google_maps", providerLabel: "Google Maps", destination: brief.destination, checkedAt, byDomain, errors, partial: errors.length > 0 || domains.includes("transport"), caveats: ["Google Maps place data does not establish bookable availability or a ticket price."], sourceDocumentation: DOC, fabricatedResults: false,
      grounding: grounding ? { ...grounding, attribution: "Google Maps", expiresAt: new Date(this.clock().getTime() + 86400_000).toISOString() } : null };
  }
  async route(origin, destination, mode, { departureTime, signal } = {}) {
    const travelMode = ({ walk: "WALK", transit: "TRANSIT", drive: "DRIVE", bicycle: "BICYCLE" })[mode];
    if (!travelMode) fail("unsupported_google_travel_mode");
    const waypoint = place => place.placeId ? { placeId: id(place.placeId) } : { location: { latLng: { latitude: place.coordinates.latitude, longitude: place.coordinates.longitude } } };
    const data = await this.request("https://routes.googleapis.com/directions/v2:computeRoutes", { method: "POST", body: { origin: waypoint(origin), destination: waypoint(destination), travelMode, computeAlternativeRoutes: true,
      ...(departureTime && mode === "transit" ? { departureTime: new Date(departureTime).toISOString() } : {}) }, fields: "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps,routes.travelAdvisory.transitFare", signal });
    return (data.routes ?? []).map((route, index) => {
      const steps = (route.legs ?? []).flatMap(l => l.steps ?? []);
      const fare = route.travelAdvisory?.transitFare;
      const fareAmount = fare ? Number(fare.units ?? 0) + Number(fare.nanos ?? 0) / 1e9 : null;
      return { alternativeId: `google_${mode}_${hash(JSON.stringify([origin, destination, route.polyline, index]))}`, mode, totalMinutes: Number.parseFloat(route.duration) / 60, distanceMeters: route.distanceMeters ?? null,
        walkingMeters: mode === "walk" ? route.distanceMeters ?? null : mode === "transit" ? steps.filter(s => s.travelMode === "WALK").reduce((sum, s) => sum + (s.distanceMeters ?? 0), 0) : 0,
        transfers: mode === "transit" ? Math.max(0, steps.filter(s => s.transitDetails).length - 1) : 0, estimatedFareCny: fare?.currencyCode === "CNY" ? fareAmount : null,
        fare: fare ? { amount: fareAmount, currency: fare.currencyCode, quality: "estimate" } : null,
        scheduleBasis: mode === "transit" ? "scheduled_service" : "query_time_estimate", realTimeArrival: false,
        navigationUrl: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin.label)}&destination=${encodeURIComponent(destination.label)}&travelmode=${({ walk: "walking", transit: "transit", drive: "driving", bicycle: "bicycling" })[mode]}`,
        polyline: decodeGooglePolyline(route.polyline?.encodedPolyline ?? ""), steps: steps.map(step => ({
          kind: step.travelMode === "WALK" ? "walk" : step.travelMode === "TRANSIT" ? "ride" : "drive",
          instruction: clean(step.navigationInstruction?.instructions ?? step.transitDetails?.transitLine?.name ?? travelMode, 500),
          line: step.transitDetails?.transitLine?.nameShort ?? step.transitDetails?.transitLine?.name ?? null,
          origin: step.transitDetails?.stopDetails?.departureStop?.name ?? null, destination: step.transitDetails?.stopDetails?.arrivalStop?.name ?? null,
          durationMinutes: step.staticDuration ? Number.parseFloat(step.staticDuration) / 60 : null, distanceMeters: step.distanceMeters ?? null,
          polyline: decodeGooglePolyline(step.polyline?.encodedPolyline ?? ""), walkType: null, accessibilityFeatures: [],
        })), accessibilityFeatures: [],
        accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false }, sourceRefs: ["google_routes"], checkedAt: this.clock().toISOString() };
    }).filter(route => Number.isFinite(route.totalMinutes));
  }
  async planMobility({ brief = {}, travelers = [], selectedNodes = [], itineraryStops = [], signal }) {
    const nodes = new Map(selectedNodes.map(n => [n.nodeId, n])); const unresolved = [];
    const visits = itineraryStops.length ? itineraryStops : selectedNodes.map(n => ({ nodeId: n.nodeId, stopId: n.nodeId, title: n.title }));
    const places = [];
    for (const visit of visits) {
      const node = nodes.get(visit.nodeId);
      const endpoint = node?.operability?.[visit.role === "transport_departure" ? "departurePlace" : "arrivalPlace"];
      let coordinates = endpoint?.coordinates ?? node?.location?.coordinates;
      if (!coordinates && node) {
        try { const found = (await this.searchPlaces(`${endpoint?.label ?? node.title} ${endpoint?.city ?? brief.destination ?? ""}`, { regionCode: endpoint?.countryCode ?? node.location?.countryCode ?? brief.countryCode, maxResultCount: 1, signal }))[0]; coordinates = point(found?.location); }
        catch { /* Keep this visit unresolved; never connect the neighbors across a missing stop. */ }
      }
      if (!coordinates || coordinates.coordinateSystem !== "WGS-84") { unresolved.push(visit.nodeId); continue; }
      places.push({ nodeId: visit.nodeId, stopId: visit.stopId, label: endpoint?.label ?? visit.title ?? node.title, coordinates, role: visit.role ?? null, ...(visit.dayIndex ? { dayIndex: visit.dayIndex } : {}), ...(visit.date ? { date: visit.date } : {}), startAt: visit.startAt ?? null, endAt: visit.endAt ?? null });
    }
    const legs = []; const errors = [];
    for (let index = 1; index < places.length; index++) {
      const origin = places[index - 1], destination = places[index];
      if (visits.findIndex(v => v.stopId === destination.stopId) !== visits.findIndex(v => v.stopId === origin.stopId) + 1) continue;
      if (origin.nodeId === destination.nodeId && origin.role === "transport_departure" && destination.role === "transport_arrival") continue;
      if (origin.dayIndex && destination.dayIndex && origin.dayIndex !== destination.dayIndex) continue;
      const modes = ["walk", "transit", "drive", ...(brief.localMobilityModes?.includes("bicycle") ? ["bicycle"] : [])];
      const settled = await Promise.allSettled(modes.map(mode => this.route(origin, destination, mode, { departureTime: origin.endAt ?? undefined, signal })));
      const alternatives = settled.flatMap(r => r.status === "fulfilled" ? r.value : []);
      errors.push(...settled.filter(r => r.status === "rejected").map(r => r.reason.code ?? "SOURCE_UNAVAILABLE"));
      const walkingLimit = Math.min(...travelers.map(t => t.careNeeds?.mobility?.maxContinuousWalkMeters).filter(Number.isFinite), Infinity);
      const transferLimit = Math.min(...travelers.map(t => t.careNeeds?.mobility?.maxTransfers).filter(Number.isFinite), Infinity);
      const recommended = alternatives.find(a => a.mode === "transit" && (a.walkingMeters ?? Infinity) <= walkingLimit && (a.transfers ?? Infinity) <= transferLimit)
        ?? alternatives.find(a => a.mode === "walk" && (a.walkingMeters ?? Infinity) <= walkingLimit)
        ?? (brief.vehicle ? alternatives.find(a => a.mode === "drive") : null) ?? alternatives.find(a => a.mode === "transit") ?? alternatives[0];
      if (!recommended) { unresolved.push(destination.nodeId); continue; }
      legs.push({ legId: `google_leg_${hash(`${origin.stopId}:${destination.stopId}`)}`, origin, destination, recommendedMode: recommended.mode, selectedAlternativeId: recommended.alternativeId,
        rationale: `Google Maps · ${Math.round(recommended.totalMinutes)} min · ${recommended.mode}. Accessibility continuity is not verified.`, alternatives });
    }
    const checkedAt = this.clock().toISOString();
    return { schemaVersion: "trip-mobility-v1", status: unresolved.length || errors.length ? "partial" : "completed", destination: brief.destination ?? null, source: "google_routes", checkedAt, freshUntil: new Date(this.clock().getTime() + 15 * 60_000).toISOString(),
      coverage: { routedNodeIds: [...new Set(places.map(p => p.nodeId))], unresolvedNodeIds: [...new Set(unresolved)], routedStopIds: places.map(p => p.stopId), unresolvedStopIds: [], unscheduled: !itineraryStops.length }, legs, itinerary: null, feasibility: null,
      travelerFit: { constrainedTravelerIds: travelers.filter(t => t.careNeeds).map(t => t.travelerId), accessibilityEvidence: "unverified" }, reason: unresolved.length ? "route_or_location_unresolved" : null,
      caveats: ["Google Maps attribution applies. Driving directions do not establish taxi availability or fare.", ...(errors.length ? ["Some travel modes could not be verified."] : [])], sourceDocumentation: "https://developers.google.com/maps/documentation/routes", fabricatedResults: false };
  }
  async tiles({ tiles, language = "en", region = "US", viewport }) {
    if (!Array.isArray(tiles) || tiles.length > 24 || !tiles.length) fail("invalid_tile_batch", 400);
    const session = await this.request(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(this.apiKey)}`, { method: "POST", body: { mapType: "roadmap", language, region } });
    if (!session.session) fail("google_tile_session_failed");
    const results = await Promise.all(tiles.map(async tile => {
      const { x, y, z } = tile;
      if (![x, y, z].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) fail("invalid_map_tile", 400);
      const response = await this.fetchImpl(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(this.apiKey)}`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
      if (!response.ok) fail(response.status === 429 ? "RATE_LIMITED" : "SOURCE_UNAVAILABLE", response.status);
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 1_000_000) fail("map_tile_too_large");
      return { x, y, z, data: bytes.toString("base64"), mimeType: response.headers.get("content-type") ?? "image/png", cacheControl: response.headers.get("cache-control") ?? "no-store" };
    }));
    const info = viewport && ["north", "south", "east", "west", "zoom"].every(k => Number.isFinite(viewport[k]))
      ? await this.request(`https://tile.googleapis.com/tile/v1/viewport?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(this.apiKey)}&${new URLSearchParams(viewport)}`) : null;
    return { tiles: results, attribution: info?.copyright ?? "Google Maps", reportProblemLink: info?.reportProblemLink ?? null };
  }
}

export function createGoogleMapsProvider(env = process.env, options = {}) {
  return new GoogleMapsProvider({ apiKey: env.GOOGLE_MAPS_API_KEY, enabled: env.TRAVEL_AGENT_GOOGLE_MAPS_ENABLED === "true" && env.TRAVEL_AGENT_GOOGLE_MAPS_DATA_POLICY === "approved", ...options });
}
