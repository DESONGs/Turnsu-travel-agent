import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDestinationExperienceScene,
  buildDestinationTrialSelection,
  destinationRenderPolicy,
  destinationSketchPolicy,
} from "../src/web/destination-experience-scene.js";

const point = (longitude, latitude) => ({ longitude, latitude, coordinateSystem: "GCJ-02" });

const plan = {
  revision: 7,
  checkedAt: "2026-09-05T08:30:00.000Z",
  byDomain: {
    stay: [{ nodeId: "stay_1", domain: "stay", title: "西湖边酒店", selected: true, location: { coordinates: point(120.15, 30.25) } }],
    play: [],
  },
  mobility: {
    checkedAt: "2026-09-05T08:40:00.000Z",
    legs: [{
      legId: "stay_lake",
      origin: { nodeId: "stay_1", label: "西湖边酒店", coordinates: point(120.15, 30.25) },
      destination: { nodeId: "play_lake", label: "曲院风荷", coordinates: point(120.14, 30.26) },
      recommendedMode: "taxi",
      rationale: "打车步行更少，适合带父母的轻松节奏。",
      alternatives: [{
        mode: "taxi",
        totalMinutes: 14,
        walkingMeters: 120,
        transfers: 0,
        estimatedFareCny: 28,
        polyline: [point(120.15, 30.25), point(120.14, 30.26)],
      }],
    }],
  },
  weather: {
    coverage: "covered",
    checkedAt: "2026-09-05T08:00:00.000Z",
    attribution: "天气来源",
    tripDates: ["2026-10-02"],
    forecastDays: [{ date: "2026-10-02", dayCondition: "多云", nightCondition: "晴" }],
    planningImpact: { guidance: { play: "户外湖景适合放在白天。", food: "餐饮不受影响。" } },
  },
};

test("DestinationExperienceScene is a read-only projection from existing node, media, evidence and mobility", () => {
  const node = {
    nodeId: "play_lake",
    domain: "play",
    title: "曲院风荷",
    summary: "适合轻松看湖景，离住宿锚点较近。",
    selected: false,
    sourceStatus: "verified_provider",
    location: { coordinates: point(120.14, 30.26) },
    media: [
      { url: "https://store.is.autonavi.com/lake.jpg", title: "湖景", source: "amap_web_service" },
      { url: "https://untrusted.example/lake.jpg", title: "未知图片", source: "unknown_blog" },
      { displayUrl: "https://cdn.example/allowed.jpg", title: "授权图片", source: "curated_source" },
    ],
    evidenceSummary: { headline: "来源提到湖景和轻松动线。", independentSourceCount: 2 },
    operability: { checkedAt: "2026-09-05T08:45:00.000Z", rating: "4.7" },
  };
  const beforePlan = structuredClone(plan);
  const beforeNode = structuredClone(node);
  const scene = buildDestinationExperienceScene({ node, plan });
  assert.equal(scene.schemaVersion, "destination-experience-scene-v1");
  assert.equal(scene.nodeId, "play_lake");
  assert.equal(scene.coordinates.longitude, 120.14);
  assert.equal(scene.media.length, 2);
  assert.equal(scene.media.some((media) => media.displayUrl.includes("untrusted.example")), false);
  assert.ok(scene.facts.some((fact) => fact.label === "此行体验线索" && fact.value.includes("轻松看湖景")));
  assert.ok(scene.facts.some((fact) => fact.label === "路线关系" && fact.value.includes("约 14 分钟")));
  assert.ok(scene.facts.some((fact) => fact.label === "天气与时段" && fact.value.includes("多云")));
  assert.equal(scene.routeRelation.polyline.length, 2);
  assert.equal(scene.cameraBeats.length, 3);
  assert.deepEqual(buildDestinationTrialSelection(scene), { play: "play_lake" });
  assert.deepEqual(plan, beforePlan);
  assert.deepEqual(node, beforeNode);
});

test("DestinationExperienceScene reports missing coordinates and does not create fake photos or route facts", () => {
  const scene = buildDestinationExperienceScene({
    node: { nodeId: "food_1", domain: "food", title: "湖边餐厅", selected: false, media: [{ url: "https://example.com/raw.jpg", source: "unknown" }], operability: {} },
    plan: { byDomain: {}, mobility: { legs: [] } },
  });
  assert.equal(scene.coordinates, null);
  assert.deepEqual(scene.media, []);
  assert.deepEqual(scene.cameraBeats, []);
  assert.equal(scene.cta.canDraft, false);
  assert.equal(buildDestinationTrialSelection(scene), null);
  assert.ok(scene.unknowns.some((unknown) => unknown.includes("可靠坐标")));
  assert.ok(scene.unknowns.some((unknown) => unknown.includes("来源图片")));
});

test("destination render policy degrades honestly for motion, data saver, missing coordinates and AMap failure", () => {
  const scene = { coordinates: point(120.14, 30.26) };
  assert.deepEqual(destinationRenderPolicy({ scene }), { mode: "amap_3d", reason: "amap_destination_ready" });
  assert.deepEqual(destinationRenderPolicy({ scene, prefersReducedMotion: true }), { mode: "fallback_2d", reason: "reduced_motion" });
  assert.deepEqual(destinationRenderPolicy({ scene, saveData: true }), { mode: "fallback_2d", reason: "save_data" });
  assert.deepEqual(destinationRenderPolicy({ scene, amapFailed: true }), { mode: "fallback_2d", reason: "amap_js_renderer_load_failed" });
  assert.deepEqual(destinationRenderPolicy({ scene: { coordinates: null } }), { mode: "unavailable", reason: "destination_coordinates_missing" });
  assert.deepEqual(destinationRenderPolicy({ scene: { coordinates: { ...point(120.14, 30.26), coordinateSystem: "WGS-84" } } }), { mode: "fallback_2d", reason: "outside_amap_coordinate_system" });
});

test("illustration themes follow available place clues without turning nearby landscapes into hotel facts", () => {
  const cases = [
    [{ domain: "play", title: "曲院风荷", summary: "湖岸散步" }, "lakeshore", "summary"],
    [{ domain: "play", title: "山地公园", summary: "适合登山" }, "mountain", "title"],
    [{ domain: "play", title: "洱海", category: "山湖田园", summary: "免费开放", evidenceSummary: { headline: "从大理古城前往洱海" } }, "lakeshore", "title"],
    [{ domain: "play", title: "湖畔街区", category: "历史街区", summary: "老街漫步" }, "heritage", "category"],
    [{ domain: "play", title: "城市博物馆" }, "culture", "title"],
    [{ domain: "food", title: "湖边餐厅", summary: "可看湖景" }, "dining", "domain"],
    [{ domain: "stay", title: "湖畔酒店", summary: "离湖岸很近" }, "notebook", "domain"],
    [{ domain: "play", title: "星光空间", summary: "候选详情待补" }, "notebook", undefined],
  ];
  for (const [node, theme, field] of cases) {
    const scene = buildDestinationExperienceScene({ node: { nodeId: "real-option", ...node } });
    assert.equal(scene.sketch.theme.id, theme);
    assert.equal(scene.sketch.theme.basis?.field, field);
    assert.equal(scene.coordinates, null);
    assert.equal(scene.cta.canDraft, false);
    assert.ok(scene.sketch.hotspots.every((point) => point.nodeId === "real-option"));
    assert.ok(scene.sketch.hotspots.length <= 3);
    assert.match(scene.sketch.authenticityLabel, /非实景还原/);
    assert.equal(scene.sketch.hotspots.find((point) => point.kind === "route").pending, true);
  }
});

test("photo and fact hotspots refer only to accepted source material and keep the trial selection contract", () => {
  const node = { nodeId: "food-source", domain: "food", title: "街角餐饮", summary: "来源只介绍本地菜", location: { coordinates: point(120, 30) }, media: [{ displayUrl: "https://source.example/photo.jpg", mediaId: "licensed", source: "当前供应方" }, { url: "https://unlicensed.example/p.jpg" }] };
  const before = structuredClone(node);
  const scene = buildDestinationExperienceScene({ node });
  assert.deepEqual(node, before);
  const photo = scene.sketch.hotspots.find((hotspot) => hotspot.kind === "photo");
  assert.equal(photo.mediaId, "licensed");
  assert.equal(scene.media.length, 1);
  assert.equal(scene.sketch.hotspots[0].text, node.summary);
  assert.deepEqual(buildDestinationTrialSelection(scene), { food: node.nodeId });
  assert.equal(buildDestinationTrialSelection(buildDestinationExperienceScene({ node: { ...node, selected: true } })), null);
});

test("sketch WebGL does not need coordinates or an AMap key; reduced motion preserves manual 3D controls", () => {
  assert.deepEqual(destinationSketchPolicy(), { mode: "webgl", reason: "ready", canTour: true });
  assert.deepEqual(destinationSketchPolicy({ prefersReducedMotion: true }), { mode: "webgl", reason: "reduced_motion", canTour: false });
  assert.deepEqual(destinationSketchPolicy({ saveData: true }), { mode: "webgl", reason: "save_data", canTour: false });
  assert.deepEqual(destinationSketchPolicy({ webglAvailable: false }), { mode: "static_sketch", reason: "webgl_unavailable", canTour: false });
});
