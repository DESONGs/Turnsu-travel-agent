import { canPreviewPhotoRelief, defaultPhotoRelief, validatePhotoRelief } from "../media/photo-relief-recipe.mjs";

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const light = (data, i) => (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
function checkPixels({ data, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 1280 || height > 1280 || !data || data.length !== width * height * 4) throw new Error("relief_pixels_invalid");
}

// Flatten small texture detail before outlining strong image edges. Original RGB
// remains available; no generated buildings, props, or all-triangle wireframes.
export function createInkPixels(pixels) {
  checkPixels(pixels);
  const { data, width, height } = pixels;
  const smooth = new Uint8ClampedArray(data.length), result = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) total += data[(clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)) * 4 + c];
      smooth[index + c] = total / 9;
    }
    smooth[index + 3] = 255;
  }
  const sample = (x, y) => light(smooth, (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const gx = sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1) - sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1);
    const gy = sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1) - sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1);
    const ink = clamp((Math.hypot(gx, gy) - 0.3) * 1.3, 0, 0.68);
    const luminance = light(smooth, i) * 255;
    for (let c = 0; c < 3; c++) {
      const softened = smooth[i + c] * 0.8 + luminance * 0.2;
      // Soft quantization keeps skies smooth instead of producing hard RGB bands.
      const flat = softened * 0.72 + Math.round(softened / 32) * 32 * 0.28;
      const tint = [249, 245, 231][c], stroke = [43, 62, 58][c];
      result[i + c] = clamp((flat * 0.91 + tint * 0.09) * (1 - ink) + stroke * ink, 0, 255);
    }
    result[i + 3] = 255;
  }
  return result;
}

// Deliberately heuristic, not learned/metric depth: a user-adjustable horizon,
// foreground recession and bounded colour relief. Sky stays distant. The pixel
// contribution changes with the photograph; the horizon/depth controls expose
// the assumptions instead of pretending a single image reveals hidden surfaces.
export function buildPhotoReliefData(pixels, subject, input = defaultPhotoRelief()) {
  checkPixels(pixels);
  if (!canPreviewPhotoRelief(subject)) throw new Error("relief_subject_unsupported");
  const recipe = validatePhotoRelief(input), { width, height, data } = pixels;
  const aspect = width / height;
  const columns = 112, rows = Math.max(24, Math.min(112, Math.round(columns / aspect)));
  const modelWidth = Math.min(5.4, 4.2 * aspect), modelHeight = modelWidth / aspect;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uv = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices = new Uint16Array(columns * rows * 6);
  const depths = new Float32Array((columns + 1) * (rows + 1));
  const pixel = (u, v) => (Math.round(clamp(v) * (height - 1)) * width + Math.round(clamp(u) * (width - 1))) * 4;
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const u = col / columns, v = row / rows, index = row * (columns + 1) + col;
    const i = pixel(u, v), lum = light(data, i);
    const far = clamp((v - recipe.horizon + 0.12) / (1.12 - recipe.horizon));
    const foreground = Math.pow(far, 0.75);
    // Blueness and low contrast alone do not identify real sky. This is a small,
    // disclosed surface cue, gated by position below the adjustable horizon.
    const colourRelief = (1 - lum) * 0.16 * clamp(far * 4);
    const envelope = Math.sin(u * Math.PI) ** 0.4;
    const buildingFace = Math.exp(-(((u - 0.5) / 0.36) ** 4)) * clamp((v - 0.16) * 4) * (1 - clamp((v - 0.82) * 4));
    const near = subject === "building" ? foreground * 0.44 + buildingFace * 0.32 + colourRelief : foreground * 0.8 + colourRelief;
    const z = (near * envelope - 0.35) * recipe.depth * 1.6;
    positions.set([(u - 0.5) * modelWidth, (0.5 - v) * modelHeight, z], index * 3);
    uv.set([u, 1 - v], index * 2); depths[index] = z;
  }
  // Smooth depth only, not UVs or silhouettes in the source photograph.
  for (let pass = 0; pass < 2; pass++) {
    const before = depths.slice();
    for (let row = 1; row < rows; row++) for (let col = 1; col < columns; col++) {
      const i = row * (columns + 1) + col;
      depths[i] = (before[i] * 4 + before[i - 1] + before[i + 1] + before[i - columns - 1] + before[i + columns + 1]) / 8;
      positions[i * 3 + 2] = depths[i];
    }
  }
  let offset = 0;
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const a = row * (columns + 1) + col, b = a + columns + 1;
    indices.set([a, b, a + 1, b, b + 1, a + 1], offset); offset += 6;
  }
  return { positions, uv, indices, modelWidth, modelHeight, columns, rows, recipe, reconstruction: false };
}
