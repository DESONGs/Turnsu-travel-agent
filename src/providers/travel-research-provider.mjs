import { createAmapTravelResearchProvider } from "./amap-travel-research.mjs";
import { createFlyaiTravelResearchProvider } from "./flyai-travel-research.mjs";
import { createOpenMeteoWeatherProvider } from "./open-meteo-weather.mjs";
import { createTuniuTravelResearchProvider } from "./tuniu-travel-research.mjs";
import { normalizeProviderResult } from "../../travel-agent-pi-package/src/providers/index.ts";

const DOMAINS = Object.freeze(["play", "food", "stay", "transport"]);
const DOMAIN_PROVIDER_STATUS = Object.freeze({
  RATE_LIMITED: "rate_limited",
  AUTH_REQUIRED: "auth_required",
  ACCOUNT_LIMITED: "provider_unavailable",
  SOURCE_UNAVAILABLE: "provider_unavailable",
  provider_unavailable: "provider_unavailable",
  EMPTY_VERIFIED: "empty_verified",
  partial: "partial",
});

function providerFamily(result, provider = null) {
  const value = `${result?.provider ?? ""} ${provider?.constructor?.name ?? provider ?? ""}`.toLowerCase();
  if (/amap|高德/.test(value)) return "amap";
  if (/flyai|fliggy|飞猪/.test(value)) return "flyai";
  if (/tuniu|途牛/.test(value)) return "tuniu";
  return "unknown";
}

function providerSupportsEmptyDomain(family, domain, criteria) {
  if (family === "amap") return ["play", "food", "stay"].includes(domain) || (domain === "transport" && !criteria?.intercityIntent);
  if (["flyai", "tuniu"].includes(family)) return ["stay", "transport"].includes(domain);
  return true;
}

function providerDomainStatus(result, domain, provider = null, criteria = null) {
  const family = providerFamily(result, provider);
  const rawCandidates = result?.byDomain?.[domain] ?? [];
  const candidates = domain === "transport" && criteria?.intercityIntent
    ? rawCandidates.filter((candidate) => candidate.operability?.mobilityRole === "intercity_inventory" || ["FLIGHT", "TRAIN"].includes(candidate.operability?.transportType))
    : rawCandidates;
  const count = candidates.length;
  if (result?.status === "completed" || result?.status === "partial") {
    if (count > 0) return { provider: result.provider ?? provider?.constructor?.name ?? provider ?? "unknown_provider", status: result.status === "partial" ? "partial" : "completed_nonempty", count, checkedAt: result.checkedAt ?? null };
    if (!providerSupportsEmptyDomain(family, domain, criteria)) return null;
    return { provider: result.provider ?? provider?.constructor?.name ?? provider ?? "unknown_provider", status: result.status === "partial" ? "partial" : "empty_verified", count: 0, checkedAt: result.checkedAt ?? null };
  }
  if (!providerSupportsEmptyDomain(family, domain, criteria)) return null;
  return { provider: result?.provider ?? provider?.constructor?.name ?? provider ?? "unknown_provider", status: DOMAIN_PROVIDER_STATUS[result?.status] ?? "provider_unavailable", count: 0, checkedAt: result?.checkedAt ?? null };
}

function aggregateDomainStatus(rows) {
  if (!rows.length) return { status: "provider_unavailable", count: 0, providers: [] };
  const statuses = new Set(rows.map((row) => row.status));
  const count = rows.reduce((total, row) => total + Number(row.count ?? 0), 0);
  if (statuses.has("completed_nonempty")) return { status: statuses.size === 1 ? "completed_nonempty" : "partial", count, providers: rows };
  if (statuses.has("partial")) return { status: "partial", count, providers: rows };
  if (statuses.has("empty_verified") && statuses.size === 1) return { status: "empty_verified", count: 0, providers: rows };
  if (statuses.has("auth_required")) return { status: "auth_required", count: 0, providers: rows };
  if (statuses.has("rate_limited")) return { status: "rate_limited", count: 0, providers: rows };
  if (statuses.has("empty_verified")) return { status: "partial", count: 0, providers: rows };
  return { status: "provider_unavailable", count: 0, providers: rows };
}

function tripDates(value) {
  const dates = [...String(value ?? "").matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  if (!dates.length) return [];
  const start = new Date(`${dates[0]}T00:00:00.000Z`);
  const end = new Date(`${dates[1] ?? dates[0]}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const result = [];
  for (let cursor = start; cursor <= end && result.length < 60; cursor = new Date(cursor.getTime() + 86_400_000)) result.push(cursor.toISOString().slice(0, 10));
  return result;
}

function weatherGapCaveat(weather) {
  if (weather?.status === "completed") return null;
  return "旅行日期对应的天气资料暂时不可用；地点候选可以先比较，但在天气核验完成前不能视为完整日程。";
}

function candidateIdentity(candidate) {
  if (candidate?.domain === "transport" && candidate.operability?.serviceNumber) {
    const type = String(candidate.operability.transportType ?? "transport").toUpperCase();
    const number = String(candidate.operability.serviceNumber).replace(/\s+/g, "").toUpperCase();
    const rawDeparture = String(candidate.operability.departureAt ?? "").replace("T", " ").replace(/\s+/g, " ").trim();
    const departure = rawDeparture.match(/^(20\d{2}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ?? rawDeparture;
    return `transport:${type}:${number}:${departure}:${candidate.operability.serviceDate ?? ""}:${candidate.operability.departureCity ?? ""}:${candidate.operability.arrivalCity ?? ""}:${candidate.operability.journeyId ?? ""}`;
  }
  const normalizedTitle = String(candidate?.title ?? "").trim().toLowerCase().replace(/[\s·・()（）【】\[\]-]+/g, "");
  return `${candidate?.domain}:${normalizedTitle}`;
}

function mergeDefined(primary = {}, secondary = {}) {
  if (!primary || typeof primary !== "object") primary = {};
  if (!secondary || typeof secondary !== "object") secondary = {};
  const output = { ...secondary, ...primary };
  for (const [key, value] of Object.entries(primary)) {
    if ((value == null || value === "") && secondary[key] != null && secondary[key] !== "") output[key] = secondary[key];
  }
  return output;
}

function evidenceRecord(candidate) {
  return {
    sourceId: candidate.sourceId,
    claimId: candidate.claimId,
    entityId: candidate.entityId,
    source: candidate.source,
    entity: candidate.entity,
    claim: candidate.claim,
  };
}

const PRICE_QUALITY_RANK = Object.freeze({ unknown: 0, estimate: 1, reference: 2, firm: 3 });

function candidatePrice(candidate) {
  if (candidate?.price && typeof candidate.price === "object") return candidate.price;
  const amount = Number(candidate?.cost);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency: "CNY",
    quality: Number.isFinite(amount) && amount > 0 ? "reference" : "unknown",
    basis: candidate?.domain === "stay" ? "per_night_room" : candidate?.domain === "transport" ? "per_person_one_way" : "per_person",
    checkedAt: candidate?.checkedAt ?? null,
  };
}

function bestPrice(...candidates) {
  return candidates.map(candidatePrice).sort((left, right) => {
    const quality = (PRICE_QUALITY_RANK[right.quality] ?? 0) - (PRICE_QUALITY_RANK[left.quality] ?? 0);
    if (quality) return quality;
    const leftAmount = left.amount == null ? Number.POSITIVE_INFINITY : Number(left.amount);
    const rightAmount = right.amount == null ? Number.POSITIVE_INFINITY : Number(right.amount);
    return leftAmount - rightAmount;
  })[0];
}

function mergeTransportCandidate(primary, secondary) {
  const primaryOperability = primary.operability ?? {};
  const secondaryOperability = secondary.operability ?? {};
  const fareOffers = [...(primaryOperability.fareOffers ?? []), ...(secondaryOperability.fareOffers ?? [])]
    .filter((offer, index, offers) => offer && offers.findIndex((item) => item.provider === offer.provider && item.totalFare === offer.totalFare) === index);
  const positiveFares = fareOffers.map((offer) => Number(offer.totalFare)).filter((fare) => Number.isFinite(fare) && fare > 0);
  const costs = [Number(primary.cost), Number(secondary.cost), ...positiveFares].filter((fare) => Number.isFinite(fare) && fare > 0);
  const cost = costs.length ? Math.min(...costs) : 0;
  const price = bestPrice(primary, secondary);
  const operability = mergeDefined(primaryOperability, secondaryOperability);
  operability.departurePlace = mergeDefined(primaryOperability.departurePlace, secondaryOperability.departurePlace);
  operability.arrivalPlace = mergeDefined(primaryOperability.arrivalPlace, secondaryOperability.arrivalPlace);
  operability.fareOffers = fareOffers;
  operability.providerSources = [...new Set([
    ...(primaryOperability.providerSources ?? [primaryOperability.provider]),
    ...(secondaryOperability.providerSources ?? [secondaryOperability.provider]),
  ].filter(Boolean))];
  if (cost > 0) operability.priceHint = `¥${cost} 起${fareOffers.length > 1 ? ` · ${fareOffers.length} 个来源` : ""}`;
  const evidence = [
    ...(primary.additionalEvidence ?? []),
    evidenceRecord(secondary),
    ...(secondary.additionalEvidence ?? []),
  ].filter((item, index, items) => item?.sourceId && items.findIndex((other) => other.sourceId === item.sourceId) === index);
  return {
    ...primary,
    cost,
    price: price.amount == null && cost > 0 ? { ...price, amount: cost, quality: "firm" } : price,
    operability,
    entity: primary.entity ? { ...primary.entity, providerRefs: [...new Set([...(primary.entity.providerRefs ?? []), ...(secondary.entity?.providerRefs ?? [])])] } : primary.entity,
    additionalEvidence: evidence,
  };
}

function mergePlaceCandidate(primary, secondary) {
  const primaryIsOffer = primary.operability?.inventoryVerified === true || Boolean(primary.operability?.roomName);
  const secondaryIsOffer = secondary.operability?.inventoryVerified === true || Boolean(secondary.operability?.roomName);
  const offerFirst = secondaryIsOffer && !primaryIsOffer ? secondary : primary;
  const mapFirst = Number.isFinite(primary.location?.coordinates?.longitude) ? primary : secondary;
  const operability = mergeDefined(offerFirst.operability, mapFirst.operability);
  operability.providerSources = [...new Set([
    ...(primary.operability?.providerSources ?? [primary.operability?.provider]),
    ...(secondary.operability?.providerSources ?? [secondary.operability?.provider]),
  ].filter(Boolean))];
  const evidence = [
    ...(offerFirst.additionalEvidence ?? []),
    evidenceRecord(offerFirst === primary ? secondary : primary),
    ...(offerFirst === primary ? secondary.additionalEvidence ?? [] : primary.additionalEvidence ?? []),
  ].filter((item, index, items) => item?.sourceId && items.findIndex((other) => other.sourceId === item.sourceId) === index);
  return {
    ...offerFirst,
    location: mapFirst.location ?? offerFirst.location,
    media: [...new Map([...(offerFirst.media ?? []), ...(mapFirst.media ?? [])].map((item) => [item.url, item])).values()].slice(0, 6),
    cost: [Number(primary.cost), Number(secondary.cost)].filter((cost) => Number.isFinite(cost) && cost > 0).sort((left, right) => left - right)[0] ?? 0,
    price: bestPrice(primary, secondary),
    operability,
    entity: offerFirst.entity ? { ...offerFirst.entity, providerRefs: [...new Set([...(primary.entity?.providerRefs ?? []), ...(secondary.entity?.providerRefs ?? [])])] } : offerFirst.entity,
    additionalEvidence: evidence,
  };
}

function deduplicate(candidates) {
  const output = [];
  const indexes = new Map();
  for (const candidate of candidates) {
    if (!candidate.title) continue;
    const key = candidateIdentity(candidate);
    if (!indexes.has(key)) {
      indexes.set(key, output.length);
      output.push(candidate);
      continue;
    }
    const index = indexes.get(key);
    if (candidate.domain === "transport") output[index] = mergeTransportCandidate(output[index], candidate);
    else if (candidate.domain === "stay" || candidate.domain === "play") output[index] = mergePlaceCandidate(output[index], candidate);
  }
  return output;
}

function candidateCorpus(candidate) {
  return [
    candidate?.title,
    candidate?.summary,
    candidate?.location?.label,
    candidate?.location?.address,
    candidate?.location?.district,
    candidate?.location?.city,
    candidate?.operability?.type,
    candidate?.operability?.businessArea,
    candidate?.operability?.departurePlace?.label,
    candidate?.operability?.arrivalPlace?.label,
  ].filter(Boolean).join(" ").toLowerCase();
}

function compactPlace(value) {
  return String(value ?? "").toLowerCase().replace(/国际|机场|火车站|高铁站|车站|[\s·・()（）【】\[\]-]/g, "");
}

function matchesAny(corpus, values = []) {
  return values.filter((value) => {
    const raw = String(value ?? "").toLowerCase().trim();
    if (!raw) return false;
    return corpus.includes(raw) || (compactPlace(raw).length >= 2 && compactPlace(corpus).includes(compactPlace(raw)));
  });
}

function timeOfDayMinutes(value) {
  const match = String(value ?? "").match(/(?:T|\s|^)([01]?\d|2[0-3]):([0-5]\d)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function transportArrivalCompatible(candidate, criteria) {
  if (candidate.operability?.transportType !== "FLIGHT") return true;
  const arrival = candidate.operability?.arrivalPlace ?? {};
  const requestedAirport = compactPlace(criteria?.arrival?.airport);
  const returnedAirport = compactPlace(arrival.label);
  if (requestedAirport && returnedAirport && !returnedAirport.includes(requestedAirport) && !requestedAirport.includes(returnedAirport)) return false;
  const requestedTerminal = String(criteria?.arrival?.terminal ?? "").toUpperCase();
  const returnedTerminal = String(arrival.terminal ?? candidate.operability?.arrivalTerminal ?? "").toUpperCase();
  return !(requestedTerminal && returnedTerminal && requestedTerminal !== returnedTerminal);
}

function candidateRoleValid(candidate, domain) {
  const typeCode = String(candidate?.operability?.typeCode ?? "");
  const type = String(candidate?.operability?.type ?? "");
  const title = String(candidate?.title ?? "");
  if (domain === "food") {
    if (typeCode.startsWith("10") || (/住宿服务|宾馆酒店|民宿/.test(type) && !/餐饮|餐厅|菜馆/.test(type))) return false;
    if (/酒店|宾馆|民宿/.test(title) && !/餐厅|餐馆|酒家|菜馆|饭店/.test(title)) return false;
  }
  if (domain === "stay" && typeCode && !typeCode.startsWith("10") && candidate.operability?.inventoryVerified !== true) return false;
  if (domain === "transport") return candidate.operability?.mobilityRole === "intercity_inventory"
    || (candidate.operability?.mobilityRole === "transport_facility_poi" && !/停车场|停车点|停车位/u.test(`${type} ${title}`))
    || ["FLIGHT", "TRAIN"].includes(candidate.operability?.transportType);
  return true;
}

function candidateFit(candidate, domain, criteria) {
  const domainCriteria = criteria?.byDomain?.[domain] ?? {};
  const corpus = candidateCorpus(candidate);
  const namedMatches = matchesAny(corpus, domainCriteria.namedEntities);
  const areaMatches = matchesAny(corpus, domainCriteria.targetAreas);
  const keywordMatches = matchesAny(corpus, domainCriteria.keywords);
  let score = namedMatches.length * 240 + areaMatches.length * 160 + keywordMatches.length * 35;
  const longTailRequested = ["food", "play"].includes(domain)
    && /小店|小众|不太大众|当地人|在地/u.test([...(domainCriteria.keywords ?? []), ...(domainCriteria.preferenceHints ?? [])].join(" "));
  if (candidate.operability?.provider === "amap_web_service") score += 20;
  if (domain === "stay" && candidate.operability?.inventoryVerified === true) score += 140;
  if (domain === "stay" && candidate.operability?.roomName) score += 40;
  if (domain === "food" && /本帮菜|上海本地菜|本地菜/u.test((domainCriteria.keywords ?? []).join(" "))) {
    if (/本帮|上海菜|老上海|沪味|沪菜/u.test(corpus)) score += 180;
  }
  if (domain === "food") {
    const rating = Number(candidate.operability?.rating);
    if (Number.isFinite(rating)) score += rating >= 4.5 ? 100 : rating >= 4.0 ? 30 : -220;
    if (longTailRequested && /美食城|购物中心|商业广场|商场|连锁集合/u.test(corpus)) score -= 180;
    if (longTailRequested && candidate.operability?.longTailEvidence === "verified") score += 220;
  }
  if (domain === "transport") {
    const type = candidate.operability?.transportType;
    const intercity = candidate.operability?.mobilityRole === "intercity_inventory";
    if (intercity) score += 160;
    if (criteria?.intercityIntent === "flight") score += type === "FLIGHT" ? 320 : -500;
    if (criteria?.intercityIntent === "train") score += type === "TRAIN" ? 320 : -500;
    if (criteria?.intercityIntent === "flexible" && ["FLIGHT", "TRAIN"].includes(type)) score += 220;
    const highSpeedRequested = (domainCriteria.preferenceHints ?? []).includes("high_speed_train");
    if (type === "TRAIN" && highSpeedRequested) score += candidate.operability?.highSpeed === true ? 320 : -500;
    if (candidate.operability?.availableSeats === 0 || candidate.operability?.inventoryUsability === "unavailable") score -= 1_000;
    const duration = Number(candidate.operability?.durationMinutes);
    if (Number.isFinite(duration)) score -= Math.min(360, duration / 4);
    const requestedAirport = criteria?.arrival?.airport;
    const arrival = candidate.operability?.arrivalPlace;
    if (type === "FLIGHT" && requestedAirport) {
      const returnedAirportKey = compactPlace(arrival?.label);
      const requestedAirportKey = compactPlace(requestedAirport);
      const airportMatches = returnedAirportKey.length >= 2 && requestedAirportKey.length >= 2
        && (returnedAirportKey.includes(requestedAirportKey) || requestedAirportKey.includes(returnedAirportKey));
      score += airportMatches ? 220 : (arrival?.label ? -500 : -80);
      const requestedTerminal = String(criteria.arrival.terminal ?? "").toUpperCase();
      const returnedTerminal = String(arrival?.terminal ?? candidate.operability?.arrivalTerminal ?? "").toUpperCase();
      if (requestedTerminal) score += returnedTerminal === requestedTerminal ? 80 : returnedTerminal ? -240 : 0;
      const requestedTime = timeOfDayMinutes(criteria.arrival.time);
      const returnedTime = timeOfDayMinutes(candidate.operability?.arrivalAt);
      if (requestedTime != null && returnedTime != null) score += Math.max(-80, 120 - Math.abs(requestedTime - returnedTime) / 2);
    }
  }
  return { score, namedMatches, areaMatches, keywordMatches };
}

function withCriteriaFit(candidate, domain, criteria) {
  const fit = candidateFit(candidate, domain, criteria);
  const requestedArrivalMinutes = domain === "transport" ? timeOfDayMinutes(criteria?.arrival?.time) : null;
  const returnedArrivalMinutes = domain === "transport" ? timeOfDayMinutes(candidate.operability?.arrivalAt) : null;
  const arrivalDifferenceMinutes = requestedArrivalMinutes != null && returnedArrivalMinutes != null
    ? Math.abs(requestedArrivalMinutes - returnedArrivalMinutes)
    : null;
  const arrivalAnchor = domain === "transport"
    && candidate.operability?.transportType === "FLIGHT"
    && criteria?.arrival?.airport
    && criteria.arrival.confirmed === true
    ? {
        kind: "airport",
        city: criteria.destination,
        label: [criteria.arrival.airport, criteria.arrival.terminal].filter(Boolean).join(" "),
        terminal: criteria.arrival.terminal,
        time: criteria.arrival.time,
        sourceNature: "user_confirmed_arrival",
      }
    : null;
  const longTailRequested = ["food", "play"].includes(domain)
    && /小店|小众|不太大众|当地人|在地/u.test([...(criteria?.byDomain?.[domain]?.keywords ?? []), ...(criteria?.byDomain?.[domain]?.preferenceHints ?? [])].join(" "));
  return {
    ...candidate,
    operability: {
      ...(candidate.operability ?? {}),
      researchFit: {
        score: fit.score,
        matchedNamedEntities: fit.namedMatches,
        matchedTargetAreas: fit.areaMatches,
        matchedKeywords: fit.keywordMatches,
        ...(requestedArrivalMinutes != null ? {
          arrivalTimeFit: arrivalDifferenceMinutes == null ? "unknown" : arrivalDifferenceMinutes <= 90 ? "matched" : "different",
          requestedArrivalTime: criteria.arrival.time,
          arrivalDifferenceMinutes,
        } : {}),
      },
      ...(arrivalAnchor ? { arrivalRouteAnchor: arrivalAnchor } : {}),
      ...(longTailRequested ? { longTailEvidence: "not_verified_by_current_sources" } : {}),
    },
  };
}

function rankAndFuse(domain, candidates, criteria, groupJourneys = true) {
  if (domain === "transport" && groupJourneys && candidates.some(item => item.operability?.journeyId)) {
    return [...new Set(candidates.map(item => item.operability?.journeyId))].flatMap(id => {
      const group = candidates.filter(item => item.operability?.journeyId === id);
      const outbound = group[0]?.operability?.journeyPurpose === "outbound";
      const scoped = outbound ? criteria : { ...criteria, arrival: { airport: null, terminal: null, time: null, confirmed: false }, byDomain: { ...criteria?.byDomain, transport: { ...criteria?.byDomain?.transport, namedEntities: [] } } };
      return rankAndFuse(domain, group, scoped, false);
    });
  }
  let ranked = deduplicate(candidates)
    .filter((candidate) => candidateRoleValid(candidate, domain))
    .map((candidate) => withCriteriaFit(candidate, domain, criteria));
  const domainCriteria = criteria?.byDomain?.[domain] ?? {};
  if (domain === "stay" && domainCriteria.targetAreas?.length) ranked = ranked.filter((candidate) => candidate.operability?.researchFit?.matchedTargetAreas?.length);
  if (domain === "play" && domainCriteria.namedEntities?.length) ranked = ranked.filter((candidate) => candidate.operability?.researchFit?.matchedNamedEntities?.length);
  if (domain === "transport" && criteria?.intercityIntent === "flight") ranked = ranked.filter((candidate) => candidate.operability?.transportType === "FLIGHT");
  if (domain === "transport" && criteria?.intercityIntent === "train") ranked = ranked.filter((candidate) => candidate.operability?.transportType === "TRAIN");
  if (domain === "transport") ranked = ranked.filter((candidate) => transportArrivalCompatible(candidate, criteria));
  ranked.sort((left, right) => {
    const score = Number(right.operability?.researchFit?.score ?? 0) - Number(left.operability?.researchFit?.score ?? 0);
    if (score) return score;
    const availability = Number((right.operability?.availableSeats ?? -1) > 0) - Number((left.operability?.availableSeats ?? -1) > 0)
      || Number(left.operability?.availableSeats === 0) - Number(right.operability?.availableSeats === 0);
    if (availability) return availability;
    const leftCost = Number(left.cost) > 0 ? Number(left.cost) : Number.POSITIVE_INFINITY;
    const rightCost = Number(right.cost) > 0 ? Number(right.cost) : Number.POSITIVE_INFINITY;
    return leftCost - rightCost;
  });
  if ((domainCriteria.namedEntities ?? []).length > 1) {
    const representatives = (domainCriteria.namedEntities ?? []).map((entity) => ranked.find((candidate) => candidate.operability?.researchFit?.matchedNamedEntities?.includes(entity))).filter(Boolean);
    ranked = [...new Set([...representatives, ...ranked])];
  }
  if (ranked.length <= 1) return ranked;
  const topScore = Number(ranked[0].operability?.researchFit?.score ?? 0);
  const diversified = [];
  const seenProviders = new Set();
  for (const candidate of ranked) {
    const providers = candidate.operability?.providerSources ?? [candidate.operability?.provider];
    if (diversified.length >= 3 || providers.some((provider) => seenProviders.has(provider))) continue;
    if (Number(candidate.operability?.researchFit?.score ?? 0) < topScore - 180) continue;
    diversified.push(candidate);
    providers.filter(Boolean).forEach((provider) => seenProviders.add(provider));
  }
  return [...diversified, ...ranked.filter((candidate) => !diversified.includes(candidate))].slice(0, 12);
}

const AMAP_ACCOUNT_GATE_CAVEAT = "高德地图账号当前被服务平台阻止访问；因此餐厅、地点照片、出入口和市内路线无法完整核验，其他已接通来源的住宿、景点和城际库存仍可比较。";

export class CompositeTravelResearchProvider {
  constructor({ providers = [], weatherProviders = [], staticErrors = [], clock } = {}) {
    this.providers = providers.filter(Boolean);
    this.weatherProviders = weatherProviders.filter(Boolean);
    this.staticErrors = staticErrors.filter((item) => item && typeof item === "object");
    this.clock = clock;
    this.researchCallCount = 0;
    this.providerInvocationCount = 0;
    this.lastResearchTrace = null;
  }

  get configuredProviders() {
    return this.providers.filter((provider) => provider.status === "configured");
  }

  get status() {
    return this.configuredProviders.length ? "configured" : "provider_unavailable";
  }

  get mapProvider() {
    return this.configuredProviders.find((provider) => provider.canRenderMap && typeof provider.renderStaticMap === "function") ?? null;
  }

  get canRenderMap() {
    return Boolean(this.mapProvider);
  }

  renderStaticMap(input) {
    if (!this.mapProvider) throw Object.assign(new Error("trip_map_unavailable"), { code: "trip_map_unavailable" });
    return this.mapProvider.renderStaticMap(input);
  }

  get mobilityProvider() {
    return this.configuredProviders.find((provider) => typeof provider.planMobility === "function") ?? null;
  }

  get canPlanMobility() {
    return Boolean(this.mobilityProvider);
  }

  planMobility(input) {
    if (!this.mobilityProvider) {
      return Promise.resolve({
        schemaVersion: "trip-mobility-v1",
        status: "provider_unavailable",
        destination: input?.brief?.destination ?? null,
        source: "amap_routes_v5",
        reason: "amap_routes_live_smoke_required",
        fabricatedResults: false,
      });
    }
    return this.mobilityProvider.planMobility(input);
  }

  async resolveWeather(input) {
    const existing = input?.existingWeather;
    const checkedAt = new Date(existing?.checkedAt ?? 0).getTime();
    const current = new Date(this.clock?.() ?? Date.now()).getTime();
    const expectedTripDates = tripDates(input?.brief?.dates);
    if (existing?.status === "completed"
      && existing.destination === input?.brief?.destination
      && JSON.stringify(existing.tripDates ?? []) === JSON.stringify(expectedTripDates)
      && Number.isFinite(checkedAt)
      && current >= checkedAt
      && current - checkedAt <= 3 * 60 * 60 * 1_000) return { ...existing, reused: true };
    let lastFailure = null;
    for (const provider of this.weatherProviders.filter((item) => item.status === "configured" && typeof item.getWeather === "function")) {
      const result = await provider.getWeather(input);
      if (result?.status === "completed") return result;
      lastFailure = result;
    }
    return lastFailure;
  }

  async research(input) {
    const providers = this.configuredProviders;
    const requested = Array.isArray(input?.domains) && input.domains.length ? input.domains : DOMAINS;
    const hasWeatherProvider = this.weatherProviders.some((provider) => provider.status === "configured" && typeof provider.getWeather === "function");
    if (!providers.length && !hasWeatherProvider) return normalizeProviderResult({ schemaVersion: "travel-provider-result-v1", status: "provider_unavailable", provider: "composite_travel_research", fabricatedResults: false });
    this.researchCallCount += 1;
    this.providerInvocationCount += providers.length;
    const startedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    const [settled, weather] = await Promise.all([
      Promise.allSettled(providers.map((provider) => provider.research({ ...input, includeWeather: false }))),
      this.resolveWeather(input),
    ]);
    this.lastResearchTrace = { researchCallCount: this.researchCallCount, providerInvocationCount: this.providerInvocationCount, providerCount: providers.length, providers: providers.map((provider) => provider.constructor?.name ?? "configured_provider"), startedAt, completedAt: new Date(this.clock?.() ?? Date.now()).toISOString() };
    const completed = settled.filter((result) => result.status === "fulfilled" && ["completed", "partial"].includes(result.value?.status)).map((result) => result.value);
    const providerDomainRows = Object.fromEntries(requested.map((domain) => [domain, settled.map((result, index) => result.status === "fulfilled"
      ? providerDomainStatus(result.value, domain, providers[index], input?.criteria)
      : providerDomainStatus({ status: result.reason?.code ?? "SOURCE_UNAVAILABLE", provider: providers[index]?.constructor?.name }, domain, providers[index], input?.criteria)).filter(Boolean)]));
    const domainStatuses = Object.fromEntries(requested.map((domain) => [domain, aggregateDomainStatus(providerDomainRows[domain])]));
    const errors = [...this.staticErrors, ...settled.flatMap((result) => {
      if (result.status === "rejected") return [{ code: result.reason?.code ?? "SOURCE_UNAVAILABLE" }];
      if (!["completed", "partial"].includes(result.value?.status)) return [{ code: result.value?.status ?? "SOURCE_UNAVAILABLE", provider: result.value?.provider ?? null }];
      return [];
    })];
    const amapAccountGate = errors.some((error) => error.code === "ACCOUNT_LIMITED" && error.provider === "amap_web_service");
    if (!completed.length) {
      if (weather?.status === "completed") {
        return normalizeProviderResult({
          schemaVersion: "travel-provider-result-v1",
          status: "completed",
          provider: weather.provider,
          providerLabel: "天气资料",
          destination: input?.brief?.destination ?? null,
          checkedAt: weather.checkedAt,
          byDomain: Object.fromEntries(DOMAINS.map((domain) => [domain, []])),
          partial: true,
          errors,
          weather,
          caveats: [amapAccountGate ? AMAP_ACCOUNT_GATE_CAVEAT : null, weather.caveat].filter(Boolean),
          fabricatedResults: false,
          sourceDocumentation: weather.sourceDocumentation,
          domainStatuses,
        });
      }
      return normalizeProviderResult({
        schemaVersion: "travel-provider-result-v1",
        status: errors.some((error) => error.code === "AUTH_REQUIRED")
          ? "AUTH_REQUIRED"
          : errors.some((error) => error.code === "ACCOUNT_LIMITED")
            ? "ACCOUNT_LIMITED"
            : errors.some((error) => error.code === "RATE_LIMITED")
              ? "RATE_LIMITED"
              : "EMPTY_VERIFIED",
        provider: "composite_travel_research",
        errors,
        domainStatuses,
        fabricatedResults: false,
      });
    }
    const byDomain = Object.fromEntries(DOMAINS.map((domain) => [domain, rankAndFuse(domain, completed.flatMap((result) => result.byDomain?.[domain] ?? []), input?.criteria)]));
    const weatherCaveat = weatherGapCaveat(weather);
    const longTailCaveat = /小店|小众|不太大众|当地人|在地/u.test([
      ...(input?.criteria?.byDomain?.food?.keywords ?? []),
      ...(input?.criteria?.byDomain?.food?.preferenceHints ?? []),
      ...(input?.criteria?.byDomain?.play?.preferenceHints ?? []),
    ].join(" "))
      ? "当前地图与商业库存只能核验地点、位置和部分营业资料，不能单独证明它是当地人才知道或不大众的选择；这项判断仍需独立内容来源或真实到访反馈。"
      : null;
    return normalizeProviderResult({
      schemaVersion: "travel-provider-result-v1",
      status: Object.values(byDomain).some((items) => items.length) ? "completed" : "EMPTY_VERIFIED",
      provider: completed.map((result) => result.provider).join("+"),
      providerLabel: completed.map((result) => result.providerLabel).filter(Boolean).join(" + "),
      destination: completed.find((result) => result.destination)?.destination ?? input?.brief?.destination ?? null,
      checkedAt: completed.map((result) => result.checkedAt).filter(Boolean).sort().at(-1) ?? new Date().toISOString(),
      byDomain,
      partial: errors.length > 0 || completed.some((result) => result.status === "partial" || result.partial) || requested.some((domain) => !(byDomain[domain]?.length)) || weather?.status !== "completed",
      errors: [
        ...errors,
        ...(weather && weather.status !== "completed" ? [{ code: weather.status, provider: weather.provider ?? null, capability: "weather" }] : []),
      ],
      weather,
      caveats: [...new Set([
        ...completed.flatMap((result) => result.caveats ?? []),
        ...(amapAccountGate ? [AMAP_ACCOUNT_GATE_CAVEAT] : []),
        longTailCaveat,
        weatherCaveat,
      ].filter(Boolean))],
      fabricatedResults: false,
      sourceDocumentation: completed.find((result) => result.sourceDocumentation)?.sourceDocumentation ?? null,
      criteriaFingerprint: input?.criteria?.fingerprint ?? null,
      domainStatuses,
    });
  }
}

export function createTravelResearchProvider(env = process.env, options = {}) {
  const amap = createAmapTravelResearchProvider(env, options.amap);
  const openMeteo = createOpenMeteoWeatherProvider(env, options.openMeteo);
  const weatherProviders = env.TRAVEL_AGENT_AMAP_SMOKE_STATUS === "passed_live_smoke" ? [amap, openMeteo] : [openMeteo, amap];
  const amapSmokeStatus = String(env.TRAVEL_AGENT_AMAP_SMOKE_STATUS ?? "");
  const staticErrors = amapSmokeStatus.includes("account_gate_10044")
    ? [{ code: "ACCOUNT_LIMITED", provider: "amap_web_service", infoCode: "10044" }]
    : [];
  return new CompositeTravelResearchProvider({
    providers: [
      amap,
      createFlyaiTravelResearchProvider(env, options.flyai),
      createTuniuTravelResearchProvider(env, options.tuniu),
    ],
    weatherProviders,
    staticErrors,
    clock: options.clock,
  });
}
