import { validDepthShapes } from "../media/destination-painting.js";

function canvasWithPixels(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("artwork_canvas_unavailable");
  return { canvas, ctx };
}

// Fill only the narrow rim that a bounded camera shift can uncover. Each
// concealed pixel borrows the nearest visible pixel on its own depth plane.
export function splitPaintingPixels(pixels, depths, width, height, overscan) {
  const count = width * height;
  const result = [];
  const planes = [...new Set(depths)].sort((a, b) => a-b);
  if (planes.length < 2) throw new Error("artwork_depth_invalid");
  for (const depth of planes) {
    const colors = new Uint8ClampedArray(count*4);
    const queue = new Int32Array(count);
    const seen = new Uint8Array(count);
    let end = 0, cursor = 0;
    for (let i = 0; i < count; i++) {
      if (depths[i] !== depth) continue;
      colors.set(pixels.subarray(i*4, i*4+4), i*4);
      seen[i] = 1;
      if ((i%width && depths[i-1] > depth) || (i%width < width-1 && depths[i+1] > depth) ||
          depths[i-width] > depth || depths[i+width] > depth) queue[end++] = i;
    }
    const extend = (from, to) => {
      if (seen[to] || depths[to] <= depth) return;
      seen[to] = 1; queue[end++] = to;
      colors.set(colors.subarray(from*4, from*4+4), to*4);
    };
    for (let distance = 0; distance < overscan && cursor < end; distance++) {
      const frontier = end;
      while (cursor < frontier) {
        const i = queue[cursor++], x = i%width;
        if (x > 0) extend(i, i-1);
        if (x < width-1) extend(i, i+1);
        if (i >= width) extend(i, i-width);
        if (i < count-width) extend(i, i+width);
      }
    }
    result.push({ depth, colors });
  }
  return result;
}

export async function createPaintingPlates({ src, shapes }, signal) {
  if (!validDepthShapes(shapes)) throw new Error("artwork_depth_invalid");
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  if (src.startsWith("https:")) image.crossOrigin = "anonymous";
  const stop = () => { image.removeAttribute("src"); };
  signal.throwIfAborted();
  signal.addEventListener("abort", stop, { once: true });
  try {
    image.src = src;
    await image.decode(); signal.throwIfAborted();
    if (!image.naturalHeight || image.naturalWidth * image.naturalHeight > 30_000_000) throw new Error("artwork_image_invalid");
    const scale = Math.min(1, 1100 / Math.max(image.naturalHeight, image.naturalWidth));
    const width = Math.max(2, Math.round(image.naturalWidth * scale)), height = Math.max(2, Math.round(image.naturalHeight * scale));
    const { ctx } = canvasWithPixels(width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const original = ctx.getImageData(0,0,width,height);
    // Rasterize the host's silhouettes at the drawing's actual aspect ratio.
    ctx.fillStyle = "black"; ctx.fillRect(0,0,width,height);
    for (const { depth, points } of [...shapes].sort((a,b) => a.depth-b.depth)) {
      const shade = depth*60;
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.beginPath(); ctx.moveTo(points[0][0]*width, points[0][1]*height);
      for (const [x,y] of points.slice(1)) ctx.lineTo(x*width,y*height);
      ctx.closePath(); ctx.fill();
    }
    const mask = ctx.getImageData(0,0,width,height).data;
    const depths = Uint8Array.from({length: width*height}, (_,i) => Math.round(mask[i*4]/60));
    const minimum = Math.min(width,height);
    // Max displacement is 1.6% horizontally + 0.9% vertically on either
    // side of neutral. The inpaint radius covers both extremal depth planes.
    const plates = splitPaintingPixels(original.data, depths, width, height, Math.ceil(minimum * .052) + 3)
      .map(({ depth, colors }) => {
        const { canvas, ctx: plate } = canvasWithPixels(width,height);
        plate.putImageData(new ImageData(colors,width,height),0,0);
        return { canvas, depth };
      });
    return { width, height, plates, shapes };
  } finally { signal.removeEventListener("abort", stop); stop(); }
}
