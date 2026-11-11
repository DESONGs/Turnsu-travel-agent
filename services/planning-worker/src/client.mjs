/** The executor may reach only the configured travel service's fixed private endpoints. */
export function createWorkerClient({ baseUrl, token, fetchImpl = fetch }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error("worker_service_not_configured"); }
  const local = base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (!(base.protocol === "https:" || local) || base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("worker_service_not_configured");

  async function post(endpoint, body = {}, signal) {
    if (!/^[a-z]+$/.test(endpoint)) throw new Error("invalid_worker_endpoint");
    const response = await fetchImpl(new URL(`/internal/worker/${endpoint}`, base), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("worker_response_too_large");
    let result;
    try { result = JSON.parse(text); } catch { throw new Error("worker_response_invalid"); }
    if (!response.ok) throw Object.assign(new Error("worker_operation_failed"), { code: result?.error || "worker_operation_failed" });
    return result;
  }
  return { post };
}
