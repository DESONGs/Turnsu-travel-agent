/** Only provider references and the user's arrangements survive a durable write.
 * Google content is fetched for the current view; it is never a database/backup cache. */
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null => v && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : null;
const refs = (v: unknown): boolean => Array.isArray(v) && v.some(r => /^google_(?:maps|routes)(?::|$)/.test(String(r)));
export function containsGoogleContent(value: unknown): boolean {
  if (typeof value === "string") return /google_maps|google_routes|google_grounding_lite|maps\.googleapis\.com|places\.googleapis\.com/.test(value);
  if (Array.isArray(value)) return value.some(containsGoogleContent);
  const v = object(value);
  return !!v && (v.usesGoogleMaps === true || Object.values(v).some(containsGoogleContent));
}
export function googlePlaceId(value: unknown): string | null {
  const v = object(value); if (!v) return null;
  const op = object(v.operability);
  if (typeof op?.providerPoiId === "string" && (op.provider === "google_maps" || Array.isArray(op.providerSources) && op.providerSources.includes("google_maps"))) return op.providerPoiId;
  const match = (Array.isArray(v.sourceRefs) ? v.sourceRefs : []).map(String).find(r => r.startsWith("google_maps:"));
  return match?.slice("google_maps:".length) ?? null;
}
export function stripGoogleContent<T>(input: T): T {
  const googleDependent = containsGoogleContent(input);
  const nodeIds = new Set<string>();
  const scan = (v: unknown): void => { if (Array.isArray(v)) { v.forEach(scan); return; } const o = object(v); if (!o) return; if (googlePlaceId(o) && typeof o.nodeId === "string") nodeIds.add(o.nodeId); Object.values(o).forEach(scan); };
  scan(input);
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    const v = object(value); if (!v) return value;
    const next = Object.fromEntries(Object.entries(v).map(([key, item]) => [key, clean(item)]));
    if (googleDependent) for (const key of ["analysis", "judgment", "grounding"]) if (key in next) next[key] = null;
    const placeId = googlePlaceId(v), op = object(v.operability);
    if (v.placeId && v.coordinates) delete next.coordinates;
    if (placeId && v.domain) {
      const googleOnly = op?.provider === "google_maps";
      if (googleOnly) { next.title = "地点资料待刷新"; next.summary = ""; next.media = []; next.sourceStatus = "refresh_required"; }
      next.location = { ...(object(v.location)?.countryCode ? { countryCode: object(v.location)!.countryCode } : {}), ...(object(v.location)?.timeZone ? { timeZone: object(v.location)!.timeZone } : {}) };
      next.operability = googleOnly
        ? { provider: "google_maps", providerPoiId: placeId, contentRefreshRequired: true, ...(op?.planningWindow ? { planningWindow: op.planningWindow } : {}), ...(op?.timeZone ? { timeZone: op.timeZone } : {}), ...(op?.countryCode ? { countryCode: op.countryCode } : {}) }
        : Object.fromEntries(Object.entries({ ...op, contentRefreshRequired: true }).filter(([key]) => !["photos", "accessibilityOptions", "openWeek", "businessStatus", "googleMapsUri", "googleContentExpiresAt"].includes(key)));
    }
    if (v.provider === "google_maps" && v.contentItemId) { next.title = null; next.checkedAt = null; }
    if (v.entityId && refs(v.providerRefs)) next.canonicalName = "地点资料待刷新";
    if (v.claimId && refs(v.sourceRefs)) { next.statement = "地点资料需从来源重新核验。"; next.observedAt = "1970-01-01T00:00:00Z"; next.confidence = 0; }
    if (typeof v.nodeId === "string" && nodeIds.has(v.nodeId) && v.stopId) next.title = "已安排地点";
    if (v.schemaVersion === "trip-mobility-v1" && (String(v.source).includes("google") || Array.isArray(v.legs) && v.legs.some(leg => containsGoogleContent(leg)))) {
      next.status = "needs_context"; next.legs = []; next.checkedAt = null; next.freshUntil = null; next.travelerFit = null;
      next.reason = "source_refresh_required";
      next.feasibility = { schemaVersion: "trip-feasibility-v1", status: "needs_context", canConfirm: false, primaryBlocker: "路线资料需重新核验。", issues: [], checkedAt: null };
    }
    if (v.grounding && containsGoogleContent(v.grounding)) next.grounding = null;
    return next;
  };
  return clean(input) as T;
}

/** Model context is rebuilt from current source readings after recovery.
 * Completed tool identities/receipts remain, so a crash never replays a commit. */
export function googleSafeCheckpoint<T>(checkpoint: T): T {
  if (!containsGoogleContent(checkpoint)) return checkpoint;
  const copy = structuredClone(checkpoint) as ObjectValue;
  const entries = Array.isArray(copy.entries) ? copy.entries : [];
  for (const entryValue of entries) {
    const entry = object(entryValue); if (!entry) continue;
    if (entry.type === "compaction") { entry.summary = "Resume the user's objective from current travel facts. Google content was not retained."; entry.details = {}; }
    const message = object(entry.message); if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) message.content = message.content.filter(b => object(b)?.type === "toolCall");
    if (message.role === "toolResult") {
      let receipt: ObjectValue = {};
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const text = object(block)?.text; if (typeof text !== "string") continue;
        try { const data = JSON.parse(text) as ObjectValue; receipt = Object.fromEntries(Object.entries(data).filter(([key]) => ["status", "tripId", "revision", "proposalId", "runId", "attempt", "nodeId", "operationId", "code"].includes(key))); } catch { /* Receipt identity is also on the message. */ }
      }
      message.content = [{ type: "text", text: JSON.stringify({ ...receipt, sourceRefreshRequired: true, instruction: "Use current travel tools to refresh source facts. Do not repeat completed business writes." }) }]; delete message.details;
    }
  }
  return copy as T;
}
export function googleSafeConversation<T>(record: T): T {
  const value = object(record);
  if (!value?.usesGoogleMaps) return record;
  const copy = structuredClone(value);
  if (Array.isArray(copy.messages)) copy.messages = copy.messages.map(message => {
    const item = object(message);
    return item?.role === "assistant" ? { ...item, text: "旅行安排已保存。打开旅行可查看重新核验的地点资料。", sourceRefreshRequired: true } : message;
  });
  return copy as T;
}

export function googleSafeDurableValue<T>(input: T): T {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string" && containsGoogleContent(value)) {
      try { return JSON.stringify(googleSafeDurableValue(JSON.parse(value))); } catch { return "Google Maps source content was not retained. Refresh current travel facts."; }
    }
    if (Array.isArray(value)) return value.map(visit);
    const v = object(value); if (!v) return value;
    if (v.schemaVersion === "travel-agent-session-v1") return googleSafeCheckpoint(v);
    if (v.usesGoogleMaps && Array.isArray(v.messages)) return googleSafeConversation(v);
    const next = Object.fromEntries(Object.entries(v).map(([key, item]) => [key, visit(item)]));
    if (v.latestResearch && containsGoogleContent(v.latestResearch)) { next.latestResearch = { status: "source_refresh_required" }; next.researchCompletionText = null; }
    return next;
  };
  return stripGoogleContent(visit(input)) as T;
}
