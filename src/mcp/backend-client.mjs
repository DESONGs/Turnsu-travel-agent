export function createBackendClient({ origin, token, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") throw new Error("invalid_backend_origin");
  return async (path, { method = "GET", body, binary = false } = {}) => {
    if (!path.startsWith("/api/") || path.includes("..")) throw new Error("backend_path_not_allowed");
    const response = await fetchImpl(new URL(path, url), { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.code ?? "travel_backend_unavailable"), { code: payload.code ?? "travel_backend_unavailable", status: response.status });
    }
    if (response.status === 204) return null;
    if (binary) { const data = Buffer.from(await response.arrayBuffer()); if (data.length > 5_000_000) throw new Error("travel_media_too_large"); return { mimeType: response.headers.get("content-type"), data: data.toString("base64") }; }
    return response.json();
  };
}
