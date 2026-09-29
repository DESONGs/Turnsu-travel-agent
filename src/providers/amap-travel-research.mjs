import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { currentTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { accessibilityFeaturesForWalkType, amapWalkTypeMetadata } from "../../travel-agent-pi-package/src/contracts/public.ts";
import { scheduledRideLeg, routeAlternativeId } from "../../travel-agent-pi-package/src/core/journey-execution.ts";

const AMAP_PLACE_ENDPOINT = "https://restapi.amap.com/v5/place/text";
const AMAP_PLACE_V3_ENDPOINT = "https://restapi.amap.com/v3/place/text";
const AMAP_GEOCODE_ENDPOINT = "https://restapi.amap.com/v3/geocode/geo";
const AMAP_WEATHER_ENDPOINT = "https://restapi.amap.com/v3/weather/weatherInfo";
const AMAP_STATIC_MAP_ENDPOINT = "https://restapi.amap.com/v3/staticmap";
const AMAP_DRIVING_ENDPOINT = "https://restapi.amap.com/v5/direction/driving";
const AMAP_WALKING_ENDPOINT = "https://restapi.amap.com/v5/direction/walking";
const AMAP_TRANSIT_ENDPOINT = "https://restapi.amap.com/v5/direction/transit/integrated";
const AMAP_PLACE_DOC = "https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch";
const AMAP_PLACE_V3_DOC = "https://lbs.amap.com/api/webservice/guide/api/search/";
const AMAP_WEATHER_DOC = "https://lbs.amap.com/api/webservice/guide/api/weatherinfo";
const AMAP_ROUTE_DOC = "https://lbs.amap.com/api/webservice/guide/api/newroute";
const DEFAULT_DOMAINS = Object.freeze(["play", "food", "stay", "transport"]);

const DOMAIN_SEARCH = Object.freeze({
  play: { types: "110000|140000", label: "景点与文化体验" },
  food: { types: "050000", label: "本地餐饮" },
  stay: { types: "100000", label: "住宿" },
  transport: { types: "150000", label: "交通设施" },
});

function text(value, limit = 500) {
  if (Array.isArray(value)) return "";
  return String(value ?? "").trim().slice(0, limit);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function referencePrice(value) {
  const raw = text(value, 40).replace(/[¥￥,\s]/g, "");
  const match = raw.match(/\d+(?:\.\d{1,2})?/);
  return match ? Number(match[0]) : null;
}

function objectOrEmpty(value) {
  return value && !Array.isArray(value) && typeof value === "object" ? value : {};
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function signedAmapParameters(values, apiSecret = "") {
  const entries = Object.entries(values).map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left.localeCompare(right, "en"));
  const parameters = new URLSearchParams(entries);
  const secret = text(apiSecret, 512);
  if (secret) {
    const signatureBase = `${entries.map(([key, value]) => `${key}=${value}`).join("&")}${secret}`;
    parameters.set("sig", createHash("md5").update(signatureBase, "utf8").digest("hex"));
  }
  return parameters;
}

function providerError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function amapStatusCode(infoCode) {
  if (["10003", "10044", "10045"].includes(infoCode)) return "ACCOUNT_LIMITED";
  if (["10004", "10014", "10015", "10019", "10020", "10021", "10029"].includes(infoCode)) return "RATE_LIMITED";
  if (["10001", "10002", "10005", "10006", "10007", "10008", "10009", "10012", "10013", "10041"].includes(infoCode)) return "AUTH_REQUIRED";
  return "SOURCE_UNAVAILABLE";
}

function isTransientQpsLimit(error) {
  return error?.code === "RATE_LIMITED" && ["10014", "10015", "10019", "10020", "10021", "10029"].includes(String(error?.details?.infoCode ?? ""));
}

function navigationUrl(poi) {
  const poiId = text(poi.id, 128);
  if (poiId) {
    const parameters = new URLSearchParams({ poiid: poiId, src: "travel-agent-v1", callnative: "0" });
    return `https://uri.amap.com/marker?${parameters}`;
  }
  const location = text(poi.location, 80);
  if (!/^\d{2,3}(?:\.\d+)?,\d{1,2}(?:\.\d+)?$/.test(location)) return null;
  const parameters = new URLSearchParams({ position: location, name: text(poi.name, 120), src: "travel-agent-v1", coordinate: "gaode", callnative: "0" });
  return `https://uri.amap.com/marker?${parameters}`;
}

function normalizePoi(poi, { domain, checkedAt, apiVersion = "v5", query = null, criteria = null }) {
  const business = Object.keys(objectOrEmpty(poi.business)).length ? objectOrEmpty(poi.business) : objectOrEmpty(poi.biz_ext);
  const indoor = objectOrEmpty(poi.indoor);
  const navi = objectOrEmpty(poi.navi);
  const rawLocation = text(poi.location, 80);
  const [longitude, latitude] = rawLocation.split(",").map(numberOrNull);
  const providerPoiId = text(poi.id, 128) || `anonymous_${shortHash(`${domain}:${poi.name}:${poi.address}:${rawLocation}`)}`;
  const sourceId = `amap:${providerPoiId}`;
  const address = text(poi.address, 300);
  const type = text(poi.type, 240);
  const typeCode = text(poi.typecode, 80) || null;
  const district = text(poi.adname, 120);
  const facts = unique([
    address,
    type,
    text(business.rating, 40) ? `高德评分 ${text(business.rating, 40)}` : null,
    text(business.cost, 40) ? `参考消费 ${text(business.cost, 40)}` : null,
    text(business.opentime_today, 160) ? `今日营业 ${text(business.opentime_today, 160)}` : null,
  ]);
  const claimId = `claim_${shortHash(`${sourceId}:${checkedAt}`)}`;
  const entityId = `entity_${shortHash(sourceId)}`;
  const media = (Array.isArray(poi.photos) ? poi.photos : []).map((photo) => ({
    url: safeHttpsUrl(photo?.url),
    title: text(photo?.title, 200),
    source: "amap_web_service",
  })).filter((photo) => photo.url).slice(0, 6);
  const entrance = text(navi.entr_location, 80) || null;
  const exit = text(navi.exit_location, 80) || null;
  const indoorMap = text(indoor.indoor_map ?? poi.indoor_map, 8) === "1";
  const cost = referencePrice(business.cost);
  const mappedFacilities = [
    ...(entrance ? [{ kind: "entrance", label: "入口位置", value: entrance }] : []),
    ...(exit ? [{ kind: "exit", label: "出口位置", value: exit }] : []),
    ...(indoorMap ? [{ kind: "indoor_map", label: "室内地图", value: "available" }] : []),
  ].map((facility) => ({
    ...facility,
    status: "mapped_non_realtime",
    realTime: false,
    source: "amap_web_service",
    checkedAt,
    guidance: "地图资料仅表示已记录的位置或设施，不代表当前开放或正常运行，建议现场确认。",
  }));
  return {
    candidateId: `${domain}_${shortHash(sourceId)}`,
    domain,
    title: text(poi.name, 200) || DOMAIN_SEARCH[domain].label,
    summary: facts.join(" · ").slice(0, 900),
    sourceId,
    claimId,
    entityId,
    checkedAt,
    media,
    cost: cost ?? 0,
    price: {
      amount: cost,
      currency: "CNY",
      quality: cost == null ? "unknown" : "reference",
      basis: domain === "stay" ? "per_night_room_reference" : "per_person_reference",
      checkedAt,
    },
    location: {
      label: address || [text(poi.cityname, 120), district].filter(Boolean).join(" ") || null,
      district: district || null,
      city: text(poi.cityname, 120) || null,
      citycode: text(poi.citycode, 20) || null,
      adcode: text(poi.adcode, 20) || null,
      coordinates: longitude != null && latitude != null ? { longitude, latitude, coordinateSystem: "GCJ-02" } : null,
    },
    operability: {
      provider: "amap_web_service",
      providerPoiId,
      mobilityRole: domain === "transport" ? "transport_facility_poi" : "place",
      type: type || null,
      typeCode,
      rating: text(business.rating, 40) || null,
      priceHint: text(business.cost, 40) || null,
      openToday: text(business.opentime_today, 160) || null,
      openWeek: text(business.opentime_week, 300) || null,
      businessArea: text(business.business_area, 120) || null,
      entrance,
      exit,
      indoorMap,
      mappedFacilities,
      facilityEvidenceNature: mappedFacilities.length ? "map_reference_non_realtime" : "not_returned",
      facilityLiveStatus: false,
      ...(domain === "stay" ? {
        lodgingDataNature: "amap_place_reference",
        inventoryVerified: false,
        hotelOfferStatus: "ota_offer_required",
      } : {}),
      navigationUrl: navigationUrl(poi),
      researchDepth: apiVersion === "v5" ? "amap_poi_v5_enriched" : "amap_poi_v3_basic_fallback",
      researchMatch: {
        query: query?.keyword ?? null,
        broadFallback: query?.broad === true,
        matchedNamedEntities: (criteria?.namedEntities ?? []).filter((item) => `${poi.name ?? ""} ${poi.address ?? ""} ${type}`.includes(item)),
        matchedTargetAreas: (criteria?.targetAreas ?? []).filter((item) => `${poi.name ?? ""} ${poi.address ?? ""} ${district} ${business.business_area ?? ""}`.includes(item)),
      },
    },
    source: {
      sourceId,
      provider: "amap_web_service",
      sourceType: "official_map_provider",
      providerPoiId,
      checkedAt,
      documentationUrl: apiVersion === "v5" ? AMAP_PLACE_DOC : AMAP_PLACE_V3_DOC,
      independenceGroup: sourceId,
      commercialBias: "provider_ranking_unknown",
    },
    entity: {
      entityId,
      kind: domain === "food" ? "place_or_venue" : "place",
      canonicalName: text(poi.name, 200),
      providerRefs: [sourceId],
    },
    claim: {
      claimId,
      entityId,
      kind: "provider_fact",
      statement: facts.join(" · ").slice(0, 1000),
      sourceRefs: [sourceId],
      sourceIndependence: "single_provider",
      commercialBias: "provider_ranking_unknown",
      confidence: 0.8,
      observedAt: checkedAt,
    },
  };
}

function poiMatchesDomain(poi, domain) {
  const typeCode = text(poi?.typecode, 100);
  const type = text(poi?.type, 300);
  const title = text(poi?.name, 200);
  const codeMatches = {
    play: /^(?:11|14)/,
    food: /^05/,
    stay: /^10/,
    transport: /^15/,
  }[domain]?.test(typeCode);
  if (codeMatches) return true;
  if (domain === "food") return /餐饮服务|中餐厅|餐厅|菜馆|小吃/u.test(`${type} ${title}`) && !/住宿服务|宾馆酒店|民宿/u.test(type);
  if (domain === "stay") return /住宿服务|宾馆酒店|酒店|民宿/u.test(`${type} ${title}`);
  if (domain === "play") return /风景名胜|科教文化|博物馆|美术馆|公园|景区|文化/u.test(`${type} ${title}`);
  if (domain === "transport") return /交通设施|机场|火车站|地铁站|客运站/u.test(`${type} ${title}`) && !/停车场|停车点|停车位/u.test(`${type} ${title}`);
  return false;
}

function domainSearchQueries(domain, criteria = {}) {
  const named = unique(criteria.namedEntities ?? []).slice(0, 2);
  if (named.length) return named.map((keyword) => ({ keyword, broad: false, reason: "named_entity" }));
  const areas = unique(criteria.targetAreas ?? []).slice(0, 2);
  if (areas.length) {
    const preferred = domain === "stay"
      ? "酒店"
      : domain === "food"
        ? ((criteria.keywords ?? []).find((item) => /本帮菜|本地菜|餐厅|小店/u.test(item)) ?? "本地餐厅").replace("上海本地菜", "本帮菜")
        : (criteria.keywords ?? [])[0] ?? DOMAIN_SEARCH[domain].label;
    return areas.map((area) => ({ keyword: `${area} ${preferred}`.trim(), broad: false, reason: "target_area" }));
  }
  const keywords = unique(criteria.keywords ?? []).filter((item) => !/不太大众|小众|轻松|方便/u.test(item)).slice(0, 2);
  if (keywords.length) return keywords.map((keyword) => ({ keyword: keyword.replace("上海本地菜", "本帮菜"), broad: false, reason: "keyword" }));
  return [{ keyword: null, broad: true, reason: "broad_recall" }];
}

function isoDates(value) {
  return [...String(value ?? "").matchAll(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/g)].map((match) => {
    const [year, month, day] = match[1].split("-").map(Number);
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
}

function dateRange(value) {
  const parsed = isoDates(value);
  if (!parsed.length) return [];
  const start = new Date(`${parsed[0]}T00:00:00.000Z`);
  const end = new Date(`${parsed[1] ?? parsed[0]}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates = [];
  for (let cursor = start; cursor <= end && dates.length < 60; cursor = new Date(cursor.getTime() + 86_400_000)) dates.push(cursor.toISOString().slice(0, 10));
  return dates;
}

function maximumNumber(value) {
  const numbers = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  return numbers.length ? Math.max(...numbers) : null;
}

function normalizeForecast(payload, brief, checkedAt) {
  const forecast = Array.isArray(payload?.forecasts) ? payload.forecasts[0] : null;
  if (!forecast) return { schemaVersion: "trip-weather-v1", status: "EMPTY_VERIFIED", reason: "forecast_not_returned", fabricatedResults: false };
  const forecastDays = (Array.isArray(forecast.casts) ? forecast.casts : []).slice(0, 8).map((cast) => ({
    date: text(cast?.date, 10),
    weekday: text(cast?.week, 8) || null,
    dayCondition: text(cast?.dayweather, 80) || null,
    nightCondition: text(cast?.nightweather, 80) || null,
    highC: numberOrNull(cast?.daytemp_float ?? cast?.daytemp),
    lowC: numberOrNull(cast?.nighttemp_float ?? cast?.nighttemp),
    dayWind: text(cast?.daywind, 40) || null,
    nightWind: text(cast?.nightwind, 40) || null,
    maxWindLevel: Math.max(maximumNumber(cast?.daypower) ?? 0, maximumNumber(cast?.nightpower) ?? 0) || null,
  })).filter((day) => day.date);
  const tripDates = dateRange(brief?.dates);
  const availableDates = new Set(forecastDays.map((day) => day.date));
  const coveredDates = tripDates.filter((date) => availableDates.has(date));
  const coverage = !tripDates.length ? "dates_unknown" : !coveredDates.length ? "outside_forecast_window" : coveredDates.length === tripDates.length ? "covered" : "partial";
  const relevantDays = forecastDays.filter((day) => coveredDates.includes(day.date));
  const conditionText = relevantDays.map((day) => `${day.dayCondition ?? ""}${day.nightCondition ?? ""}`).join(" ");
  const hasSevereCondition = /暴雨|大雨|雷|雪|冰雹|台风|沙尘|大雾/.test(conditionText);
  const hasWetCondition = /雨|雪|雷|冰雹/.test(conditionText);
  const hasHeat = relevantDays.some((day) => day.highC != null && day.highC >= 35);
  const hasCold = relevantDays.some((day) => day.lowC != null && day.lowC <= 5);
  const hasStrongWind = relevantDays.some((day) => day.maxWindLevel != null && day.maxWindLevel >= 5);
  const riskSignals = [
    ...(hasWetCondition ? ["precipitation"] : []),
    ...(hasHeat ? ["heat"] : []),
    ...(hasCold ? ["cold"] : []),
    ...(hasStrongWind ? ["strong_wind"] : []),
  ];
  const severity = hasSevereCondition || hasStrongWind || hasHeat ? "high" : riskSignals.length ? "watch" : "none";
  const active = ["covered", "partial"].includes(coverage) && severity !== "none";
  const guidance = {
    play: active ? (hasWetCondition ? "优先室内或可随时取消的体验，户外项目保留替代方案。" : "把高暴露户外活动放在较舒适时段，并保留休息窗口。") : null,
    transport: active ? "减少紧凑换乘并增加步行、等车和行李移动缓冲。" : null,
    stay: active ? "住宿位置优先考虑公共交通与室内衔接便利，避免恶劣天气下长距离拖行李。" : null,
    food: active ? "餐饮尽量靠近当日活动或住宿，减少天气不佳时的额外往返。" : null,
  };
  return {
    schemaVersion: "trip-weather-v1",
    status: "completed",
    provider: "amap_weather",
    destination: text(brief?.destination, 120),
    city: text(forecast.city, 120) || null,
    province: text(forecast.province, 120) || null,
    adcode: text(forecast.adcode, 20) || null,
    reportTime: text(forecast.reporttime, 40) || null,
    checkedAt,
    coverage,
    tripDates,
    forecastDays,
    riskSignals,
    planningImpact: { active, severity, affectedDomains: active ? [...DEFAULT_DOMAINS] : [], guidance },
    sourceDocumentation: AMAP_WEATHER_DOC,
    caveat: coverage === "outside_forecast_window" ? "行程日期不在当前预报窗口内，暂不据此改动方案，临近出发需重新核验。" : coverage === "dates_unknown" ? "尚无可解析的具体日期，当前预报只作目的地近期天气参考。" : null,
    fabricatedResults: false,
  };
}

function reusableWeather(existingWeather, brief, clock) {
  if (!existingWeather || existingWeather.status !== "completed") return null;
  if (text(existingWeather.destination, 120) !== text(brief?.destination, 120)) return null;
  const expectedDates = dateRange(brief?.dates);
  if (JSON.stringify(existingWeather.tripDates ?? []) !== JSON.stringify(expectedDates)) return null;
  const checkedAt = new Date(existingWeather.checkedAt ?? 0).getTime();
  const current = new Date(clock?.() ?? Date.now()).getTime();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(current) || current < checkedAt || current - checkedAt > 3 * 60 * 60 * 1_000) return null;
  return { ...existingWeather, reused: true };
}

function array(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function secondsToMinutes(value) {
  const seconds = numberOrNull(value);
  return seconds == null ? null : Math.max(1, Math.round(seconds / 60));
}

function coordinatePair(input) {
  const coordinates = input?.location?.coordinates ?? input?.coordinates ?? null;
  if (!Number.isFinite(coordinates?.longitude) || !Number.isFinite(coordinates?.latitude)) return null;
  return {
    longitude: Number(coordinates.longitude),
    latitude: Number(coordinates.latitude),
    coordinateSystem: "GCJ-02",
  };
}

function coordinateString(point) {
  return `${Number(point.longitude).toFixed(6)},${Number(point.latitude).toFixed(6)}`;
}

function polylinePoints(values) {
  const joined = array(values).flatMap((value) => String(value ?? "").split(";")).filter(Boolean);
  return joined.map((value) => {
    const [longitude, latitude] = value.split(",").map(Number);
    return Number.isFinite(longitude) && Number.isFinite(latitude)
      ? { longitude, latitude, coordinateSystem: "GCJ-02" }
      : null;
  }).filter(Boolean).slice(0, 600);
}

function straightLineMeters(left, right) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function navigationRouteUrl(origin, destination, mode) {
  const parameters = new URLSearchParams({
    from: `${coordinateString(origin.coordinates)},${origin.label}`,
    to: `${coordinateString(destination.coordinates)},${destination.label}`,
    mode: mode === "transit" ? "bus" : mode === "walk" ? "walk" : "car",
    policy: mode === "transit" ? "2" : "0",
    src: "travel-agent-v1",
    callnative: "0",
  });
  return `https://uri.amap.com/navigation?${parameters}`;
}

function routeStep({ item, kind, instruction, line = null, origin = null, destination = null, duration, distance }) {
  const walkType = kind === "walk"
    ? amapWalkTypeMetadata(item?.navi?.walk_type ?? item?.walk_type)
    : null;
  return {
    kind,
    instruction,
    line,
    origin,
    destination,
    durationMinutes: secondsToMinutes(duration),
    distanceMeters: numberOrNull(distance),
    polyline: polylinePoints(item?.polyline),
    walkType,
    accessibilityFeatures: accessibilityFeaturesForWalkType(walkType),
  };
}

function routeAccessibilityFeatures(steps) {
  return [...new Map(steps
    .flatMap((step) => step.accessibilityFeatures ?? [])
    .map((feature) => [feature.kind, feature])).values()];
}

function withRouteAccessibility(alternative) {
  const accessibilityFeatures = routeAccessibilityFeatures(alternative.steps ?? []);
  return {
    ...alternative,
    accessibilityFeatures,
    accessibilityAssessment: {
      hasStairs: accessibilityFeatures.some((feature) => feature.kind === "stairs"),
      hasElevator: accessibilityFeatures.some((feature) => feature.kind === "elevator"),
      hasEscalator: accessibilityFeatures.some((feature) => feature.kind === "escalator"),
      hasRamp: accessibilityFeatures.some((feature) => feature.kind === "ramp"),
      stepFreeContinuity: "not_verified",
      realTimeStatus: false,
    },
  };
}

function normalizeWalkingAlternative(payload, origin, destination) {
  const path = array(payload?.route?.paths)[0];
  if (!path) return null;
  const steps = array(path.steps).map((item) => routeStep({
    item,
    kind: "walk",
    instruction: text(item?.instruction, 500) || "按步行路线前往",
    duration: item?.cost?.duration ?? item?.duration,
    distance: item?.step_distance ?? item?.distance,
  }));
  return withRouteAccessibility({
    mode: "walk",
    totalMinutes: secondsToMinutes(path?.cost?.duration ?? path?.duration) ?? 1,
    distanceMeters: numberOrNull(path.distance),
    walkingMeters: numberOrNull(path.distance),
    transfers: 0,
    estimatedFareCny: 0,
    scheduleBasis: "query_time_estimate",
    realTimeArrival: false,
    navigationUrl: navigationRouteUrl(origin, destination, "walk"),
    polyline: polylinePoints(array(path.steps).map((item) => item?.polyline)),
    steps: steps.length ? steps : [routeStep({ item: null, kind: "walk", instruction: `步行前往${destination.label}`, origin: origin.label, destination: destination.label, duration: path?.cost?.duration ?? path?.duration, distance: path.distance })],
  });
}

function normalizeDrivingAlternative(payload, origin, destination, mode = "taxi") {
  const path = array(payload?.route?.paths)[0];
  if (!path) return null;
  const steps = array(path.steps).slice(0, 12).map((item) => ({
    kind: mode,
    instruction: text(item?.instruction, 500) || "按驾车路线前往",
    line: null,
    origin: null,
    destination: null,
    durationMinutes: secondsToMinutes(item?.cost?.duration ?? item?.duration),
    distanceMeters: numberOrNull(item?.step_distance ?? item?.distance),
    polyline: polylinePoints(item?.polyline),
  }));
  const taxiFare = numberOrNull(path?.cost?.taxi ?? path?.cost?.taxi_fee ?? payload?.route?.taxi_cost);
  return {
    mode,
    totalMinutes: secondsToMinutes(path?.cost?.duration ?? path?.duration) ?? 1,
    distanceMeters: numberOrNull(path.distance),
    walkingMeters: 0,
    transfers: 0,
    estimatedFareCny: mode === "drive" ? null : taxiFare,
    scheduleBasis: "query_time_estimate",
    realTimeArrival: false,
    navigationUrl: navigationRouteUrl(origin, destination, "taxi"),
    polyline: polylinePoints(array(path.steps).map((item) => item?.polyline)),
    steps: steps.length ? steps : [{ kind: "taxi", instruction: `驾车或打车前往${destination.label}`, line: null, origin: origin.label, destination: destination.label, durationMinutes: secondsToMinutes(path?.cost?.duration ?? path?.duration), distanceMeters: numberOrNull(path.distance) }],
  };
}

function normalizeTransitAlternative(payload, origin, destination) {
  const transit = array(payload?.route?.transits)[0];
  if (!transit) return null;
  const steps = [];
  const polylines = [];
  let transitLineCount = 0;
  for (const segment of array(transit.segments)) {
    const segmentPolylineCount = polylines.length;
    for (const walking of array(segment?.walking)) {
      for (const item of array(walking?.steps)) {
        steps.push(routeStep({ item, kind: "walk", instruction: text(item?.instruction, 500) || "步行衔接", duration: item?.duration, distance: item?.distance }));
        if (item?.polyline) polylines.push(item.polyline);
      }
    }
    for (const bus of array(segment?.bus)) {
      for (const line of array(bus?.buslines)) {
        transitLineCount += 1;
        const lineName = text(line?.name, 160) || "公共交通";
        const originName = text(line?.departure_stop?.name, 160) || null;
        const destinationName = text(line?.arrival_stop?.name, 160) || null;
        steps.push({
          kind: transitLineCount > 1 ? "transfer" : "ride",
          instruction: [originName ? `从${originName}` : null, `乘坐${lineName}`, destinationName ? `到${destinationName}` : null].filter(Boolean).join("，"),
          line: lineName,
          origin: originName,
          destination: destinationName,
          durationMinutes: secondsToMinutes(line?.duration),
          distanceMeters: numberOrNull(line?.distance),
          polyline: polylinePoints(line?.polyline),
        });
        if (line?.polyline) polylines.push(line.polyline);
      }
    }
    for (const railway of array(segment?.railway)) {
      const lineName = text(railway?.name, 160) || "轨道交通";
      transitLineCount += 1;
      steps.push({
        kind: transitLineCount > 1 ? "transfer" : "ride",
        instruction: `乘坐${lineName}`,
        line: lineName,
        origin: text(railway?.departure_stop?.name, 160) || null,
        destination: text(railway?.arrival_stop?.name, 160) || null,
        durationMinutes: secondsToMinutes(railway?.time),
        distanceMeters: numberOrNull(railway?.distance),
        polyline: polylinePoints([
          railway?.polyline,
          railway?.path,
          ...array(railway?.steps).map((item) => item?.polyline),
        ]),
      });
      if (railway?.polyline) polylines.push(railway.polyline);
      if (railway?.path) polylines.push(railway.path);
      for (const item of array(railway?.steps)) if (item?.polyline) polylines.push(item.polyline);
    }
    for (const taxi of array(segment?.taxi)) {
      steps.push({
        kind: "taxi",
        instruction: [text(taxi?.startname, 160), text(taxi?.endname, 160)].filter(Boolean).length
          ? `打车从${text(taxi?.startname, 160) || "上车点"}前往${text(taxi?.endname, 160) || "下车点"}`
          : "打车衔接",
        line: null,
        origin: text(taxi?.startname, 160) || null,
        destination: text(taxi?.endname, 160) || null,
        durationMinutes: secondsToMinutes(taxi?.drivetime),
        distanceMeters: numberOrNull(taxi?.distance),
        polyline: polylinePoints(taxi?.polyline),
      });
      if (taxi?.polyline) polylines.push(taxi.polyline);
    }
    // V5 may return the drawable transit geometry on the segment instead of
    // the nested bus/railway object. Use it only when that segment yielded no
    // detailed geometry; never synthesize a line from its endpoints.
    if (polylines.length === segmentPolylineCount && segment?.polyline) polylines.push(segment.polyline);
  }
  if (!polylines.length && transit?.polyline) polylines.push(transit.polyline);
  const walkingMeters = numberOrNull(transit.walking_distance)
    ?? steps.filter((item) => item.kind === "walk").reduce((sum, item) => sum + Number(item.distanceMeters ?? 0), 0);
  return withRouteAccessibility({
    mode: "transit",
    totalMinutes: secondsToMinutes(transit?.cost?.duration ?? transit?.duration) ?? 1,
    distanceMeters: numberOrNull(transit.distance),
    walkingMeters,
    transfers: Math.max(0, transitLineCount - 1),
    estimatedFareCny: numberOrNull(transit?.cost?.transit_fee ?? transit?.cost),
    scheduleBasis: "scheduled_service",
    realTimeArrival: false,
    navigationUrl: navigationRouteUrl(origin, destination, "transit"),
    polyline: polylinePoints(polylines),
    steps: steps.length ? steps : [{ kind: "ride", instruction: `乘公共交通前往${destination.label}`, line: null, origin: origin.label, destination: destination.label, durationMinutes: secondsToMinutes(transit?.cost?.duration ?? transit?.duration), distanceMeters: numberOrNull(transit.distance) }],
  });
}

function mobilityConstraintProfile(brief, travelers) {
  const structured = travelers.map((traveler) => ({ travelerId: traveler.travelerId, mobility: traveler.careNeeds?.mobility ?? {} }));
  const constrained = structured.filter(({ mobility }) => Object.values(mobility).some((value) => value === true || Number.isFinite(value)));
  const walkingLimits = constrained.map(({ mobility }) => mobility.maxContinuousWalkMeters).filter(Number.isFinite);
  const transferLimits = constrained.map(({ mobility }) => mobility.maxTransfers).filter(Number.isFinite);
  const reducedMobility = constrained.length > 0;
  const explicitMaxWalkingMeters = walkingLimits.length ? Math.min(...walkingLimits) : null;
  const explicitMaxTransfers = transferLimits.length ? Math.min(...transferLimits) : null;
  return {
    reducedMobility,
    constrainedTravelerIds: constrained.map(({ travelerId }) => travelerId),
    maxWalkingMeters: explicitMaxWalkingMeters,
    maxTransfers: explicitMaxTransfers,
    planningWalkingTarget: explicitMaxWalkingMeters ?? (reducedMobility ? 800 : 1_500),
    planningTransferTarget: explicitMaxTransfers ?? (reducedMobility ? 1 : 3),
    walkingTargetSource: explicitMaxWalkingMeters != null ? "traveler_explicit" : reducedMobility ? "reduced_mobility_default" : "general_default",
    transferTargetSource: explicitMaxTransfers != null ? "traveler_explicit" : reducedMobility ? "reduced_mobility_default" : "general_default",
    stepFreeRequired: constrained.some(({ mobility }) => mobility.stepFreeRequired === true),
    avoidStairs: constrained.some(({ mobility }) => mobility.avoidStairs === true),
  };
}

function chooseRouteAlternative(alternatives, constraints) {
  const byMode = Object.fromEntries(alternatives.map((item) => [item.mode, item]));
  const conflictsWithStairs = (alternative) => (constraints.stepFreeRequired || constraints.avoidStairs)
    && alternative?.accessibilityAssessment?.hasStairs === true;
  const transit = byMode.transit ?? null;
  const taxi = byMode.taxi ?? null;
  const walk = byMode.walk ?? null;
  const transitWalking = Number(transit?.walkingMeters ?? Number.POSITIVE_INFINITY);
  const transitTransfers = Number(transit?.transfers ?? Number.POSITIVE_INFINITY);
  const walkingExceeded = Boolean(transit) && transitWalking > constraints.planningWalkingTarget;
  const transfersExceeded = Boolean(transit) && transitTransfers > constraints.planningTransferTarget;
  const knownStairConflict = Boolean(transit) && conflictsWithStairs(transit);
  const accessibilityStatus = knownStairConflict
    ? "stairs_detected"
    : transit?.accessibilityAssessment?.stepFreeContinuity === "verified"
      ? "verified"
      : "not_verified";
  const audit = {
    thresholds: {
      walkingMeters: constraints.planningWalkingTarget,
      transfers: constraints.planningTransferTarget,
      walkingSource: constraints.walkingTargetSource,
      transferSource: constraints.transferTargetSource,
    },
    transit: transit ? {
      totalMinutes: transit.totalMinutes,
      walkingMeters: transit.walkingMeters,
      transfers: transit.transfers,
      estimatedFareCny: transit.estimatedFareCny,
      walkingExceeded,
      transfersExceeded,
      hasStairs: transit.accessibilityAssessment?.hasStairs === true,
      hasElevator: transit.accessibilityAssessment?.hasElevator === true,
      hasEscalator: transit.accessibilityAssessment?.hasEscalator === true,
      hasRamp: transit.accessibilityAssessment?.hasRamp === true,
      stepFreeContinuity: transit.accessibilityAssessment?.stepFreeContinuity ?? "not_verified",
    } : null,
    taxi: taxi ? { totalMinutes: taxi.totalMinutes, walkingMeters: taxi.walkingMeters, transfers: taxi.transfers, estimatedFareCny: taxi.estimatedFareCny } : null,
    walk: walk ? { totalMinutes: walk.totalMinutes, distanceMeters: walk.distanceMeters } : null,
    triggers: [
      ...(walkingExceeded ? ["transit_walking_exceeds_target"] : []),
      ...(transfersExceeded ? ["transit_transfers_exceed_target"] : []),
      ...(knownStairConflict ? ["mapped_stairs_conflict"] : []),
    ],
    accessibilityEvidence: { status: accessibilityStatus, directTrigger: knownStairConflict },
  };
  if (byMode.walk && !conflictsWithStairs(byMode.walk) && byMode.walk.distanceMeters <= Math.min(1_200, constraints.planningWalkingTarget)) {
    return { mode: "walk", rationale: `步行全程约 ${Math.round(byMode.walk.distanceMeters)} 米，不超过当前 ${Math.min(1_200, constraints.planningWalkingTarget)} 米目标，且不需要换乘。`, audit };
  }
  if (constraints.reducedMobility) {
    if (transit && !knownStairConflict && !walkingExceeded && !transfersExceeded) {
      const evidence = accessibilityStatus === "verified" ? "无台阶连续性已有证据" : "无台阶连续性仍待核验";
      return { mode: "transit", rationale: `公交地铁约 ${transit.totalMinutes} 分钟，步行 ${Math.round(transit.walkingMeters ?? 0)} 米（目标不超过 ${constraints.planningWalkingTarget} 米），换乘 ${transit.transfers ?? 0} 次（目标不超过 ${constraints.planningTransferTarget} 次）；${evidence}。`, audit };
    }
    if (taxi) {
      const triggers = [
        ...(walkingExceeded ? [`公交步行 ${Math.round(transitWalking)} 米，超过当前 ${constraints.planningWalkingTarget} 米目标`] : []),
        ...(transfersExceeded ? [`公交需换乘 ${transitTransfers} 次，超过当前 ${constraints.planningTransferTarget} 次目标`] : []),
        ...(knownStairConflict ? ["路线资料明确包含楼梯，与避开楼梯要求冲突"] : []),
        ...(!transit ? ["本次没有取得可比较的公交地铁方案"] : []),
      ];
      const taxiSummary = `打车约 ${taxi.totalMinutes} 分钟、步行 ${Math.round(taxi.walkingMeters ?? 0)} 米、换乘 ${taxi.transfers ?? 0} 次`;
      const accessibility = accessibilityStatus === "not_verified"
        ? "电梯与连续无台阶状态仍待核验；该未知项不是本次推荐打车的直接触发条件"
        : accessibilityStatus === "stairs_detected"
          ? "已发现楼梯冲突"
          : "连续无台阶已有证据";
      return { mode: "taxi", rationale: `${triggers.join("；")}。${taxiSummary}，因此优先打车。${accessibility}。`, audit };
    }
  }
  if (byMode.transit && byMode.transit.totalMinutes <= Number(byMode.taxi?.totalMinutes ?? Infinity) + 20) {
    return { mode: "transit", rationale: `公交地铁约 ${byMode.transit.totalMinutes} 分钟、步行 ${Math.round(byMode.transit.walkingMeters ?? 0)} 米、换乘 ${byMode.transit.transfers ?? 0} 次，时间与当前目标可接受。`, audit };
  }
  if (byMode.taxi) return { mode: "taxi", rationale: `打车约 ${byMode.taxi.totalMinutes} 分钟、步行 ${Math.round(byMode.taxi.walkingMeters ?? 0)} 米、换乘 ${byMode.taxi.transfers ?? 0} 次，当前预计更直接。`, audit };
  const fallback = alternatives[0];
  return {
    mode: fallback.mode,
    rationale: conflictsWithStairs(fallback)
      ? "当前仅返回了含阶梯的路线，与避开台阶要求冲突，不能作为最终可执行路线。"
      : "采用当前可核验的路线方案。",
    audit,
  };
}

export class AmapTravelResearchProvider {
  constructor({ apiKey, apiSecret, fetchImpl = globalThis.fetch, clock, timeoutMs = 8_000, requestIntervalMs, rateLimitRetryMs, enabled = true } = {}) {
    this.apiKey = text(apiKey, 512);
    this.apiSecret = text(apiSecret, 512);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.requestIntervalMs = Number.isFinite(requestIntervalMs) ? Math.max(0, requestIntervalMs) : fetchImpl === globalThis.fetch ? 1_200 : 0;
    this.rateLimitRetryMs = Number.isFinite(rateLimitRetryMs) ? Math.max(0, rateLimitRetryMs) : fetchImpl === globalThis.fetch ? 2_200 : 0;
    this.lastRequestStartedAt = 0;
    this.requestSchedule = Promise.resolve();
    this.poiApiVersion = "v5";
    this.enabled = enabled === true;
  }

  async waitForRequestSlot(signal = currentTravelExecution()?.signal) {
    signal?.throwIfAborted();
    const scheduled = this.requestSchedule.then(async () => {
      signal?.throwIfAborted();
      const remaining = this.lastRequestStartedAt + this.requestIntervalMs - Date.now();
      if (remaining > 0) await delay(remaining, undefined, { signal });
      signal?.throwIfAborted();
      this.lastRequestStartedAt = Date.now();
    });
    this.requestSchedule = scheduled.catch(() => {});
    if (!signal) { await scheduled; return; }
    let abort;
    try {
      await Promise.race([scheduled, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }

  get status() {
    return this.apiKey && this.enabled ? "configured" : "provider_unavailable";
  }

  get canRenderMap() {
    return this.status === "configured";
  }

  async requestJson(endpoint, values, provider, externalSignal = null) {
    externalSignal ??= currentTravelExecution()?.signal;
    const parameters = signedAmapParameters({ ...values, key: this.apiKey }, this.apiSecret);
    await this.waitForRequestSlot(externalSignal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
      const response = await this.fetchImpl(`${endpoint}?${parameters}`, { method: "GET", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw providerError("SOURCE_UNAVAILABLE", { provider, httpStatus: response.status });
      const payload = await response.json();
      if (String(payload?.status) !== "1" || String(payload?.infocode) !== "10000") {
        throw providerError(amapStatusCode(String(payload?.infocode ?? "")), {
          provider,
          infoCode: text(payload?.infocode, 20),
          info: text(payload?.info, 160),
        });
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw providerError("SOURCE_UNAVAILABLE", { provider, reason: externalSignal?.aborted ? "cancelled" : "timeout" });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestJsonWithRetry(endpoint, values, provider, externalSignal = null) {
    try {
      return await this.requestJson(endpoint, values, provider, externalSignal);
    } catch (error) {
      if (!isTransientQpsLimit(error)) throw error;
      if (this.rateLimitRetryMs > 0) await delay(this.rateLimitRetryMs, undefined, { signal: externalSignal ?? currentTravelExecution()?.signal });
      return this.requestJson(endpoint, values, provider, externalSignal);
    }
  }

  async searchDomainVersion({ destination, domain, apiVersion, query = { keyword: null, broad: true }, criteria = {} }) {
    const search = DOMAIN_SEARCH[domain];
    if (!search) throw providerError("unsupported_research_domain", { domain });
    const isV5 = apiVersion === "v5";
    const payload = await this.requestJsonWithRetry(
      isV5 ? AMAP_PLACE_ENDPOINT : AMAP_PLACE_V3_ENDPOINT,
      isV5
        ? { ...(query.keyword ? { keywords: query.keyword } : {}), types: search.types, region: destination, city_limit: "true", show_fields: "business,navi,indoor,photos", page_size: "6", page_num: "1", output: "json" }
        : { ...(query.keyword ? { keywords: query.keyword } : {}), types: search.types, city: destination, citylimit: "true", extensions: "all", offset: "6", page: "1", output: "json" },
      isV5 ? "amap_poi_v5" : "amap_poi_v3",
    );
    const checkedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    return (Array.isArray(payload.pois) ? payload.pois : [])
      .filter((poi) => poiMatchesDomain(poi, domain))
      .map((poi) => normalizePoi(poi, { domain, checkedAt, apiVersion, query, criteria }));
  }

  async searchDomain(input) {
    if (this.poiApiVersion === "v3") return this.searchDomainVersion({ ...input, apiVersion: "v3" });
    try {
      return await this.searchDomainVersion({ ...input, apiVersion: "v5" });
    } catch (error) {
      if (!(["10041", "10012"].includes(String(error?.details?.infoCode ?? "")))) throw error;
      this.poiApiVersion = "v3";
      return this.searchDomainVersion({ ...input, apiVersion: "v3" });
    }
  }

  async resolveMobilityStop(node, destination, destinationGeocode, signal = null) {
    const intercityArrival = node?.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(node?.operability?.mobilityRole)
      ? (node.operability.arrivalRouteAnchor ?? node.operability.arrivalPlace)
      : null;
    const existing = coordinatePair(node);
    if (existing) {
      return {
        nodeId: text(node?.nodeId, 128) || null,
        label: text(node?.title, 200) || text(node?.location?.label, 200) || "地点",
        coordinates: existing,
        citycode: text(node?.location?.citycode, 20) || text(destinationGeocode?.citycode, 20) || null,
        adcode: text(node?.location?.adcode, 20) || text(destinationGeocode?.adcode, 20) || null,
        providerPoiId: text(node?.operability?.providerPoiId, 128) || null,
      };
    }
    const address = text(intercityArrival?.label, 300) || text(node?.location?.label, 300) || text(node?.title, 200);
    if (!address) return null;
    const payload = await this.requestJsonWithRetry(
      AMAP_GEOCODE_ENDPOINT,
      { address, city: text(intercityArrival?.city, 120) || destination, output: "json" },
      "amap_mobility_geocode",
      signal,
    );
    const match = array(payload?.geocodes)[0];
    const [longitude, latitude] = text(match?.location, 80).split(",").map(Number);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    return {
      nodeId: text(node?.nodeId, 128) || null,
      label: text(intercityArrival?.label, 200) || text(node?.title, 200) || address,
      coordinates: { longitude, latitude, coordinateSystem: "GCJ-02" },
      citycode: text(match?.citycode, 20) || text(destinationGeocode?.citycode, 20) || null,
      adcode: text(match?.adcode, 20) || text(destinationGeocode?.adcode, 20) || null,
      providerPoiId: text(node?.operability?.providerPoiId, 128) || null,
    };
  }

  async routeMobilityLeg({ origin, destination, brief, constraints, routeAt = null, signal = null }) {
    const routeDateTime = String(routeAt ?? "");
    const date = routeDateTime.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? isoDates(brief?.dates)[0] ?? null;
    const timeMatch = routeDateTime.match(/(?:T|\s|^)([01]?\d|2[0-3]):([0-5]\d)/)
      ?? JSON.stringify(brief ?? {}).match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    const routeTime = timeMatch ? `${Number(timeMatch[1])}-${timeMatch[2]}` : null;
    const common = {
      origin: coordinateString(origin.coordinates),
      destination: coordinateString(destination.coordinates),
      output: "json",
      show_fields: "cost,navi,polyline",
    };
    const requests = [
      this.requestJsonWithRetry(AMAP_TRANSIT_ENDPOINT, {
        ...common,
        city1: origin.citycode,
        city2: destination.citycode,
        strategy: constraints.reducedMobility ? "3" : "0",
        AlternativeRoute: "2",
        nightflag: "1",
        ...(origin.providerPoiId && destination.providerPoiId ? { originpoi: origin.providerPoiId, destinationpoi: destination.providerPoiId } : {}),
        ...(date ? { date } : {}),
        ...(routeTime ? { time: routeTime } : {}),
      }, "amap_routes_v5_transit", signal).then((payload) => array(payload?.route?.transits).slice(0, 3).map(transit => normalizeTransitAlternative({ ...payload, route: { ...payload.route, transits: [transit] } }, origin, destination))),
      this.requestJsonWithRetry(AMAP_DRIVING_ENDPOINT, {
        ...common,
        strategy: "32",
        alternative_route: "2",
        ...(origin.providerPoiId ? { origin_id: origin.providerPoiId } : {}),
        ...(destination.providerPoiId ? { destination_id: destination.providerPoiId } : {}),
      }, "amap_routes_v5_driving", signal).then((payload) => array(payload?.route?.paths).slice(0, 2).flatMap(path => (brief.vehicle ? ["taxi", "drive"] : ["taxi"]).map(mode => normalizeDrivingAlternative({ ...payload, route: { ...payload.route, paths: [path] } }, origin, destination, mode)))),
    ];
    if (straightLineMeters(origin.coordinates, destination.coordinates) <= 3_500) {
      requests.push(this.requestJsonWithRetry(AMAP_WALKING_ENDPOINT, {
        ...common,
        alternative_route: "1",
        isindoor: "1",
        ...(origin.providerPoiId ? { origin_id: origin.providerPoiId } : {}),
        ...(destination.providerPoiId ? { destination_id: destination.providerPoiId } : {}),
      }, "amap_routes_v5_walking", signal).then((payload) => normalizeWalkingAlternative(payload, origin, destination)));
    }
    const settled = await Promise.allSettled(requests);
    const alternatives = settled
      .filter((result) => result.status === "fulfilled" && result.value)
      .flatMap((result) => result.value).filter(Boolean).map(alternative => ({ ...alternative, alternativeId: routeAlternativeId(alternative) }));
    const errors = settled
      .filter((result) => result.status === "rejected")
      .map((result) => ({ code: result.reason?.code ?? "SOURCE_UNAVAILABLE", details: result.reason?.details ?? null }));
    if (!alternatives.length) return { alternatives: [], errors };
    const recommendation = chooseRouteAlternative(alternatives, constraints);
    return { alternatives, errors, recommendation };
  }

  async planMobility({ brief = {}, travelers = [], selectedNodes = [], itineraryStops = [], targetAreas = [], signal = null } = {}) {
    const destination = text(brief.destination, 120);
    if (!destination) return { schemaVersion: "trip-mobility-v1", status: "needs_context", reason: "destination_required", source: "amap_routes_v5", fabricatedResults: false };
    if (!this.apiKey || !this.enabled) return { schemaVersion: "trip-mobility-v1", status: "provider_unavailable", destination, reason: this.apiKey ? "amap_live_smoke_required" : "AMAP_API_KEY_not_configured", source: "amap_routes_v5", sourceDocumentation: AMAP_ROUTE_DOC, fabricatedResults: false };
    const selected = selectedNodes.filter((node) => node?.selected === true).sort((left, right) => {
      const leftValue = left?.operability?.arrivalAt ?? left?.operability?.planningWindow?.startAt ?? left?.time ?? left?.operability?.departureAt ?? "";
      const rightValue = right?.operability?.arrivalAt ?? right?.operability?.planningWindow?.startAt ?? right?.time ?? right?.operability?.departureAt ?? "";
      return String(leftValue).localeCompare(String(rightValue));
    });
    if (selected.length < 2) return { schemaVersion: "trip-mobility-v1", status: "needs_context", destination, reason: "at_least_two_selected_places_required", source: "amap_routes_v5", sourceDocumentation: AMAP_ROUTE_DOC, fabricatedResults: false };
    let destinationGeocode;
    try {
      const payload = await this.requestJsonWithRetry(AMAP_GEOCODE_ENDPOINT, { address: destination, city: destination, output: "json" }, "amap_mobility_city_geocode", signal);
      destinationGeocode = array(payload?.geocodes)[0] ?? null;
    } catch (error) {
      return { schemaVersion: "trip-mobility-v1", status: "provider_unavailable", destination, reason: error?.code ?? "SOURCE_UNAVAILABLE", source: "amap_routes_v5", sourceDocumentation: AMAP_ROUTE_DOC, fabricatedResults: false };
    }
    const resolved = [];
    const unresolvedNodeIds = [];
    for (const node of selected) {
      if (signal?.aborted) throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_routes_v5", reason: "cancelled" });
      try {
        const stop = await this.resolveMobilityStop(node, destination, destinationGeocode, signal);
        if (stop?.coordinates && stop.citycode) resolved.push({ node, stop });
        else unresolvedNodeIds.push(node.nodeId);
      } catch {
        unresolvedNodeIds.push(node.nodeId);
      }
    }
    const ordered = [];
    const pushStop = (entry) => {
      if (!entry) return;
      ordered.push(entry);
    };
    const resolvedByNodeId = new Map(resolved.map((entry) => [entry.node.nodeId, entry]));
    const departures = new Map();
    for (const node of selected.filter(node => itineraryStops.some(stop => stop.nodeId === node.nodeId && stop.role === "transport_departure"))) {
      const place = node.operability?.departurePlace;
      if (!place?.label) continue;
      try {
        const stop = await this.resolveMobilityStop({ ...node, title: place.label, location: null, operability: { ...node.operability, arrivalRouteAnchor: place, arrivalPlace: place } }, place.city ?? destination, destinationGeocode, signal);
        if (stop?.coordinates && stop.citycode) departures.set(node.nodeId, { node, stop });
      } catch { /* Kept as an unresolved stop, never replaced by arrival coordinates. */ }
    }
    const resolvedStay = resolved.find(({ node }) => node.domain === "stay") ?? null;
    const unresolvedStopIds = [];
    if (Array.isArray(itineraryStops) && itineraryStops.length) {
      for (const itineraryStop of itineraryStops) {
        const entry = itineraryStop.role === "transport_departure" ? departures.get(itineraryStop.nodeId) : resolvedByNodeId.get(itineraryStop.nodeId);
        if (!entry) {
          unresolvedStopIds.push(itineraryStop.stopId);
          continue;
        }
        pushStop({
          node: entry.node,
          itineraryStop,
          stop: {
            ...entry.stop,
            stopId: itineraryStop.stopId,
            label: ["intercity_arrival", "transport_departure", "transport_arrival"].includes(itineraryStop.role) ? entry.stop.label : itineraryStop.title,
            dayIndex: itineraryStop.dayIndex,
            date: itineraryStop.date,
            role: itineraryStop.role,
            startAt: itineraryStop.startAt,
            endAt: itineraryStop.endAt,
          },
        });
      }
    } else {
      const intercityArrival = resolved.find(({ node }) => node.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(node.operability?.mobilityRole)) ?? null;
      const transport = resolved.filter(({ node }) => node.domain === "transport" && !["intercity_inventory", "user_confirmed_arrival"].includes(node.operability?.mobilityRole));
      const stay = resolved.find(({ node }) => node.domain === "stay") ?? null;
      const activities = resolved.filter(({ node }) => ["play", "food"].includes(node.domain)).sort((left, right) => {
        const leftValue = left.node?.operability?.planningWindow?.startAt ?? left.node?.time ?? "";
        const rightValue = right.node?.operability?.planningWindow?.startAt ?? right.node?.time ?? "";
        return String(leftValue).localeCompare(String(rightValue));
      });
      const remaining = resolved.filter(({ node }) => !["stay", "play", "food", "transport"].includes(node.domain));
      pushStop(intercityArrival);
      pushStop(transport[0]);
      pushStop(stay);
      for (let index = 0; index < activities.length; index += 1) {
        pushStop(activities[index]);
        const currentDate = String(activities[index].node?.operability?.planningWindow?.startAt ?? activities[index].node?.time ?? "").slice(0, 10);
        const nextDate = String(activities[index + 1]?.node?.operability?.planningWindow?.startAt ?? activities[index + 1]?.node?.time ?? "").slice(0, 10);
        if (stay && (!activities[index + 1] || (currentDate && nextDate && currentDate !== nextDate))) pushStop(stay);
      }
      for (const entry of remaining) pushStop(entry);
    }
    if (ordered.length < 2) {
      return { schemaVersion: "trip-mobility-v1", status: "needs_context", destination, reason: "selected_places_need_resolvable_coordinates", source: "amap_routes_v5", coverage: { routedNodeIds: [], unresolvedNodeIds, unscheduled: true }, sourceDocumentation: AMAP_ROUTE_DOC, fabricatedResults: false };
    }
    const constraints = mobilityConstraintProfile(brief, travelers);
    const legs = [];
    const errors = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const origin = ordered[index].stop;
      const nextDestination = ordered[index + 1].stop;
      const originNode = ordered[index].node;
      const destinationNode = ordered[index + 1].node;
      const routeAt = ordered[index].itineraryStop?.endAt ?? ordered[index + 1].itineraryStop?.startAt ?? (originNode.domain === "stay"
        ? destinationNode.operability?.planningWindow?.startAt ?? destinationNode.time
        : originNode.operability?.planningWindow?.endAt ?? originNode.operability?.arrivalAt ?? originNode.time ?? destinationNode.operability?.planningWindow?.startAt ?? destinationNode.time);
      const samePlace = origin.nodeId === nextDestination.nodeId;
      if (signal?.aborted) throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_routes_v5", reason: "cancelled" });
      if (samePlace && origin.role === "transport_departure" && nextDestination.role === "transport_arrival") {
        const ride = scheduledRideLeg(ordered[index].itineraryStop, ordered[index + 1].itineraryStop, originNode);
        if (ride) legs.push({ ...ride, origin, destination: nextDestination });
        continue;
      }
      const result = samePlace ? {
        errors: [],
        recommendation: { mode: "walk", rationale: "同一住宿的返回与次日出发节点，不产生额外移动。", audit: null },
        alternatives: [{ mode: "walk", totalMinutes: 0, distanceMeters: 0, walkingMeters: 0, transfers: 0, estimatedFareCny: 0, scheduleBasis: "query_time_estimate", realTimeArrival: false, navigationUrl: null, polyline: [], steps: [], accessibilityFeatures: [], accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false } }],
      } : await this.routeMobilityLeg({ origin, destination: nextDestination, brief, constraints, routeAt, signal });
      errors.push(...result.errors);
      if (!result.alternatives.length) continue;
      const isArrivalTransfer = ordered[index].node.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(ordered[index].node.operability?.mobilityRole);
      legs.push({
        legId: `mobility_${shortHash(`${origin.stopId ?? origin.nodeId}:${nextDestination.stopId ?? nextDestination.nodeId}:${index}`)}`,
        origin,
        destination: nextDestination,
        recommendedMode: result.recommendation.mode,
        rationale: `${isArrivalTransfer ? "这是抵达后的接驳。" : ""}${result.recommendation.rationale}`,
        recommendationAudit: result.recommendation.audit,
        alternatives: result.alternatives,
      });
    }
    const checkedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    const routedNodeIds = unique(legs.flatMap((leg) => [leg.origin.nodeId, leg.destination.nodeId]));
    const routedStopIds = unique(legs.flatMap((leg) => [leg.origin.stopId, leg.destination.stopId]).filter(Boolean));
    const recommendedFeatures = legs.flatMap((leg) => leg.alternatives
      .find((alternative) => alternative.mode === leg.recommendedMode)?.accessibilityFeatures ?? []);
    const hasMappedAccessibilityFeature = recommendedFeatures.length > 0;
    const hasStairConflict = (constraints.stepFreeRequired || constraints.avoidStairs)
      && recommendedFeatures.some((feature) => feature.kind === "stairs");
    const stayAnchorFits = [];
    if (resolvedStay && Array.isArray(targetAreas)) {
      for (const area of unique(targetAreas.map((item) => text(item, 80)).filter(Boolean)).slice(0, 2)) {
        try {
          if (signal?.aborted) break;
          const payload = await this.requestJsonWithRetry(AMAP_GEOCODE_ENDPOINT, { address: `${destination}${area}`, city: destination, output: "json" }, "amap_stay_anchor_geocode", signal);
          const match = array(payload?.geocodes)[0];
          const [longitude, latitude] = text(match?.location, 80).split(",").map(Number);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
          const anchor = { nodeId: null, label: area, coordinates: { longitude, latitude, coordinateSystem: "GCJ-02" }, citycode: text(match?.citycode, 20) || resolvedStay.stop.citycode, adcode: text(match?.adcode, 20) || resolvedStay.stop.adcode, providerPoiId: null };
          const routed = await this.routeMobilityLeg({ origin: resolvedStay.stop, destination: anchor, brief, constraints, routeAt: itineraryStops.find((stop) => stop.nodeId === resolvedStay.node.nodeId)?.endAt ?? null, signal });
          if (!routed.alternatives.length) continue;
          stayAnchorFits.push({
            area,
            recommendedMode: routed.recommendation.mode,
            checkedAt,
            source: "amap_routes_v5",
            alternatives: routed.alternatives.map((alternative) => ({ mode: alternative.mode, totalMinutes: alternative.totalMinutes, walkingMeters: alternative.walkingMeters, transfers: alternative.transfers, estimatedFareCny: alternative.estimatedFareCny })),
          });
        } catch {
          // Missing anchor routes are reported as unknown; they never become a positive location-fit claim.
        }
      }
    }
    return {
      schemaVersion: "trip-mobility-v1",
      status: legs.length === ordered.length - 1 && !unresolvedNodeIds.length && !unresolvedStopIds.length ? "completed" : legs.length ? "partial" : "provider_unavailable",
      destination,
      source: "amap_routes_v5",
      checkedAt,
      freshUntil: new Date(new Date(checkedAt).getTime() + 3 * 60 * 60 * 1_000).toISOString(),
      coverage: { routedNodeIds, unresolvedNodeIds, routedStopIds, unresolvedStopIds, unscheduled: !(Array.isArray(itineraryStops) && itineraryStops.length) },
      legs,
      travelerFit: {
        constrainedTravelerIds: constraints.constrainedTravelerIds,
        maxContinuousWalkMeters: constraints.maxWalkingMeters,
        maxTransfers: constraints.maxTransfers,
        planningWalkingTarget: constraints.planningWalkingTarget,
        planningTransferTarget: constraints.planningTransferTarget,
        walkingTargetSource: constraints.walkingTargetSource,
        transferTargetSource: constraints.transferTargetSource,
        stepFreeRequired: constraints.stepFreeRequired,
        avoidStairs: constraints.avoidStairs,
        accessibilityEvidence: constraints.stepFreeRequired || constraints.avoidStairs
          ? (hasMappedAccessibilityFeature ? "partial" : "unverified")
          : "not_required",
        stayAnchorFits,
      },
      reason: legs.length ? null : errors[0]?.code ?? "route_not_returned",
      caveats: [
        "路线、时间和费用是查询时估算，不代表实时公交到站、即时叫车供给或最终车费。",
        ...(Array.isArray(itineraryStops) && itineraryStops.length ? [] : ["当前地点尚未形成按天时刻表；路线用于核验已选地点之间的移动负担，日程确定后必须重新计算。"]),
        ...(constraints.stepFreeRequired || constraints.avoidStairs ? [
          hasMappedAccessibilityFeature
            ? "路线已保留高德返回的扶梯、直梯、阶梯或斜坡信息；它们不是实时运行状态，也不能单独证明连续无障碍，建议现场确认。"
            : "本次路线没有返回可用于判断直梯、扶梯、阶梯或斜坡的资料；连续无障碍仍待核验。",
        ] : []),
        ...(hasStairConflict ? ["当前推荐路线资料中仍含阶梯，与避开台阶要求冲突，必须更换路线或交通方式后再执行。"] : []),
        ...(errors.length ? ["部分出行方式暂未返回，本轮只展示已核验的路线方案。"] : []),
      ],
      sourceDocumentation: AMAP_ROUTE_DOC,
      fabricatedResults: false,
    };
  }

  async getWeather({ brief = {} } = {}) {
    const destination = text(brief.destination, 120);
    if (!destination) return { schemaVersion: "trip-weather-v1", status: "provider_unavailable", reason: "destination_required", fabricatedResults: false };
    if (!this.apiKey || !this.enabled) return { schemaVersion: "trip-weather-v1", status: "provider_unavailable", reason: this.apiKey ? "amap_live_smoke_required" : "AMAP_API_KEY_not_configured", fabricatedResults: false };
    try {
      const geocode = await this.requestJsonWithRetry(AMAP_GEOCODE_ENDPOINT, { address: destination, city: destination, output: "json" }, "amap_geocode");
      const match = Array.isArray(geocode.geocodes) ? geocode.geocodes.find((item) => text(item?.adcode, 20)) : null;
      const adcode = text(match?.adcode, 20);
      if (!adcode) return { schemaVersion: "trip-weather-v1", status: "EMPTY_VERIFIED", reason: "destination_adcode_not_found", fabricatedResults: false };
      const payload = await this.requestJsonWithRetry(AMAP_WEATHER_ENDPOINT, { city: adcode, extensions: "all", output: "json" }, "amap_weather");
      return normalizeForecast(payload, brief, new Date(this.clock?.() ?? Date.now()).toISOString());
    } catch (error) {
      return {
        schemaVersion: "trip-weather-v1",
        status: error?.code ?? "SOURCE_UNAVAILABLE",
        reason: error?.code ?? "SOURCE_UNAVAILABLE",
        diagnostic: error?.details ?? null,
        sourceDocumentation: AMAP_WEATHER_DOC,
        fabricatedResults: false,
      };
    }
  }

  async research({ brief = {}, domains = DEFAULT_DOMAINS, criteria = null, existingWeather = null, includeWeather = true } = {}) {
    const destination = text(brief.destination, 120);
    if (!destination) throw providerError("destination_required");
    if (!this.apiKey) {
      return {
        schemaVersion: "travel-provider-result-v1",
        status: "provider_unavailable",
        provider: "amap_web_service",
        reason: "AMAP_API_KEY_not_configured",
        fabricatedResults: false,
      };
    }
    if (!this.enabled) {
      return {
        schemaVersion: "travel-provider-result-v1",
        status: "provider_unavailable",
        provider: "amap_web_service",
        reason: "amap_live_smoke_required",
        fabricatedResults: false,
      };
    }
    const requestedDomains = unique(domains).filter((domain) => DEFAULT_DOMAINS.includes(domain));
    if (!requestedDomains.length) throw providerError("research_domains_required");
    const byDomain = Object.fromEntries(requestedDomains.map((domain) => [domain, []]));
    const errors = [];
    for (const domain of requestedDomains) {
      const domainCriteria = criteria?.byDomain?.[domain] ?? {};
      const searches = domainSearchQueries(domain, domainCriteria);
      const candidates = [];
      for (const query of searches) {
        try {
          candidates.push(...await this.searchDomain({ destination, domain, query, criteria: domainCriteria }));
        } catch (error) {
          errors.push({ code: error?.code ?? "SOURCE_UNAVAILABLE", domain, queryReason: query.reason, details: error?.details ?? null });
        }
      }
      byDomain[domain] = [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()].slice(0, 8);
    }
    const weather = includeWeather ? (reusableWeather(existingWeather, brief, this.clock) ?? await this.getWeather({ brief })) : null;
    const resultCount = Object.values(byDomain).reduce((total, candidates) => total + candidates.length, 0);
    if (!resultCount && weather?.status !== "completed") {
      return {
        schemaVersion: "travel-provider-result-v1",
        status: errors.some((error) => error.code === "AUTH_REQUIRED")
          ? "AUTH_REQUIRED"
          : errors.some((error) => error.code === "ACCOUNT_LIMITED")
            ? "ACCOUNT_LIMITED"
            : errors.some((error) => error.code === "RATE_LIMITED")
              ? "RATE_LIMITED"
              : "EMPTY_VERIFIED",
        provider: "amap_web_service",
        reason: errors[0]?.code ?? "EMPTY_VERIFIED",
        errors,
        ...(weather ? { weather } : {}),
        fabricatedResults: false,
      };
    }
    return {
      schemaVersion: "travel-provider-result-v1",
      status: "completed",
      provider: "amap_web_service",
      providerLabel: "高德地图 Web 服务",
      destination,
      checkedAt: new Date(this.clock?.() ?? Date.now()).toISOString(),
      byDomain,
      partial: errors.length > 0 || requestedDomains.some((domain) => byDomain[domain].length === 0),
      errors,
      ...(weather ? { weather } : {}),
      caveats: [
        "高德综合排序用于地点发现，不代表独立口碑结论。",
        ...(this.poiApiVersion === "v3" ? ["当前账号的 POI 2.0 权益不可用，地点已自动切换为高德基础检索；营业时段、入口与室内字段可能较少。"] : []),
        ...(weather?.caveat ? [weather.caveat] : []),
      ],
      fabricatedResults: false,
      sourceDocumentation: this.poiApiVersion === "v5" ? AMAP_PLACE_DOC : AMAP_PLACE_V3_DOC,
    };
  }

  async renderStaticMap({ points = [], paths = [], width = 750, height = 360 } = {}) {
    if (!this.apiKey || !this.enabled) throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_static_map" });
    const safePoints = points.filter((point) => Number.isFinite(point?.coordinates?.longitude) && Number.isFinite(point?.coordinates?.latitude)).slice(0, 10);
    if (!safePoints.length) throw providerError("EMPTY_VERIFIED", { provider: "amap_static_map" });
    const markerLocations = safePoints.map((point) => `${point.coordinates.longitude},${point.coordinates.latitude}`).join(";");
    const safePaths = paths.map((path) => array(path).filter((point) => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude)).slice(0, 80))
      .filter((path) => path.length >= 2)
      .slice(0, 4);
    const parameters = signedAmapParameters({
      key: this.apiKey,
      size: `${Math.min(1024, Math.max(320, width))}*${Math.min(1024, Math.max(240, height))}`,
      scale: "2",
      markers: `mid,0xFF5A4F,:${markerLocations}`,
      ...(safePaths.length ? { paths: safePaths.map((path, index) => `${index === 0 ? 8 : 5},${index === 0 ? "0x216DD7" : "0x5F8FB0"},0.85,,:${path.map(coordinateString).join(";")}`).join("|") } : {}),
    }, this.apiSecret);
    await this.waitForRequestSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${AMAP_STATIC_MAP_ENDPOINT}?${parameters}`, { method: "GET", headers: { Accept: "image/*" }, signal: controller.signal });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.startsWith("image/")) {
        if (contentType.includes("json")) {
          const payload = await response.json().catch(() => null);
          throw providerError(amapStatusCode(String(payload?.infocode ?? "")), {
            provider: "amap_static_map",
            httpStatus: response.status,
            infoCode: text(payload?.infocode, 20),
            info: text(payload?.info, 160),
          });
        }
        throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_static_map", httpStatus: response.status });
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > 5_000_000) throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_static_map", reason: "invalid_image_size" });
      return { body, contentType, checkedAt: new Date(this.clock?.() ?? Date.now()).toISOString() };
    } catch (error) {
      if (error?.name === "AbortError") throw providerError("SOURCE_UNAVAILABLE", { provider: "amap_static_map", reason: "timeout" });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createAmapTravelResearchProvider(env = process.env, options = {}) {
  const enabled = Boolean(env.AMAP_API_KEY) && env.TRAVEL_AGENT_AMAP_SMOKE_STATUS === "passed_live_smoke";
  return new AmapTravelResearchProvider({ apiKey: env.AMAP_API_KEY, apiSecret: env.AMAP_API_SECRET, enabled, ...options });
}

export {
  AMAP_GEOCODE_ENDPOINT,
  AMAP_PLACE_DOC,
  AMAP_PLACE_ENDPOINT,
  AMAP_PLACE_V3_DOC,
  AMAP_PLACE_V3_ENDPOINT,
  AMAP_ROUTE_DOC,
  AMAP_DRIVING_ENDPOINT,
  AMAP_TRANSIT_ENDPOINT,
  AMAP_WALKING_ENDPOINT,
  AMAP_WEATHER_DOC,
  AMAP_WEATHER_ENDPOINT,
  DOMAIN_SEARCH,
  signedAmapParameters,
};
