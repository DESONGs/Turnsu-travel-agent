const TRUSTED_MEDIA_SOURCE = /amap|高德|fliggy|flyai|飞猪|tuniu|途牛/i;
const DOMAIN_LABELS = { play: "玩", food: "吃", stay: "住", transport: "行" };
const MODE_LABELS = { walk: "步行", transit: "公交 / 地铁", taxi: "打车" };

function coordinate(value) {
  if (!value || !Number.isFinite(Number(value.longitude)) || !Number.isFinite(Number(value.latitude))) return null;
  return {
    longitude: Number(value.longitude),
    latitude: Number(value.latitude),
    coordinateSystem: value.coordinateSystem === "WGS-84" ? "WGS-84" : "GCJ-02",
  };
}

function safeDisplayUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function mediaDisplayUrl(media) {
  const explicit = safeDisplayUrl(media?.displayUrl);
  if (explicit) return explicit;
  const source = String(media?.source || media?.provider || "");
  const url = safeDisplayUrl(media?.url);
  if (!url) return null;
  if (media?.rights === "provider_display" || media?.display === true || TRUSTED_MEDIA_SOURCE.test(source)) return url;
  return null;
}

function mediaRows(node) {
  return (node?.media ?? []).map((media, index) => {
    const displayUrl = mediaDisplayUrl(media);
    if (!displayUrl) return null;
    return {
      mediaId: String(media.mediaId || `${node.nodeId}:media:${index}`),
      displayUrl,
      alt: String(media.alt || media.title || `${node.title} 来源图片`).slice(0, 240),
      source: String(media.source || media.provider || node.operability?.sourceLabel || "来源图片").slice(0, 120),
    };
  }).filter(Boolean).slice(0, 4);
}

function mobilityPlaceForNode(plan, nodeId) {
  return (plan?.mobility?.legs ?? [])
    .flatMap((leg) => [leg.origin, leg.destination])
    .find((place) => place?.nodeId === nodeId && coordinate(place.coordinates)) ?? null;
}

function nodeCoordinate(node, plan) {
  return coordinate(node?.location?.coordinates) ?? coordinate(mobilityPlaceForNode(plan, node?.nodeId)?.coordinates);
}

function selectedAnchor(plan, nodeId) {
  const selectedNodes = Object.entries(plan?.byDomain ?? {})
    .flatMap(([domain, nodes]) => (nodes ?? []).filter((node) => node.selected).map((node) => ({ ...node, domain })));
  const preferred = [
    ...selectedNodes.filter((node) => node.domain === "stay"),
    ...selectedNodes.filter((node) => node.domain === "transport"),
    ...selectedNodes,
  ].find((node) => node.nodeId !== nodeId && nodeCoordinate(node, plan));
  if (!preferred) return null;
  return {
    nodeId: preferred.nodeId,
    title: preferred.title,
    domain: preferred.domain,
    coordinates: nodeCoordinate(preferred, plan),
  };
}

function selectedAlternative(leg) {
  return leg?.alternatives?.find((item) => item.mode === leg.recommendedMode) ?? leg?.alternatives?.[0] ?? null;
}

function routeRelationForNode(plan, node) {
  const leg = (plan?.mobility?.legs ?? []).find((item) => item.origin?.nodeId === node?.nodeId || item.destination?.nodeId === node?.nodeId);
  const alternative = selectedAlternative(leg);
  if (!leg || !alternative) return null;
  const nodeIsOrigin = leg.origin?.nodeId === node.nodeId;
  const anchorPlace = nodeIsOrigin ? leg.destination : leg.origin;
  return {
    legId: String(leg.legId ?? ""),
    label: `${leg.origin?.label ?? "起点"} → ${leg.destination?.label ?? "下一站"}`,
    anchorLabel: anchorPlace?.label ?? null,
    mode: alternative.mode ?? leg.recommendedMode ?? null,
    modeLabel: MODE_LABELS[alternative.mode ?? leg.recommendedMode] ?? alternative.mode ?? leg.recommendedMode ?? "路线",
    minutes: Number.isFinite(Number(alternative.totalMinutes)) ? Number(alternative.totalMinutes) : null,
    walkingMeters: Number.isFinite(Number(alternative.walkingMeters)) ? Number(alternative.walkingMeters) : null,
    transfers: Number.isFinite(Number(alternative.transfers)) ? Number(alternative.transfers) : null,
    estimatedFareCny: Number.isFinite(Number(alternative.estimatedFareCny)) ? Number(alternative.estimatedFareCny) : null,
    rationale: String(leg.rationale || "").slice(0, 260),
    checkedAt: plan?.mobility?.checkedAt ?? null,
    polyline: (alternative.polyline ?? []).map(coordinate).filter(Boolean),
    anchorCoordinates: coordinate(anchorPlace?.coordinates),
  };
}

function weatherFacts(plan, domain) {
  const weather = plan?.weather;
  if (!weather || !["covered", "partial"].includes(weather.coverage)) return null;
  const tripDates = new Set(weather.tripDates ?? []);
  const days = (weather.forecastDays ?? []).filter((day) => tripDates.has(day.date)).slice(0, 3);
  const conditions = [...new Set(days.flatMap((day) => [day.dayCondition, day.nightCondition]).filter(Boolean))];
  const guidance = weather.planningImpact?.guidance?.[domain] ?? null;
  if (!days.length && !guidance) return null;
  return {
    label: "天气与时段",
    value: [conditions.join(" / "), guidance].filter(Boolean).join("；"),
    checkedAt: weather.checkedAt ?? null,
    source: weather.attribution || weather.provider || "天气来源",
  };
}

function factRows(node, plan, routeRelation) {
  const detail = node?.operability ?? {};
  return [
    node?.summary ? { label: "此行体验线索", value: String(node.summary).slice(0, 260), source: "当前候选说明", checkedAt: detail.checkedAt ?? node.checkedAt ?? null } : null,
    node?.evidenceSummary?.headline ? { label: "来源证据", value: String(node.evidenceSummary.headline).slice(0, 220), source: `${node.evidenceSummary.independentSourceCount ?? 0} 个独立来源`, checkedAt: detail.checkedAt ?? node.checkedAt ?? null } : null,
    detail.openWeek || detail.openTime || detail.opentime ? { label: "建议时段线索", value: String(detail.openWeek || detail.openTime || detail.opentime).slice(0, 120), source: "来源营业时间", checkedAt: detail.checkedAt ?? null } : null,
    detail.rating ? { label: "来源评分", value: String(detail.rating), source: detail.provider || detail.sourceLabel || "来源资料", checkedAt: detail.checkedAt ?? null } : null,
    routeRelation ? { label: "路线关系", value: `${routeRelation.label}${routeRelation.minutes != null ? ` · 约 ${Math.round(routeRelation.minutes)} 分钟` : ""}${routeRelation.walkingMeters != null ? ` · 步行 ${Math.round(routeRelation.walkingMeters)} 米` : ""}`, source: "高德路线", checkedAt: routeRelation.checkedAt } : null,
    weatherFacts(plan, node?.domain),
  ].filter(Boolean).slice(0, 6);
}

function unknownRows(node, coordinates, media, routeRelation, facts) {
  const unknowns = [];
  if (!coordinates) unknowns.push("当前候选没有可用于路线试排的可靠坐标；仍可浏览地点手账。");
  if (!media.length) unknowns.push("当前候选没有可直接展示的来源图片；不会用通用风景图替代。");
  if (!routeRelation) unknowns.push("尚未形成与住宿、到达点或当前路线的已核验移动关系。");
  if (!facts.some((fact) => fact.label === "天气与时段")) unknowns.push("建议时段和天气影响仍待已有证据补齐。");
  if (node?.domain === "stay" && node?.foreignGuestEligible == null) unknowns.push("外宾住宿资格仍需酒店或授权平台确认。");
  return unknowns.slice(0, 5);
}

function midpoint(left, right) {
  return {
    longitude: (left.longitude + right.longitude) / 2,
    latitude: (left.latitude + right.latitude) / 2,
    coordinateSystem: left.coordinateSystem === "WGS-84" || right.coordinateSystem === "WGS-84" ? "WGS-84" : "GCJ-02",
  };
}

function cameraBeats(coordinates, anchor, routeRelation) {
  if (!coordinates) return [];
  const relationCenter = routeRelation?.anchorCoordinates ? midpoint(coordinates, routeRelation.anchorCoordinates) : anchor?.coordinates ? midpoint(coordinates, anchor.coordinates) : coordinates;
  return [
    { key: "area", label: "城市/片区定位", center: relationCenter, zoom: routeRelation?.anchorCoordinates || anchor?.coordinates ? 13 : 14, pitch: 46, rotation: 12, duration: 1600 },
    { key: "place", label: "地点近景", center: coordinates, zoom: 17, pitch: 62, rotation: 34, duration: 2400 },
    { key: "route", label: "与当前锚点的关系", center: relationCenter, zoom: routeRelation?.anchorCoordinates || anchor?.coordinates ? 14 : 16, pitch: 54, rotation: -18, duration: 1800 },
  ];
}

const SKETCH_THEMES = {
  lakeshore: { label: "湖岸手账", englishLabel: "By the water", caption: "转一转，看水岸在纸上展开", englishCaption: "Turn the island. Follow the water's edge." },
  mountain: { label: "山野手账", englishLabel: "Into the hills", caption: "换个角度，看山的起伏", englishCaption: "A different angle, a different ridge." },
  heritage: { label: "街巷手账", englishLabel: "Along old streets", caption: "从屋檐到街角，慢慢看看", englishCaption: "From the rooftops to the street corners." },
  culture: { label: "建筑手账", englishLabel: "A place for culture", caption: "绕过正面，看看另一侧", englishCaption: "Circle around. See another side." },
  dining: { label: "寻味手账", englishLabel: "A little taste of the trip", caption: "在街角停一停", englishCaption: "Pause at a little street corner." },
  notebook: { label: "地点手账", englishLabel: "A place in your notebook", caption: "一页地点线索，留给旅行的想象", englishCaption: "A page of clues for your next trip." },
};

// These rules choose an illustration theme, never facts or a reconstruction.
function sketchTheme(node) {
  const fields = [
    ["category", [node.category, node.operability?.category, node.operability?.type].filter((value) => typeof value === "string").join(" / ")],
    ["title", node.title], ["summary", node.summary], ["evidenceSummary.headline", node.evidenceSummary?.headline],
  ];
  if (node.domain === "food") return { id: "dining", basis: { field: "domain", excerpt: "food" } };
  // A hotel by a lake is still a hotel; proximity is not a landscape type.
  if (node.domain === "stay" || node.domain === "transport") return { id: "notebook", basis: { field: "domain", excerpt: node.domain } };
  const rules = [
    ["heritage", /古镇|古城|老街|历史街|历史建筑群|古街|弄堂|胡同|\b(?:old town|historic district|heritage street)\b/i],
    ["culture", /博物馆|美术馆|艺术馆|展览馆|文化馆|纪念馆|寺庙|寺院|祠堂|\b(?:museum|gallery|temple|cultural centre)\b/i],
    ["lakeshore", /湖景|湖岸|湖畔|湖滨|湖边|西湖|洱海|海滨|海岸|江岸|江畔|滨江|河畔|水岸|\b(?:lake|lakeside|waterfront|coast|riverside)\b/i],
    ["mountain", /山地|山景|山野|山峰|山脉|登山|徒步|森林公园|\b(?:mountain|hiking|woodland)\b/i],
  ];
  for (const [field, value] of fields) {
    if (typeof value !== "string") continue;
    for (const [id, pattern] of rules) {
      const match = value.match(pattern);
      if (match) return { id, basis: { field, excerpt: match[0] } };
    }
  }
  return { id: "notebook", basis: null };
}

function sketchWorld(node, media, facts, routeRelation) {
  const theme = sketchTheme(node);
  let seed = 2166136261;
  for (const char of String(node.nodeId || node.title)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  const overview = facts.find((fact) => fact.label === "此行体验线索") ?? facts.find((fact) => fact.label === "来源证据");
  const hotspots = [{
    id: "place", kind: "place", label: "地点概览", englishLabel: "The place", nodeId: node.nodeId,
    text: overview?.value || String(node.title), source: overview?.source || node.operability?.sourceLabel || "当前候选",
    factLabel: overview?.label ?? null,
  }];
  if (media.length) hotspots.push({ id: "photo", kind: "photo", label: "来源照片", englishLabel: "Source photo", nodeId: node.nodeId, mediaId: media[0].mediaId, text: media[0].alt, source: media[0].source });
  else {
    const fact = facts.find((row) => row !== overview && row.label !== "路线关系");
    if (fact) hotspots.push({ id: "evidence", kind: "fact", label: "资料线索", englishLabel: "A source clue", nodeId: node.nodeId, factLabel: fact.label, text: fact.value, source: fact.source });
  }
  hotspots.push({
    id: "route", kind: "route", label: "路线关系", englishLabel: "In your route", nodeId: node.nodeId,
    legId: routeRelation?.legId ?? null,
    text: routeRelation ? facts.find((fact) => fact.label === "路线关系")?.value : "尚无已核验路线。试排后查看时间、步行与预算影响。",
    source: routeRelation ? "当前行程出行资料" : "路线待试排",
    pending: !routeRelation,
  });
  return {
    theme: { ...theme, ...SKETCH_THEMES[theme.id] }, seed, hotspots,
    authenticityLabel: "风格化示意 · 非实景还原",
    englishAuthenticityLabel: "Stylized illustration · not a reconstruction",
  };
}

export function buildDestinationExperienceScene({ node, plan } = {}) {
  if (!node) return null;
  const coordinates = nodeCoordinate(node, plan);
  const media = mediaRows(node);
  const routeRelation = routeRelationForNode(plan, node);
  const anchor = selectedAnchor(plan, node.nodeId);
  const facts = factRows(node, plan, routeRelation);
  const unknowns = unknownRows(node, coordinates, media, routeRelation, facts);
  return {
    schemaVersion: "destination-experience-scene-v1",
    nodeId: node.nodeId,
    title: node.title,
    domain: node.domain,
    domainLabel: DOMAIN_LABELS[node.domain] ?? "地点",
    coordinates,
    cameraBeats: cameraBeats(coordinates, anchor, routeRelation),
    media,
    facts,
    unknowns,
    routeRelation,
    sketch: sketchWorld(node, media, facts, routeRelation),
    checkedAt: node.operability?.checkedAt ?? node.checkedAt ?? plan?.checkedAt ?? null,
    source: node.operability?.sourceLabel || node.operability?.provider || node.sourceStatus || "旅行资料来源",
    cta: {
      canDraft: Boolean(coordinates && !node.selected && ["play", "food", "stay"].includes(node.domain)),
      label: node.selected ? "已在当前旅行中" : coordinates ? "加入路线试排" : "坐标待补，暂不能试排",
    },
  };
}

export function destinationSketchPolicy({ webglAvailable = true, prefersReducedMotion = false, saveData = false } = {}) {
  if (!webglAvailable) return { mode: "static_sketch", reason: "webgl_unavailable", canTour: false };
  return { mode: "webgl", reason: prefersReducedMotion ? "reduced_motion" : saveData ? "save_data" : "ready", canTour: !prefersReducedMotion && !saveData };
}

export function destinationRenderPolicy({ scene, prefersReducedMotion = false, saveData = false, amapFailed = false } = {}) {
  if (!scene?.coordinates) return { mode: "unavailable", reason: "destination_coordinates_missing" };
  if (prefersReducedMotion) return { mode: "fallback_2d", reason: "reduced_motion" };
  if (saveData) return { mode: "fallback_2d", reason: "save_data" };
  if (amapFailed) return { mode: "fallback_2d", reason: "amap_js_renderer_load_failed" };
  if (scene.coordinates.coordinateSystem !== "GCJ-02") return { mode: "fallback_2d", reason: "outside_amap_coordinate_system" };
  return { mode: "amap_3d", reason: "amap_destination_ready" };
}

export function buildDestinationTrialSelection(scene) {
  if (!scene?.cta?.canDraft || !scene.domain || !scene.nodeId) return null;
  return { [scene.domain]: scene.nodeId };
}
