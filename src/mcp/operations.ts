import { workspaceActions, workspaceReadActions } from "../../travel-agent-pi-package/src/core/workspace-actions.ts";
export interface TravelOperation { method: "GET" | "POST" | "DELETE"; path: string; scope: "travel:read" | "travel:write"; binary?: boolean }
const segment = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw Object.assign(new Error("invalid_resource_id"), { code: "invalid_resource_id" });
  return encodeURIComponent(value);
};
/** An allowlist of actual backend operations, never a caller-selected URL or HTTP verb. */
export function travelOperation(action: string, args: Record<string, unknown> = {}): TravelOperation {
  const read = (path: string, binary = false): TravelOperation => ({ method: "GET", path, scope: "travel:read", binary });
  const write = (path: string, method: "POST" | "DELETE" = "POST"): TravelOperation => ({ method, path, scope: "travel:write" });
  switch (action) {
    case "session": return read("/api/mcp/session");
    case "health": return read("/api/health");
    case "providers": return read("/api/provider-status");
    case "authProviders": return read("/api/auth/providers");
    case "confirmPreference": return write(`/api/preferences/${segment(args.preferenceId)}/confirm`);
    case "preferences": return read("/api/preferences");
    case "savePreferences": return write("/api/preferences");
    case "watches": return read("/api/price-watches");
    case "recheckWatch": return write(`/api/price-watches/${segment(args.watchId)}/recheck`);
    case "createWatch": return write("/api/price-watches");
    case "updateWatch": return write(`/api/price-watches/${segment(args.watchId)}`);
    case "notifications": return read("/api/notifications");
    case "markNotificationRead": return write(`/api/notifications/${segment(args.notificationId)}/read`);
    case "removeNotificationEmail": return write("/api/notification-email", "DELETE");
    case "notificationEmail": return read("/api/notification-email");
    case "requestNotificationEmail": return write("/api/notification-email");
    case "verifyNotificationEmail": return write("/api/notification-email/verify");
    case "account": return read("/api/account");
    case "profile": return write("/api/account/profile");
    case "logout": return { ...write("/api/mcp/connection", "DELETE"), scope: "travel:read" };
    case "revokeConnection": return write(`/api/account/connections/${segment(args.connectionId)}`, "DELETE");
    case "linkIntent": return write("/api/account/link-intent");
    case "unlinkIdentity": return write(`/api/account/identities/${segment(args.identityId)}`, "DELETE");
    case "revokeSession": return write(`/api/account/sessions/${segment(args.sessionId)}`, "DELETE");
    case "revokeOtherSessions": return write("/api/account/sessions/others", "DELETE");
    case "listTrips": return read("/api/trips");
    case "listConversations": return read(`/api/conversations${args.includeDeleted ? "?includeDeleted=true" : ""}`);
    case "createConversation": return write("/api/conversations");
    case "conversation": return read(`/api/conversations/${segment(args.conversationId)}`);
    case "deleteConversation": return write(`/api/conversations/${segment(args.conversationId)}`, "DELETE");
    case "restoreConversation": return write(`/api/conversations/${segment(args.conversationId)}/restore`);
    case "submit": return write(`/api/conversations/${segment(args.conversationId)}/runs`);
    case "runs": return read(`/api/conversations/${segment(args.conversationId)}/runs`);
    case "run": {
      const after = Number(args.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_execution_cursor");
      return read(`/api/runs/${segment(args.runId)}?after=${after}`);
    }
    case "cancel": return write(`/api/runs/${segment(args.runId)}/cancel`);
    case "inspectImage": return write("/api/visual-evidence/inspect");
    case "mapConfig": return read("/api/maps/config");
    case "googleTiles": return { ...write("/api/maps/google/tiles"), scope: "travel:read" };
    case "googlePlace": return read(`/api/maps/google/places/${segment(args.placeId)}`);
    case "googlePhoto": return { ...write("/api/maps/google/photo"), scope: "travel:read" };
  }
  const trip = `/api/trips/${segment(args.tripId)}`;
  switch (action) {
    case "workspace": {
      if (typeof args.tool !== "string" || !workspaceActions.has(args.tool)) throw Object.assign(new Error("workspace_operation_not_allowed"), { code: "workspace_operation_not_allowed" });
      return { ...write(`${trip}/workspace/${segment(args.tool)}`), scope: workspaceReadActions.has(args.tool) ? "travel:read" : "travel:write" };
    }
    case "previewLocalChoice": return write(`${trip}/local-choice`);
    case "undoChange": return write(`${trip}/undo`);
    case "watchOffers": return read(`${trip}/watch-offers`);
    case "updateRequirements": return write(`${trip}/requirements`);
    case "control": return read(`${trip}/control`);
    case "plan": return read(`${trip}/plan`);
    case "decisions": return read(`${trip}/decisions`);
    case "map": return read(`${trip}/map`, true);
    case "evidenceNode": return read(`${trip}/evidence/nodes/${segment(args.nodeId)}?targetLanguage=${encodeURIComponent(String(args.language ?? "zh-CN"))}`);
    case "evidence": return read(`${trip}/evidence/${segment(args.bundleId)}`);
    case "resolveEvidence": return write(`${trip}/evidence/resolve`);
    case "translateEvidence": return write(`${trip}/evidence/${segment(args.bundleId)}/translate`);
    case "readiness": return write(`${trip}/readiness`);
    case "previewMobility": return write(`${trip}/mobility/preview`);
    case "refreshMobility": return write(`${trip}/mobility/refresh`);
    case "accept": return write(`${trip}/proposals/${segment(args.proposalId)}/accept`);
    case "reject": return write(`${trip}/proposals/${segment(args.proposalId)}/reject`);
    case "discard": return write(`${trip}/itinerary-trials/${segment(args.proposalId)}/discard`);
    case "transit": return read(`${trip}/transit/${segment(args.nodeId)}`);
    case "feedback": return write(`${trip}/feedback`);
    case "bookingHandoff": return write(`${trip}/booking-handoffs`);
    case "bookingConfirmation": return write(`${trip}/booking-confirmations`);
    case "journal": return read(`${trip}/journal${args.nodeId ? `?nodeId=${segment(args.nodeId)}` : ""}`);
    case "saveJournal": return write(`${trip}/journal`);
    case "deleteJournal": return write(`${trip}/journal/${segment(args.entryId)}`, "DELETE");
    case "journalPhoto": return read(`${trip}/journal/${segment(args.entryId)}/photos/${segment(args.photoId)}`, true);
    default: throw Object.assign(new Error("travel_operation_not_allowed"), { code: "travel_operation_not_allowed" });
  }
}
