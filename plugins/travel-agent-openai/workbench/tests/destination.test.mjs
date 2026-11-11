import test from "node:test";
import assert from "node:assert/strict";
import { destinationFromPlace, sourceIsExpired } from "../src/destination.mjs";

test("a source place gets a stylized scene without an invented route or source photo", () => {
  const scene = destinationFromPlace({ sourceId: "poi-1", name: "测试博物馆", address: "测试路 1 号", type: "博物馆",
    coordinates: { longitude: 121.47, latitude: 31.23, coordinateSystem: "GCJ-02" } }, "play", "2026-11-06T10:00:00Z");
  assert.equal(scene.title, "测试博物馆");
  assert.equal(scene.sketch.theme.id, "culture");
  assert.equal(scene.sketch.authenticityLabel, "风格化示意 · 非实景还原");
  assert.equal(scene.routeRelation, null);
  assert.deepEqual(scene.media, []);
  assert.equal(scene.sketch.hotspots.find(item => item.id === "route").pending, true);
  assert.equal(scene.sketch.hotspots.find(item => item.id === "place").text, "地图记录地址：测试路 1 号");
});

test("a place with no landscape evidence uses the neutral notebook theme", () => {
  const scene = destinationFromPlace({ sourceId: "poi-2", name: "测试地点" }, "play", "2026-11-06T10:00:00Z");
  assert.equal(scene.sketch.theme.id, "notebook");
  assert.equal(scene.sketch.theme.basis, null);
  assert.equal(scene.coordinates, null);
});

test("an open source page becomes expired at its recorded deadline", () => {
  const source = { freshUntil: "2026-11-06T10:30:00Z", expired: false };
  assert.equal(sourceIsExpired(source, Date.parse("2026-11-06T10:29:59Z")), false);
  assert.equal(sourceIsExpired(source, Date.parse("2026-11-06T10:30:00Z")), true);
  assert.equal(sourceIsExpired({ expired: true }, Date.now()), true);
});
