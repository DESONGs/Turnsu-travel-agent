import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { localDateTime } from "../../travel-agent-pi-package/src/core/global-travel.ts";

const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const money = price => {
  const amount = Number(price?.amount);
  const multiplier = ({ PRICE_UNIT_MICRO: 1e6, PRICE_UNIT_MILLI: 1000, PRICE_UNIT_CENTI: 100, PRICE_UNIT_WHOLE: 1 })[price?.unit];
  return Number.isFinite(amount) && amount >= 0 && multiplier ? amount / multiplier : null;
};
const https = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null; } catch { return null; } };
const date = value => { const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? { year: +m[1], month: +m[2], day: +m[3] } : null; };
const asArray = value => Array.isArray(value) ? value : Object.values(value ?? {});

function candidate({ provider, domain, ref, title, summary, amount, currency, checkedAt, bookingUrl, location = null, operability = {}, basis = "trip_total", unit = "per_booking", taxStatus = "unknown", taxesAndFees = [] }) {
  const sourceId = `${provider}:${hash(ref)}`, entityId = `entity_${hash(sourceId)}`, claimId = `claim_${hash(`${sourceId}:${checkedAt}`)}`;
  return { candidateId: `${domain}_${hash(ref)}`, domain, title: String(title).slice(0, 200), summary: String(summary ?? "").slice(0, 900), checkedAt,
    cost: amount ?? 0, price: { amount, currency, unit, quantity: 1, taxStatus, taxesAndFees, quality: amount == null ? "unknown" : "reference", basis, checkedAt }, location, media: [], sourceId, entityId, claimId,
    source: { sourceId, provider, providerRef: String(ref).slice(0, 128), sourceType: "official_ota_search", sourceUrl: bookingUrl, checkedAt, independenceGroup: sourceId, commercialBias: "ota_commercial_inventory" },
    entity: { entityId, kind: domain === "transport" ? "transport_offer" : "place", canonicalName: String(title).slice(0, 200), providerRefs: [sourceId] },
    claim: { claimId, entityId, kind: "provider_fact", statement: String(summary || title).slice(0, 1000), sourceRefs: [sourceId], sourceIndependence: "single_provider", commercialBias: "ota_commercial_inventory", confidence: 0.9, observedAt: checkedAt },
    operability: { provider, providerRef: ref, bookingUrl, inventoryVerified: amount != null, checkedAt, ...operability } };
}

export class SkyscannerProvider {
  constructor({ apiKey, enabled = false, fetchImpl = fetch, clock = () => new Date(), pollIntervalMs = 1000, maxPolls = 12, resolvePlaceContext = null } = {}) {
    this.resolvePlaceContext = resolvePlaceContext;
    this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.clock = clock; this.pollIntervalMs = pollIntervalMs; this.maxPolls = maxPolls;
    this.status = apiKey && enabled ? "configured" : "provider_unavailable"; this.providerId = "skyscanner"; this.regions = ["international"];
  }
  async request(path, body, signal) {
    if (this.status !== "configured") fail("SKYSCANNER_API_KEY_not_configured");
    const response = await this.fetchImpl(`https://partners.api.skyscanner.net/apiservices/${path}`, { method: "POST", headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) fail(response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "AUTH_REQUIRED" : "SOURCE_UNAVAILABLE");
    return response.json();
  }
  async search(vertical, query, signal) {
    if (!["v3/flights", "v1/hotels", "v1/carhire"].includes(vertical)) fail("inventory_vertical_not_allowed");
    let payload = await this.request(`${vertical}/live/search/create`, { query, ...(vertical === "v1/hotels" ? { initialPageSize: 12 } : {}) }, signal);
    if (!payload.sessionToken) fail("SOURCE_CHANGED");
    const token = String(payload.sessionToken);
    if (!/^[A-Za-z0-9._~-]{1,4096}$/.test(token)) fail("SOURCE_CHANGED");
    for (let i = 0; i < this.maxPolls && !["RESULT_STATUS_COMPLETE", "completed"].includes(payload.status); i++) {
      await delay(this.pollIntervalMs, undefined, { signal });
      const next = await this.request(`${vertical}/live/search/poll/${encodeURIComponent(token)}`, vertical.includes("hotels") ? { pagination: { limit: 12, offset: 0 } } : {}, signal);
      if (next.action === "RESULT_ACTION_NOT_MODIFIED") { payload = { ...payload, status: next.status }; continue; }
      const results = { ...(payload.content?.results ?? {}) };
      for (const [key, value] of Object.entries(next.content?.results ?? {})) results[key] = next.action === "RESULT_ACTION_REPLACED" ? value : { ...results[key], ...value };
      payload = { ...payload, ...next, content: { ...payload.content, ...next.content, results } };
    }
    return { payload, partial: !["RESULT_STATUS_COMPLETE", "completed"].includes(payload.status) };
  }
  async place(text, market, locale, signal) {
    const result = await this.request("v3/autosuggest/flights", { query: { market, locale, searchTerm: text, includedEntityTypes: ["PLACE_TYPE_CITY", "PLACE_TYPE_AIRPORT"] } }, signal);
    const place = result.places?.[0];
    if (!place?.entityId) fail("inventory_location_not_resolved");
    return place;
  }
  async research({ brief = {}, travelers = [], domains = ["stay", "transport"], signal }) {
    const byDomain = { play: [], food: [], stay: [], transport: [] }, errors = [];
    const checkedAt = this.clock().toISOString(), dates = String(brief.dates ?? "").match(/20\d{2}-\d{2}-\d{2}/g) ?? [];
    const currency = brief.currency;
    const market = brief.market === "GB" ? "UK" : brief.market;
    const locale = brief.language === "zh-CN" ? "zh-CN" : brief.locale ?? "en-GB";
    const adults = brief.party?.adults ?? (travelers.length && travelers.every(t => t.ageBand === "adult") ? travelers.length : null);
    const childrenAges = brief.party?.childrenAges ?? [];
    if (!currency || !market || !adults || !dates[0]) return { status: "needs_context", provider: "skyscanner", byDomain, reason: "dates_party_market_currency_required", fabricatedResults: false };
    let partial = false;
    const destination = await this.place(brief.destination, market, locale, signal);
    if (domains.includes("transport") && brief.origin) {
      const journeys = brief.journeys?.filter(j => j.scope === "plan" && [undefined, "flight", "flexible"].includes(j.mode))
        ?? [{ journeyId: "outbound", origin: brief.origin, destination: brief.destination, date: dates[0], purpose: "outbound" }, ...(dates[1] && brief.returnRequired === true ? [{ journeyId: "return", origin: brief.destination, destination: brief.origin, date: dates[1], purpose: "return" }] : [])];
      for (const journey of journeys.slice(0, 12)) try {
        const [origin, arrivalCity] = await Promise.all([this.place(journey.origin, market, locale, signal), this.place(journey.destination, market, locale, signal)]);
        const search = await this.search("v3/flights", { market, locale, currency, queryLegs: [{ originPlaceId: { entityId: origin.entityId }, destinationPlaceId: { entityId: arrivalCity.entityId }, date: date(journey.date) }], adults, childrenAges, cabinClass: "CABIN_CLASS_ECONOMY" }, signal);
        partial ||= search.partial;
        const results = search.payload.content?.results;
        if (!results?.itineraries) fail("SOURCE_CHANGED");
        const contexts = new Map();
        const context = async place => {
          if (place?.timeZone) return { timeZone: place.timeZone, countryCode: place.countryCode };
          if (!this.resolvePlaceContext || !place) return {};
          const key = place.iata ?? place.entityId ?? place.name;
          if (!contexts.has(key)) contexts.set(key, this.resolvePlaceContext(place).catch(() => ({})));
          return contexts.get(key);
        };
        const candidates = await Promise.all(Object.entries(results.itineraries).slice(0, 6).map(async ([ref, item]) => {
          const options = asArray(item.pricingOptions).map(o => ({ ...o, amount: money(o.price) })).filter(o => o.amount != null).sort((a, b) => a.amount - b.amount);
          const option = options[0], leg = results.legs?.[item.legIds?.[0]];
          const departure = results.places?.[leg?.originPlaceId], arrival = results.places?.[leg?.destinationPlaceId];
          const [departureContext, arrivalContext] = await Promise.all([context(departure), context(arrival)]);
          const stamp = d => d ? `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T${String(d.hour ?? 0).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")}:00` : null;
          const departureAt = departureContext.timeZone ? localDateTime(stamp(leg?.departureDateTime), null, departureContext.timeZone) : stamp(leg?.departureDateTime);
          const arrivalAt = arrivalContext.timeZone ? localDateTime(stamp(leg?.arrivalDateTime), null, arrivalContext.timeZone) : stamp(leg?.arrivalDateTime);
          return candidate({ provider: "skyscanner", domain: "transport", ref: `${journey.journeyId}_${ref}`, title: `${departure?.name ?? origin.name} → ${arrival?.name ?? arrivalCity.name}`, summary: `${leg?.durationInMinutes ?? "?"} min · ${journey.date}`, amount: option?.amount ?? null, currency, checkedAt, bookingUrl: https(option?.items?.[0]?.deepLink ?? item.deepLink),
            operability: { transportType: "FLIGHT", mobilityRole: "intercity_inventory", inventoryUsability: option ? "available" : "unknown", departureAt, arrivalAt, durationMinutes: leg?.durationInMinutes,
              departurePlace: { kind: "airport", label: departure?.name ?? origin.name, city: journey.origin, ...departureContext }, arrivalPlace: { kind: "airport", label: arrival?.name ?? arrivalCity.name, city: journey.destination, ...arrivalContext },
              departureTimeZone: departureContext.timeZone ?? null, arrivalTimeZone: arrivalContext.timeZone ?? null, inventoryVerified: Boolean(option), fareScope: "one_way_party", scheduleVerified: Boolean(departureContext.timeZone && arrivalContext.timeZone && departureAt && arrivalAt), journeyId: journey.journeyId, journeyPurpose: journey.purpose, departureCity: journey.origin, arrivalCity: journey.destination, serviceDate: journey.date,
              sourceLegs: item.legIds?.map(id => results.legs?.[id]).filter(Boolean) ?? [], priceParty: { adults, childrenAges } } });
        }));
        byDomain.transport.push(...candidates);
      } catch (error) { errors.push({ domain: "transport", provider: "skyscanner", code: error.code ?? "SOURCE_UNAVAILABLE", journeyId: journey.journeyId }); }
    }
    if (domains.includes("stay") && dates[1]) {
      try {
        const search = await this.search("v1/hotels", { market, locale, currency, entityId: destination.entityId, checkinDate: date(dates[0]), checkoutDate: date(dates[1]), adults, childrenAges, rooms: brief.party?.rooms ?? Math.ceil(adults / 2) }, signal); partial ||= search.partial;
        const results = search.payload.content?.results ?? search.payload;
        if (!results.hotelsPricingOptions) fail("SOURCE_CHANGED");
        const groups = new Map();
        for (const option of asArray(results.hotelsPricingOptions)) {
          const current = groups.get(option.hotelId);
          if (!current || Number(option.price?.price) < Number(current.price?.price)) groups.set(option.hotelId, option);
        }
        byDomain.stay = [...groups.entries()].slice(0, 8).map(([ref, option]) => {
          const info = results.hotelContent?.[ref] ?? {}, quote = option.price;
          const exclusions = new Set(["AR","BO","BR","CL","CO","CR","CU","DO","EC","GT","HN","MX","NI","PA","PY","PE","PR","SV","UY","VE","IN","US","CA"]);
          const amount = Number.isFinite(quote?.price) && quote.price >= 0 ? quote.price : null;
          return candidate({ provider: "skyscanner", domain: "stay", ref, title: info.hotelName ?? ref, summary: option.roomName ?? "", amount, currency: quote?.currency ?? currency, checkedAt,
            bookingUrl: https(option.deeplink ?? results.hotelInfo?.[ref]?.deeplink), basis: "entire_stay_display_price", taxStatus: exclusions.has(market) ? "excludes_some_taxes_or_fees" : "included", taxesAndFees: quote?.taxesAndFees ?? [],
            location: info.coordinates ? { name: info.hotelName ?? ref, countryCode: brief.countryCode, timeZone: brief.timeZone, coordinates: { latitude: info.coordinates.latitude, longitude: info.coordinates.longitude, coordinateSystem: "WGS-84" } } : null,
            operability: { inventoryVerified: amount != null, roomName: option.roomName ?? null, cancellationPolicy: option.cancellationPolicy, mealPlan: option.mealPlan, fareScope: "entire_stay", researchDepth: "live_ota_search", party: { adults, childrenAges, rooms: brief.party?.rooms ?? Math.ceil(adults / 2) } } });
        });
      } catch (error) { errors.push({ domain: "stay", provider: "skyscanner", code: error.code ?? "SOURCE_UNAVAILABLE" }); }
    }
    if (domains.includes("transport") && brief.carHire) {
      try {
        const hire = brief.carHire;
        if (!hire.pickUpAt || !hire.dropOffAt || !Number.isInteger(hire.driverAge) || hire.driverAge < 21 || hire.driverAge > 99) fail("car_hire_dates_and_driver_age_required");
        const local = value => { const d = String(value).match(/^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!d) fail("car_hire_local_time_required"); return { year: +d[1], month: +d[2], day: +d[3], hour: +d[4], minute: +d[5] }; };
        const pickup = await this.place(hire.pickUpLocation ?? brief.destination, market, locale, signal);
        const dropoff = hire.dropOffLocation ? await this.place(hire.dropOffLocation, market, locale, signal) : pickup;
        const search = await this.search("v1/carhire", { market, locale, currency, pickUpLocation: { entityId: pickup.entityId }, dropOffLocation: { entityId: dropoff.entityId }, pickUpDate: local(hire.pickUpAt), dropOffDate: local(hire.dropOffAt), driverAge: hire.driverAge }, signal);
        partial ||= search.partial;
        const results = search.payload.content?.results;
        if (!results?.quotes) fail("SOURCE_CHANGED");
        for (const [ref, quote] of Object.entries(results.quotes).slice(0, 8)) {
          byDomain.transport.push(candidate({ provider: "skyscanner", domain: "transport", ref: `car_${ref}`, title: quote.vehicleName ?? results.vendors?.[quote.vendorId]?.name ?? quote.sippCode, summary: `${pickup.name ?? brief.destination} · ${hire.pickUpAt} → ${hire.dropOffAt}`, amount: money(quote.price), currency, checkedAt, bookingUrl: https(quote.deeplinkUrl), basis: "entire_rental", unit: "per_vehicle",
            location: quote.pickupLocation?.geo ? { name: quote.pickupLocation.address, coordinates: { ...quote.pickupLocation.geo, coordinateSystem: "WGS-84" }, countryCode: brief.countryCode, timeZone: brief.timeZone } : null,
            operability: { inventoryVerified: money(quote.price) != null, transportType: "CAR_HIRE", mobilityRole: "car_hire_inventory", pickUpAt: hire.pickUpAt, dropOffAt: hire.dropOffAt, driverAge: hire.driverAge, pickupLocation: quote.pickupLocation, dropoffLocation: quote.dropoffLocation, sippCode: quote.sippCode, seats: null, luggageCapacity: null, additions: quote.additions, researchDepth: "live_ota_search" } }));
        }
      } catch (error) { errors.push({ domain: "transport", provider: "skyscanner", code: error.code ?? "SOURCE_UNAVAILABLE" }); }
    }
    return { schemaVersion: "travel-provider-result-v1", status: Object.values(byDomain).some(v => v.length) ? "completed" : errors.length ? "provider_unavailable" : "EMPTY_VERIFIED", provider: "skyscanner", providerLabel: "Skyscanner", byDomain, checkedAt, errors, partial: partial || errors.length > 0, caveats: [], fabricatedResults: false, sourceDocumentation: "https://developers.skyscanner.net/docs/intro" };
  }
}

export class ViatorProvider {
  constructor({ apiKey, enabled = false, fullAccess = false, fetchImpl = fetch, clock = () => new Date() } = {}) {
    this.apiKey = apiKey; this.fullAccess = fullAccess; this.fetchImpl = fetchImpl; this.clock = clock;
    this.status = apiKey && enabled ? "configured" : "provider_unavailable"; this.providerId = "viator"; this.regions = ["international"];
  }
  async request(path, body, signal) {
    if (this.status !== "configured") fail("VIATOR_API_KEY_not_configured");
    if (!["search/freetext", "availability/check"].includes(path) || (path === "availability/check" && !this.fullAccess)) fail("viator_capability_not_authorized");
    const response = await this.fetchImpl(`https://api.viator.com/partner/${path}`, { method: "POST", headers: { "exp-api-key": this.apiKey, "Accept": "application/json;version=2.0", "Accept-Language": "en-US", "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) fail(response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "AUTH_REQUIRED" : "SOURCE_UNAVAILABLE");
    return response.json();
  }
  async checkAvailability({ productCode, travelDate, currency, paxMix, productOptionCode, startTime, signal }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(productCode) || !date(travelDate) || !/^[A-Z]{3}$/.test(currency) || !Array.isArray(paxMix) || !paxMix.length || !paxMix.every(p => ["ADULT", "CHILD", "INFANT", "YOUTH", "SENIOR"].includes(p.ageBand) && Number.isInteger(p.numberOfTravelers) && p.numberOfTravelers > 0)) fail("activity_date_and_party_required");
    return this.request("availability/check", { productCode, travelDate, currency, paxMix, ...(productOptionCode ? { productOptionCode } : {}), ...(startTime ? { startTime } : {}) }, signal);
  }
  async research({ brief = {}, domains = ["play"], signal }) {
    const checkedAt = this.clock().toISOString(), byDomain = { food: [], stay: [], transport: [], play: [] };
    if (!domains.includes("play")) return { status: "completed", provider: "viator", byDomain, checkedAt, fabricatedResults: false };
    if (!brief.currency) return { status: "needs_context", reason: "currency_required", provider: "viator", byDomain, fabricatedResults: false };
    const data = await this.request("search/freetext", { searchTerm: brief.destination, searchTypes: [{ searchType: "PRODUCTS", pagination: { start: 1, count: 6 } }], currency: brief.currency }, signal);
    const products = data.products?.results;
    if (!Array.isArray(products)) fail("SOURCE_CHANGED");
    byDomain.play = products.map(p => candidate({ provider: "viator", domain: "play", ref: p.productCode, title: p.title, summary: p.description ?? "", amount: Number.isFinite(p.pricing?.summary?.fromPrice) ? p.pricing.summary.fromPrice : null, currency: p.pricing?.currency ?? brief.currency, checkedAt,
      bookingUrl: https(p.productUrl), basis: "per_person_reference", unit: "per_person", operability: { productCode: p.productCode, inventoryVerified: false, availabilityCheckSupported: this.fullAccess, researchDepth: "affiliate_product_search" } }));
    if (brief.activityRequest) {
      const request = brief.activityRequest;
      const checked = await this.checkAvailability({ ...request, currency: brief.currency, signal });
      const product = products.find(p => p.productCode === request.productCode);
      const items = checked.bookableItems;
      if (!Array.isArray(items)) fail("SOURCE_CHANGED");
      const live = items.filter(item => item.available === true).map((item, index) => candidate({ provider: "viator", domain: "play", ref: `${request.productCode}_${item.productOptionCode ?? index}_${request.travelDate}_${item.startTime ?? ""}`, title: product?.title ?? request.productCode, summary: `${request.travelDate} ${item.startTime ?? ""}`, amount: Number.isFinite(item.totalPrice?.price?.recommendedRetailPrice) ? item.totalPrice.price.recommendedRetailPrice : null, currency: checked.currency ?? brief.currency, checkedAt, bookingUrl: https(product?.productUrl), basis: "dated_party_total", operability: { inventoryVerified: true, productCode: request.productCode, productOptionCode: item.productOptionCode, startTime: item.startTime, serviceDate: request.travelDate, availabilityCheckedAt: checkedAt, researchDepth: "dated_availability", priceParty: request.paxMix } }));
      byDomain.play = [...live, ...byDomain.play.filter(p => p.operability.productCode !== request.productCode)];
    }
    return { schemaVersion: "travel-provider-result-v1", status: products.length ? "completed" : "EMPTY_VERIFIED", provider: "viator", providerLabel: "Viator", checkedAt, byDomain, partial: false, caveats: ["From-prices are reference prices. A dated availability check requires the appropriate Viator partner access."], fabricatedResults: false, sourceDocumentation: "https://docs.viator.com/partner-api/technical/" };
  }
}

export function createGlobalInventoryProviders(env, options = {}) {
  return [new SkyscannerProvider({ apiKey: env.SKYSCANNER_API_KEY, enabled: env.TRAVEL_AGENT_SKYSCANNER_ENABLED === "true", ...options.skyscanner }),
    new ViatorProvider({ apiKey: env.VIATOR_API_KEY, enabled: env.TRAVEL_AGENT_VIATOR_ENABLED === "true", fullAccess: env.TRAVEL_AGENT_VIATOR_ACCESS === "full", ...options.viator })];
}
