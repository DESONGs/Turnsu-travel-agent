import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authenticatedUserId, AUTH_PROVIDERS, DESKTOP_AUTH_CODE_TTL_MS } from "./session.mjs";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const iso = (value) => new Date(Number(value)).toISOString();
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const display = (value) => String(value ?? "").trim().slice(0, 120) || null;

export function sessionDevice(request) {
  const agent = String(request.headers["user-agent"] ?? "");
  const client = request.headers["x-travel-client"];
  if (client === "desktop") return "Desktop app";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows" : /Macintosh|Mac OS/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "Device";
  const browser = /MicroMessenger/.test(agent) ? "WeChat" : /AlipayClient/.test(agent) ? "Alipay" : /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "Browser";
  return `${browser} · ${system}`;
}

export class AccountService {
  constructor({ repository, clock = () => new Date() }) { this.repository = repository; this.clock = clock; }
  now() { return this.clock().getTime(); }

  async ensureUser(connection, userId, displayName) {
    await connection.query("INSERT INTO travel_auth_users (user_id, display_name, created_at) VALUES ($1,$2,$3) ON CONFLICT(user_id) DO NOTHING", [userId, display(displayName), this.now()]);
  }

  async resolveIdentity(identity) {
    const legacyId = authenticatedUserId(identity);
    return this.repository.transaction(async (db) => {
      const existing = await db.query("SELECT user_id FROM travel_auth_identities WHERE provider=$1 AND subject=$2", [identity.provider, identity.subject]);
      if (existing.rowCount) return existing.rows[0].user_id;
      await this.ensureUser(db, legacyId, identity.displayName);
      await db.query("INSERT INTO travel_auth_identities (identity_id,user_id,provider,subject,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(provider,subject) DO NOTHING", [randomUUID(), legacyId, identity.provider, identity.subject, this.now()]);
      const result = await db.query("SELECT user_id FROM travel_auth_identities WHERE provider=$1 AND subject=$2", [identity.provider, identity.subject]);
      return result.rows[0].user_id;
    });
  }

  async issue({ userId, provider, displayName = null, ttlMs = SESSION_TTL_MS, device = "Browser" }) {
    if (!AUTH_PROVIDERS.includes(provider) || !userId || !Number.isFinite(ttlMs) || ttlMs <= 0) fail("invalid_session");
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const now = this.now();
    const expires = now + ttlMs;
    await this.repository.transaction(async (db) => {
      await this.ensureUser(db, userId, displayName);
      await db.query("INSERT INTO travel_auth_sessions (session_id,token_hash,user_id,provider,device,created_at,last_seen_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)", [sessionId, hash(token), userId, provider, String(device).slice(0, 100), now, expires]);
      await db.query("DELETE FROM travel_auth_sessions WHERE expires_at<=$1", [now]);
    });
    return { opaqueToken: token, expiresAt: iso(expires), sessionId };
  }

  async read(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now();
    const result = await this.repository.query("SELECT s.*,u.display_name FROM travel_auth_sessions s JOIN travel_auth_users u ON s.user_id=u.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2", [hash(token), now]);
    const row = result.rows[0];
    if (!row) return null;
    if (now - Number(row.last_seen_at) >= 60_000) await this.repository.query("UPDATE travel_auth_sessions SET last_seen_at=$1 WHERE session_id=$2 AND revoked_at IS NULL", [now, row.session_id]);
    return { sessionId: row.session_id, userId: row.user_id, provider: row.provider, displayName: row.display_name, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) };
  }

  async revoke(token) {
    if (!token) return;
    await this.repository.query("UPDATE travel_auth_sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL", [this.now(), hash(token)]);
  }

  async listSessions(userId, currentId) {
    const result = await this.repository.query("SELECT session_id,provider,device,created_at,last_seen_at,expires_at FROM travel_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY last_seen_at DESC", [userId, this.now()]);
    return result.rows.map((row) => ({ sessionId: row.session_id, provider: row.provider, device: row.device, current: row.session_id === currentId, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at), expiresAt: iso(row.expires_at) }));
  }

  async revokeSession(userId, sessionId) {
    const result = await this.repository.query("UPDATE travel_auth_sessions SET revoked_at=$1 WHERE user_id=$2 AND session_id=$3 AND revoked_at IS NULL RETURNING session_id", [this.now(), userId, sessionId]);
    if (!result.rowCount) fail("session_not_found", 404);
  }

  async revokeOthers(userId, currentId) {
    await this.repository.query("UPDATE travel_auth_sessions SET revoked_at=$1 WHERE user_id=$2 AND session_id<>$3 AND revoked_at IS NULL", [this.now(), userId, currentId]);
  }

  async identities(userId) {
    const result = await this.repository.query("SELECT identity_id,provider,created_at FROM travel_auth_identities WHERE user_id=$1 ORDER BY created_at", [userId]);
    return result.rows.map((row) => ({ id: row.identity_id, provider: row.provider, linkedAt: iso(row.created_at) }));
  }

  async linkIdentity(session, identity) {
    return this.repository.transaction(async (db) => {
      // Lock the owning account, then recheck the initiating session. Revoked
      // linking requests must never change account membership.
      await db.query("SELECT user_id FROM travel_auth_users WHERE user_id=$1 FOR UPDATE", [session.userId]);
      const active = await db.query("SELECT session_id FROM travel_auth_sessions WHERE session_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3", [session.sessionId, session.userId, this.now()]);
      if (!active.rowCount) fail("authentication_required", 401);
      await db.query("INSERT INTO travel_auth_identities (identity_id,user_id,provider,subject,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(provider,subject) DO NOTHING", [randomUUID(), session.userId, identity.provider, identity.subject, this.now()]);
      const existing = await db.query("SELECT user_id FROM travel_auth_identities WHERE provider=$1 AND subject=$2", [identity.provider, identity.subject]);
      if (existing.rows[0].user_id !== session.userId) fail("identity_already_linked", 409);
    });
  }

  async unlinkIdentity(session, identityId) {
    await this.repository.transaction(async (db) => {
      await db.query("SELECT user_id FROM travel_auth_users WHERE user_id=$1 FOR UPDATE", [session.userId]);
      const result = await db.query("SELECT identity_id,provider FROM travel_auth_identities WHERE user_id=$1", [session.userId]);
      const identity = result.rows.find((row) => row.identity_id === identityId);
      if (!identity) fail("identity_not_found", 404);
      if (result.rows.length <= 1) fail("last_login_method_required", 409);
      if (identity.provider === session.provider) fail("current_login_method_required", 409);
      await db.query("DELETE FROM travel_auth_identities WHERE identity_id=$1 AND user_id=$2", [identityId, session.userId]);
      await db.query("UPDATE travel_auth_sessions SET revoked_at=$1 WHERE user_id=$2 AND provider=$3 AND revoked_at IS NULL", [this.now(), session.userId, identity.provider]);
    });
  }

  async updateProfile(userId, name) {
    const value = display(name);
    if (!value || String(name).trim().length > 80) fail("invalid_display_name");
    await this.repository.query("UPDATE travel_auth_users SET display_name=$1 WHERE user_id=$2", [value, userId]);
  }

  async issueChallenge(kind, payload, ttlMs = DESKTOP_AUTH_CODE_TTL_MS) {
    const code = randomBytes(32).toString("base64url");
    const expires = this.now() + ttlMs;
    await this.repository.transaction(async (db) => {
      await db.query("DELETE FROM travel_auth_challenges WHERE expires_at<=$1", [this.now()]);
      await db.query("INSERT INTO travel_auth_challenges (code_hash,kind,payload,expires_at) VALUES ($1,$2,$3,$4)", [hash(code), kind, JSON.stringify(payload), expires]);
    });
    return { code, expiresAt: iso(expires) };
  }

  async consumeChallenge(kind, code) {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const result = await this.repository.query("DELETE FROM travel_auth_challenges WHERE code_hash=$1 AND kind=$2 AND expires_at>$3 RETURNING payload,expires_at", [hash(code), kind, this.now()]);
    if (!result.rowCount) return null;
    return { ...JSON.parse(result.rows[0].payload), expiresAt: iso(result.rows[0].expires_at) };
  }
}
