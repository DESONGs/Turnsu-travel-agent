import { canPreviewPhotoRelief, defaultPhotoRelief, validatePhotoRelief } from "../media/photo-relief-recipe.mjs";

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const light = (data, i) => (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
function checkPixels({ data, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 1280 || height > 1280 || !data || data.length !== width * height * 4) throw new Error("relief_pixels_invalid");
}

// A quiet wash beneath the actual vector contours, rather than an edge filter
// baked into a photograph. The original pixels are never changed.
export function createPhotoWashPixels(pixels) {
  checkPixels(pixels);
  const { data, width, height } = pixels;
  const result = new Uint8Array(data.length), paper = [249, 247, 239];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      let total = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) total += data[(clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)) * 4 + c];
      result[index + c] = total / 9 * 0.32 + paper[c] * 0.68;
    }
    result[index + 3] = 255;
  }
  return result;
}

// Gaussian smoothing, non-maximum suppression and connected-edge hysteresis.
// These paths follow the source image, not the triangulation of the depth mesh.
export function extractPhotoContours(pixels) {
  checkPixels(pixels);
  const { data, width, height } = pixels, size = width * height;
  const grey = new Float32Array(size), temporary = new Float32Array(size), smooth = new Float32Array(size);
  const magnitude = new Float32Array(size), direction = new Uint8Array(size), thin = new Float32Array(size);
  const kernel = [1, 4, 6, 4, 1];
  for (let i = 0; i < size; i++) grey[i] = light(data, i * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += grey[y * width + clamp(x + k, 0, width - 1)] * kernel[k + 2];
    temporary[y * width + x] = sum / 16;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += temporary[clamp(y + k, 0, height - 1) * width + x] * kernel[k + 2];
    smooth[y * width + x] = sum / 16;
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = (smooth[i - width + 1] + 2 * smooth[i + 1] + smooth[i + width + 1] - smooth[i - width - 1] - 2 * smooth[i - 1] - smooth[i + width - 1]) / 4;
    const gy = (smooth[i + width - 1] + 2 * smooth[i + width] + smooth[i + width + 1] - smooth[i - width - 1] - 2 * smooth[i - width] - smooth[i - width + 1]) / 4;
    magnitude[i] = Math.hypot(gx, gy);
    direction[i] = Math.round((Math.atan2(gy, gx) + Math.PI) / (Math.PI / 4)) % 4;
  }
  const offsets = [1, width + 1, width, width - 1], histogram = new Uint32Array(256);
  let count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, m = magnitude[i], offset = offsets[direction[i]];
    if (m >= 0.025 && m >= magnitude[i - offset] && m > magnitude[i + offset]) {
      thin[i] = m; histogram[Math.min(255, Math.floor(m * 255))]++; count++;
    }
  }
  let total = 0, percentile = 0;
  for (; percentile < 255; percentile++) { total += histogram[percentile]; if (total >= count * 0.82) break; }
  const high = clamp(percentile / 255, 0.055, 0.18), low = high * 0.4;
  const mask = new Uint8Array(size), stack = new Int32Array(size);
  let top = 0;
  for (let i = 0; i < size; i++) if (thin[i] >= high) { mask[i] = 1; stack[top++] = i; }
  while (top) {
    const i = stack[--top], x = i % width, y = Math.floor(i / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, n = ny * width + nx;
      if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1 && !mask[n] && thin[n] >= low) { mask[n] = 1; stack[top++] = n; }
    }
  }
  // Trace the thin edge graph into paths, then simplify subpixel stair steps.
  // One combined GPU buffer keeps even detailed architecture cheap to draw.
  const steps = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const links = new Uint8Array(size), visited = new Uint8Array(size), degrees = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (mask[i]) {
    const x = i % width, y = Math.floor(i / width);
    steps.forEach(([dx, dy], d) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) return;
      if (dx && dy && (mask[y * width + nx] || mask[ny * width + x])) return;
      links[i] |= 1 << d; degrees[i]++;
    });
  }
  const simplify = (path) => {
    const keep = new Uint8Array(path.length); keep[0] = keep[path.length - 1] = 1;
    const pending = [[0, path.length - 1]];
    while (pending.length) {
      const [a, b] = pending.pop(), ax = path[a] % width, ay = Math.floor(path[a] / width), bx = path[b] % width, by = Math.floor(path[b] / width);
      const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
      let farthest = -1, distance = 0.65 ** 2;
      for (let k = a + 1; k < b; k++) {
        const x = path[k] % width, y = Math.floor(path[k] / width), t = length ? clamp(((x - ax) * dx + (y - ay) * dy) / length) : 0;
        const d = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
        if (d > distance) { distance = d; farthest = k; }
      }
      if (farthest !== -1) { keep[farthest] = 1; pending.push([a, farthest], [farthest, b]); }
    }
    return path.filter((_, i) => keep[i]);
  };
  const paths = [];
  const trace = (start, first) => {
    let i = start, d = first; const path = [i];
    while (true) {
      const [dx, dy] = steps[d], next = i + dy * width + dx;
      visited[i] |= 1 << d; visited[next] |= 1 << ((d + 4) % 8); path.push(next);
      if (degrees[next] !== 2 || next === start) break;
      i = next; d = steps.findIndex((_, direction) => (links[i] & ~visited[i]) & (1 << direction));
      if (d < 0) break;
    }
    if (path.length >= 5) paths.push(simplify(path));
  };
  for (const junctions of [true, false]) for (let i = 0; i < size; i++) if (mask[i] && (degrees[i] !== 2) === junctions) {
    for (let d = 0; d < 8; d++) if ((links[i] & ~visited[i]) & (1 << d)) trace(i, d);
  }
  // Retain complete long contours first if a very noisy input hits the budget.
  paths.sort((a, b) => b.length - a.length);
  const segments = [], strengths = [];
  for (const path of paths) {
    if (segments.length / 4 + path.length - 1 > 50000) continue;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k];
      segments.push((a % width) / (width - 1), Math.floor(a / width) / (height - 1), (b % width) / (width - 1), Math.floor(b / width) / (height - 1));
      strengths.push(clamp(Math.max(magnitude[a], magnitude[b]) / (high * 2)));
    }
  }
  return { segments: new Float32Array(segments), strengths: new Float32Array(strengths), width, height };
}

export function liftPhotoContours(contours, surface) {
  const { columns, rows, positions, modelWidth, modelHeight } = surface;
  const result = new Float32Array(contours.segments.length / 2 * 3);
  for (let i = 0; i < contours.segments.length; i += 2) {
    const u = contours.segments[i], v = contours.segments[i + 1], x = u * columns, y = v * rows;
    const col = Math.min(columns - 1, Math.floor(x)), row = Math.min(rows - 1, Math.floor(y)), tx = x - col, ty = y - row;
    const z = (r, c) => positions[(r * (columns + 1) + c) * 3 + 2];
    const depth = z(row, col) * (1 - tx) * (1 - ty) + z(row, col + 1) * tx * (1 - ty) + z(row + 1, col) * (1 - tx) * ty + z(row + 1, col + 1) * tx * ty;
    result.set([(u - 0.5) * modelWidth, (0.5 - v) * modelHeight, depth + 0.008], i / 2 * 3);
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
