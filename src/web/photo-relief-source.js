// Called only after the user chooses to process a displayed source photograph.
// CORS remains enforced by the browser; this is deliberately not a URL proxy.
export async function fetchReliefSourcePhoto(source, signal) {
  let url;
  try { url = new URL(source); } catch { throw new Error("relief_source_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("relief_source_invalid");
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(url.href, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("relief_source_unavailable");
    if (Number(response.headers.get("content-length")) > 12_000_000) throw new Error("relief_source_too_large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("relief_source_unavailable");
    let length = 0; const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 12_000_000) throw new Error("relief_source_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return new Blob(chunks, { type });
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
