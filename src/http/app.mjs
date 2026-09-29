import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { assertTravelServicePort } from "../../travel-agent-pi-package/src/core/index.ts";
import { createTravelService } from "../api/create-travel-service.mjs";
import { EvidenceCompanionService } from "../api/evidence-companion-service.mjs";
import { TravelConversationAgent } from "../agent/travel-conversation-agent.mjs";
import { createConversationRepository } from "../persistence/conversation-repository.mjs";
import { providerStatusSummary } from "../providers/provider-status.mjs";
import { authenticatedUserId, developmentUserId, guestUserId, GUEST_SESSION_TTL_MS } from "./session.mjs";
import { createAuthService, oauthClientCookieName, oauthNonceCookieName } from "./auth-providers.mjs";
import { AuthRepository } from "../persistence/auth-repository.mjs";
import { AccountService, sessionDevice } from "./account-service.mjs";
import { createAmapJsSecurityProxy } from "./amap-js-security-proxy.mjs";
import { httpError, sendError } from "./http-errors.mjs";
import { TravelJournalRepository } from "../persistence/travel-journal-repository.mjs";
import { registerTravelJournalRoutes } from "./travel-journal.mjs";
import { registerTravelRuntimeRoutes } from "./travel-runtime-routes.mjs";
import { registerTravelExecutionRoutes } from "./travel-execution-routes.mjs";
import { ExecutionRepository } from "../persistence/execution-repository.mjs";
import { TravelExecutionService } from "../agent/travel-execution-service.mjs";
import { randomUUID } from "node:crypto";

function cookieValue(request, name) {
  const values = String(request.headers.cookie ?? "").split(";").map((item) => item.trim());
  const encoded = values.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
  try {
    return encoded ? decodeURIComponent(encoded) : null;
  } catch {
    return null;
  }
}

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

function parseAllowedOrigins(value) {
  return new Set(String(value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

function isLocalDevelopmentOrigin(origin) {
  return /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
}

function requestPublicOrigin(request, runtimeEnv) {
  const configured = String(runtimeEnv.TRAVEL_AGENT_PUBLIC_ORIGIN ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const inferred = `${request.protocol}://${request.get("host")}`;
  return runtimeEnv.NODE_ENV !== "production" && isLocalDevelopmentOrigin(inferred) ? inferred : null;
}

function sessionTokenFromRequest(request) {
  const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : null;
  return bearer ?? cookieValue(request, "travel_session");
}

function sessionCookieOptions(runtimeEnv, expiresAt) {
  const maxAge = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: runtimeEnv.NODE_ENV === "production" || String(runtimeEnv.TRAVEL_AGENT_PUBLIC_ORIGIN ?? "").startsWith("https://"),
    path: "/",
    maxAge,
  };
}

function authResultLocation(returnTo, key, value) {
  const url = new URL(returnTo || "/", "http://travel-agent.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

function desktopAuthConfiguration(runtimeEnv) {
  const requested = String(runtimeEnv.TRAVEL_AGENT_DESKTOP_AUTH_ENABLED ?? "false").trim().toLowerCase() === "true";
  const scheme = String(runtimeEnv.TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME ?? "zhuanshu-travel").trim().toLowerCase();
  const validScheme = /^[a-z][a-z0-9+.-]{1,62}$/.test(scheme);
  return {
    requested,
    enabled: requested && validScheme,
    scheme: validScheme ? scheme : null,
    unavailableReason: !requested ? "desktop_auth_disabled" : !validScheme ? "desktop_deep_link_scheme_invalid" : null,
  };
}

function desktopAuthResultLocation(config, returnTo, key, value) {
  const url = new URL(`${config.scheme}://auth/callback`);
  url.searchParams.set(key, value);
  url.searchParams.set("returnTo", String(returnTo || "/").slice(0, 1024));
  return url.toString();
}

function publicAuthError(error) {
  return ["auth_authorization_denied", "auth_state_invalid", "auth_state_expired", "auth_provider_not_configured", "auth_provider_unavailable", "identity_already_linked", "auth_link_session_changed", "recent_login_required"].includes(error?.code)
    ? error.code
    : "auth_login_failed";
}

export function createHttpApp({
  travelService,
  conversationRepository,
  conversationAgent,
  executionRepository,
  sessionStore,
  authService,
  accountService,
  desktopAuthCodeStore,
  evidenceCompanionService,
  journalRepository,
  webRoot = resolve(process.cwd(), "dist"),
  developmentAuthEnabled = process.env.NODE_ENV !== "production" && process.env.TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH === "true",
  allowedOrigins = parseAllowedOrigins(process.env.TRAVEL_AGENT_CORS_ORIGINS),
  runtimeEnv = process.env,
  clock = () => new Date(),
} = {}) {
  const ownsTravelService = !travelService;
  const ownsConversations = !conversationRepository;
  const ownsAccountService = !accountService;
  const ownsJournalRepository = !journalRepository;
  const ownsExecutionRepository = !executionRepository;
  journalRepository ??= new TravelJournalRepository({ databaseUrl: runtimeEnv.DATABASE_URL, rootDir: resolve(runtimeEnv.TRAVEL_AGENT_DATA_DIR ?? "runtime-data", "photo-journal") });
  travelService = assertTravelServicePort(travelService ?? createTravelService(runtimeEnv));
  conversationRepository ??= createConversationRepository({
    databaseUrl: runtimeEnv.DATABASE_URL,
    pool: travelService.store?.pool,
    rootDir: runtimeEnv.TRAVEL_AGENT_CONVERSATION_DATA_DIR
      ?? (runtimeEnv.TRAVEL_AGENT_DATA_DIR ? resolve(runtimeEnv.TRAVEL_AGENT_DATA_DIR, "conversations") : undefined),
  });
  developmentAuthEnabled = developmentAuthEnabled && runtimeEnv.NODE_ENV !== "production";
  if (!accountService) {
    if (runtimeEnv.NODE_ENV === "production" && !runtimeEnv.DATABASE_URL && !sessionStore) throw httpError("auth_database_required", 503);
    const repository = new AuthRepository({ databaseUrl: runtimeEnv.DATABASE_URL,
      filename: sessionStore ? ":memory:" : resolve(runtimeEnv.TRAVEL_AGENT_DATA_DIR ?? "runtime-data", "auth.sqlite"),
    });
    accountService = new AccountService({ repository, clock });
  }
  sessionStore ??= accountService;
  authService ??= createAuthService({ env: runtimeEnv, clock });
  desktopAuthCodeStore ??= {
    issue: (payload) => accountService.issueChallenge("desktop", payload),
    consume: (code) => accountService.consumeChallenge("desktop", code),
  };
  evidenceCompanionService ??= new EvidenceCompanionService({ travelService, env: runtimeEnv, clock });
  const travelConversationAgent = conversationAgent ?? new TravelConversationAgent({ travelService, conversationRepository, env: runtimeEnv });
  executionRepository ??= new ExecutionRepository({ databaseUrl: runtimeEnv.DATABASE_URL, pool: travelService.store?.pool,
    filename: sessionStore && !ownsConversations ? ":memory:" : resolve(runtimeEnv.TRAVEL_AGENT_DATA_DIR ?? "runtime-data", "executions", "runs.sqlite") });
  const executionService = new TravelExecutionService({ repository: executionRepository, conversationAgent: travelConversationAgent, conversationRepository, env: runtimeEnv });
  const app = express();
  app.locals.executionService = executionService;
  app.locals.close = async () => {
    await executionService.close();
    if (ownsExecutionRepository) await executionRepository.close();
    await Promise.all([
      ownsAccountService ? accountService.repository.close() : undefined,
      ownsTravelService ? travelService.store.close?.() : undefined,
      ownsConversations ? conversationRepository.close?.() : undefined,
      ownsJournalRepository ? journalRepository.close() : undefined,
    ]);
  };
  const desktopAuth = desktopAuthConfiguration(runtimeEnv);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "6mb", type: "application/json" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (!origin) return next();
    // Apple sends a top-level HTML form, not a cross-origin API request.
    // Only this exact callback bypasses CORS; OAuth state/nonce still authorize it.
    if (origin === "https://appleid.apple.com" && request.method === "POST"
      && request.path === "/api/auth/apple/callback" && request.is("application/x-www-form-urlencoded")) return next();
    if (!allowedOrigins.has(origin) && !(developmentAuthEnabled && isLocalDevelopmentOrigin(origin))) {
      return sendError(response, httpError("cors_origin_not_allowed", 403));
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Travel-Client");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (request.method === "OPTIONS") return response.status(204).end();
    return next();
  });
  app.use("/_AMapService", createAmapJsSecurityProxy({
    publicKey: String(runtimeEnv.TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED ?? "true").trim().toLowerCase() === "false" ? undefined : runtimeEnv.AMAP_JS_API_KEY,
    securityCode: String(runtimeEnv.TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED ?? "true").trim().toLowerCase() === "false" ? undefined : runtimeEnv.AMAP_JS_SECURITY_CODE,
  }));

  const currentSession = async (request) => {
    const session = await sessionStore.read(sessionTokenFromRequest(request));
    return session?.provider === "email_otp" && !developmentAuthEnabled ? null : session;
  };
  const publicSession = (session, extra = {}) => ({
    schemaVersion: "auth-session-v1",
    ...session,
    guest: session.provider === "guest",
    ...extra,
  });
  const claimGuestData = async (session, userId) => {
    if (session?.provider !== "guest" || !session.userId || session.userId === userId) return { transferredTrips: 0, transferredConversations: 0 };
    const tripResult = await travelService.transferUserOwnership({ fromUserId: session.userId, toUserId: userId });
    const conversationResult = typeof conversationRepository.transferUserOwnership === "function"
      ? await conversationRepository.transferUserOwnership(session.userId, userId)
      : { transferredConversations: 0 };
    await executionRepository.transferUserOwnership(session.userId, userId);
    return { ...tripResult, ...conversationResult };
  };
  const finishLogin = async (request, { userId, provider, displayName, developmentOnly = false }) => {
    const previousToken = sessionTokenFromRequest(request);
    const claim = await claimGuestData(await currentSession(request), userId);
    const issued = await sessionStore.issue({ userId, provider, displayName, device: sessionDevice(request) });
    // Rotate only after the claim and new session succeed, so failures remain retryable.
    await sessionStore.revoke(previousToken);
    const session = await sessionStore.read(issued.opaqueToken);
    return { issued, session: publicSession(session, { developmentOnly, claim }) };
  };
  const finishVerifiedLogin = async (request, identity) => finishLogin(request, {
    userId: await accountService.resolveIdentity(identity), provider: identity.provider, displayName: identity.displayName,
  });
  const requireSession = async (request) => {
    const session = await currentSession(request);
    if (!session) throw httpError("authentication_required", 401);
    return session;
  };
  const requireTripMember = async (request, tripId) => {
    const session = await requireSession(request);
    const state = await travelService.store.get(tripId);
    if (!state) throw httpError("trip_not_found", 404, { tripId });
    const members = state.collaboration?.memberUserIds;
    if (members && !members.includes(session.userId)) throw httpError("trip_access_denied", 403, { tripId });
    if (session.provider === "guest" && state.collaboration?.guestExpiresAt && new Date(state.collaboration.guestExpiresAt).getTime() <= clock().getTime()) {
      throw httpError("guest_trip_expired", 410, { tripId });
    }
    return session;
  };
  const requireConversationOwner = async (request, conversationId) => {
    const session = await requireSession(request);
    try {
      await travelConversationAgent.getConversation({ conversationId, userId: session.userId });
    } catch (error) {
      if (error?.code === "conversation_not_found") throw httpError("conversation_not_found", 404, { conversationId });
      if (error?.code === "conversation_access_denied") throw httpError("conversation_access_denied", 403, { conversationId });
      throw error;
    }
    return session;
  };

  const requireAccount = async (request, { fresh = false, verified = false } = {}) => {
    const session = await requireSession(request);
    if (session.provider === "guest") throw httpError("account_login_required", 403);
    if (verified && session.provider === "email_otp") throw httpError("verified_login_required", 403);
    if (fresh && (!session.createdAt || clock().getTime() - new Date(session.createdAt).getTime() > 15 * 60 * 1000)) throw httpError("recent_login_required", 403);
    return session;
  };
  const linkVerifiedIdentity = async (session, identity) => {
    const originalId = authenticatedUserId(identity);
    if (originalId !== session.userId) {
      // Preserve data from pre-registry accounts; never silently attach their
      // login method to another user and strand their existing trips.
      const trips = await travelService.listTrips({ userId: originalId });
      const conversations = await conversationRepository.listByUser?.(originalId, { includeDeleted: true });
      if (trips.trips?.length || conversations?.length) throw httpError("identity_already_linked", 409);
    }
    await accountService.linkIdentity(session, identity);
  };
  const completeLink = async (request, completed) => {
    const session = await requireAccount(request, { fresh: true, verified: true });
    if (session.sessionId !== completed.linkSessionId) throw httpError("auth_link_session_changed", 403);
    await linkVerifiedIdentity(session, completed.identity);
  };

  app.get("/api/account", asyncRoute(async (request, response) => {
    const session = await requireAccount(request);
    response.json({ userId: session.userId, displayName: session.displayName, provider: session.provider,
      identities: await accountService.identities(session.userId),
      sessions: await accountService.listSessions(session.userId, session.sessionId),
    });
  }));
  app.post("/api/account/profile", asyncRoute(async (request, response) => {
    const session = await requireAccount(request);
    await accountService.updateProfile(session.userId, request.body?.displayName);
    response.json(publicSession(await requireSession(request)));
  }));
  app.delete("/api/account/sessions/others", asyncRoute(async (request, response) => {
    const session = await requireAccount(request);
    await accountService.revokeOthers(session.userId, session.sessionId);
    response.status(204).end();
  }));
  app.delete("/api/account/sessions/:sessionId", asyncRoute(async (request, response) => {
    const session = await requireAccount(request);
    await accountService.revokeSession(session.userId, request.params.sessionId);
    if (session.sessionId === request.params.sessionId) response.clearCookie("travel_session", { path: "/" });
    response.status(204).end();
  }));
  app.post("/api/account/link-intent", asyncRoute(async (request, response) => {
    const session = await requireAccount(request, { fresh: true, verified: true });
    const provider = request.body?.provider;
    const summary = authService.providerSummary({ origin: requestPublicOrigin(request, runtimeEnv) });
    if (!summary.providers.some((item) => item.id === provider && item.available)) throw httpError("auth_provider_not_configured", 503);
    const client = request.headers["x-travel-client"] === "desktop" ? "desktop" : "web";
    const intent = await accountService.issueChallenge("link", { sessionId: session.sessionId, provider, client });
    response.json({ startPath: `/api/auth/${provider}/start?client=${client}&link=${encodeURIComponent(intent.code)}` });
  }));
  app.post("/api/account/identities/platform", asyncRoute(async (request, response) => {
    const session = await requireAccount(request, { fresh: true, verified: true });
    const identity = await authService.exchangePlatform({ provider: request.body?.provider, authorizationCode: request.body?.authorizationCode });
    await linkVerifiedIdentity(session, identity);
    response.json({ identities: await accountService.identities(session.userId) });
  }));
  app.delete("/api/account/identities/:identityId", asyncRoute(async (request, response) => {
    const session = await requireAccount(request, { fresh: true, verified: true });
    await accountService.unlinkIdentity(session, request.params.identityId);
    response.status(204).end();
  }));

  app.get("/api/health", asyncRoute(async (_request, response) => {
    response.json({ status: "ok", developmentAuthEnabled, desktopAuth, storageMode: travelService.store.mode ?? "unknown", workflowExecution: travelService.workflowExecution ?? { workflowExecutionMode: "injected_service_unknown", semanticFanoutEnabled: Boolean(travelService.analysisFanout), backgroundResumeSupported: false, crossInstanceSteerSupported: false } });
  }));
  app.use("/api/auth", (_request, response, next) => {
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/api/auth/providers", asyncRoute(async (request, response) => {
    response.json({ ...authService.providerSummary({ origin: requestPublicOrigin(request, runtimeEnv) }), developmentAuthEnabled, clients: { web: { available: true }, desktop: desktopAuth } });
  }));
  app.get("/api/auth/:provider/start", asyncRoute(async (request, response) => {
    const provider = String(request.params.provider ?? "");
    const client = request.query.client ?? "web";
    if (!["web", "desktop"].includes(client)) throw httpError("unsupported_auth_client", 400);
    if (client === "desktop" && !desktopAuth.enabled) throw httpError("desktop_auth_not_configured", 503, { reason: desktopAuth.unavailableReason });
    let linkSessionId = null;
    if (request.query.link) {
      const intent = await accountService.consumeChallenge("link", request.query.link);
      if (!intent || intent.provider !== provider || intent.client !== client) throw httpError("auth_state_invalid", 400);
      linkSessionId = intent.sessionId;
    }
    const authorization = authService.beginWeb({
      provider,
      origin: requestPublicOrigin(request, runtimeEnv),
      returnTo: linkSessionId ? "/?account=connections" : request.query.returnTo,
      client,
      linkSessionId,
    });
    response.cookie(oauthNonceCookieName(provider), authorization.nonce, {
      httpOnly: true,
      sameSite: authorization.cookieSameSite,
      secure: authorization.cookieSecure,
      path: `/api/auth/${provider}/callback`,
      maxAge: authorization.cookieMaxAge,
    });
    response.cookie(oauthClientCookieName(provider), authorization.client ?? client, {
      httpOnly: true,
      sameSite: authorization.cookieSameSite,
      secure: authorization.cookieSecure,
      path: `/api/auth/${provider}/callback`,
      maxAge: authorization.cookieMaxAge,
    });
    response.redirect(302, authorization.authorizationUrl);
  }));
  const completeWebAuthorization = async (request, response) => {
    const provider = String(request.params.provider ?? "");
    const state = request.body?.state ?? request.query.state;
    const nonceCookie = oauthNonceCookieName(provider);
    const clientCookie = oauthClientCookieName(provider);
    const requestedClient = cookieValue(request, clientCookie) === "desktop" ? "desktop" : "web";
    const cookieOptions = { path: `/api/auth/${provider}/callback`, sameSite: provider === "apple" ? "none" : "lax", secure: provider === "apple" || runtimeEnv.NODE_ENV === "production" };
    let returnTo = "/";
    try {
      if (request.body?.error || request.query.error) throw httpError("auth_authorization_denied", 400);
      const code = request.body?.code ?? request.query.code ?? request.query.auth_code;
      const completed = await authService.completeWeb({ provider, code, state, nonce: cookieValue(request, nonceCookie) });
      returnTo = completed.returnTo;
      response.clearCookie(clientCookie, cookieOptions);
      if ((completed.client ?? requestedClient) === "desktop") {
        if (!desktopAuth.enabled) throw httpError("desktop_auth_not_configured", 503, { reason: desktopAuth.unavailableReason });
        const issuedCode = await desktopAuthCodeStore.issue({ identity: completed.identity, returnTo, linkSessionId: completed.linkSessionId });
        response.clearCookie(nonceCookie, cookieOptions);
        return response.redirect(303, desktopAuthResultLocation(desktopAuth, returnTo, "code", issuedCode.code));
      }
      if (completed.linkSessionId) {
        await completeLink(request, completed);
        response.clearCookie(nonceCookie, cookieOptions);
        return response.redirect(303, authResultLocation(returnTo, "auth", "linked"));
      }
      const { issued } = await finishVerifiedLogin(request, completed.identity);
      response.cookie("travel_session", issued.opaqueToken, sessionCookieOptions(runtimeEnv, issued.expiresAt));
      response.clearCookie(nonceCookie, cookieOptions);
      response.redirect(303, authResultLocation(returnTo, "auth", "success"));
    } catch (error) {
      response.clearCookie(nonceCookie, cookieOptions);
      response.clearCookie(clientCookie, cookieOptions);
      response.redirect(303, requestedClient === "desktop" && desktopAuth.enabled
        ? desktopAuthResultLocation(desktopAuth, returnTo, "auth_error", publicAuthError(error))
        : authResultLocation(returnTo, "auth_error", publicAuthError(error)));
    }
  };
  app.get("/api/auth/:provider/callback", completeWebAuthorization);
  app.post("/api/auth/:provider/callback", asyncRoute(async (request, response) => {
    if (request.params.provider !== "apple") return completeWebAuthorization(request, response);
    if (!request.is("application/x-www-form-urlencoded")) throw httpError("invalid_auth_callback", 400);
    // The cross-site POST cannot carry the SameSite=Lax guest session. A 303 GET
    // restores it before the shared login finalizer claims the guest's work.
    const parameters = new URLSearchParams();
    for (const key of ["code", "state", "error"]) {
      const value = request.body?.[key];
      if (value == null) continue;
      if (typeof value !== "string" || value.length > 8192) throw httpError("invalid_auth_callback", 400);
      parameters.set(key, value);
    }
    // Never forward Apple's id_token or user profile into a URL.
    response.redirect(303, `/api/auth/apple/callback?${parameters}`);
  }));
  app.get("/api/provider-status", asyncRoute(async (request, response) => {
    await requireSession(request);
    response.json(providerStatusSummary(runtimeEnv));
  }));
  app.post("/api/auth/session", asyncRoute(async (request, response) => {
    const provider = request.body?.provider;
    if (provider !== "email_otp") throw httpError("unsupported_auth_provider", 400, { provider });
    if (!developmentAuthEnabled) throw httpError("auth_provider_not_configured", 503, { provider, message: "Configure this provider callback before issuing a production session." });
    const identity = String(request.body?.identity ?? "").trim();
    if (!identity || identity.length > 256) throw httpError("invalid_auth_identity");
    const userId = developmentUserId({ provider, identity });
    const { issued, session } = await finishLogin(request, { userId, provider, displayName: identity, developmentOnly: true });
    response.cookie("travel_session", issued.opaqueToken, sessionCookieOptions(runtimeEnv, issued.expiresAt));
    response.status(201).json({ ...session, accessToken: issued.opaqueToken });
  }));
  app.post("/api/auth/guest-session", asyncRoute(async (request, response) => {
    const desktopClient = request.headers["x-travel-client"] === "desktop";
    if (desktopClient && !desktopAuth.enabled) throw httpError("desktop_auth_not_configured", 503, { reason: desktopAuth.unavailableReason });
    const existing = await currentSession(request);
    if (existing) return response.status(200).json(publicSession(existing, desktopClient ? { accessToken: sessionTokenFromRequest(request) } : {}));
    const userId = guestUserId();
    const issued = await sessionStore.issue({ userId, provider: "guest", displayName: null, ttlMs: GUEST_SESSION_TTL_MS, device: sessionDevice(request) });
    response.cookie("travel_session", issued.opaqueToken, sessionCookieOptions(runtimeEnv, issued.expiresAt));
    return response.status(201).json(publicSession(await sessionStore.read(issued.opaqueToken), { developmentOnly: false, ...(desktopClient ? { accessToken: issued.opaqueToken } : {}) }));
  }));
  app.post("/api/auth/desktop-exchange", asyncRoute(async (request, response) => {
    if (!desktopAuth.enabled) throw httpError("desktop_auth_not_configured", 503, { reason: desktopAuth.unavailableReason });
    if (request.headers["x-travel-client"] !== "desktop") throw httpError("desktop_auth_client_required", 400);
    const code = String(request.body?.code ?? "").trim();
    if (!code || code.length > 512) throw httpError("invalid_authorization_code", 400);
    const completed = await desktopAuthCodeStore.consume(code);
    if (!completed) throw httpError("desktop_auth_code_invalid_or_expired", 400);
    if (completed.linkSessionId) {
      await completeLink(request, completed);
      return response.json(publicSession(await requireSession(request), { linked: true, returnTo: completed.returnTo }));
    }
    const { issued, session } = await finishVerifiedLogin(request, completed.identity);
    response.status(201).json({ ...session, accessToken: issued.opaqueToken, returnTo: completed.returnTo });
  }));
  app.post("/api/auth/platform-exchange", asyncRoute(async (request, response) => {
    const provider = request.body?.provider;
    if (!["wechat", "alipay"].includes(provider)) throw httpError("unsupported_auth_provider", 400, { provider });
    const authorizationCode = String(request.body?.authorizationCode ?? "").trim();
    if (!authorizationCode || authorizationCode.length > 4096) throw httpError("invalid_authorization_code", 400);
    const identity = await authService.exchangePlatform({ provider, authorizationCode });
    const { issued, session } = await finishVerifiedLogin(request, identity);
    response.status(201).json({ ...session, accessToken: issued.opaqueToken });
  }));
  app.get("/api/session", asyncRoute(async (request, response) => {
    response.json(publicSession(await requireSession(request)));
  }));
  app.delete("/api/session", asyncRoute(async (request, response) => {
    await sessionStore.revoke(sessionTokenFromRequest(request));
    response.clearCookie("travel_session", { path: "/" });
    response.status(204).end();
  }));
  app.get("/api/trips", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await travelService.listTrips({ userId: session.userId }));
  }));
  app.get("/api/conversations", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await travelConversationAgent.listConversations({ userId: session.userId, includeDeleted: request.query.includeDeleted === "true" }));
  }));
  app.post("/api/conversations", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    const tripId = request.body?.tripId ?? null;
    if (tripId) await requireTripMember(request, tripId);
    response.status(201).json(await travelConversationAgent.createConversation({ userId: session.userId, tripId, modelId: request.body?.modelId }));
  }));
  app.get("/api/conversations/:conversationId", asyncRoute(async (request, response) => {
    const session = await requireConversationOwner(request, request.params.conversationId);
    response.json(await travelConversationAgent.getConversation({ conversationId: request.params.conversationId, userId: session.userId }));
  }));
  app.delete("/api/conversations/:conversationId", asyncRoute(async (request, response) => {
    const session = await requireConversationOwner(request, request.params.conversationId);
    response.json(await travelConversationAgent.deleteConversation({ conversationId: request.params.conversationId, userId: session.userId }));
  }));
  app.post("/api/conversations/:conversationId/restore", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    try {
      response.json(await travelConversationAgent.restoreConversation({ conversationId: request.params.conversationId, userId: session.userId }));
    } catch (error) {
      if (error?.code === "conversation_not_found") throw httpError("conversation_not_found", 404, { conversationId: request.params.conversationId });
      if (error?.code === "conversation_access_denied") throw httpError("conversation_access_denied", 403, { conversationId: request.params.conversationId });
      throw error;
    }
  }));
  app.post("/api/conversations/:conversationId/messages", asyncRoute(async (request, response) => {
    const session = await requireConversationOwner(request, request.params.conversationId);
    // Legacy clients wait for the same durable run; there is no second Parent path.
    const run = await executionService.submit({ ...request.body, conversationId: request.params.conversationId, userId: session.userId, requestId: request.body?.requestId ?? randomUUID() });
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    response.on("close", disconnect);
    try {
      const finished = await executionService.wait({ runId: run.runId, userId: session.userId, signal: controller.signal });
      response.json(finished.result ?? { schemaVersion: "travel-conversation-turn-v1", status: finished.status,
        conversation: await travelConversationAgent.getConversation({ conversationId: run.conversationId, userId: session.userId }), activities: [], runId: run.runId });
    } finally { response.off("close", disconnect); }
  }));
  registerTravelExecutionRoutes({ app, asyncRoute, requireSession, requireConversationOwner, executionService });
  app.post("/api/visual-evidence/inspect", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await travelConversationAgent.inspectVisualEvidence({ userId: session.userId, text: request.body?.text, images: request.body?.images }));
  }));
  app.post("/api/trips", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.status(201).json(await travelService.createTrip({ ...request.body, ownerUserId: session.userId }));
  }));
  app.get("/api/trips/:tripId/control", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.getTripControlView(request.params.tripId));
  }));
  app.get("/api/trips/:tripId/plan", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.getTripPlanView(request.params.tripId));
  }));
  app.get("/api/trips/:tripId/evidence/nodes/:nodeId", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await evidenceCompanionService.presentationForNode({ tripId: request.params.tripId, nodeId: request.params.nodeId, targetLanguage: request.query.targetLanguage }));
  }));
  registerTravelJournalRoutes({ app, asyncRoute, requireTripMember, travelService, repository: journalRepository, clock });
  registerTravelRuntimeRoutes({ app, asyncRoute, requireTripMember, travelService });
  app.post("/api/trips/:tripId/evidence/resolve", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.status(201).json(await evidenceCompanionService.resolveShareLink({ tripId: request.params.tripId, nodeId: request.body?.nodeId ?? null, url: request.body?.url, targetLanguage: request.body?.targetLanguage }));
  }));
  app.get("/api/trips/:tripId/evidence/:bundleId", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await evidenceCompanionService.getBundle({ tripId: request.params.tripId, bundleId: request.params.bundleId }));
  }));
  app.post("/api/trips/:tripId/evidence/:bundleId/translate", asyncRoute(async (request, response) => {
    const session = await requireTripMember(request, request.params.tripId);
    response.json(await evidenceCompanionService.translateBundle({ tripId: request.params.tripId, bundleId: request.params.bundleId, targetLanguage: request.body?.targetLanguage, userId: session.userId }));
  }));
  app.post("/api/trips/:tripId/readiness", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.updateTripReadiness({ tripId: request.params.tripId, signalId: request.body?.signalId, status: request.body?.status }));
  }));
  app.get("/api/trips/:tripId/map", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    const map = await travelService.renderTripMap(request.params.tripId);
    response.setHeader("Content-Type", map.contentType);
    response.setHeader("Content-Length", String(map.body.length));
    response.status(200).send(map.body);
  }));
  app.get("/api/trips/:tripId/decisions", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.getOpenDecisions(request.params.tripId));
  }));
  app.post("/api/trips/:tripId/proposals", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.status(201).json(await travelService.proposeTripChange({ tripId: request.params.tripId, proposal: request.body?.proposal }));
  }));
  app.post("/api/trips/:tripId/proposals/:proposalId/accept", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.acceptTripChange({ tripId: request.params.tripId, proposalId: request.params.proposalId, selections: request.body?.selections, partial: request.body?.partial === true, previewId: request.body?.previewId, baseRevision: request.body?.baseRevision, routeModes: request.body?.routeModes }));
  }));
  app.post("/api/trips/:tripId/proposals/:proposalId/reject", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.rejectTripChange({ tripId: request.params.tripId, proposalId: request.params.proposalId }));
  }));
  app.post("/api/trips/:tripId/itinerary-trials/:proposalId/discard", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.discardItineraryTrial({ tripId: request.params.tripId, proposalId: request.params.proposalId, baseRevision: request.body?.baseRevision }));
  }));
  app.post("/api/trips/:tripId/mobility/refresh", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.json(await travelService.refreshTripMobility({ tripId: request.params.tripId }));
  }));
  app.post("/api/trips/:tripId/mobility/preview", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    try {
      response.json(await travelService.previewTripMobility({ tripId: request.params.tripId, baseRevision: request.body?.baseRevision, selections: request.body?.selections, previewId: request.body?.previewId, routeModes: request.body?.routeModes, signal: controller.signal }));
    } finally {
      request.off("aborted", abort);
    }
  }));
  app.get("/api/trips/:tripId/transit/:nodeId", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    const plan = await travelService.getTripPlanView(request.params.tripId);
    const match = plan.transitSegments.find((item) => item.nodeId === request.params.nodeId);
    if (!match) throw httpError("transit_segment_not_found", 404);
    response.json({ schemaVersion: "transit-segment-view-v1", tripId: request.params.tripId, revision: plan.revision, ...match });
  }));
  app.post("/api/trips/:tripId/feedback", asyncRoute(async (request, response) => {
    await requireTripMember(request, request.params.tripId);
    response.status(201).json(await travelService.submitTripFeedback({ ...request.body, tripId: request.params.tripId }));
  }));
  app.use(express.static(webRoot, { index: false, fallthrough: true, maxAge: 0 }));
  app.use(asyncRoute(async (request, response) => {
    if (request.path.startsWith("/api/")) throw httpError("api_route_not_found", 404);
    try {
      response.type("html").send(await readFile(resolve(webRoot, "index.html"), "utf8"));
    } catch {
      response.status(503).json({ status: "error", code: "web_build_unavailable", message: "Run npm run web:build before starting the production server." });
    }
  }));
  return app;
}
