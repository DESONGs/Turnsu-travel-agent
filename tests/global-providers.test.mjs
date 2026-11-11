import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleMapsProvider } from "../src/providers/google-maps.mjs";
import { SkyscannerProvider, ViatorProvider } from "../src/providers/global-inventory.mjs";
import { CompositeTravelResearchProvider } from "../src/providers/travel-research-provider.mjs";
import { normalizeTripMobility } from "../travel-agent-pi-package/src/contracts/mobility.ts";
import { createTripControlState, TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { googleSafeDurableValue, stripGoogleContent } from "../travel-agent-pi-package/src/core/provider-content.ts";
import { withGoogleReferences } from "../src/persistence/google-reference-trip-repository.mjs";
import { transportFacts } from "../travel-agent-pi-package/src/core/journey-execution.ts";

// API contract fixtures, never evidence of live inventory or native-host acceptance.
const clock = () => new Date("2026-10-26T04:00:00Z");
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const place = { id: "fixture_place", displayName: { text: "Contract Museum" }, formattedAddress: "Contract address", location: { latitude: 35.65, longitude: 139.75 }, addressComponents: [{ types: ["country"], shortText: "JP" }], googleMapsUri: "https://www.google.com/maps/place/?q=place_id:fixture_place", photos: [{ name: "places/fixture_place/photos/fixture_photo", authorAttributions: [{ displayName: "Fixture author", uri: "https://www.google.com/maps/contrib/fixture" }] }] };
const routes = { routes: [{
  duration: "600s", distanceMeters: 700, polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
  travelAdvisory: { transitFare: { currencyCode: "JPY", units: "250", nanos: 0 } },
  legs: [{ steps: [
    { travelMode: "WALK", distanceMeters: 100, staticDuration: "60s", navigationInstruction: { instructions: "Walk to station" } },
    { travelMode: "TRANSIT", staticDuration: "540s", transitDetails: { transitLine: { name: "Fixture line", nameShort: "F" }, stopDetails: { departureStop: { name: "A" }, arrivalStop: { name: "B" } } } },
  ] }],
}] };

function googleFixture() {
  const calls = [];
  const google = new GoogleMapsProvider({ apiKey: "test-only", enabled: true, clock, groundingClient: { callTool: async input => { calls.push(input); return { content: [{ type: "text", text: "Google Maps contract fixture" }] }; } }, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, fields: init.headers?.["X-Goog-FieldMask"] });
    if (String(url).includes("timezone")) return json({ status: "OK", timeZoneId: "Asia/Tokyo" });
    if (String(url).includes(":searchText")) return json({ places: [place] });
    if (String(url).includes("computeRoutes")) return json(routes);
    if (String(url).startsWith("https://places.googleapis.com/v1/places/")) return json(place);
    throw new Error("Unexpected contract URL");
  } });
  return { google, calls };
}

test("Google research and Routes cross the real normalization boundary without changing WGS-84, fare currency or transit steps", async () => {
  const { google, calls } = googleFixture();
  const result = await google.research({ brief: { destination: "Tokyo", countryCode: "JP", timeZone: "Asia/Tokyo", currency: "USD" }, domains: ["play"] });
  assert.equal(calls[0].name, "search_places"); assert.ok(calls[0].arguments.text_query);
  const candidate = result.byDomain.play[0]; assert.equal(candidate.price.amount, null); assert.equal(candidate.operability.inventoryVerified, false);
  assert.equal(candidate.location.coordinates.coordinateSystem, "WGS-84"); assert.equal(candidate.location.countryCode, "JP"); assert.equal(candidate.operability.timeZone, "Asia/Tokyo");
  const endpoint = { nodeId: "a", stopId: "a1", label: "A", coordinates: candidate.location.coordinates };
  const alternatives = await google.route(endpoint, { ...endpoint, nodeId: "b", stopId: "b1", label: "B" }, "transit");
  const normalized = normalizeTripMobility({ status: "completed", source: "google_routes", sourceDocumentation: "https://developers.google.com/maps/documentation/routes", legs: [{ legId: "l", origin: endpoint, destination: { ...endpoint, nodeId: "b" }, recommendedMode: "transit", rationale: "Fixture comparison", alternatives }] });
  const route = normalized.legs[0].alternatives[0];
  assert.equal(normalized.legs[0].origin.coordinates.coordinateSystem, "WGS-84"); assert.equal(route.polyline[0].coordinateSystem, "WGS-84");
  assert.equal(route.estimatedFareCny, null); assert.deepEqual(route.fare, { amount: 250, currency: "JPY", quality: "estimate" });
  assert.equal(route.steps[1].line, "F"); assert.equal(route.steps[1].origin, "A"); assert.equal(route.realTimeArrival, false);
  await assert.rejects(google.route(endpoint, endpoint, "taxi"), /unsupported_google/);
  await assert.rejects(google.request("https://attacker.example/steal"), /endpoint_not_allowed/);
});

test("mixed mainland and overseas visits select the provider for each leg and do not drive a scheduled border crossing", async () => {
  const calls = [];
  const provider = (name, regions) => ({ status: "configured", regions, async planMobility(input) { calls.push([name, input.itineraryStops.map(s => s.stopId)]); return { status: "completed", legs: [{ legId: name, origin: { nodeId: input.itineraryStops[0].nodeId, stopId: input.itineraryStops[0].stopId }, destination: { nodeId: input.itineraryStops[1].nodeId, stopId: input.itineraryStops[1].stopId } }], coverage: {}, travelerFit: {}, caveats: [] }; } });
  const composite = new CompositeTravelResearchProvider({ providers: [provider("amap", ["CN"]), provider("google", ["international"])], clock });
  const visits = [ ["a", "CN", "activity"], ["flight", "CN", "transport_departure"], ["flight", "JP", "transport_arrival"], ["b", "JP", "activity"] ].map(([nodeId, country, role], i) => ({ nodeId, country, role, stopId: `s${i}`, dayIndex: 1 }));
  const selectedNodes = [{ nodeId: "a", location: { countryCode: "CN" } }, { nodeId: "b", location: { countryCode: "JP" } }, { nodeId: "flight", operability: { departurePlace: { countryCode: "CN" }, arrivalPlace: { countryCode: "JP" } } }];
  const result = await composite.planMobility({ brief: { destination: "Tokyo", countryCode: "JP" }, selectedNodes, itineraryStops: visits });
  assert.deepEqual(calls, [["amap", ["s0", "s1"]], ["google", ["s2", "s3"]]]); assert.equal(result.legs.length, 2);
});

test("durable Google state keeps visit identity and arrangements, removes raw details, and refreshes after a repository restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "google-reference-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { google } = googleFixture();
  const base = new TripStore({ rootDir: root }), store = withGoogleReferences(base, google);
  const state = createTripControlState({ tripId: "global_trip", brief: { destination: "Tokyo", countryCode: "JP", timeZone: "Asia/Tokyo", currency: "USD" }, clock });
  const record = { nodeId: "museum", domain: "play", title: "Contract Museum", summary: "Contract address", selected: false, status: "candidate", sourceRefs: ["google_maps:fixture_place"], claimRefs: [], sourceStatus: "verified_provider", kind: "place", lock: null, offerRef: null, foreignGuestEligible: null, travelerIds: [], impactsNodeIds: [], spoilerLevel: "low", time: null, location: { coordinates: { latitude: 35.65, longitude: 139.75, coordinateSystem: "WGS-84" }, countryCode: "JP", timeZone: "Asia/Tokyo" }, media: [], price: { amount: null, currency: "USD", quality: "unknown" }, cost: 0, operability: { provider: "google_maps", providerPoiId: "fixture_place", photos: place.photos }, version: 1, updatedAt: clock().toISOString() };
  state.nodes.push(record);
  await store.create(state);
  const raw = await readFile(base.pathFor(state.tripId), "utf8"); assert.doesNotMatch(raw, /Contract Museum|Contract address|fixture_photo|139\.75/); assert.match(raw, /fixture_place/);
  const reopened = await withGoogleReferences(new TripStore({ rootDir: root }), google).get(state.tripId);
  assert.equal(reopened.nodes[0].nodeId, "museum"); assert.equal(reopened.nodes[0].title, "Contract Museum"); assert.equal(reopened.nodes[0].location.coordinates.coordinateSystem, "WGS-84");
  const saved = await store.save({ ...reopened, revision: reopened.revision + 1 }, { expectedStorageVersion: reopened.storageVersion });
  assert.equal(saved.storageVersion, 1); assert.equal((await base.get(state.tripId)).revision, 1);
  const noSource = await withGoogleReferences(base, { status: "configured", placeDetails: async () => { throw new Error("offline"); } }).get(state.tripId);
  assert.equal(noSource.nodes[0].operability.contentRefreshRequired, true); assert.equal(noSource.nodes[0].location.coordinates, undefined);
});

test("Google payloads do not survive nested tool receipts, model checkpoints or conversation backups", () => {
  const checkpoint = { schemaVersion: "travel-agent-session-v1", entries: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Contract Museum" }, { type: "toolCall", id: "call", name: "research_trip_options", arguments: {} }] } }, { type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: JSON.stringify({ status: "proposed", tripId: "t", byDomain: { play: [{ domain: "play", title: "Contract Museum", operability: { provider: "google_maps", providerPoiId: "fixture_place" } }] } }) }] } }] };
  const value = googleSafeDurableValue({ checkpoint, conversation: { usesGoogleMaps: true, messages: [{ role: "user", text: "My own requirement" }, { role: "assistant", text: "Contract Museum is here" }] } });
  assert.doesNotMatch(JSON.stringify(value), /Contract Museum/); assert.match(JSON.stringify(value), /My own requirement/); assert.match(JSON.stringify(value), /toolCall/); assert.match(JSON.stringify(value), /sourceRefreshRequired/);
  assert.deepEqual(stripGoogleContent({ brief: { destinationContext: { placeId: "p", coordinates: place.location } } }).brief.destinationContext, { placeId: "p" });
});

test("Skyscanner polls partial results, decodes real price units and uses each airport's time zone", async () => {
  const calls = [];
  const provider = new SkyscannerProvider({ apiKey: "fixture", enabled: true, clock, pollIntervalMs: 0, resolvePlaceContext: async p => ({ timeZone: p.name === "Tokyo" ? "Asia/Tokyo" : "America/Los_Angeles", countryCode: p.name === "Tokyo" ? "JP" : "US" }), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push([String(url), body]);
    if (String(url).includes("autosuggest")) return json({ places: [{ entityId: body.query.searchTerm, name: body.query.searchTerm }] });
    if (String(url).endsWith("/create")) return json({ sessionToken: "fixture_session", status: "RESULT_STATUS_INCOMPLETE", content: { results: {} } });
    return json({ sessionToken: "fixture_session", status: "RESULT_STATUS_COMPLETE", content: { results: { places: { a: { name: "Tokyo" }, b: { name: "Los Angeles" } }, legs: { l: { originPlaceId: "a", destinationPlaceId: "b", departureDateTime: { year: 2027, month: 1, day: 12, hour: 17, minute: 0 }, arrivalDateTime: { year: 2027, month: 1, day: 12, hour: 10, minute: 0 }, durationInMinutes: 600 } }, itineraries: { i: { legIds: ["l"], pricingOptions: [{ price: { amount: "125000000", unit: "PRICE_UNIT_MICRO" }, items: [{ deepLink: "https://www.skyscanner.com/transport/fixture" }] }] } } } } });
  } });
  const result = await provider.research({ brief: { origin: "Tokyo", destination: "Los Angeles", dates: "2027-01-12", countryCode: "US", currency: "USD", market: "US", party: { adults: 1, childrenAges: [] } }, domains: ["transport"] });
  const flight = result.byDomain.transport[0]; assert.equal(flight.price.amount, 125); assert.equal(flight.price.unit, "per_booking");
  assert.equal(flight.operability.departureAt, "2027-01-12T17:00:00+09:00"); assert.equal(flight.operability.arrivalAt, "2027-01-12T10:00:00-08:00");
  assert.equal(transportFacts({ ...flight, nodeId: "flight", sourceRefs: [flight.sourceId] }).valid, true);
  assert.ok(calls.some(([url]) => url.includes("/poll/")));
  const missing = await provider.research({ brief: { destination: "Tokyo", dates: "2027-01-12", currency: "USD" } }); assert.equal(missing.status, "needs_context");
});

test("Skyscanner stay and car hire parse their separate contracts; Viator basic access cannot claim dated availability", async () => {
  const calls = [];
  const provider = new SkyscannerProvider({ apiKey: "fixture", enabled: true, clock, pollIntervalMs: 0, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push([String(url), body]);
    if (String(url).includes("autosuggest")) return json({ places: [{ entityId: "city", name: "Tokyo" }] });
    if (String(url).includes("hotels")) return json({ sessionToken: "stay", status: "completed", content: { results: { hotelContent: { hotel: { hotelName: "Contract hotel" } }, hotelsPricingOptions: { quote: { hotelId: "hotel", roomName: "Contract room", deeplink: "https://www.skyscanner.com/hotels/fixture", price: { currency: "USD", price: 120, basePrice: 100, taxesAndFees: [{ feeType: "TAX", value: 20 }] } } } } } });
    return json({ sessionToken: "car", status: "RESULT_STATUS_COMPLETE", content: { results: { quotes: { quote: { vehicleName: "Contract car", price: { amount: "25000", unit: "PRICE_UNIT_CENTI" }, deeplinkUrl: "https://www.skyscanner.com/carhire/fixture", sippCode: "ECMR" } } } } });
  } });
  const result = await provider.research({ brief: { destination: "Tokyo", countryCode: "JP", dates: "2027-01-12 to 2027-01-14", market: "US", currency: "USD", party: { adults: 2, childrenAges: [], rooms: 1 }, carHire: { pickUpAt: "2027-01-12T10:00", dropOffAt: "2027-01-14T10:00", driverAge: 40 } } });
  assert.equal(result.byDomain.stay[0].price.amount, 120); assert.equal(result.byDomain.stay[0].price.taxStatus, "excludes_some_taxes_or_fees"); assert.equal(result.byDomain.transport[0].price.amount, 250); assert.equal(result.byDomain.transport[0].operability.seats, null);
  assert.equal(calls.find(([url]) => url.includes("hotels"))[1].initialPageSize, 12);
  const viator = new ViatorProvider({ apiKey: "fixture", enabled: true, clock });
  await assert.rejects(viator.checkAvailability({ productCode: "test", travelDate: "2027-01-12", currency: "USD", paxMix: [{ ageBand: "ADULT", numberOfTravelers: 1 }] }), /not_authorized/);
});
