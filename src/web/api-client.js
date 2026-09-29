const desktopBridge = typeof window !== "undefined" ? window.travelDesktop : null;
const apiBaseUrl = String(desktopBridge?.runtimeConfig?.apiBaseUrl ?? import.meta.env?.VITE_TRAVEL_API_BASE_URL ?? "").trim().replace(/\/$/, "");
let desktopAccessToken = null;
let desktopPersistence = null;
const desktopSessionReady = desktopBridge?.restoreSession?.().then((result) => {
  desktopAccessToken = result.accessToken ?? null;
  desktopPersistence = result.persistent === true;
}).catch(() => { desktopPersistence = false; }) ?? Promise.resolve();

export async function setDesktopAccessToken(token) {
  await desktopSessionReady;
  desktopAccessToken = typeof token === "string" && token.trim() ? token.trim() : null;
  if (desktopBridge && desktopAccessToken) {
    const result = await desktopBridge.saveSession(desktopAccessToken).catch(() => ({ persistent: false }));
    desktopPersistence = result.persistent === true;
  }
}

export function desktopSessionPersistence() { return desktopPersistence; }

export async function clearDesktopAccessToken() {
  await desktopSessionReady;
  desktopAccessToken = null;
  await desktopBridge?.clearSession?.().catch(() => { desktopPersistence = false; });
}

export function apiPublicUrl(path) {
  if (!apiBaseUrl) return new URL(path, window.location.origin).toString();
  return new URL(path, `${apiBaseUrl}/`).toString();
}

async function request(path, { method = "GET", body, token, signal } = {}) {
  await desktopSessionReady;
  const authorizationToken = token ?? desktopAccessToken;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(authorizationToken ? { Authorization: `Bearer ${authorizationToken}` } : {}),
      ...(desktopBridge ? { "X-Travel-Client": "desktop" } : {}),
    },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ status: "error", code: "invalid_response" }));
  if (!response.ok) {
    const error = new Error(data.code ?? "request_failed");
    error.code = data.code;
    error.status = response.status;
    error.details = data.details;
    throw error;
  }
  return data;
}

const terminalRuns = new Set(["completed", "failed", "cancelled", "interrupted", "awaiting_input"]);
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
});

export async function watchTravelRun(runId, { onProgress, signal } = {}) {
  let cursor = 0;
  let failures = 0;
  const events = new Map();
  while (!signal?.aborted) {
    try {
      await desktopSessionReady;
      const response = await fetch(`${apiBaseUrl}/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`, {
        headers: { ...(desktopAccessToken ? { Authorization: `Bearer ${desktopAccessToken}` } : {}), ...(desktopBridge ? { "X-Travel-Client": "desktop" } : {}) }, credentials: "same-origin", signal,
      });
      if (!response.ok) throw Object.assign(new Error("execution_stream_unavailable"), { status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new Error("execution_stream_too_large");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data || !frame.includes("event: progress")) continue;
            const run = JSON.parse(data);
            for (const event of run.events ?? []) { if (event.sequence > cursor) events.set(event.sequence, event); cursor = Math.max(cursor, event.sequence); }
            failures = 0;
            const progress = { ...run, events: [...events.values()].slice(-80), connection: "connected" };
            onProgress?.(progress);
            if (terminalRuns.has(run.status) && cursor >= run.sequence) return progress;
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      throw new Error("execution_stream_closed");
    } catch (error) {
      if (signal?.aborted || [401, 403, 404].includes(error.status)) throw error;
      failures += 1;
      onProgress?.({ runId, connection: "reconnecting" });
      if (failures >= 12) throw Object.assign(new Error("execution_connection_lost"), { code: "execution_connection_lost", runId });
      await pause(Math.min(5000, 500 * 2 ** Math.min(failures, 4)), signal);
    }
  }
  throw signal?.reason ?? new Error("execution_watch_cancelled");
}

async function executionResult(run) {
  const result = run.result ?? {};
  return { ...result, status: run.status === "completed" ? result.status ?? "completed" : run.status,
    conversation: result.conversation ?? await api.conversation(run.conversationId),
    activities: result.activities ?? [], runId: run.runId };
}

export const api = {
  journal: (tripId, nodeId, signal) => request(`/api/trips/${encodeURIComponent(tripId)}/journal${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""}`, { signal }),
  saveJournalEntry: (tripId, body) => request(`/api/trips/${encodeURIComponent(tripId)}/journal`, { method: "POST", body }),
  deleteJournalEntry: (tripId, id) => request(`/api/trips/${encodeURIComponent(tripId)}/journal/${encodeURIComponent(id)}`, { method: "DELETE" }),
  journalPhoto: async (tripId, entryId, photoId, signal) => {
    await desktopSessionReady;
    const response = await fetch(`${apiBaseUrl}/api/trips/${encodeURIComponent(tripId)}/journal/${encodeURIComponent(entryId)}/photos/${encodeURIComponent(photoId)}`, {
      headers: { ...(desktopAccessToken ? { Authorization: `Bearer ${desktopAccessToken}` } : {}), ...(desktopBridge ? { "X-Travel-Client": "desktop" } : {}) },
      credentials: "same-origin", signal,
    });
    if (!response.ok) throw Object.assign(new Error("journal_photo_unavailable"), { code: "journal_photo_unavailable" });
    return response.blob();
  },
  health: () => request("/api/health"),
  account: () => request("/api/account"),
  updateProfile: (displayName) => request("/api/account/profile", { method: "POST", body: { displayName } }),
  linkIntent: (provider) => request("/api/account/link-intent", { method: "POST", body: { provider } }),
  unlinkIdentity: (identityId) => request(`/api/account/identities/${encodeURIComponent(identityId)}`, { method: "DELETE" }),
  revokeSession: (sessionId) => request(`/api/account/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  revokeOtherSessions: () => request("/api/account/sessions/others", { method: "DELETE" }),
  authProviders: () => request("/api/auth/providers"),
  authStartUrl: (provider, returnTo = "/") => `${apiBaseUrl}/api/auth/${encodeURIComponent(provider)}/start?returnTo=${encodeURIComponent(returnTo)}${desktopBridge ? "&client=desktop" : ""}`,
  createDevelopmentSession: (provider, identity) => request("/api/auth/session", { method: "POST", body: { provider, identity } }),
  createGuestSession: () => request("/api/auth/guest-session", { method: "POST" }),
  desktopExchange: (code) => request("/api/auth/desktop-exchange", { method: "POST", body: { code } }),
  session: () => request("/api/session"),
  logout: () => request("/api/session", { method: "DELETE" }),
  listTrips: () => request("/api/trips"),
  providerStatus: () => request("/api/provider-status"),
  listConversations: (includeDeleted = false) => request(`/api/conversations${includeDeleted ? "?includeDeleted=true" : ""}`),
  createConversation: (input = {}) => request("/api/conversations", { method: "POST", body: input }),
  conversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}`),
  deleteConversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" }),
  restoreConversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}/restore`, { method: "POST" }),
  conversationRuns: (conversationId, signal) => request(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { signal }),
  cancelRun: (runId) => request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  resumeRunView: async (runId, options) => executionResult(await watchTravelRun(runId, options)),
  sendConversationMessage: async (conversationId, text, modelId, images = undefined, planningContext = undefined, options = {}) => {
    const body = { requestId: options.requestId ?? crypto.randomUUID(), text, modelId, ...(images?.length ? { images } : {}), ...(planningContext ? { planningContext } : {}), ...(options.answerTo ? { answerTo: options.answerTo } : {}) };
    // One retry reuses the command identity even if the first response was lost.
    let run;
    try { run = await request(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { method: "POST", body }); }
    catch (error) {
      if (error.status) throw error;
      run = await request(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { method: "POST", body });
    }
    options.onProgress?.(run);
    return executionResult(await watchTravelRun(run.runId, options));
  },
  inspectVisualEvidence: (input) => request("/api/visual-evidence/inspect", { method: "POST", body: input }),
  createTrip: (input) => request("/api/trips", { method: "POST", body: input }),
  control: (tripId) => request(`/api/trips/${encodeURIComponent(tripId)}/control`),
  plan: (tripId) => request(`/api/trips/${encodeURIComponent(tripId)}/plan`),
  evidenceForNode: (tripId, nodeId, targetLanguage = "zh-CN") => request(`/api/trips/${encodeURIComponent(tripId)}/evidence/nodes/${encodeURIComponent(nodeId)}?targetLanguage=${encodeURIComponent(targetLanguage)}`),
  resolveEvidenceShareLink: (tripId, nodeId, url, targetLanguage = "zh-CN") => request(`/api/trips/${encodeURIComponent(tripId)}/evidence/resolve`, { method: "POST", body: { nodeId, url, targetLanguage } }),
  evidenceBundle: (tripId, bundleId) => request(`/api/trips/${encodeURIComponent(tripId)}/evidence/${encodeURIComponent(bundleId)}`),
  translateEvidenceBundle: (tripId, bundleId, targetLanguage) => request(`/api/trips/${encodeURIComponent(tripId)}/evidence/${encodeURIComponent(bundleId)}/translate`, { method: "POST", body: { targetLanguage } }),
  updateReadiness: (tripId, signalId, status) => request(`/api/trips/${encodeURIComponent(tripId)}/readiness`, { method: "POST", body: { signalId, status } }),
  mapUrl: (tripId) => `${apiBaseUrl}/api/trips/${encodeURIComponent(tripId)}/map`,
  mapBlob: async (tripId, signal = undefined) => {
    const response = await fetch(`${apiBaseUrl}/api/trips/${encodeURIComponent(tripId)}/map`, {
      headers: { ...(desktopAccessToken ? { Authorization: `Bearer ${desktopAccessToken}` } : {}), ...(desktopBridge ? { "X-Travel-Client": "desktop" } : {}) },
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) throw Object.assign(new Error("map_request_failed"), { code: "map_request_failed" });
    return response.blob();
  },
  decisions: (tripId) => request(`/api/trips/${encodeURIComponent(tripId)}/decisions`),
  transit: (tripId, nodeId) => request(`/api/trips/${encodeURIComponent(tripId)}/transit/${encodeURIComponent(nodeId)}`),
  refreshMobility: (tripId) => request(`/api/trips/${encodeURIComponent(tripId)}/mobility/refresh`, { method: "POST" }),
  previewMobility: (tripId, baseRevision, selections, signal = undefined, previewId = undefined, routeModes = undefined) => request(`/api/trips/${encodeURIComponent(tripId)}/mobility/preview`, { method: "POST", body: { baseRevision, selections, ...(previewId ? { previewId } : {}), ...(routeModes && Object.keys(routeModes).length ? { routeModes } : {}) }, signal }),
  submitFeedback: (tripId, input) => request(`/api/trips/${encodeURIComponent(tripId)}/feedback`, { method: "POST", body: input }),
  propose: (tripId, proposal) => request(`/api/trips/${encodeURIComponent(tripId)}/proposals`, { method: "POST", body: { proposal } }),
  accept: (tripId, proposalId, selections = undefined, partial = false, previewId = undefined, baseRevision = undefined, routeModes = undefined) => request(`/api/trips/${encodeURIComponent(tripId)}/proposals/${encodeURIComponent(proposalId)}/accept`, { method: "POST", body: { ...(selections ? { selections } : {}), ...(partial ? { partial: true } : {}), ...(previewId ? { previewId } : {}), ...(baseRevision != null ? { baseRevision } : {}), ...(routeModes && Object.keys(routeModes).length ? { routeModes } : {}) } }),
  reject: (tripId, proposalId) => request(`/api/trips/${encodeURIComponent(tripId)}/proposals/${encodeURIComponent(proposalId)}/reject`, { method: "POST" }),
  discardItineraryTrial: (tripId, proposalId, baseRevision) => request(`/api/trips/${encodeURIComponent(tripId)}/itinerary-trials/${encodeURIComponent(proposalId)}/discard`, { method: "POST", body: { baseRevision } }),
};
