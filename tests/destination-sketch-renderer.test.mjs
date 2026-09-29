import assert from "node:assert/strict";
import test from "node:test";
import { Box3 } from "three";
import { buildDestinationSketchModel } from "../src/web/destination-sketch-renderer.js";
import { createSketchFrameLoop, createSketchTour } from "../src/web/destination-sketch-motion.js";

const sketch = (id) => ({ theme: { id }, seed: 20923, hotspots: [{ id: "place", nodeId: "candidate" }, { id: "photo", nodeId: "candidate", mediaId: "source-photo" }, { id: "route", nodeId: "candidate" }] });

test("six scene themes are real finite 3D meshes, within the small-world geometry budget", () => {
  const signatures = new Set();
  for (const theme of ["lakeshore", "mountain", "heritage", "culture", "dining", "notebook"]) {
    const model = buildDestinationSketchModel(sketch(theme));
    const bounds = new Box3().setFromObject(model.root);
    assert.ok(bounds.max.y - bounds.min.y > 0.8, `${theme} has real depth`);
    assert.ok(model.stats.triangles > 0 && model.stats.triangles < 40000);
    assert.ok(model.stats.drawCalls < 80);
    assert.ok(model.root.children.some((object) => object.isMesh));
    for (const object of model.root.children) assert.ok(object.geometry.getAttribute("position").array.every(Number.isFinite), theme);
    signatures.add(`${model.stats.triangles}:${bounds.max.y}`);
    assert.deepEqual(model.hotspots.map((point) => point.nodeId), ["candidate", "candidate", "candidate"]);
    model.dispose();
  }
  assert.equal(signatures.size, 6, "theme changes produce different geometry, not just a new label");
});

test("sketch strokes are deterministic and all geometries, materials and the shared texture dispose once", () => {
  const a = buildDestinationSketchModel(sketch("lakeshore"));
  const b = buildDestinationSketchModel(sketch("lakeshore"));
  assert.deepEqual(a.root.children.map((child) => child.geometry.getAttribute("position").array), b.root.children.map((child) => child.geometry.getAttribute("position").array));
  const resources = new Set(a.root.children.flatMap((child) => [child.geometry, child.material, child.material.gradientMap].filter(Boolean)));
  let released = 0;
  for (const resource of resources) resource.addEventListener("dispose", () => released++);
  a.dispose(); a.dispose();
  assert.equal(released, resources.size);
  assert.equal(a.root.children.length, 0);
  b.dispose();
});

test("solid, ink and point views share the model geometry and release point resources", () => {
  const model = buildDestinationSketchModel(sketch("culture"));
  const originalMeshes = model.root.children.filter((object) => object.isMesh);
  assert.equal(model.setPresentation("ink"), true);
  assert.ok(originalMeshes.every((object) => !object.visible));
  assert.ok(model.root.children.some((object) => object.isLineSegments && object.visible));
  model.setPresentation("points");
  const points = model.root.children.find((object) => object.isPoints);
  assert.ok(points.visible);
  assert.ok(points.geometry.getAttribute("position").count > 100);
  assert.ok(points.geometry.getAttribute("position").array.every(Number.isFinite));
  model.setPresentation("solid");
  assert.ok(originalMeshes.every((object) => object.visible));
  assert.equal(points.visible, false);
  let released = 0;
  points.geometry.addEventListener("dispose", () => released++);
  points.material.addEventListener("dispose", () => released++);
  model.dispose(); assert.equal(released, 2);
});

test("the render loop sleeps at rest, pauses when hidden and ignores late callbacks after disposal", () => {
  const callbacks = new Map();
  let id = 0, renders = 0, moving = false;
  const loop = createSketchFrameLoop({ requestFrame: (fn) => { callbacks.set(++id, fn); return id; }, cancelFrame: (key) => callbacks.delete(key), render: () => renders++, step: () => moving });
  const tick = (time) => { const [key, fn] = callbacks.entries().next().value; callbacks.delete(key); fn(time); };
  loop.invalidate(); loop.invalidate(); assert.equal(callbacks.size, 1);
  tick(1); assert.equal(renders, 1); assert.equal(callbacks.size, 0);
  moving = true; loop.invalidate(); tick(2); assert.equal(callbacks.size, 1);
  loop.pause(); assert.equal(callbacks.size, 0); loop.invalidate(); assert.equal(callbacks.size, 0);
  loop.resume(); const late = callbacks.values().next().value; loop.dispose(); late(4);
  assert.equal(renders, 2); assert.equal(callbacks.size, 0);
});

test("the user-triggered 7.2-second tour visits chapters and stops immediately on interruption or disposal", () => {
  let camera = { position: [10, 10, 13], target: [0, 0, 0], zoom: 1 }, writes = 0;
  const chapters = [], states = [];
  const tour = createSketchTour({ readCamera: () => structuredClone(camera), writeCamera: (value) => { camera = value; writes++; }, onChapter: (id) => chapters.push(id), onState: (state) => states.push(state) });
  const beats = [0, 1, 2].map((i) => ({ id: `chapter-${i}`, position: [i, 9, 12], target: [i, 0, 0], zoom: 1.2 }));
  assert.equal(tour.playing, false);
  tour.start(beats, 0); tour.step(0); tour.step(2400); tour.step(4800); tour.step(7200);
  assert.deepEqual(chapters, ["chapter-0", "chapter-1", "chapter-2"]);
  assert.deepEqual(camera.position, beats[2].position);
  assert.equal(tour.playing, false);
  assert.deepEqual(states, [true, false]);
  tour.start(beats, 8000); tour.step(9000); tour.stop(); const count = writes;
  assert.equal(tour.step(10000), false); assert.equal(writes, count);
  tour.dispose(); assert.equal(tour.start(beats, 11000), false);
  const still = createSketchTour({ readCamera: () => camera, writeCamera: () => assert.fail("reduced motion must not animate"), reducedMotion: true });
  assert.equal(still.start(beats, 0), false); assert.equal(still.step(3000), false);
});
