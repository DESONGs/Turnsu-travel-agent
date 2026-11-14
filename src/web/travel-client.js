/** Path matching is deliberately finite; an embedded page cannot proxy arbitrary backend routes. */
export function operationForPath(path, method = "GET") {
  const url = new URL(path, "https://travel.invalid"); const p = url.pathname;
  const exact = {
    "GET /api/session": "session", "GET /api/health": "health", "GET /api/provider-status": "providers", "GET /api/auth/providers": "authProviders",
    "GET /api/preferences": "preferences", "POST /api/preferences": "savePreferences", "GET /api/price-watches": "watches", "POST /api/price-watches": "createWatch", "GET /api/notifications": "notifications", "GET /api/notification-email": "notificationEmail", "DELETE /api/notification-email": "removeNotificationEmail", "POST /api/notification-email": "requestNotificationEmail", "POST /api/notification-email/verify": "verifyNotificationEmail",
    "GET /api/account": "account", "POST /api/account/profile": "profile", "GET /api/trips": "listTrips", "GET /api/conversations": "listConversations", "POST /api/conversations": "createConversation",
    "DELETE /api/session": "logout", "POST /api/account/link-intent": "linkIntent", "DELETE /api/account/sessions/others": "revokeOtherSessions",
    "POST /api/visual-evidence/inspect": "inspectImage", "GET /api/maps/config": "mapConfig", "POST /api/maps/google/tiles": "googleTiles", "POST /api/maps/google/photo": "googlePhoto",
  };
  if (exact[`${method} ${p}`]) return { action: exact[`${method} ${p}`], args: { includeDeleted: url.searchParams.get("includeDeleted") === "true" } };
  const preference = p.match(/^\/api\/preferences\/([A-Za-z0-9_-]+)\/confirm$/);
  if (preference && method === "POST") return { action: "confirmPreference", args: { preferenceId: preference[1] } };
  const recheck = p.match(/^\/api\/price-watches\/([A-Za-z0-9_-]+)\/recheck$/);
  if (recheck && method === "POST") return { action: "recheckWatch", args: { watchId: recheck[1] } };
  let special = p.match(/^\/api\/price-watches\/([A-Za-z0-9_-]+)$/);
  if (special && method === "POST") return { action: "updateWatch", args: { watchId: special[1] } };
  special = p.match(/^\/api\/notifications\/([A-Za-z0-9_-]+)\/read$/);
  if (special && method === "POST") return { action: "markNotificationRead", args: { notificationId: special[1] } };
  let match = p.match(/^\/api\/account\/(connections|sessions|identities)\/([^/]+)$/);
  if (match && method === "DELETE") return { action: ({ connections: "revokeConnection", sessions: "revokeSession", identities: "unlinkIdentity" })[match[1]], args: { [({ connections: "connectionId", sessions: "sessionId", identities: "identityId" })[match[1]]]: decodeURIComponent(match[2]) } };
  match = p.match(/^\/api\/maps\/google\/places\/([A-Za-z0-9_-]+)$/);
  if (match && method === "GET") return { action: "googlePlace", args: { placeId: match[1] } };
  match = p.match(/^\/api\/conversations\/([^/]+)(?:\/(runs|restore))?$/);
  if (match) {
    const action = match[2] === "runs" ? (method === "GET" ? "runs" : method === "POST" ? "submit" : null) : match[2] === "restore" && method === "POST" ? "restoreConversation" : !match[2] ? ({ GET: "conversation", DELETE: "deleteConversation" })[method] : null;
    if (action) return { action, args: { conversationId: decodeURIComponent(match[1]) } };
  }
  match = p.match(/^\/api\/runs\/([^/]+)(?:\/(cancel))?$/);
  if (match && ((match[2] && method === "POST") || (!match[2] && method === "GET"))) return { action: match[2] ? "cancel" : "run", args: { runId: decodeURIComponent(match[1]), after: Number(url.searchParams.get("after") ?? 0) } };
  match = p.match(/^\/api\/trips\/([^/]+)\/(.+)$/);
  if (match) {
    const args = { tripId: decodeURIComponent(match[1]) }; const tail = match[2];
    const routes = [
      [/^workspace\/([a-z_]+)$/, "POST", m => { args.tool = m[1]; return "workspace"; }],
      [/^(control|plan|decisions|map)$/, "GET", m => m[1]],
      [/^transit\/([^/]+)$/, "GET", (_m, a) => { args.nodeId = decodeURIComponent(a); return "transit"; }],
      [/^local-choice$/, "POST", () => "previewLocalChoice"],
      [/^undo$/, "POST", () => "undoChange"],
      [/^watch-offers$/, "GET", () => "watchOffers"],
      [/^requirements$/, "POST", () => "updateRequirements"],
      [/^readiness$/, "POST", () => "readiness"], [/^feedback$/, "POST", () => "feedback"],
      [/^booking-handoffs$/, "POST", () => "bookingHandoff"], [/^booking-confirmations$/, "POST", () => "bookingConfirmation"],
      [/^mobility\/(preview|refresh)$/, "POST", m => m[1] === "preview" ? "previewMobility" : "refreshMobility"],
      [/^proposals\/([^/]+)\/(accept|reject)$/, "POST", m => { args.proposalId = decodeURIComponent(m[1]); return m[2]; }],
      [/^itinerary-trials\/([^/]+)\/discard$/, "POST", m => { args.proposalId = decodeURIComponent(m[1]); return "discard"; }],
      [/^evidence\/nodes\/([^/]+)$/, "GET", m => { args.nodeId = decodeURIComponent(m[1]); args.language = url.searchParams.get("targetLanguage"); return "evidenceNode"; }],
      [/^evidence\/resolve$/, "POST", () => "resolveEvidence"],
      [/^evidence\/([^/]+)\/translate$/, "POST", m => { args.bundleId = decodeURIComponent(m[1]); return "translateEvidence"; }],
      [/^evidence\/([^/]+)$/, "GET", m => { args.bundleId = decodeURIComponent(m[1]); return "evidence"; }],
      [/^journal$/, "GET", () => { args.nodeId = url.searchParams.get("nodeId"); return "journal"; }], [/^journal$/, "POST", () => "saveJournal"],
      [/^journal\/([^/]+)$/, "DELETE", m => { args.entryId = decodeURIComponent(m[1]); return "deleteJournal"; }],
      [/^journal\/([^/]+)\/photos\/([^/]+)$/, "GET", m => { args.entryId = decodeURIComponent(m[1]); args.photoId = decodeURIComponent(m[2]); return "journalPhoto"; }],
    ];
    for (const [pattern, verb, select] of routes) { const m = tail.match(pattern); if (m && method === verb) return { action: select(m, m[1]), args }; }
  }
  throw Object.assign(new Error("travel_operation_not_allowed"), { code: "travel_operation_not_allowed" });
}

export function createMcpTravelClient(bridge) {
  return {
    host: bridge,
    request(path, { method = "GET", body, signal } = {}) {
      signal?.throwIfAborted();
      const operation = operationForPath(path, method);
      const pending = bridge.callTool("travel_app_action", { ...operation, ...(body ? { body } : {}) });
      if (!signal) return pending;
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        pending.then(value => { if (!signal.aborted) resolve(value); }, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    },
    async binary(path, options) {
      const value = await this.request(path, options);
      const bytes = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
      return new Blob([bytes], { type: value.mimeType });
    },
  };
}
