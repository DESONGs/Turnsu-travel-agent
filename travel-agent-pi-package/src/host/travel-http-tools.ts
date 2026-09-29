/** The embedded host has no TripStore. Every business operation uses the authenticated API. */
export interface TravelHttpTools {
  invoke(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export const TRAVEL_HOST_TOOLS = Object.freeze([
  "create_trip", "update_trip_scope", "get_trip_control_view", "get_trip_plan_view", "get_open_decisions",
  "research_trip_options", "propose_trip_change", "plan_itinerary_trial", "accept_trip_change", "reject_trip_change",
  "prepare_booking_handoff", "record_booking_confirmation", "report_trip_disruption", "submit_trip_feedback",
] as const);

export const TRAVEL_HOST_CONFIRMATION_TOOLS = new Set<string>([
  "accept_trip_change", "reject_trip_change", "prepare_booking_handoff", "record_booking_confirmation", "submit_trip_feedback",
]);

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw failure("invalid_travel_resource_id");
  return encodeURIComponent(value);
}

function route(name: string, params: Record<string, unknown>): { path: string; method: "GET" | "POST"; body?: Record<string, unknown> } {
  if (name === "create_trip") {
    // Ownership and generated IDs belong to the API session, never to the model or host.
    const { brief, travelers } = params;
    return { path: "/api/trips", method: "POST", body: { brief, travelers } };
  }
  if (!(TRAVEL_HOST_TOOLS as readonly string[]).includes(name)) throw failure("travel_host_tool_not_allowed");
  const root = `/api/trips/${identifier(params["tripId"])}`;
  const { tripId: _tripId, proposalId, ...body } = params;
  switch (name) {
    case "get_trip_control_view": return { path: `${root}/control`, method: "GET" };
    case "get_trip_plan_view": return { path: `${root}/plan`, method: "GET" };
    case "get_open_decisions": return { path: `${root}/decisions`, method: "GET" };
    case "update_trip_scope": return { path: `${root}/scope`, method: "POST", body };
    case "research_trip_options": return { path: `${root}/research`, method: "POST", body };
    case "propose_trip_change": return { path: `${root}/proposals`, method: "POST", body };
    case "plan_itinerary_trial": return { path: `${root}/itinerary-trials`, method: "POST", body };
    case "accept_trip_change": return { path: `${root}/proposals/${identifier(proposalId)}/accept`, method: "POST", body };
    case "reject_trip_change": return { path: `${root}/proposals/${identifier(proposalId)}/reject`, method: "POST", body };
    case "prepare_booking_handoff": return { path: `${root}/booking-handoffs`, method: "POST", body };
    case "record_booking_confirmation": return { path: `${root}/booking-confirmations`, method: "POST", body };
    case "report_trip_disruption": return { path: `${root}/disruptions`, method: "POST", body };
    case "submit_trip_feedback": return { path: `${root}/feedback`, method: "POST", body };
    default: throw failure("travel_host_tool_not_allowed");
  }
}

export function createTravelHttpTools({ baseUrl, accessToken, fetchImpl = fetch }: {
  baseUrl: string; accessToken: string; fetchImpl?: typeof fetch;
}): TravelHttpTools {
  const base = new URL(baseUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:"))
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw failure("invalid_travel_api_origin");
  if (!accessToken || /\s/.test(accessToken)) throw failure("travel_api_session_required");
  return {
    async invoke(name, params, signal) {
      signal?.throwIfAborted();
      const target = route(name, params);
      const requestSignal = AbortSignal.any([AbortSignal.timeout(95_000), ...(signal ? [signal] : [])]);
      let response: Response;
      try {
        response = await fetchImpl(`${base.origin}${target.path}`, {
          method: target.method, redirect: "error", signal: requestSignal,
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          ...(target.body ? { body: JSON.stringify(target.body) } : {}),
        });
      } catch {
        throw failure(requestSignal.aborted ? "travel_request_cancelled" : "travel_api_unavailable");
      }
      // Bound tool output before parsing it; do not reflect headers, URLs, or transport errors.
      const reader = response.body?.getReader();
      if (!reader) throw failure("invalid_travel_api_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) { await reader.cancel(); throw failure("travel_api_response_too_large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("invalid_travel_api_response"); }
      if (!response.ok) {
        const code = value && typeof value === "object" ? Reflect.get(value, "code") : null;
        throw failure(typeof code === "string" && /^[a-zA-Z0-9_]{1,100}$/.test(code) ? code : "travel_api_request_failed");
      }
      if (!value || typeof value !== "object") throw failure("invalid_travel_api_response");
      return value;
    },
  };
}

export function travelHttpToolsFromEnv(env: NodeJS.ProcessEnv): TravelHttpTools | undefined {
  if (env["TRAVEL_AGENT_PI_MODE"] !== "api") return undefined;
  if (!env["TRAVEL_AGENT_API_BASE_URL"] || !env["TRAVEL_AGENT_API_ACCESS_TOKEN"]) throw failure("travel_api_session_required");
  return createTravelHttpTools({ baseUrl: env["TRAVEL_AGENT_API_BASE_URL"], accessToken: env["TRAVEL_AGENT_API_ACCESS_TOKEN"] });
}
