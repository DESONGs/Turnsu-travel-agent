import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canPreviewPhotoRelief, defaultPhotoRelief, validatePhotoRelief } from "../src/media/photo-relief-recipe.mjs";
import { buildPhotoReliefData, createPhotoWashPixels, extractPhotoContours, liftPhotoContours } from "../src/web/photo-relief-data.js";
import { buildPhotoReliefGeometry, buildPhotoContourGeometry, readReliefPixels } from "../src/web/photo-relief-renderer.js";

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

test("portrait and wide photos stay bounded; wash uses source colours without changing the original", () => {
  for (const input of [pixels(24, 96), pixels(96, 24), pixels(2, 2)]) {
    const before = input.data.slice(); const ink = createPhotoWashPixels(input);
    assert.equal(ink.length, input.data.length); assert.deepEqual(input.data, before);
    assert.deepEqual(ink, createPhotoWashPixels(input));
    assert.notDeepEqual(ink, input.data);
    const model = buildPhotoReliefData(input, "landscape"); assert.ok(model.modelWidth <= 5.4); assert.ok(model.modelHeight <= 4.2);
  }
  assert.throws(() => createPhotoWashPixels({ data: new Uint8Array(4), width: 1281, height: 1 }), /relief_pixels_invalid/);
});

test("wash keeps a smooth sky gradient instead of introducing hard posterization bands", () => {
  const width = 192, height = 8, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([40 + x, 50 + x, 60 + x, 255], (y * width + x) * 4);
  const ink = createPhotoWashPixels({ data, width, height });
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

test("contours follow a photograph's silhouette rather than a triangle grid, and lift onto its depth surface", () => {
  const width = 120, height = 90, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 20; y < 76; y++) for (let x = 30; x < 92; x++) data.set([40, 60, 50, 255], (y * width + x) * 4);
  const source = { data, width, height }, before = data.slice(), contours = extractPhotoContours(source);
  assert.deepEqual(data, before); assert.deepEqual(contours, extractPhotoContours(source));
  assert.ok(contours.segments.length > 0 && contours.segments.length < 200, "straight silhouette simplifies into a few strokes");
  for (let i = 0; i < contours.segments.length; i += 2) {
    const x = contours.segments[i] * (width - 1), y = contours.segments[i + 1] * (height - 1);
    assert.ok(Math.min(Math.abs(x - 30), Math.abs(x - 91), Math.abs(y - 20), Math.abs(y - 75)) < 3, "all strokes stay on the source silhouette");
  }
  const surface = buildPhotoReliefData(source, "building"), lifted = liftPhotoContours(contours, surface);
  const z = [];
  for (let i = 0; i < lifted.length; i += 3) {
    assert.ok(Math.abs(lifted[i] / surface.modelWidth + 0.5 - contours.segments[i / 3 * 2]) < 1e-6, "front view keeps original horizontal framing");
    assert.ok(lifted.slice(i, i + 3).every(Number.isFinite)); z.push(lifted[i + 2]);
  }
  assert.ok(Math.max(...z) - Math.min(...z) > 0.2, "lines have actual depth");
  const geometry = buildPhotoContourGeometry(contours, surface);
  assert.equal(geometry.attributes.instanceStart.count, contours.strengths.length);
  let disposed = false; geometry.addEventListener("dispose", () => { disposed = true; }); geometry.dispose(); assert.ok(disposed);
  assert.equal(extractPhotoContours({ ...source, data: new Uint8ClampedArray(data.length).fill(255) }).segments.length, 0, "blank photos do not receive invented features");
});

test("pure line and wash recipes survive validation while older original-colour records remain readable", () => {
  for (const style of ["line", "ink", "photo"]) assert.equal(validatePhotoRelief({ ...defaultPhotoRelief(), style }).style, style);
  const source = pixels(160, 120), contours = extractPhotoContours(source);
  const shallow = buildPhotoReliefData(source, "landscape", { ...defaultPhotoRelief(), depth: 0.15 });
  const deep = buildPhotoReliefData(source, "landscape", { ...defaultPhotoRelief(), depth: 1 });
  assert.notDeepEqual(liftPhotoContours(contours, shallow), liftPhotoContours(contours, deep));
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
