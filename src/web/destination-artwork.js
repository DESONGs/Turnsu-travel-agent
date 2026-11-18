import { api } from "./api-client.js";
import { depthInstructions, paintingInstructions, validDepthShapes } from "../media/destination-painting.js";

export function artworkHostMode(host = globalThis.travelHost, files = globalThis.openai) {
  if (typeof host?.generateDestinationArtwork === "function") return "connector";
  if (host && typeof files?.getFileDownloadUrl === "function" && (host.supportsImageMessage ||
      (files.uploadFile && files.sendFollowUpMessage && files.setWidgetState))) return "file";
  if (host?.supportsSampling) return "sampling";
  return null;
}

function localImage(block) {
  if (!["image/jpeg","image/png","image/webp"].includes(block?.mimeType) || typeof block.data !== "string" ||
      block.data.length > 12_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) throw new Error("artwork_host_no_image");
  return "data:" + block.mimeType + ";base64," + block.data;
}
async function waitForReturn(signal) {
  await new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1800);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function generateDestinationArtwork({ photo, style, tripId, signal, onDepth, host = globalThis.travelHost, files = globalThis.openai }) {
  const mode = artworkHostMode(host, files);
  const source = { type: "image", mimeType: "image/jpeg", data: photo.data };
  const prompt = paintingInstructions(style);
  let src, shapes;
  signal.throwIfAborted();
  if (mode === "connector") {
    const result = await host.generateDestinationArtwork({ image: source, prompt, depthInstructions }, signal);
    src = localImage(result?.image); shapes = result.shapes;
  } else if (mode === "sampling") {
    const painting = await host.sample([{ type: "text", text: prompt + " Return the actual edited raster as an image content block." }, source], signal);
    const blocks = [painting?.content].flat();
    const image = blocks.find(block => block?.type === "image");
    src = localImage(image);
    if (image.data === photo.data) throw new Error("artwork_host_no_image");
    onDepth(); signal.throwIfAborted();
    const depth = await host.sample([{ type: "text", text: depthInstructions + ' Return JSON only: {"shapes":[{"depth":1,"points":[[0,0],[1,0],[1,1]]}]}. The coordinates in this example are only the format.' }, image], signal);
    const output = [depth?.content].flat().find(block => block?.type === "text")?.text ?? "";
    if (output.length > 64000) throw new Error("artwork_depth_invalid");
    try { shapes = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, "")).shapes; } catch { throw new Error("artwork_depth_invalid"); }
  } else if (mode === "file") {
    const requestId = crypto.randomUUID();
    await api.artworkRequest(tripId, requestId, "POST", signal);
    try {
      let instructions = prompt + " " + depthInstructions + " Edit the attached image using your native image generation tool, then call return_destination_artwork with the generated file, shapes, tripId=" + JSON.stringify(tripId) + " and requestId=" + requestId + ". If image generation or file return is unavailable, call decline_destination_artwork for the same request.";
      if (host.supportsImageMessage) {
        const response = await host.sendImageMessage([{ type: "text", text: instructions }, source], signal);
        if (response?.isError) throw new Error("artwork_host_unavailable");
      } else {
        const bytes = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));
        const { fileId } = await files.uploadFile(new File([bytes], "place.jpg", { type: "image/jpeg" }));
        if (!fileId) throw new Error("artwork_host_unavailable");
        signal.throwIfAborted();
        const widget = files.widgetState ?? {};
        const ids = Array.isArray(widget.imageIds) ? widget.imageIds : [];
        await files.setWidgetState({ ...widget, imageIds: [...new Set([...ids, fileId])] });
        signal.throwIfAborted();
        await files.sendFollowUpMessage({ prompt: instructions + " Source file ID: " + fileId, scrollToBottom: false });
      }
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await waitForReturn(signal);
        const result = await api.artworkRequest(tripId, requestId, "GET", signal);
        if (result.status === "unavailable") throw new Error("artwork_host_unavailable");
        if (result.status === "ready") {
          onDepth();
          const { downloadUrl } = await files.getFileDownloadUrl({ fileId: result.fileId });
          if (new URL(downloadUrl).protocol !== "https:") throw new Error("artwork_host_no_image");
          src = downloadUrl; shapes = result.shapes; break;
        }
        if (Date.now() >= deadline) throw new Error("artwork_timeout");
      }
    } finally { void api.artworkRequest(tripId, requestId, "DELETE").catch(() => {}); }
  } else throw new Error("artwork_host_unavailable");
  signal.throwIfAborted();
  if (!validDepthShapes(shapes)) throw new Error("artwork_depth_invalid");
  return { src, shapes };
}
