import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const fail = code => {
  throw Object.assign(new Error(code), {
    code
  });
};
const disconnected = 'travel-account-disconnected';
export const managedTokenRef = origin => `TRAVEL_AGENT_DSH_OAUTH_${createHash('sha256').update(new URL(origin).origin).digest('hex').slice(0, 12).toUpperCase()}`;
export function travelOrigin(raw, {
  development = false
} = {}) {
  const u = new URL(raw);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !(u.protocol === 'https:' || development && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) fail('invalid_travel_origin');
  return u.origin;
}

/** One cloud account per origin and private DSH credential store. Grants stay in its credential provider. */
export class DshTravelAuthorization {
  constructor({
    credentials,
    origin,
    callbackUrl,
    allowLoopback = true,
    fetchImpl = fetch,
    clock = Date.now
  }) {
    Object.assign(this, {
      credentials,
      origin,
      callbackUrl,
      allowLoopback,
      fetch: fetchImpl,
      clock
    });
    this.key = `turnsu-travel-agent/oauth-${createHash('sha256').update(origin).digest('hex').slice(0, 12)}`;
    this.tokenRef = managedTokenRef(origin);
    this.epoch = 0;
    this.closed = false;
    this.pending = null;
    this.refreshing = null;
    this.starting = null;
    this.completing = null;
    this.disconnecting = null;
    this.managedWrites = Promise.resolve();
    if (callbackUrl) {
      const u = new URL(callbackUrl);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/travel-agent/oauth/callback') fail('invalid_oauth_callback');
    }
  }
  async record() {
    const r = await this.credentials.readRecord(this.key);
    return r?.kind === 'grant' && r.payload?.schemaVersion === 'travel-dsh-oauth-v1' && r.payload.origin === this.origin ? r.payload : null;
  }
  async write(value) {
    await this.credentials.modifyRecord(this.key, async () => ({
      kind: 'grant',
      payload: {
        schemaVersion: 'travel-dsh-oauth-v1',
        origin: this.origin,
        ...value
      }
    }));
  }
  // Serialize reference writes as well as grant writes: an already-started provider write
  // must finish before a later disconnect can shadow ambient credential fallback.
  managed(value, epoch = this.epoch) {
    const task = this.managedWrites.then(() => {
      if (epoch === this.epoch && (value === disconnected || !this.closed)) return this.credentials.set(this.tokenRef, value);
    });
    this.managedWrites = task.catch(() => {});
    return task;
  }
  async publicStatus() {
    const r = await this.record();
    return {
      connected: !!r?.tokens && r.status === 'connected',
      state: r?.status ?? (this.pending ? 'authorizing' : 'disconnected'),
      authorizing: !!this.pending,
      origin: this.origin,
      expiresAt: r?.tokens?.expiresAt ?? null
    };
  }
  async json(path, body) {
    let response;
    try {
      response = await this.fetch(new URL(path, this.origin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      return fail('travel_authorization_unavailable');
    }
    const v = await response.json().catch(() => ({}));
    if (!response.ok) return fail(response.status === 400 && v.error === 'invalid_grant' ? 'travel_authorization_expired' : 'travel_authorization_unavailable');
    return v;
  }
  async token(body) {
    let response;
    try {
      response = await this.fetch(new URL('/token', this.origin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      return fail('travel_authorization_unavailable');
    }
    const v = await response.json().catch(() => ({}));
    if (!response.ok) return fail(v.error === 'invalid_grant' ? 'travel_authorization_expired' : 'travel_authorization_unavailable');
    if (typeof v.access_token !== 'string' || !/^mcp_[A-Za-z0-9_-]{43}$/.test(v.access_token) || typeof v.refresh_token !== 'string' || !Number.isFinite(v.expires_in) || v.expires_in <= 0 || v.expires_in > 86400) return fail('invalid_travel_token_response');
    return {
      accessToken: v.access_token,
      refreshToken: v.refresh_token,
      expiresAt: this.clock() + v.expires_in * 1000
    };
  }
  async accessToken() {
    if (this.closed) return fail('travel_connection_closed');
    const epoch = this.epoch;
    const record = await this.record();
    if (epoch !== this.epoch || record?.status !== 'connected' || !record.tokens) return fail('travel_authentication_required');
    if (record.tokens.expiresAt > this.clock() + 60000) return record.tokens.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let token;
      await this.credentials.modifyRecord(this.key, async current => {
        const r = current?.payload;
        if (this.closed || epoch !== this.epoch || r?.status !== 'connected') return fail('travel_authentication_required');
        if (r.tokens.expiresAt > this.clock() + 60000) {
          token = r.tokens.accessToken;
          return undefined;
        }
        try {
          const next = await this.token({
            grant_type: 'refresh_token',
            refresh_token: r.tokens.refreshToken,
            client_id: r.client.client_id,
            resource: `${this.origin}/mcp`
          });
          token = next.accessToken;
          // A rotated token must be saved even during unload/disconnect. The old refresh
          // token is already invalid; disconnect waits for this write before revoking it.
          return {
            kind: 'grant',
            payload: {
              ...r,
              tokens: next
            }
          };
        } catch (error) {
          return {
            kind: 'grant',
            payload: {
              ...r,
              status: error.code === 'travel_authorization_expired' ? 'reauthorize' : 'refresh_unknown'
            }
          };
        }
      });
      if (!token || this.closed || epoch !== this.epoch) {
        await this.managed(disconnected, epoch);
        return fail('travel_authentication_required');
      }
      await this.managed(token, epoch);
      if (this.closed || epoch !== this.epoch) return fail('travel_authentication_required');
      return token;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async sync() {
    const epoch = this.epoch;
    try {
      await this.managed(await this.accessToken(), epoch);
    } catch {
      await this.managed(disconnected, epoch);
    }
  }
  async cancel() {
    const epoch = ++this.epoch;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending?.timer);
    await this.closeListener(pending);
    await this.completing?.catch(() => {});
    // Completion performs grant cleanup first. The sentinel is always the final ref write.
    if (pending) await this.managed(disconnected, epoch);
    return epoch;
  }
  async closeListener(pending) {
    const s = pending?.listener;
    if (s) {
      pending.listener = null;
      s.closeAllConnections();
      await new Promise(r => s.close(r));
    }
  }
  start() {
    if (this.starting) return this.starting;
    this.starting = this.begin().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async begin() {
    await this.disconnecting;
    if (this.closed) return fail('travel_connection_closed');
    const r = await this.record();
    if (r?.status === 'connected') return fail('travel_already_connected');
    if (r?.status === 'revocation_pending') return fail('travel_revocation_pending');
    const epoch = await this.cancel();
    if (epoch !== this.epoch || this.closed) return fail('travel_authorization_cancelled');
    const pending = {
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      epoch,
      expiresAt: this.clock() + 600000
    };
    this.pending = pending;
    try {
      let callback = this.callbackUrl;
      if (!callback) {
        if (!this.allowLoopback) return fail('travel_callback_configuration_required');
        const server = createServer((req, res) => {
          void this.httpCallback(req, res);
        });
        pending.listener = server;
        await new Promise((r, j) => {
          server.once('error', j);
          server.listen(0, '127.0.0.1', r);
        });
        server.unref();
        if (this.pending !== pending || this.closed) {
          await this.closeListener(pending);
          return fail('travel_authorization_cancelled');
        }
        callback = `http://127.0.0.1:${server.address().port}/callback`;
      }
      pending.callback = callback;
      const old = await this.record();
      let client = old?.client;
      if (!client?.redirect_uris?.includes(callback)) client = await this.json('/register', {
        client_name: 'Travel Agent for DSH',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      });
      if (!client?.client_id || this.pending !== pending || this.closed) return fail('travel_authorization_cancelled');
      pending.client = client;
      pending.timer = setTimeout(() => {
        if (this.pending === pending) void this.cancel();
      }, 600000);
      pending.timer.unref();
      const url = new URL('/authorize', this.origin);
      for (const [k, v] of Object.entries({
        client_id: client.client_id,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'travel:read travel:write',
        state: pending.state,
        code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: `${this.origin}/mcp`
      })) url.searchParams.set(k, v);
      return {
        authorizationUrl: url.href,
        callbackOrigin: new URL(callback).origin,
        expiresAt: pending.expiresAt
      };
    } catch (e) {
      if (this.pending === pending) await this.cancel();
      throw e;
    }
  }
  complete(url) {
    const p = this.pending;
    const state = url.searchParams.get('state') ?? '';
    if (!p || p.completing || p.expiresAt < this.clock() || Buffer.byteLength(state) !== Buffer.byteLength(p.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(p.state))) return Promise.reject(Object.assign(new Error('invalid_travel_authorization_state'), {
      code: 'invalid_travel_authorization_state'
    }));
    if (url.searchParams.get('error')) return this.cancel().then(() => fail('travel_authorization_denied'));
    if (url.searchParams.get('iss') !== new URL(this.origin).href || !url.searchParams.get('code')) return Promise.reject(Object.assign(new Error('invalid_travel_authorization_response'), {
      code: 'invalid_travel_authorization_response'
    }));
    const valid = () => this.pending === p && !this.closed && p.epoch === this.epoch;
    p.completing = (async () => {
      let tokens;
      try {
        tokens = await this.token({
          grant_type: 'authorization_code',
          code: url.searchParams.get('code'),
          code_verifier: p.verifier,
          redirect_uri: p.callback,
          client_id: p.client.client_id,
          resource: `${this.origin}/mcp`
        });
        if (!valid()) return fail('travel_authorization_cancelled');
        await this.write({
          status: 'connected',
          client: p.client,
          tokens
        });
        if (!valid()) return fail('travel_authorization_cancelled');
        await this.managed(tokens.accessToken, p.epoch);
        if (!valid()) return fail('travel_authorization_cancelled');
        this.pending = null;
        clearTimeout(p.timer);
      } catch (error) {
        if (tokens) {
          // A cancelled callback can still have exchanged a one-use code. Revoke the
          // issued grant; retain an explicit pending receipt when acknowledgement is lost.
          await this.write({
            status: 'revocation_pending',
            client: p.client,
            tokens
          });
          try {
            await this.json('/revoke', {
              token: tokens.accessToken,
              client_id: p.client.client_id
            });
            await this.credentials.deleteRecord(this.key);
          } catch {/* Retry via disconnect. */}
        }
        throw error;
      }
    })().finally(() => {
      if (this.completing === p.completing) this.completing = null;
    });
    this.completing = p.completing;
    return p.completing;
  }
  async httpCallback(req, res) {
    const path = new URL(req.url, 'http://callback.invalid');
    if (req.method !== 'GET' || !['/callback', '/travel-agent/oauth/callback'].includes(path.pathname)) {
      res.writeHead(404).end();
      return;
    }
    const pending = this.pending;
    let success = false;
    try {
      await this.complete(path);
      success = true;
    } catch {/* Never reflect code, state, credentials or provider bodies. */}
    res.writeHead(success ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>旅行账户连接</title><style>body{font:16px system-ui;max-width:480px;margin:15vh auto;padding:24px;color:#17191c}button{padding:12px 18px;border:0;border-radius:8px;background:#c9443b;color:white}</style><h1>${success ? '旅行账户已连接' : '这次连接未完成'}</h1><p>${success ? '返回 DSH 即可继续这趟旅行。' : '请返回 DSH 重试。原有旅行会保留。'}</p><button onclick="window.close()">关闭此页</button><script>history.replaceState(null,'',location.pathname)</script>`);
    if (success && pending?.listener) {
      const s = pending.listener;
      pending.listener = null;
      setImmediate(() => {
        s.close();
        s.closeIdleConnections();
      });
    }
  }
  disconnect() {
    if (this.disconnecting) return this.disconnecting;
    this.disconnecting = this.revoke().finally(() => {
      this.disconnecting = null;
    });
    return this.disconnecting;
  }
  async revoke() {
    const epoch = await this.cancel();
    await this.refreshing?.catch(() => {});
    await this.managed(disconnected, epoch);
    const r = await this.record();
    if (!r?.tokens) {
      await this.credentials.deleteRecord(this.key);
      return {
        state: 'disconnected'
      };
    }
    await this.write({
      ...r,
      status: 'revocation_pending'
    });
    try {
      await this.json('/revoke', {
        token: r.tokens.accessToken,
        client_id: r.client.client_id
      });
      await this.credentials.deleteRecord(this.key);
      return {
        state: 'disconnected'
      };
    } catch {
      return {
        state: 'revocation_pending'
      };
    }
  }
  async dispose() {
    this.closed = true;
    const epoch = await this.cancel();
    await this.refreshing?.catch(() => {});
    await this.managed(disconnected, epoch);
  }
}
