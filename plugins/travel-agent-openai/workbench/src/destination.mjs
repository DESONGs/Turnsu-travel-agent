import { buildDestinationExperienceScene } from "../../../../src/web/destination-experience-scene.js";

export function sourceIsExpired(source, now = Date.now()) {
  const deadline = Date.parse(source?.freshUntil);
  return source?.expired === true || (Number.isFinite(deadline) && deadline <= now);
}

/** The illustration receives only fields returned by the current place reference. */
export function destinationFromPlace(place, domain, checkedAt) {
  return buildDestinationExperienceScene({ node: {
    nodeId: place.sourceId, title: place.name, domain,
    ...(place.address ? { summary: `地图记录地址：${place.address}` } : {}),
    location: { coordinates: place.coordinates },
    operability: { category: place.type, sourceLabel: "高德地图参考资料", checkedAt },
  } });
}
