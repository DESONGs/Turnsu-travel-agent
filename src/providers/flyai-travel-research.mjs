import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { journeyQueries, tagJourneyCandidate } from "../../travel-agent-pi-package/src/core/journey-execution.ts";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const FLYAI_PACKAGE_ROOT = dirname(require.resolve("@fly-ai/flyai-cli/package.json"));
const FLYAI_BIN = resolve(FLYAI_PACKAGE_ROOT, "dist/flyai-bundle.cjs");
const FLYAI_DOC = "https://flyai.open.fliggy.com/docs/overview";
const FLYAI_PROVIDER = "fliggy_flyai";

function text(value, limit = 500) {
  if (Array.isArray(value) || (value && typeof value === "object")) return "";
  return String(value ?? "").trim().slice(0, limit);
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeProviderUrl(value, kind = "handoff") {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:") return null;
    if (kind === "handoff" && url.hostname !== "router.feizhu.com") return null;
    if (kind === "image" && !(url.hostname === "alicdn.com" || url.hostname.endsWith(".alicdn.com"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function exactPrice(value) {
  const raw = text(value, 40).replace(/[¥￥,\s]/g, "");
  return /^\d+(?:\.\d{1,2})?$/.test(raw) ? Number(raw) : 0;
}

function isoDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

function travelDates(value) {
  const raw = text(value, 160);
  const iso = [...raw.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)].map((match) => isoDate(match[1], match[2], match[3])).filter(Boolean);
  if (iso.length) return { start: iso[0], end: iso[1] ?? null };
  const chinese = raw.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:\s*[-至到]\s*(?:(20\d{2})年)?(?:(\d{1,2})月)?(\d{1,2})日)?/);
  if (!chinese) return { start: null, end: null };
  return {
    start: isoDate(chinese[1], chinese[2], chinese[3]),
    end: chinese[6] ? isoDate(chinese[4] || chinese[1], chinese[5] || chinese[2], chinese[6]) : null,
  };
}

function intercityModes(brief = {}, question = "", criteria = null) {
  if (criteria?.intercityIntent === "flight") return ["flight"];
  if (criteria?.intercityIntent === "train") return ["train"];
  if (criteria?.intercityIntent === "none") return [];
  const explicit = text(question, 800);
  const saved = text(brief.arrivalMode, 120);
  const flightPattern = /飞机|航班|机票|flight|\bair\b/i;
  const trainPattern = /高铁|动车|火车|列车|train|rail/i;
  const flightDenied = /(?:不坐|不要|不考虑|避免)(?:乘坐)?(?:飞机|航班)|(?:飞机|航班|机票).{0,8}(?:不考虑|不要)/i.test(explicit);
  const trainDenied = /(?:不坐|不要|不考虑|避免)(?:乘坐)?(?:高铁|动车|火车|列车)|(?:高铁|动车|火车|列车).{0,8}(?:不考虑|不要)/i.test(explicit);
  const explicitModes = [
    ...(flightPattern.test(explicit) && !flightDenied ? ["flight"] : []),
    ...(trainPattern.test(explicit) && !trainDenied ? ["train"] : []),
  ];
  if (explicitModes.length) return explicitModes;
  if (flightDenied && !trainDenied) return ["train"];
  if (trainDenied && !flightDenied) return ["flight"];
  const savedModes = [
    ...(flightPattern.test(saved) ? ["flight"] : []),
    ...(trainPattern.test(saved) ? ["train"] : []),
  ];
  return savedModes.length ? savedModes : ["flight", "train"];
}

function endpointLabel(value, kind) {
  const label = text(value, 100);
  if (!label) return null;
  if (kind === "airport") return /机场|airport/i.test(label) ? label : `${label}机场`;
  return /站$/.test(label) ? label : `${label}站`;
}

function transportKind(value) {
  return /flight|air|飞机|航班/i.test(text(value, 40)) ? "FLIGHT" : "TRAIN";
}

function candidateBase({ domain, providerRef, title, summary, checkedAt, media = [], location = null, cost = 0, operability = {} }) {
  const sourceId = `${FLYAI_PROVIDER}:${providerRef}`;
  const entityId = `entity_${shortHash(sourceId)}`;
  const claimId = `claim_${shortHash(`${sourceId}:${checkedAt}`)}`;
  return {
    candidateId: `${domain}_${shortHash(sourceId)}`,
    domain,
    title: text(title, 200),
    summary: text(summary, 900),
    sourceId,
    claimId,
    entityId,
    checkedAt,
    media,
    location,
    cost,
    price: {
      amount: cost > 0 ? cost : null,
      currency: "CNY",
      quality: cost > 0 ? "reference" : "unknown",
      basis: domain === "stay" ? "per_night_room" : domain === "transport" ? "per_person_one_way" : "per_person",
      checkedAt,
    },
    operability: {
      provider: FLYAI_PROVIDER,
      providerRef,
      bookingProviderLabel: "飞猪",
      researchDepth: "official_ota_search",
      checkedAt,
      ...operability,
    },
    source: {
      sourceId,
      provider: FLYAI_PROVIDER,
      sourceType: "official_ota_search",
      providerPoiId: providerRef,
      checkedAt,
      documentationUrl: FLYAI_DOC,
      independenceGroup: sourceId,
      commercialBias: "ota_commercial_inventory",
    },
    entity: {
      entityId,
      kind: domain === "transport" ? "transport_offer" : "place",
      canonicalName: text(title, 200),
      providerRefs: [sourceId],
    },
    claim: {
      claimId,
      entityId,
      kind: "provider_fact",
      statement: text(summary, 1000),
      sourceRefs: [sourceId],
      sourceIndependence: "single_provider",
      commercialBias: "ota_commercial_inventory",
      confidence: 0.85,
      observedAt: checkedAt,
    },
  };
}

function normalizeHotel(item, checkedAt) {
  const providerRef = text(item.shId, 128) || shortHash(`${item.name}:${item.address}`);
  const priceHint = text(item.price, 40);
  const mediaUrl = safeProviderUrl(item.mainPic, "image");
  const longitude = numberOrNull(item.longitude);
  const latitude = numberOrNull(item.latitude);
  const address = text(item.address, 260);
  const facts = [text(item.star, 80), text(item.brandName, 80), priceHint ? `参考价 ${priceHint}` : "", text(item.interestsPoi, 160), text(item.address, 260)].filter(Boolean);
  return candidateBase({
    domain: "stay",
    providerRef,
    title: item.name,
    summary: facts.join(" · "),
    checkedAt,
    media: mediaUrl ? [{ url: mediaUrl, title: text(item.name, 120), source: FLYAI_PROVIDER }] : [],
    location: address || (longitude != null && latitude != null) ? {
      ...(address ? { address, label: address } : {}),
      ...(longitude != null && latitude != null ? { coordinates: { longitude, latitude, coordinateSystem: "GCJ-02" } } : {}),
    } : null,
    cost: exactPrice(priceHint),
    operability: {
      priceHint: priceHint || null,
      bookingUrl: safeProviderUrl(item.detailUrl),
      inventoryVerified: false,
      offerFreshness: "search_time",
    },
  });
}

function normalizePoi(item, checkedAt) {
  const providerRef = text(item.id, 128) || shortHash(`${item.name}:${item.address}`);
  const ticketPrice = text(item.ticketInfo?.price, 40);
  const mediaUrl = safeProviderUrl(item.mainPic, "image");
  const longitude = numberOrNull(item.longitude);
  const latitude = numberOrNull(item.latitude);
  const address = text(item.address, 260);
  const facts = [text(item.category, 80), text(item.poiLevel, 20) ? `${text(item.poiLevel, 20)}A` : "", ticketPrice ? `门票参考 ${ticketPrice}` : text(item.freePoiStatus, 40) === "FREE" ? "免费开放" : "", text(item.address, 260), text(item.description, 300)].filter(Boolean);
  return candidateBase({
    domain: "play",
    providerRef,
    title: item.name,
    summary: facts.join(" · "),
    checkedAt,
    media: mediaUrl ? [{ url: mediaUrl, title: text(item.name, 120), source: FLYAI_PROVIDER }] : [],
    location: address || (longitude != null && latitude != null) ? {
      ...(address ? { address, label: address } : {}),
      ...(longitude != null && latitude != null ? { coordinates: { longitude, latitude, coordinateSystem: "GCJ-02" } } : {}),
    } : null,
    cost: exactPrice(ticketPrice),
    operability: {
      priceHint: ticketPrice || null,
      bookingUrl: safeProviderUrl(item.jumpUrl),
      ticketName: text(item.ticketInfo?.ticketName, 160) || null,
      inventoryVerified: false,
    },
  });
}

function normalizeTransport(item, checkedAt, context = {}) {
  const journey = Array.isArray(item.journeys) ? item.journeys[0] : null;
  const segments = Array.isArray(journey?.segments) ? journey.segments : [];
  const first = segments[0] ?? {};
  const last = segments.at(-1) ?? {};
  const transportNumbers = segments.map((segment) => text(segment.marketingTransportNo, 40)).filter(Boolean).join(" + ");
  const providerRef = shortHash(`${transportNumbers}:${first.depDateTime}:${last.arrDateTime}`);
  const priceHint = text(item.ticketPrice ?? item.price, 40);
  const transportType = transportKind(first.transportType ?? first.marketingTransportName);
  const highSpeed = transportType === "TRAIN" && /^[GCD]/i.test(transportNumbers);
  const placeKind = transportType === "FLIGHT" ? "airport" : "rail_station";
  const departureLabel = endpointLabel(first.depStationName, placeKind);
  const arrivalLabel = endpointLabel(last.arrStationName, placeKind);
  const cost = exactPrice(priceHint);
  const bookingUrl = safeProviderUrl(item.jumpUrl);
  const title = `${transportNumbers || text(first.marketingTransportName, 80) || "交通"} ${departureLabel || text(context.origin, 100)} → ${arrivalLabel || text(context.destination, 100)}`;
  const facts = [text(journey?.journeyType, 40), text(first.depDateTime, 80), text(last.arrDateTime, 80), text(first.seatClassName, 60), priceHint ? `参考价 ${priceHint}` : "", text(item.totalDuration, 20) ? `全程约 ${text(item.totalDuration, 20)} 分钟` : ""].filter(Boolean);
  return candidateBase({
    domain: "transport",
    providerRef,
    title,
    summary: facts.join(" · "),
    checkedAt,
    cost,
    operability: {
      priceHint: priceHint || null,
      bookingUrl,
      routeVerified: true,
      scheduleVerified: true,
      mobilityRole: "intercity_inventory",
      inventoryVerified: false,
      transportType,
      highSpeed,
      serviceNumber: transportNumbers || null,
      carrier: text(first.marketingTransportName, 80) || null,
      departureCity: text(context.origin, 100) || null,
      arrivalCity: text(context.destination, 100) || null,
      departurePlace: departureLabel ? { kind: placeKind, city: text(context.origin, 100) || null, label: departureLabel, terminal: null } : null,
      arrivalPlace: arrivalLabel ? { kind: placeKind, city: text(context.destination, 100) || null, label: arrivalLabel, terminal: null } : null,
      departureAt: text(first.depDateTime, 80) || null,
      arrivalAt: text(last.arrDateTime, 80) || null,
      durationMinutes: numberOrNull(item.totalDuration),
      seatClass: text(first.seatClassName, 60) || null,
      journeyType: text(journey?.journeyType, 40) || null,
      fareOffers: cost > 0 ? [{ provider: FLYAI_PROVIDER, providerLabel: "飞猪", currency: "CNY", totalFare: cost, baseFare: null, taxes: null, checkedAt, bookingUrl }] : [],
      segments: segments.slice(0, 4).map((segment) => ({
        number: text(segment.marketingTransportNo, 40),
        carrier: text(segment.marketingTransportName, 80),
        from: text(segment.depStationName, 100),
        to: text(segment.arrStationName, 100),
        departureAt: text(segment.depDateTime, 80),
        arrivalAt: text(segment.arrDateTime, 80),
      })),
    },
  });
}

function limitDomainCandidates(domain, candidates, groupJourneys = true) {
  if (groupJourneys && domain === "transport" && candidates.some(item => item.operability?.journeyId)) {
    return [...new Set(candidates.map(item => item.operability?.journeyId))].flatMap(id => limitDomainCandidates("transport", candidates.filter(item => item.operability?.journeyId === id), false));
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()];
  if (domain !== "transport") return unique.slice(0, 6);
  const flights = unique.filter((candidate) => candidate.operability?.transportType === "FLIGHT").slice(0, 3);
  const trains = unique.filter((candidate) => candidate.operability?.transportType === "TRAIN").slice(0, 3);
  const other = unique.filter((candidate) => !["FLIGHT", "TRAIN"].includes(candidate.operability?.transportType));
  return [...flights, ...trains, ...other].slice(0, 6);
}

function mapCliFailure(error) {
  const message = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  if (/401|unauthorized|authentication/i.test(message)) return "AUTH_REQUIRED";
  if (/429|rate.?limit/i.test(message)) return "RATE_LIMITED";
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return "SOURCE_UNAVAILABLE";
  return "SOURCE_UNAVAILABLE";
}

export class FlyaiTravelResearchProvider {
  constructor({ apiKey = "", enabled = false, workerHome = resolve(tmpdir(), "travel-agent-flyai-worker"), clock, timeoutMs = 35_000, runner = execFileAsync } = {}) {
    this.apiKey = text(apiKey, 512);
    this.enabled = enabled === true;
    this.workerHome = resolve(workerHome);
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  get status() {
    return this.enabled ? "configured" : "provider_unavailable";
  }

  async run(command, args) {
    if (!this.enabled) throw Object.assign(new Error("provider_unavailable"), { code: "provider_unavailable" });
    await mkdir(this.workerHome, { recursive: true, mode: 0o700 });
    const env = {
      HOME: this.workerHome,
      TMPDIR: this.workerHome,
      LANG: "zh_CN.UTF-8",
      FLYAI_JSON: "1",
      ...(this.apiKey ? { FLYAI_API_KEY: this.apiKey } : {}),
    };
    try {
      const { stdout } = await this.runner(process.execPath, [FLYAI_BIN, command, ...args], {
        env,
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const payload = JSON.parse(String(stdout ?? "").trim());
      if (Number(payload?.status) !== 0 || !Array.isArray(payload?.data?.itemList)) throw Object.assign(new Error("SOURCE_UNAVAILABLE"), { code: "SOURCE_UNAVAILABLE" });
      return { items: payload.data.itemList.slice(0, 10), systemMessage: text(payload.systemMessage, 400) };
    } catch (error) {
      throw Object.assign(new Error(mapCliFailure(error)), { code: mapCliFailure(error) });
    }
  }

  async research({ brief = {}, domains = [], question = "", criteria = null } = {}) {
    if (!this.enabled) return { schemaVersion: "travel-provider-result-v1", status: "provider_unavailable", provider: FLYAI_PROVIDER, fabricatedResults: false };
    const destination = text(brief.destination, 120);
    if (!destination) throw Object.assign(new Error("destination_required"), { code: "destination_required" });
    const requested = [...new Set(domains)].filter((domain) => ["stay", "play", "transport"].includes(domain));
    const dates = travelDates(brief.dates);
    const tasks = [];
    if (requested.includes("stay")) {
      const args = ["--dest-name", destination];
      if (dates.start) args.push("--check-in-date", dates.start);
      if (dates.end) args.push("--check-out-date", dates.end);
      tasks.push({ domain: "stay", command: "search-hotel", args, normalize: normalizeHotel });
    }
    if (requested.includes("play")) tasks.push({ domain: "play", command: "search-poi", args: ["--city-name", destination], normalize: normalizePoi });
    const origin = text(brief.origin, 120);
    if (requested.includes("transport")) {
      for (const journey of journeyQueries(brief)) for (const mode of journey.mode && journey.mode !== "flexible" ? [journey.mode] : intercityModes(brief, question, criteria)) {
        tasks.push({ domain: "transport", command: mode === "flight" ? "search-flight" : "search-train", args: ["--origin", journey.origin, "--destination", journey.destination, "--dep-date", journey.date], normalize: (item, checkedAt) => tagJourneyCandidate(normalizeTransport(item, checkedAt, { origin: journey.origin, destination: journey.destination }), journey) });
      }
    }
    const byDomain = { play: [], food: [], stay: [], transport: [] };
    const checkedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    const settled = await Promise.allSettled(tasks.map(async (task) => ({ task, result: await this.run(task.command, task.args) })));
    const errors = [];
    const systemMessages = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        errors.push({ code: result.reason?.code ?? "SOURCE_UNAVAILABLE" });
        continue;
      }
      const { task, result: response } = result.value;
      byDomain[task.domain].push(...response.items.map((item) => task.normalize(item, checkedAt)).filter((candidate) => candidate.title));
      if (response.systemMessage) systemMessages.push(response.systemMessage);
    }
    for (const domain of Object.keys(byDomain)) byDomain[domain] = limitDomainCandidates(domain, byDomain[domain]);
    const count = Object.values(byDomain).reduce((sum, items) => sum + items.length, 0);
    if (!count) return { schemaVersion: "travel-provider-result-v1", status: errors.some((error) => error.code === "AUTH_REQUIRED") ? "AUTH_REQUIRED" : "EMPTY_VERIFIED", provider: FLYAI_PROVIDER, errors, fabricatedResults: false };
    return {
      schemaVersion: "travel-provider-result-v1",
      status: "completed",
      provider: FLYAI_PROVIDER,
      providerLabel: "飞猪 AI 开放平台",
      destination,
      checkedAt,
      byDomain,
      partial: requested.some((domain) => byDomain[domain].length === 0) || errors.length > 0,
      errors,
      caveats: [...new Set(["飞猪结果属于商业库存与平台排序，不代表独立口碑。", ...systemMessages])],
      fabricatedResults: false,
      sourceDocumentation: FLYAI_DOC,
    };
  }
}

export function createFlyaiTravelResearchProvider(env = process.env, options = {}) {
  const enabledByConfig = env.TRAVEL_AGENT_FLYAI_ENABLED === "true";
  const smokePassed = String(env.TRAVEL_AGENT_FLYAI_SMOKE_STATUS ?? "").startsWith("passed_read_only_isolated");
  const enabled = enabledByConfig && smokePassed && (env.NODE_ENV !== "production" || Boolean(env.FLYAI_API_KEY));
  const workerHome = env.TRAVEL_AGENT_DATA_DIR ? resolve(env.TRAVEL_AGENT_DATA_DIR, "provider-workers", "flyai-home") : undefined;
  return new FlyaiTravelResearchProvider({ apiKey: env.FLYAI_API_KEY, enabled, ...(workerHome ? { workerHome } : {}), ...options });
}

export { FLYAI_BIN, FLYAI_DOC, intercityModes, normalizeHotel, normalizePoi, normalizeTransport, travelDates };
