import { createHash } from "node:crypto";
import { createTuniuOfficialMcpClient } from "./tuniu-official-mcp.mjs";
import { intercityModes, travelDates } from "./flyai-travel-research.mjs";
import { journeyQueries, tagJourneyCandidate } from "../../travel-agent-pi-package/src/core/journey-execution.ts";

const PROVIDER = "tuniu_official_mcp";
const DOCUMENTATION = "https://open.tuniu.com/mcp/docs/";

function text(value, limit = 500) {
  if (Array.isArray(value) || (value && typeof value === "object")) return "";
  return String(value ?? "").trim().slice(0, limit);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/[¥￥,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeImage(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || !(url.hostname === "tuniucdn.com" || url.hostname.endsWith(".tuniucdn.com"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function lowestPrice(price = {}) {
  const values = Object.values(price).map(numeric).filter((value) => value != null && value > 0);
  return values.length ? Math.min(...values) : null;
}

function endpointLabel(value, kind) {
  const label = text(value, 100);
  if (!label) return null;
  if (kind === "airport") return /机场|airport/i.test(label) ? label : `${label}机场`;
  return /站$/.test(label) ? label : `${label}站`;
}

function durationMinutes(value) {
  const raw = text(value, 80);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const hours = Number(raw.match(/(\d+(?:\.\d+)?)\s*(?:h|小时|时)/i)?.[1] ?? 0);
  const minutes = Number(raw.match(/(\d+)\s*(?:m|分钟|分)/i)?.[1] ?? 0);
  const total = Math.round(hours * 60 + minutes);
  return total > 0 ? total : null;
}

const TRAIN_FARES = Object.freeze([
  ["swz", "商务座"], ["tdz", "特等座"], ["ydz", "一等座"], ["edz", "二等座"],
  ["gjrw", "高级软卧"], ["rw", "软卧"], ["dw", "动卧"], ["yw", "硬卧"],
  ["rz", "软座"], ["yz", "硬座"], ["wz", "无座"],
]);

function trainFareOptions(price = {}, seatAvailable = {}) {
  return TRAIN_FARES.flatMap(([prefix, seatClass]) => {
    const fare = numeric(price[`${prefix}Price`]);
    if (fare == null || fare <= 0) return [];
    const availableSeats = numeric(seatAvailable[`${prefix}Num`]);
    return [{ seatClass, fare, availableSeats }];
  }).sort((left, right) => left.fare - right.fare);
}

function candidate({ domain, providerRef, title, summary, checkedAt, cost = 0, media = [], location = null, operability = {} }) {
  const sourceId = `${PROVIDER}:${providerRef}`;
  const entityId = `entity_${hash(sourceId)}`;
  const claimId = `claim_${hash(`${sourceId}:${checkedAt}`)}`;
  return {
    candidateId: `${domain}_${hash(sourceId)}`,
    domain,
    title: text(title, 200),
    summary: text(summary, 900),
    sourceId,
    claimId,
    entityId,
    checkedAt,
    cost,
    price: {
      amount: cost > 0 ? cost : null,
      currency: "CNY",
      quality: cost > 0 ? "firm" : "unknown",
      basis: domain === "stay" ? "per_night_room" : "per_person_one_way",
      checkedAt,
    },
    media,
    location,
    operability: { provider: PROVIDER, providerRef, bookingProviderLabel: "途牛", researchDepth: "official_ota_search", checkedAt, ...operability },
    source: { sourceId, provider: PROVIDER, sourceType: "official_ota_search", providerPoiId: providerRef, checkedAt, documentationUrl: DOCUMENTATION, independenceGroup: sourceId, commercialBias: "ota_commercial_inventory" },
    entity: { entityId, kind: domain === "transport" ? "transport_offer" : "place", canonicalName: text(title, 200), providerRefs: [sourceId] },
    claim: { claimId, entityId, kind: "provider_fact", statement: text(summary, 1000), sourceRefs: [sourceId], sourceIndependence: "single_provider", commercialBias: "ota_commercial_inventory", confidence: 0.86, observedAt: checkedAt },
  };
}

function normalizeHotel(item, checkedAt) {
  const providerRef = text(item.hotelId, 100) || hash(`${item.hotelName}:${item.address}`);
  const cost = numeric(item.lowestPrice) ?? 0;
  const photo = safeImage(item.firstPic);
  const address = text(item.address, 240);
  const district = text(item.business, 120);
  const city = text(item.cityName, 100);
  const details = [text(item.starName, 50), text(item.brandName, 80), item.commentScore ? `评分 ${item.commentScore}` : "", cost ? `最低价 ¥${cost}` : "", text(item.roomName, 120), text(item.meal, 60), text(item.refund, 100), text(item.commentDigest, 200), text(item.address, 240)].filter(Boolean);
  return candidate({
    domain: "stay",
    providerRef,
    title: item.hotelName,
    summary: details.join(" · "),
    checkedAt,
    cost,
    media: photo ? [{ url: photo, title: text(item.hotelName, 120), source: PROVIDER }] : [],
    location: address || district || city ? { ...(address ? { address, label: address } : {}), ...(district ? { district } : {}), ...(city ? { city } : {}) } : null,
    operability: {
      rating: numeric(item.commentScore),
      priceHint: cost ? `¥${cost} 起` : null,
      roomName: text(item.roomName, 120) || null,
      roomArea: text(item.roomArea, 80) || null,
      roomWindow: text(item.roomWindow, 80) || null,
      meal: text(item.meal, 80) || null,
      refundPolicy: text(item.refund, 140) || null,
      inventoryVerified: true,
      hotelOfferStatus: "available_search_offer",
      offerFreshness: "search_time",
      hotelOffer: {
        provider: PROVIDER,
        providerLabel: "途牛",
        roomName: text(item.roomName, 120) || null,
        meal: text(item.meal, 80) || null,
        refundPolicy: text(item.refund, 140) || null,
        totalPrice: cost || null,
        currency: "CNY",
        checkedAt,
        bookingUrl: null,
        dataNature: "read_only_search_offer",
      },
    },
  });
}

function normalizeTrain(item, checkedAt, context = {}) {
  const providerRef = hash(`${item.trainNum}:${item.departStationName}:${item.destStationName}:${item.departureTime}`);
  const fareOptions = trainFareOptions(item.price, item.seatAvailable);
  const cost = fareOptions[0]?.fare ?? lowestPrice(item.price) ?? 0;
  const seatCounts = Object.values(item.seatAvailable ?? {}).map(numeric).filter((value) => value != null);
  const available = seatCounts.length ? seatCounts.reduce((sum, value) => sum + value, 0) : null;
  const departureLabel = endpointLabel(item.departStationName, "rail_station");
  const arrivalLabel = endpointLabel(item.destStationName, "rail_station");
  const serviceNumber = text(item.trainNum, 40) || null;
  const highSpeed = /^[GCD]/i.test(serviceNumber ?? "");
  const title = `${serviceNumber || "火车"} ${departureLabel || text(context.origin, 100)} → ${arrivalLabel || text(context.destination, 100)}`;
  const details = [text(item.trainType, 50), text(item.departureTime, 80), text(item.arrivalTime, 80), text(item.duration, 60), cost ? `最低席别 ¥${cost}` : "", available != null ? `可见余票 ${available}` : ""].filter(Boolean);
  return candidate({ domain: "transport", providerRef, title, summary: details.join(" · "), checkedAt, cost, operability: { transportType: "TRAIN", serviceNumber, highSpeed, inventoryUsability: available === 0 ? "unavailable" : available > 0 ? "available" : "unknown", mobilityRole: "intercity_inventory", priceHint: cost ? `¥${cost} 起` : null, departureCity: text(context.origin, 100) || null, arrivalCity: text(context.destination, 100) || null, departurePlace: departureLabel ? { kind: "rail_station", city: text(context.origin, 100) || null, label: departureLabel, terminal: null } : null, arrivalPlace: arrivalLabel ? { kind: "rail_station", city: text(context.destination, 100) || null, label: arrivalLabel, terminal: null } : null, departureAt: text(item.departureTime, 80) || null, arrivalAt: text(item.arrivalTime, 80) || null, durationMinutes: durationMinutes(item.duration), fareOptions, availableSeats: available, routeVerified: true, scheduleVerified: true, inventoryVerified: true, offerFreshness: "search_time" } });
}

function normalizeFlight(item, checkedAt, context = {}) {
  const providerRef = hash(`${item.flightNumber}:${item.departureAirport}:${item.arrivalAirport}:${item.departureTime}`);
  const base = numeric(item.basePrice) ?? 0;
  const tax = numeric(item.totalTax) ?? 0;
  const cost = base + tax;
  const departureLabel = endpointLabel(item.departureAirport, "airport");
  const arrivalLabel = endpointLabel(item.arrivalAirport, "airport");
  const departureTerminal = text(item.departureTerminal, 40) || null;
  const arrivalTerminal = text(item.arrivalTerminal, 40) || null;
  const serviceNumber = text(item.flightNumber, 40) || null;
  const title = `${serviceNumber || "航班"} ${departureLabel || text(context.origin, 100)} → ${arrivalLabel || text(context.destination, 100)}`;
  const details = [text(item.airlineCompany, 80), text(item.type, 40), text(item.departureTime, 80), text(item.arrivalTime, 80), text(item.cabinClass, 60), cost ? `含税参考 ¥${cost}` : "", item.remainingSeats ? `余位 ${text(item.remainingSeats, 20)}` : ""].filter(Boolean);
  return candidate({ domain: "transport", providerRef, title, summary: details.join(" · "), checkedAt, cost, operability: { transportType: "FLIGHT", serviceNumber, carrier: text(item.airlineCompany, 80) || null, mobilityRole: "intercity_inventory", priceHint: cost ? `¥${cost} 含税` : null, departureCity: text(context.origin, 100) || null, arrivalCity: text(context.destination, 100) || null, departurePlace: departureLabel ? { kind: "airport", city: text(context.origin, 100) || null, label: departureLabel, terminal: departureTerminal } : null, arrivalPlace: arrivalLabel ? { kind: "airport", city: text(context.destination, 100) || null, label: arrivalLabel, terminal: arrivalTerminal } : null, departureTerminal, arrivalTerminal, departureAt: text(item.departureTime, 80) || null, arrivalAt: text(item.arrivalTime, 80) || null, durationMinutes: durationMinutes(item.totalDuration), vehicleModel: text(item.craftType, 80) || null, seatClass: text(item.cabinClass, 60) || null, fareOffers: cost > 0 ? [{ provider: PROVIDER, providerLabel: "途牛", currency: "CNY", totalFare: cost, baseFare: base || null, taxes: tax || null, checkedAt, bookingUrl: null }] : [], availableSeats: numeric(item.remainingSeats), routeVerified: true, scheduleVerified: true, inventoryVerified: true, offerFreshness: "search_time" } });
}

function limitDomainCandidates(domain, candidates, groupJourneys = true) {
  if (groupJourneys && domain === "transport" && candidates.some(item => item.operability?.journeyId)) {
    return [...new Set(candidates.map(item => item.operability?.journeyId))].flatMap(id => limitDomainCandidates("transport", candidates.filter(item => item.operability?.journeyId === id), false));
  }
  const unique = [...new Map(candidates.map((item) => [item.candidateId, item])).values()];
  if (domain !== "transport") return unique.slice(0, 6);
  const flights = unique.filter((item) => item.operability?.transportType === "FLIGHT").slice(0, 3);
  const trains = unique.filter((item) => item.operability?.transportType === "TRAIN").slice(0, 3);
  const other = unique.filter((item) => !["FLIGHT", "TRAIN"].includes(item.operability?.transportType));
  return [...flights, ...trains, ...other].slice(0, 6);
}

export class TuniuTravelResearchProvider {
  constructor({ client, clock } = {}) {
    this.client = client;
    this.clock = clock;
  }

  get status() {
    return this.client?.status === "configured" ? "configured" : "provider_unavailable";
  }

  async research({ brief = {}, domains = [], question = "", criteria = null } = {}) {
    if (this.status !== "configured") return { schemaVersion: "travel-provider-result-v1", status: "provider_unavailable", provider: PROVIDER, fabricatedResults: false };
    const destination = text(brief.destination, 120);
    if (!destination) throw Object.assign(new Error("destination_required"), { code: "destination_required" });
    const requested = [...new Set(domains)].filter((domain) => ["stay", "transport"].includes(domain));
    const dates = travelDates(brief.dates);
    const origin = text(brief.origin, 120);
    const tasks = [];
    if (requested.includes("stay")) {
      const args = { cityName: destination };
      if (dates.start && dates.end) Object.assign(args, { checkIn: dates.start, checkOut: dates.end });
      tasks.push({ domain: "stay", service: "hotel", tool: "tuniuHotelSearch", args, extract: (result) => result?.hotels ?? [], normalize: normalizeHotel });
    }
    if (requested.includes("transport")) {
      for (const journey of journeyQueries(brief)) for (const mode of journey.mode && journey.mode !== "flexible" ? [journey.mode] : intercityModes(brief, question, criteria)) {
        const flight = mode === "flight";
        tasks.push({
          domain: "transport",
          service: flight ? "flight" : "train",
          tool: flight ? "searchLowestPriceFlight" : "searchLowestPriceTrain",
          args: { departureCityName: journey.origin, arrivalCityName: journey.destination, departureDate: journey.date },
          extract: (result) => result?.data ?? [],
          normalize: (item, checkedAt) => tagJourneyCandidate((flight ? normalizeFlight : normalizeTrain)(item, checkedAt, { origin: journey.origin, destination: journey.destination }), journey),
        });
      }
    }
    const checkedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    const byDomain = { play: [], food: [], stay: [], transport: [] };
    const settled = await Promise.allSettled(tasks.map(async (task) => ({ task, result: await this.client.callReadTool(task.service, task.tool, task.args) })));
    const errors = [];
    for (const result of settled) {
      if (result.status === "rejected") { errors.push({ code: result.reason?.code ?? "SOURCE_UNAVAILABLE" }); continue; }
      const { task, result: response } = result.value;
      byDomain[task.domain].push(...task.extract(response).map((item) => task.normalize(item, checkedAt)).filter((item) => item.title));
    }
    for (const domain of Object.keys(byDomain)) byDomain[domain] = limitDomainCandidates(domain, byDomain[domain]);
    const count = Object.values(byDomain).reduce((sum, items) => sum + items.length, 0);
    if (!count) return { schemaVersion: "travel-provider-result-v1", status: errors.some((item) => item.code === "AUTH_REQUIRED") ? "AUTH_REQUIRED" : "EMPTY_VERIFIED", provider: PROVIDER, errors, fabricatedResults: false };
    return { schemaVersion: "travel-provider-result-v1", status: "completed", provider: PROVIDER, providerLabel: "途牛官方 MCP", destination, checkedAt, byDomain, partial: requested.some((domain) => byDomain[domain].length === 0) || errors.length > 0, errors, caveats: ["途牛结果属于商业库存与平台排序，价格、余位和退改政策需在最终跳转前再次核验。", "当前只读接入不会创建、查询或取消订单。"], fabricatedResults: false, sourceDocumentation: DOCUMENTATION };
  }
}

export function createTuniuTravelResearchProvider(env = process.env, options = {}) {
  const client = options.client ?? createTuniuOfficialMcpClient(env, options.clientOptions);
  return new TuniuTravelResearchProvider({ client, clock: options.clock });
}

export { normalizeFlight, normalizeHotel, normalizeTrain };
