import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

// Explicit browser protocol fixture, not a Google login or a travel-data provider.
const frame = document.querySelector("iframe");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const R = "55555555-5555-4555-8555-555555555555";
const D = "33333333-3333-4333-8333-333333333333", H = "44444444-4444-4444-8444-444444444444";
let actor = "A", revoked = false, requests = [], releaseFile;
const now = new Date().toISOString();
const placesFirst = new URLSearchParams(location.search).get("order") === "places-first";
const trips = Object.fromEntries([[A, "账号 A 的私人旅行"], [B, "文件 B 的旅行"]].map(([tripId, destination]) => [tripId,
  { tripId, revision: 0, role: "owner", state: { brief: { destination, origin: "上海", dates: "2026-12-01" }, budgetLedger: { currency: "CNY", totalBudget: 1200 }, travelers: [] } }]));
const ok = value => ({ structuredContent: value, content: [] });
const fail = code => ({ structuredContent: { code }, isError: true, content: [] });
const bridge = new AppBridge(null, { name: "Travel browser protocol fixture", version: "1" },
  { serverTools: {}, serverResources: {}, message: {}, logging: {}, experimental: { "openai/message": {}, "openai/resource": {} } });
bridge.setHostContext({ theme: "light", displayMode: "fullscreen", availableDisplayModes: ["fullscreen"] });
bridge.oncalltool = async ({ name, arguments: args = {} }) => {
  if (name === "get_profile") return ok({ id: actor });
  if (["open_travel_workbench", "open_travel_mcp_workbench"].includes(name)) return ok({ service: "https://travel.example.com", trip: args.tripId && actor === "A" && !revoked ? trips[args.tripId] : null, workspaces: { items: [], nextCursor: null } });
  if (actor !== "A" || revoked) return fail("trip_not_found");
  if (name === "get_travel_workspace") return ok(trips[args.tripId]);
  if (name === "get_workbench_document") return ok({ layoutRevision: 0, document: { components: [{ type: "itinerary", version: 1 }, { type: "map", version: 1 },
    ...(placesFirst ? [{ type: "places", version: 1, resultIds: [R] }, { type: "requirements", version: 1 }] : [{ type: "requirements", version: 1 }])] } });
  if (name === "list_trip_itinerary_drafts") return ok({ items: args.tripId === A ? [{ draftId: D, tripId: A, draftRevision: 0, baseRevision: 0, status: "proposed", createdAt: now, draft: { stops: [{ stopId: "visit-1", sourceResultId: R, sourceId: "fixture-place", role: "activity", startLocal: "2026-12-01T10:00", timeZone: "Asia/Shanghai", utcOffset: "+08:00", durationMinutes: 60, startAt: "2026-12-01T02:00:00Z", endAt: "2026-12-01T03:00:00Z" }], timeConflicts: [] } }] : [], nextCursor: null });
  if (name === "get_trip_result_reference") return { ...ok({ status: "ok" }), _meta: { "travel/uiData": { resultId: R, tripId: A, tripRevision: 0, kind: "places", checkedAt: now, freshUntil: new Date(Date.now() + 1200000).toISOString(), data: { domain: "play", candidates: [{ sourceId: "fixture-place", name: "核验地点（合成资料）" }] } } } };
  if (name === "list_trip_tasks") return ok({ items: [], nextCursor: null });
  if (name === "list_workbench_requests") return ok({ items: requests, nextCursor: null });
  if (name === "save_workbench_request") { const item = { handoffId: H, tripId: A, draftId: D, draftRevision: 0, requestedBy: "A", notification: "saved", workStatus: "requested", createdAt: now }; requests = [item]; return ok(item); }
  if (name === "begin_workbench_notification") { requests[0].notification = "sending"; return ok({ ...requests[0], maySend: true }); }
  if (name === "record_workbench_notification") { requests[0].notification = args.outcome; return ok(requests[0]); }
  if (name === "verify_trip_itinerary_draft") return ok({ draftId: D, tripRevision: 0, draftRevision: 0, checkedAt: now, canAdopt: false,
    checks: [{ id: "opening", status: "unverified", message: "营业及预约尚未核实。" }] });
  throw new Error("Unhandled browser fixture tool: " + name);
};
bridge.onmessage = async () => { document.querySelector("#sent").textContent = String(Number(document.querySelector("#sent").textContent) + 1); return {}; };
const pointer = (uri, tripId) => ({ contents: [{ uri, text: JSON.stringify({ formatVersion: 1, service: "https://travel.example.com/", tripId }) }] });
bridge.onreadresource = ({ uri }) => uri === "file:///A.traveltrip" ? new Promise(resolve => { releaseFile = () => resolve(pointer(uri, A)); }) : Promise.resolve(pointer(uri, B));
bridge.oninitialized = () => bridge.sendToolInput({ arguments: { tripId: A } });
document.querySelector("#switch").onclick = async () => { actor = "B"; document.querySelector("#actor").textContent = "B"; await bridge.sendToolResult(ok({ service: "https://travel.example.com", workspaces: { items: [] }, trip: null })); };
document.querySelector("#restore").onclick = async () => { actor = "A"; revoked = false; document.querySelector("#actor").textContent = "A"; await bridge.sendToolResult(ok({ service: "https://travel.example.com", workspaces: { items: [] }, trip: null })); };
document.querySelector("#open").onclick = () => bridge.sendToolInput({ arguments: { tripId: A } });
document.querySelector("#link").onclick = () => bridge.sendToolInput({ arguments: { tripId: A, instruction: "继续核验这趟旅行" } });
document.querySelector("#revoke").onclick = () => { revoked = true; document.querySelector("#actor").textContent = "A 已撤权"; };
document.querySelector("#file-a").onclick = () => bridge.sendToolInput({ arguments: { file: { name: "A.traveltrip", resourceUri: "file:///A.traveltrip" } } });
document.querySelector("#file-b").onclick = () => bridge.sendToolInput({ arguments: { file: { name: "B.traveltrip", resourceUri: "file:///B.traveltrip" } } });
document.querySelector("#release").onclick = () => releaseFile?.();
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = "/app.html?host=" + (new URLSearchParams(location.search).get("host") === "mcp" ? "mcp" : "codex");
