import { createHash } from "node:crypto";
import {
  TravelResearchCriteriaSchema,
  assertSchema,
} from "../../travel-agent-pi-package/src/contracts/index.ts";

const DOMAINS = Object.freeze(["play", "food", "stay", "transport"]);
const SENSITIVE_TEXT = /身份证|护照号|银行卡|信用卡|手机号|密码|口令|cookie|token|credential|secret|passport\s*number|phone\s*number/i;
const PLACE_SUFFIX = /(?:广场|路|街|区|商圈|古城|湖|湾|镇|村|机场|火车站|高铁站)$/u;
const PLAY_SUFFIX = /(?:外滩|博物馆|美术馆|科技馆|公园|景区|乐园|古镇|古城|山|湖|寺|塔|宫|园)$/u;

function safeText(value, limit = 120) {
  if (Array.isArray(value) || (value && typeof value === "object")) return "";
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  return normalized && !SENSITIVE_TEXT.test(normalized) ? normalized : "";
}

function unique(values, limit = 12) {
  return [...new Set(values.map((value) => safeText(value)).filter(Boolean))].slice(0, limit);
}

function cleanArea(value) {
  const cleaned = safeText(value)
    .replace(/^(?:住宿|酒店|民宿|住在|住到|住|优先|最好|希望|想要|选择|靠近|位于|在)+/u, "")
    .replace(/(?:附近|周边|一带|片区|区域|更方便|方便)$/u, "")
    .trim();
  if (!cleaned || /(?:由旅行助手|你来|待定|未定|不限|都可以)/u.test(cleaned)) return "";
  if (/^(?:交通|位置|出行|住宿|酒店|方便|舒适|安静|少折返|好打车)$/u.test(cleaned)) return "";
  return cleaned.slice(0, 40);
}

function splitAreaPreference(value) {
  return unique(String(value ?? "").split(/(?:或|或者|、|，|,|\/|和)/u).map(cleanArea).filter((item) => item && (PLACE_SUFFIX.test(item) || /(?:市中心|城区|老城|海边|湖边|河边)$/u.test(item))));
}

function extractStayAreas(question) {
  const matches = [];
  for (const match of String(question ?? "").matchAll(/(?:住宿|酒店|民宿|住)(?:优先|希望|想要|选在|在|靠近)?([^。；;]{2,50})/gu)) {
    const phrase = match[1].split(/(?:，|,|。|；|;|并且|同时|然后)/u)[0];
    matches.push(...splitAreaPreference(phrase));
  }
  return unique(matches.filter((item) => PLACE_SUFFIX.test(item) || /(?:市中心|城区|老城|海边|湖边|河边)$/u.test(item)));
}

function extractPlayEntities(question) {
  const matches = [];
  for (const match of String(question ?? "").matchAll(/(?:想去|要去|希望去|安排|包括|看看|体验)([^。；;]{1,80})/gu)) {
    const phrase = match[1].split(/(?:，然后|并且|同时|住宿|酒店|餐厅|吃|交通)/u)[0];
    for (const raw of phrase.split(/(?:、|，|,|或|和|以及)/u)) {
      const item = safeText(raw, 40).replace(/^(?:一下|一些|适合[^的]{0,8}的|轻松的)/u, "").trim();
      if (item && (PLAY_SUFFIX.test(item) || /博物馆|外滩|美术馆|公园|景区/u.test(item))) matches.push(item);
    }
  }
  return unique(matches);
}

function extractFoodHints(brief, question) {
  const corpus = `${(brief?.foodPreferences ?? []).join(" ")} ${question ?? ""}`;
  const patterns = ["本帮菜", "上海本地菜", "本地菜", "小店", "不太大众", "小众", "老字号", "街坊店", "清淡", "素食", "海鲜"];
  return unique([...(brief?.foodPreferences ?? []), ...patterns.filter((item) => corpus.includes(item))]);
}

function travelerConstraintHints(travelers = []) {
  const hints = [];
  for (const traveler of travelers) {
    const name = safeText(traveler?.displayName, 40) || "同行人";
    const mobility = traveler?.careNeeds?.mobility ?? {};
    const stamina = traveler?.careNeeds?.stamina ?? {};
    const facilities = traveler?.careNeeds?.facilities ?? {};
    if (mobility.reduceWalking) hints.push(`${name}:少走路`);
    if (mobility.avoidStairs) hints.push(`${name}:避开楼梯`);
    if (mobility.stepFreeRequired) hints.push(`${name}:连续无台阶路线`);
    if (Number.isFinite(mobility.maxContinuousWalkMeters)) hints.push(`${name}:单段步行不超过${mobility.maxContinuousWalkMeters}米`);
    if (Number.isFinite(mobility.maxTransfers)) hints.push(`${name}:最多换乘${mobility.maxTransfers}次`);
    if (stamina.needsFrequentRest) hints.push(`${name}:需要休息窗口`);
    if (facilities.toiletAccessPriority || facilities.accessibleToiletRequired) hints.push(`${name}:卫生间可达优先`);
  }
  return unique(hints);
}

function arrivalCriteria(brief, question, input = {}) {
  const raw = String(question ?? "");
  const airportMatch = raw.match(/((?:上海)?浦东(?:国际)?(?:机场)?|(?:上海)?虹桥(?:国际)?(?:机场)?|[\p{Script=Han}A-Za-z·-]{2,24}(?:国际)?机场)/u);
  let airport = safeText(input.airport ?? brief?.arrivalAirport ?? airportMatch?.[1], 120) || null;
  if (airport && /浦东$/u.test(airport)) airport = "浦东机场";
  if (airport && /虹桥$/u.test(airport)) airport = "虹桥机场";
  const terminal = safeText(input.terminal ?? brief?.arrivalTerminal ?? raw.match(/\b(T\s*\d+)\b/i)?.[1]?.replace(/\s+/g, ""), 40) || null;
  const arrivalTimeMatch = raw.match(/(?:落地|到达|抵达)[^\d]{0,12}((?:[01]?\d|2[0-3]):[0-5]\d)/u)
    ?? raw.match(/((?:[01]?\d|2[0-3]):[0-5]\d)[^。；;]{0,8}(?:落地|到达|抵达)/u);
  const time = safeText(input.time ?? brief?.arrivalTime ?? arrivalTimeMatch?.[1], 40) || null;
  return { airport, terminal, time, confirmed: input.confirmed === true || brief?.arrivalConfirmed === true };
}

function intercityIntent(brief, question, requested) {
  if (["flight", "train", "flexible", "none"].includes(requested)) return requested;
  const corpus = `${brief?.arrivalMode ?? ""} ${question ?? ""}`;
  const flight = /飞机|航班|机票|flight|\bair\b/i.test(corpus) && !/(?:不坐|不要|不考虑|避免)(?:乘坐)?(?:飞机|航班)/u.test(corpus);
  const train = /高铁|动车|火车|列车|train|rail/i.test(corpus) && !/(?:不坐|不要|不考虑|避免)(?:乘坐)?(?:高铁|动车|火车|列车)/u.test(corpus);
  if (flight && !train) return "flight";
  if (train && !flight) return "train";
  return safeText(brief?.origin) ? "flexible" : "none";
}

function localMobilityIntent(travelers, requested = []) {
  const valid = requested.filter((item) => ["transit", "taxi", "walk", "accessible_transit", "flexible"].includes(item));
  if (valid.length) return unique(valid, 5);
  const constrained = travelers.some((traveler) => traveler?.careNeeds?.mobility?.reduceWalking || traveler?.careNeeds?.mobility?.avoidStairs || traveler?.careNeeds?.mobility?.stepFreeRequired);
  return constrained ? ["taxi", "accessible_transit"] : ["flexible"];
}

function normalizedDomain(input = {}) {
  return {
    keywords: unique(input.keywords ?? []),
    namedEntities: unique(input.namedEntities ?? []),
    targetAreas: unique(input.targetAreas ?? []),
    anchorCoordinates: (input.anchorCoordinates ?? []).filter((item) => Number.isFinite(item?.longitude) && Number.isFinite(item?.latitude)).slice(0, 6).map((item) => ({
      ...(safeText(item.label) ? { label: safeText(item.label) } : {}),
      longitude: Number(item.longitude),
      latitude: Number(item.latitude),
    })),
    hardConstraints: unique(input.hardConstraints ?? []),
    preferenceHints: unique(input.preferenceHints ?? []),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function fingerprint(value) {
  return `rc_${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 24)}`;
}

export function buildTravelResearchCriteria({ brief = {}, travelers = [], question = "", criteria: input = {}, domains = DOMAINS } = {}) {
  const destination = safeText(brief.destination);
  if (!destination) throw Object.assign(new Error("destination_required"), { code: "destination_required" });
  const travelerHints = travelerConstraintHints(travelers);
  const byDomain = Object.fromEntries(DOMAINS.map((domain) => [domain, normalizedDomain(input?.byDomain?.[domain])]));

  byDomain.stay.targetAreas = unique([...byDomain.stay.targetAreas, ...splitAreaPreference(brief.lodgingPreference), ...extractStayAreas(question)]);
  byDomain.stay.keywords = unique([...byDomain.stay.keywords, "酒店"]);
  byDomain.play.namedEntities = unique([...byDomain.play.namedEntities, ...extractPlayEntities(question)]);
  byDomain.play.keywords = unique([...byDomain.play.keywords, ...byDomain.play.namedEntities]);
  const foodHints = extractFoodHints(brief, question);
  byDomain.food.keywords = unique([...byDomain.food.keywords, ...foodHints]);
  byDomain.food.preferenceHints = unique([...byDomain.food.preferenceHints, ...foodHints]);
  if (!byDomain.food.targetAreas.length && byDomain.stay.targetAreas.length) byDomain.food.targetAreas = [...byDomain.stay.targetAreas];
  for (const domain of DOMAINS) byDomain[domain].hardConstraints = unique([...byDomain[domain].hardConstraints, ...travelerHints]);

  const arrival = arrivalCriteria(brief, question, input.arrival);
  const transportCorpus = `${brief?.arrivalMode ?? ""} ${question ?? ""}`;
  if (/高铁|动车/u.test(transportCorpus)) byDomain.transport.preferenceHints = unique([...byDomain.transport.preferenceHints, "high_speed_train"]);
  if (/飞机|航班|机票/u.test(transportCorpus) && /高铁|动车/u.test(transportCorpus)) byDomain.transport.preferenceHints = unique([...byDomain.transport.preferenceHints, "compare_flight_high_speed_train"]);
  if (arrival.airport) byDomain.transport.namedEntities = unique([...byDomain.transport.namedEntities, [arrival.airport, arrival.terminal].filter(Boolean).join(" ")]);
  byDomain.transport.namedEntities = byDomain.transport.namedEntities.filter((item) => /机场|航站楼|火车站|高铁站|客运站|地铁站|码头/u.test(item));
  byDomain.transport.keywords = byDomain.transport.keywords.filter((item) => !/酒店|宾馆|民宿|停车场|停车点/u.test(item));
  const shared = {
    ...(brief.journeys ? { journeys: brief.journeys } : {}),
    schemaVersion: "travel-research-criteria-v1",
    origin: safeText(brief.origin) || null,
    destination,
    dates: safeText(brief.dates) || null,
    partySize: travelers.length || null,
    budgetCny: Number.isFinite(brief.totalBudget) ? Number(brief.totalBudget) : null,
    travelerConstraintHints: travelerHints,
    byDomain,
    intercityIntent: intercityIntent(brief, question, input.intercityIntent),
    localMobilityIntent: localMobilityIntent(travelers, input.localMobilityIntent),
    arrival,
  };
  const requestedDomains = unique(domains.filter((domain) => DOMAINS.includes(domain)), 4);
  const domainFingerprints = Object.fromEntries(DOMAINS.map((domain) => [domain, fingerprint({
    origin: shared.origin,
    destination: shared.destination,
    dates: shared.dates,
    partySize: shared.partySize,
    budgetCny: shared.budgetCny,
    travelerConstraintHints: shared.travelerConstraintHints,
    criteria: byDomain[domain],
    ...(domain === "transport" ? { journeys: brief.journeys ?? [], intercityIntent: shared.intercityIntent, localMobilityIntent: shared.localMobilityIntent, arrival } : {}),
    requested: requestedDomains.includes(domain),
  })]));
  const normalized = { ...shared, fingerprint: fingerprint({ ...shared, requestedDomains }), domainFingerprints };
  return assertSchema(TravelResearchCriteriaSchema, normalized, "invalid_travel_research_criteria");
}

export function researchCriteriaMatchesProposal(proposal, criteria, domains) {
  const fingerprints = proposal?.researchCriteria?.domainFingerprints ?? {};
  return domains.every((domain) => fingerprints[domain] === criteria.domainFingerprints[domain]);
}

export { DOMAINS as RESEARCH_DOMAINS };
