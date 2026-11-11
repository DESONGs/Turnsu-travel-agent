import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidGrantError, InvalidClientError, InvalidScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const hash = value => createHash("sha256").update(String(value)).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SCOPES = ["travel:read", "travel:write"];
export const MCP_OAUTH_SQL = `CREATE TABLE IF NOT EXISTS travel_mcp_oauth_records (
  record_key TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, family_id TEXT,
  payload TEXT NOT NULL, expires_at BIGINT NOT NULL
); CREATE INDEX IF NOT EXISTS travel_mcp_oauth_family ON travel_mcp_oauth_records(family_id);
CREATE INDEX IF NOT EXISTS travel_mcp_oauth_expiry ON travel_mcp_oauth_records(expires_at);`;

/** Persistent OAuth grants share the account repository, never the trip state. */
export class TravelMcpOAuth {
  constructor({ repository, origin, redirectUris = [], clock = () => new Date(), development = false }) {
    this.repository = repository; this.origin = origin.replace(/\/$/, ""); this.resource = `${this.origin}/mcp`;
    this.clock = clock; this.development = development; this.skipLocalPkceValidation = true;
    this.redirectUris = new Set(redirectUris);
    this.ready = null;
    this.clientsStore = { getClient: id => this.get(`client:${id}`), registerClient: client => this.registerClient(client) };
  }
  now() { return this.clock().getTime(); }
  isRedirectAllowed(uri) {
    if(this.redirectUris.has(uri))return true;
    try { const requested=new URL(uri);
      // RFC 8252 varies only the port of an explicitly registered IP loopback
      // callback. Do not broaden hosts, paths, query strings or credentials.
      return [...this.redirectUris].some(value=>{const base=new URL(value);return base.protocol==='http:'&&['127.0.0.1','[::1]'].includes(base.hostname)&&!base.port&&!base.username&&!base.password&&!base.hash&&requested.protocol===base.protocol&&requested.hostname===base.hostname&&requested.pathname===base.pathname&&requested.search===base.search&&!requested.username&&!requested.password&&!requested.hash&&!!requested.port;});
    } catch { return false; }
  }
  async init() { await this.repository.migrate?.(); this.ready ??= this.repository.transaction(async db => { if(this.repository.mode==='postgres')await db.query('SELECT pg_advisory_xact_lock(715803127)');for (const sql of MCP_OAUTH_SQL.split(";").filter(s => s.trim())) await db.query(sql, []); }).catch(error=>{this.ready=null;throw error}); await this.ready; }
  async put(key, kind, value, ttl, { userId = null, family = null } = {}, db = null) {
    await this.init();
    const sql = "INSERT INTO travel_mcp_oauth_records(record_key,kind,user_id,family_id,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(record_key) DO UPDATE SET payload=$5,expires_at=$6";
    await (db ?? this.repository).query(sql, [key, kind, userId, family, JSON.stringify(value), this.now() + ttl]);
  }
  async get(key) {
    await this.init();
    const r = await this.repository.query("SELECT payload FROM travel_mcp_oauth_records WHERE record_key=$1 AND expires_at>$2", [key, this.now()]);
    return r.rows[0] ? JSON.parse(r.rows[0].payload) : undefined;
  }
  async consume(key, db = null) {
    await this.init();
    const r = await (db ?? this.repository).query("DELETE FROM travel_mcp_oauth_records WHERE record_key=$1 AND expires_at>$2 RETURNING payload", [key, this.now()]);
    return r.rows[0] ? JSON.parse(r.rows[0].payload) : undefined;
  }
  async registerClient(client) {
    if (!client.redirect_uris?.length || client.redirect_uris.some(uri => !this.isRedirectAllowed(String(uri)))) throw new InvalidClientError("redirect_uri_not_allowed");
    const registered = { ...client, client_id: `travel_${random()}`, client_id_issued_at: Math.floor(this.now() / 1000), token_endpoint_auth_method: "none" };
    await this.put(`client:${registered.client_id}`, "client", registered, 365 * 86400_000);
    return registered;
  }
  async authorize(client, params, response) {
    if (params.resource?.toString() !== this.resource || !params.codeChallenge || !client.redirect_uris.includes(params.redirectUri)) throw new InvalidGrantError("invalid_resource_or_redirect");
    const scopes = params.scopes?.length ? params.scopes : ["travel:read"];
    if (scopes.some(s => !SCOPES.includes(s))) throw new InvalidScopeError("scope_not_supported");
    const pending = random();
    await this.put(`pending:${hash(pending)}`, "pending", { clientId: client.client_id, clientName: client.client_name, redirectUri: params.redirectUri, state: params.state, codeChallenge: params.codeChallenge, scopes, resource: this.resource, csrf: random() }, 10 * 60_000);
    response.redirect(`${this.origin}/mcp/consent?request=${encodeURIComponent(pending)}`);
  }
  async approve(pending, session) {
    if (!session || session.provider === "guest") throw new InvalidGrantError("account_login_required");
    const value = await this.consume(`pending:${hash(pending)}`);
    if (!value) throw new InvalidGrantError("authorization_expired");
    const code = random();
    await this.put(`code:${hash(code)}`, "code", { ...value, userId: session.userId, displayName: session.displayName }, 120_000, { userId: session.userId });
    const callback = new URL(value.redirectUri); callback.searchParams.set("code", code);
    if (value.state) callback.searchParams.set("state", value.state);
    callback.searchParams.set("iss", new URL(this.origin).href);
    return callback.toString();
  }
  async challengeForAuthorizationCode(client, code) {
    const value = await this.get(`code:${hash(code)}`);
    if (!value || value.clientId !== client.client_id) throw new InvalidGrantError("authorization_code_invalid");
    return value.codeChallenge;
  }
  async exchangeAuthorizationCode(client, code, verifier, redirectUri, resource) {
    const value = await this.consume(`code:${hash(code)}`);
    const expected = value?.codeChallenge ?? "";
    const observed = verifier ? createHash("sha256").update(verifier).digest("base64url") : "";
    if (!value || value.clientId !== client.client_id || value.redirectUri !== redirectUri || resource?.toString() !== this.resource || expected.length !== observed.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(observed))) throw new InvalidGrantError("authorization_code_invalid");
    return this.issue(value, random());
  }
  async issue(value, family) {
    const access = `mcp_${random()}`, refresh = random();
    const record = { userId: value.userId, displayName: value.displayName, clientId: value.clientId, clientName: value.clientName, scopes: value.scopes, resource: this.resource, family, issuedAt: this.now() };
    await this.repository.transaction(async db => {
      await this.put(`access:${hash(access)}`, "access", record, 3600_000, { userId: value.userId, family }, db);
      await this.put(`refresh:${hash(refresh)}`, "refresh", record, 30 * 86400_000, { userId: value.userId, family }, db);
    });
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: value.scopes.join(" ") };
  }
  async exchangeRefreshToken(client, token, scopes, resource) {
    const value = await this.consume(`refresh:${hash(token)}`);
    if (!value || value.clientId !== client.client_id || (resource && resource.toString() !== this.resource) || scopes?.some(s => !value.scopes.includes(s))) throw new InvalidGrantError("refresh_token_invalid");
    await this.repository.query("DELETE FROM travel_mcp_oauth_records WHERE family_id=$1 AND kind='access'", [value.family]);
    return this.issue({ ...value, scopes: scopes?.length ? scopes : value.scopes }, value.family);
  }
  async verifyAccessToken(token) {
    const value = await this.get(`access:${hash(token)}`);
    if (!value || value.resource !== this.resource) throw new InvalidGrantError("access_token_invalid");
    return { token, clientId: value.clientId, scopes: value.scopes, expiresAt: Math.floor((value.issuedAt + 3600_000) / 1000), resource: new URL(this.resource), extra: { userId: value.userId } };
  }
  async session(token, write = false) {
    if (!String(token ?? "").startsWith("mcp_")) return null;
    const value = await this.get(`access:${hash(token)}`);
    if (!value || value.resource !== this.resource || !value.scopes.includes(write ? "travel:write" : "travel:read")) return null;
    return { userId: value.userId, displayName: value.displayName, provider: "mcp", sessionId: value.family, scopes: value.scopes, createdAt: new Date(value.issuedAt).toISOString() };
  }
  async revokeToken(client, { token }) {
    const value = await this.get(`access:${hash(token)}`) ?? await this.get(`refresh:${hash(token)}`);
    if (value?.clientId === client.client_id) await this.repository.query("DELETE FROM travel_mcp_oauth_records WHERE family_id=$1", [value.family]);
  }
  async connections(userId, currentFamily) {
    await this.init();
    const rows = await this.repository.query("SELECT payload,expires_at FROM travel_mcp_oauth_records WHERE kind='refresh' AND user_id=$1 AND expires_at>$2", [userId, this.now()]);
    return rows.rows.map(row => { const value = JSON.parse(row.payload); return { connectionId: value.family, name: value.clientName ?? "Travel Agent connector", scopes: value.scopes, connectedAt: new Date(value.issuedAt).toISOString(), expiresAt: new Date(Number(row.expires_at)).toISOString(), current: value.family === currentFamily }; });
  }
  async revokeConnection(userId, family) {
    await this.init();
    await this.repository.query("DELETE FROM travel_mcp_oauth_records WHERE family_id=$1 AND user_id=$2", [family, userId]);
  }
}

export function registerMcpOAuth({ app, oauth, currentSession, authService, asyncRoute }) {
  const options = { provider: oauth, issuerUrl: new URL(oauth.origin), resourceServerUrl: new URL(oauth.resource), scopesSupported: SCOPES, resourceName: "Travel Agent", serviceDocumentationUrl: new URL(`${oauth.origin}/`) };
  // The SDK creates some error callbacks itself. RFC 9207 also requires iss on
  // those validated redirects, not just on successful consent.
  app.use("/authorize", (_request, response, next) => {
    const redirect = response.redirect.bind(response);
    response.redirect = (statusOrUrl, maybeUrl) => {
      const status = typeof statusOrUrl === "number" ? statusOrUrl : 302;
      let target = typeof statusOrUrl === "number" ? maybeUrl : statusOrUrl;
      try { const url = new URL(target);const callback=new URL(target);for(const key of ['code','state','error','error_description','error_uri','iss'])callback.searchParams.delete(key);if (oauth.isRedirectAllowed(callback.href)) { url.searchParams.set("iss", new URL(oauth.origin).href); target = url.toString(); } } catch { /* Internal consent redirect has no external callback. */ }
      return redirect(status, target);
    };
    next();
  });
  app.get("/.well-known/oauth-authorization-server", (_request, response) => response.json({ ...createOAuthMetadata(options), authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"] }));
  app.use(mcpAuthRouter(options));
  app.get("/mcp/consent", asyncRoute(async (request, response) => {
    const pending = String(request.query.request ?? "");
    const value = await oauth.get(`pending:${hash(pending)}`);
    if (!value) return response.status(400).type("text").send("Authorization expired. Reconnect Travel Agent.");
    const session = await currentSession(request);
    const returnTo = `/mcp/consent?request=${encodeURIComponent(pending)}`;
    response.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!session || session.provider === "guest") {
      const providers = authService.providerSummary({ origin: oauth.origin }).providers.filter(p => p.available);
      return response.type("html").send(`<!doctype html><meta charset="utf-8"><title>Connect Travel Agent</title><main><h1>Connect your Travel Agent account</h1>${providers.map(p => `<p><a href="/api/auth/${escapeHtml(p.id)}/start?returnTo=${encodeURIComponent(returnTo)}">Sign in with ${escapeHtml(p.id)}</a></p>`).join("") || "<p>No production sign-in provider is configured.</p>"}</main>`);
    }
    response.cookie(`travel_mcp_csrf`, value.csrf, { httpOnly: true, secure: oauth.origin.startsWith("https:"), sameSite: "strict", path: "/mcp/consent", maxAge: 600_000 });
    response.type("html").send(`<!doctype html><meta charset="utf-8"><title>Connect Travel Agent</title><main><h1>Connect Travel Agent</h1><p>${escapeHtml(value.clientName ?? value.clientId)}</p><p>${escapeHtml(session.displayName ?? "Your account")} · ${escapeHtml(value.scopes.join(", "))}</p><form method="post"><input type="hidden" name="request" value="${escapeHtml(pending)}"><input type="hidden" name="csrf" value="${escapeHtml(value.csrf)}"><button name="decision" value="approve">Allow access</button><button name="decision" value="deny">Cancel</button></form></main>`);
  }));
  app.post("/mcp/consent", asyncRoute(async (request, response) => {
    const pending = String(request.body?.request ?? "");
    const value = await oauth.get(`pending:${hash(pending)}`);
    const cookie = String(request.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith("travel_mcp_csrf="))?.slice("travel_mcp_csrf=".length);
    if (!value || request.headers.origin !== oauth.origin || request.body?.csrf !== value.csrf || cookie !== value.csrf) return response.status(403).json({ code: "authorization_csrf_invalid" });
    const session = await currentSession(request);
    if (!session || session.provider === "guest") return response.status(401).json({ code: "account_login_required" });
    response.clearCookie("travel_mcp_csrf", { path: "/mcp/consent" });
    if (request.body.decision !== "approve") {
      await oauth.consume(`pending:${hash(pending)}`); const url = new URL(value.redirectUri); url.searchParams.set("error", "access_denied"); url.searchParams.set("iss", new URL(oauth.origin).href); if (value.state) url.searchParams.set("state", value.state); return response.redirect(url.toString());
    }
    response.redirect(await oauth.approve(pending, session));
  }));
}
