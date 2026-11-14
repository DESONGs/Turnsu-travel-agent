import { buildDestinationExperienceScene } from "../destination-experience-scene.js";

export function sourceIsExpired(source, now = Date.now()) {
  const deadline = Date.parse(source?.freshUntil);
  return source?.expired === true || (Number.isFinite(deadline) && deadline <= now);
}

export function destinationSourceLabel(value) {
  const label = String(value || "地点参考资料").trim();
  return ({ decision_fixture: "受控测试资料", fixture: "受控测试资料", amap: "高德地图", amap_mcp: "高德地图", amap_official_mcp: "高德地图", google_maps: "Google Maps", fliggy: "飞猪", tuniu: "途牛" })[label] || label;
}

/** The illustration receives only fields returned by the current place reference. */
export function destinationFromPlace(place, domain, checkedAt) {
  return buildDestinationExperienceScene({ node: {
    nodeId: place.sourceId, title: place.name, domain,
    ...(place.address ? { summary: `地图记录地址：${place.address}` } : {}),
    location: { coordinates: place.coordinates },
    operability: { category: place.type, sourceLabel: destinationSourceLabel(place.operability?.sourceLabel || place.sourceLabel), checkedAt },
  } });
}
