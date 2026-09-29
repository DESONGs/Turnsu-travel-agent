import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canPreviewPhotoRelief, defaultPhotoRelief, validatePhotoRelief } from "../src/media/photo-relief-recipe.mjs";
import { buildPhotoReliefData, createInkPixels } from "../src/web/photo-relief-data.js";
import { buildPhotoReliefGeometry, readReliefPixels } from "../src/web/photo-relief-renderer.js";

function pixels(width = 96, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(y < height * 0.45 ? [153, 190, 211, 255] : [45 + x, 109, 67 + y, 255], (y * width + x) * 4);
  return { width, height, data };
}

test("only scenery and architecture may create a versioned, bounded local relief", () => {
  assert.equal(canPreviewPhotoRelief("landscape"), true); assert.equal(canPreviewPhotoRelief("building"), true); assert.equal(canPreviewPhotoRelief("food"), false);
  const defaults = defaultPhotoRelief(); assert.deepEqual(validatePhotoRelief(defaults), defaults);
  for (const change of [{ horizon: NaN }, { horizon: 0.81 }, { depth: Infinity }, { depth: 0 }, { style: "executable" }, { version: "future-v9" }, { url: "https://external.invalid" }]) assert.throws(() => validatePhotoRelief({ ...defaults, ...change }), { code: "journal_relief_invalid" });
  assert.throws(() => buildPhotoReliefData(pixels(), "food"), /relief_subject_unsupported/);
});

test("the photograph produces an actual non-flat bounded mesh, with deterministic geometry and valid UVs", () => {
  const input = pixels(), before = input.data.slice();
  const a = buildPhotoReliefData(input, "landscape"), b = buildPhotoReliefData(input, "landscape");
  assert.deepEqual(a.positions, b.positions); assert.deepEqual(input.data, before);
  assert.equal(a.reconstruction, false);
  assert.ok(a.indices.length / 3 <= 26000); assert.ok(a.positions.length / 3 < 13000);
  const z = [];
  for (let i = 0; i < a.positions.length; i++) { assert.ok(Number.isFinite(a.positions[i])); if (i % 3 === 2) z.push(a.positions[i]); }
  assert.ok(Math.max(...z) - Math.min(...z) > 0.5, "not a spinning flat image plane");
  assert.ok(a.indices.every((index) => index < a.positions.length / 3));
  assert.ok(a.uv.every((value) => value >= 0 && value <= 1));
  const changed = { ...input, data: new Uint8ClampedArray(input.data.length).fill(240) };
  assert.notDeepEqual(a.positions, buildPhotoReliefData(changed, "landscape").positions, "depth includes photo data, not a fixed generic scene");
  assert.notDeepEqual(a.positions, buildPhotoReliefData(input, "landscape", { ...defaultPhotoRelief(), horizon: 0.7 }).positions);
  assert.notDeepEqual(a.positions, buildPhotoReliefData(input, "building").positions);
});

test("portrait and wide photos stay bounded; ink uses source colours without changing the original", () => {
  for (const input of [pixels(24, 96), pixels(96, 24), pixels(2, 2)]) {
    const before = input.data.slice(); const ink = createInkPixels(input);
    assert.equal(ink.length, input.data.length); assert.deepEqual(input.data, before);
    assert.deepEqual(ink, createInkPixels(input));
    assert.notDeepEqual(ink, input.data);
    const model = buildPhotoReliefData(input, "landscape"); assert.ok(model.modelWidth <= 5.4); assert.ok(model.modelHeight <= 4.2);
  }
  assert.throws(() => createInkPixels({ data: new Uint8Array(4), width: 1281, height: 1 }), /relief_pixels_invalid/);
});

test("ink keeps a smooth sky gradient instead of introducing hard posterization bands", () => {
  const width = 192, height = 8, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([40 + x, 50 + x, 60 + x, 255], (y * width + x) * 4);
  const ink = createInkPixels({ data, width, height });
  for (let x = 2; x < width - 2; x++) for (let c = 0; c < 3; c++) {
    const i = (4 * width + x) * 4 + c;
    assert.ok(Math.abs(ink[i] - ink[i - 4]) <= 10, "smooth skies must not turn into hard colour stripes");
  }
});

test("Three.js geometry is finite and disposable; remote photos are not fetched by the renderer", async () => {
  const model = buildPhotoReliefGeometry(pixels(), "landscape", defaultPhotoRelief());
  assert.equal(model.geometry.isBufferGeometry, true);
  assert.ok(model.geometry.getAttribute("normal").array.every(Number.isFinite));
  assert.ok(model.geometry.boundingBox.max.z > model.geometry.boundingBox.min.z);
  let disposed = false; model.geometry.addEventListener("dispose", () => { disposed = true; }); model.geometry.dispose(); assert.equal(disposed, true);
  await assert.rejects(readReliefPixels("https://external.invalid/private-photo.jpg"), /relief_source_not_local/);
  await assert.rejects(readReliefPixels("file:///private/photo.jpg"), /relief_source_not_local/);
});

test("the real journal consumer connects draft and saved-photo previews, and preserves explicit food exclusion", async () => {
  const journal = await readFile(new URL("../src/web/travel-photo-journal.jsx", import.meta.url), "utf8");
  assert.match(journal, /src=\{photos\[active\]\.url\}/);
  assert.match(journal, /onRecipeChange=/); assert.match(journal, /canPreviewPhotoRelief\(subject\)/);
  assert.match(journal, /onPaste=\{pastePhotos\}/); assert.match(journal, /onDrop=/);
  const preview = await readFile(new URL("../src/web/photo-relief-preview.jsx", import.meta.url), "utf8");
  assert.match(preview, /aria-label=\{pick\("远近分界", "Horizon"\)\}/);
  assert.match(preview, /aria-label=\{pick\("立体强度", "Depth strength"\)\}/);
  const renderer = await readFile(new URL("../src/web/photo-relief-renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /minAzimuthAngle = -0\.38/);
  assert.match(renderer, /document\.removeEventListener\("visibilitychange", visibility\)/);
  assert.match(renderer, /tour\.dispose\(\); loop\.dispose\(\)/);
  assert.match(renderer, /previous\.dispose\(\)/);
});
