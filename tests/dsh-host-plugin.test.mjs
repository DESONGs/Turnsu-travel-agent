import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthRepository } from '../src/persistence/auth-repository.mjs';
import { AccountService } from '../src/http/account-service.mjs';
import { createHttpApp } from '../src/http/app.mjs';
import { createTravelService } from '../src/api/create-travel-service.mjs';
import { DshTravelAuthorization } from '../src/hosts/dsh/oauth.mjs';
import { createDshTravelHost } from '../src/hosts/dsh/server.mjs';
/** Test boundary for a DSH credential provider; no values leave status/RPC results. */
class Credentials {
  records = new Map();
  refs = new Map();
  tails = new Map();
  hook = null;
  async readRecord(k) {
    return structuredClone(this.records.get(k));
  }
  async modifyRecord(k, f) {
    const task = (this.tails.get(k) ?? Promise.resolve()).then(async () => {
      const v = await f(await this.readRecord(k));
      if (v !== undefined) {
        await this.hook?.(k, v);
        this.records.set(k, structuredClone(v));
      }
      return this.readRecord(k);
    });
    this.tails.set(k, task.catch(() => {}));
    return task;
  }
  async deleteRecord(k) {
    this.records.delete(k);
  }
  async set(k, v) {
    this.refs.set(k, v);
  }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'travel-dsh-native-host-'));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = createTravelService({
    TRAVEL_AGENT_DATA_DIR: root,
    TRAVEL_AGENT_OPEN_METEO_ENABLED: 'false'
  }, {
    researchProvider: null,
    analysisFanout: false
  });
  const accountService = new AccountService({
    repository: new AuthRepository({
      filename: ':memory:'
    })
  });
  const app = createHttpApp({
    travelService: service,
    accountService,
    allowedOrigins: new Set([origin]),
    runtimeEnv: {
      NODE_ENV: 'test',
      TRAVEL_AGENT_PUBLIC_ORIGIN: origin,
      TRAVEL_AGENT_DATA_DIR: root,
      TRAVEL_AGENT_MCP_REDIRECT_URIS: 'http://127.0.0.1/callback',
      TRAVEL_AGENT_EXECUTION_ROLE: 'api'
    }
  });
  server.on('request', app);
  const credentials = new Credentials();
  const auth = new DshTravelAuthorization({
    credentials,
    origin
  });
  t.after(async () => {
    await auth.dispose();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await app.locals.close();
    await accountService.repository.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  });
  const approve = async start => {
    const u = new URL(start.authorizationUrl),
      client = await app.locals.mcpOAuth.clientsStore.getClient(u.searchParams.get('client_id'));
    let consent;
    await app.locals.mcpOAuth.authorize(client, {
      redirectUri: u.searchParams.get('redirect_uri'),
      codeChallenge: u.searchParams.get('code_challenge'),
      resource: new URL(u.searchParams.get('resource')),
      scopes: u.searchParams.get('scope').split(' '),
      state: u.searchParams.get('state')
    }, {
      redirect: v => {
        consent = v;
      }
    });
    return new URL(await app.locals.mcpOAuth.approve(new URL(consent).searchParams.get('request'), {
      userId: 'native-owner',
      displayName: 'Controlled traveler',
      provider: 'google'
    }));
  };
  return {
    app,
    auth,
    credentials,
    origin,
    approve,
    accountService
  };
}
test('native DSH one-click OAuth uses real PKCE callbacks, persists refresh and exposes no grant in public status', async t => {
  const f = await fixture(t);
  const start = await f.auth.start();
  const callback = await f.approve(start);
  assert.equal((await fetch(callback)).status, 200);
  const status = await f.auth.publicStatus();
  assert.equal(status.connected, true);
  assert.doesNotMatch(JSON.stringify(status), /mcp_|refreshToken|accessToken|code_verifier/);
  const old = await f.auth.accessToken();
  await f.credentials.modifyRecord(f.auth.key, async r => ({
    ...r,
    payload: {
      ...r.payload,
      tokens: {
        ...r.payload.tokens,
        expiresAt: Date.now() - 1
      }
    }
  }));
  const [a, b] = await Promise.all([f.auth.accessToken(), f.auth.accessToken()]);
  assert.equal(a, b);
  assert.notEqual(a, old);
  assert.equal(await f.app.locals.mcpOAuth.session(old), null);
  assert.equal((await f.app.locals.mcpOAuth.session(a)).userId, 'native-owner');
  const restarted = new DshTravelAuthorization({
    credentials: f.credentials,
    origin: f.origin
  });
  assert.equal(await restarted.accessToken(), a);
  await restarted.dispose();
  const result = await f.auth.disconnect();
  assert.equal(result.state, 'disconnected');
  assert.equal(await f.app.locals.mcpOAuth.session(a), null);
  assert.equal((await f.auth.publicStatus()).connected, false);
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), 'travel-account-disconnected');
});
test('a cancelled or mismatched callback cannot connect a native host', async t => {
  const f = await fixture(t);
  const start = await f.auth.start();
  const callback = await f.approve(start);
  const wrong = new URL(callback);
  wrong.searchParams.set('iss', 'https://other.example');
  await assert.rejects(f.auth.complete(wrong), {
    code: 'invalid_travel_authorization_response'
  });
  assert.equal((await f.auth.publicStatus()).connected, false);
  await f.auth.cancel();
  await assert.rejects(f.auth.complete(callback), {
    code: 'invalid_travel_authorization_state'
  });
  assert.equal((await f.auth.publicStatus()).connected, false);
});
test('cancelling during credential persistence prevents a late grant from reconnecting the host', async t => {
  const f = await fixture(t);
  const callback = await f.approve(await f.auth.start());
  let release, entered;
  const gate = new Promise(r => {
      release = r;
    }),
    waiting = new Promise(r => {
      entered = r;
    });
  f.credentials.hook = async (_k, v) => {
    if (v.payload.status === 'connected') {
      entered();
      await gate;
    }
  };
  const completion = f.auth.complete(callback);
  await waiting;
  const cancelled = f.auth.cancel();
  release();
  await assert.rejects(completion);
  await cancelled;
  assert.equal((await f.auth.publicStatus()).connected, false);
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), 'travel-account-disconnected');
});
test('native host RPC rejects non-owner peers and arbitrary operations, shares the real cloud workspace and injects context without waking', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(await f.approve(await f.auth.start()))).status, 200);
  const injected = [],
    followups = [];
  let nativeActive = false,
    resumed = 0;
  const agent = {
    id: 'native-session',
    session: {
      deriveMessages: () => []
    },
    inject: m => injected.push(m),
    followup: m => followups.push(m)
  };
  let registered, registeredRoute;
  const ctx = {
    credentials: f.credentials,
    connection: {
      allowsRemoteAuthorities: false,
      fetch: {
        register: route => {
          registeredRoute = route;
          assert.equal(route.path, '/api/travel-agent/dispatch');
          return async () => {};
        }
      }
    },
    agents: {
      get: id => nativeActive && id === agent.id ? agent : undefined
    },
    sessionController: {
      resolveAgent: async id => {
        if (!nativeActive) resumed++;
        nativeActive = true;
        return id === agent.id ? {
          agent
        } : {
          error: {
            code: 'session/not-found'
          }
        };
      }
    },
    sessions: {
      flush: async () => true
    }
  };
  const host = createDshTravelHost(ctx, {
    origin: f.origin,
    development: true
  }, {
    readWorkspace: async () => '<main>Shared app</main>'
  });
  registered = host.rpc;
  t.after(() => host.dispose());
  const owner = {
      principal: {
        kind: 'owner'
      }
    },
    signal = new AbortController().signal;
  assert.equal((await registered('status', {}, signal, {
    principal: {
      kind: 'guest'
    }
  })).error.code, 'travel_host_owner_required');
  assert.equal((await registered('tool', {
    name: 'shell',
    arguments: {}
  }, signal, owner)).error.code, 'travel_operation_not_allowed');
  assert.equal((await registered('tool', {
    name: 'travel_app_action',
    arguments: {
      action: 'arbitrary_url',
      args: {
        url: 'https://evil.example'
      }
    }
  }, signal, owner)).ok, false);
  const envelope = await registeredRoute.fetch(new Request('http://native.example/api/travel-agent/dispatch', {
    method: 'POST',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'native-1',
      method: 'travel-agent/dispatch',
      payload: {
        endpoint: 'status',
        payload: {}
      }
    })
  }));
  assert.equal((await envelope.json()).result.value.connected, true);
  const call = async (action, args = {}, body) => {
    const r = await registered('tool', {
      name: 'travel_app_action',
      arguments: {
        action,
        args,
        body
      }
    }, signal, owner);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.value.structuredContent, { status: "completed" });
    return r.value._meta["travel/uiData"];
  };
  const created = await call('createConversation', {}, {});
  await registered('context', {
    sessionId: agent.id,
    context: {
      conversationId: created.conversationId,
      tripId: 'forged',
      revision: 999
    }
  }, signal, owner);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source.kind, 'travel-canvas');
  assert.equal(resumed, 1);
  assert.equal(followups.length, 0);
  assert.doesNotMatch(JSON.stringify(injected), /forged|999|mcp_/);
  await registered('context', {
    sessionId: agent.id,
    context: {
      conversationId: created.conversationId
    }
  }, signal, owner);
  assert.equal(injected.length, 1);
  assert.equal(resumed, 1);
  assert.equal((await registered('message', {
    sessionId: agent.id,
    text: '继续这趟旅行'
  }, signal, owner)).ok, true);
  assert.equal(followups.length, 1);
  assert.equal((await call('listConversations')).conversations[0].conversationId, created.conversationId);
});
test('disconnect waits for refresh persistence and revokes the rotated grant without a late credential ref', async t => {
  const f = await fixture(t);
  await f.auth.complete(await f.approve(await f.auth.start()));
  const old = await f.auth.accessToken();
  await f.credentials.modifyRecord(f.auth.key, async r => ({
    ...r,
    payload: {
      ...r.payload,
      tokens: {
        ...r.payload.tokens,
        expiresAt: 0
      }
    }
  }));
  let release, entered;
  const gate = new Promise(r => {
      release = r;
    }),
    waiting = new Promise(r => {
      entered = r;
    });
  f.credentials.hook = async (_k, v) => {
    if (v.payload.status === 'connected') {
      entered();
      await gate;
    }
  };
  const refresh = f.auth.accessToken();
  const rejection = assert.rejects(refresh, {
    code: 'travel_authentication_required'
  });
  await waiting;
  const disconnect = f.auth.disconnect();
  release();
  await rejection;
  assert.equal((await disconnect).state, 'disconnected');
  assert.equal(await f.app.locals.mcpOAuth.session(old), null);
  assert.equal((await f.auth.publicStatus()).connected, false);
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), 'travel-account-disconnected');
});
test('plugin unload during refresh preserves the rotated private grant for a new instance', async t => {
  const f = await fixture(t);
  await f.auth.complete(await f.approve(await f.auth.start()));
  const old = await f.auth.accessToken();
  await f.credentials.modifyRecord(f.auth.key, async r => ({
    ...r,
    payload: {
      ...r.payload,
      tokens: {
        ...r.payload.tokens,
        expiresAt: 0
      }
    }
  }));
  let release, entered;
  const gate = new Promise(r => {
      release = r;
    }),
    waiting = new Promise(r => {
      entered = r;
    });
  f.credentials.hook = async (_k, v) => {
    if (v.payload.status === 'connected') {
      entered();
      await gate;
    }
  };
  const refresh = f.auth.accessToken();
  const rejection = assert.rejects(refresh, {
    code: 'travel_authentication_required'
  });
  await waiting;
  const unload = f.auth.dispose();
  release();
  await rejection;
  await unload;
  f.credentials.hook = null;
  const restarted = new DshTravelAuthorization({
    credentials: f.credentials,
    origin: f.origin
  });
  t.after(() => restarted.dispose());
  const token = await restarted.accessToken();
  assert.notEqual(token, old);
  assert.equal((await f.app.locals.mcpOAuth.session(token)).userId, 'native-owner');
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), 'travel-account-disconnected');
});
test('a queued managed credential write cannot overtake disconnect', async t => {
  const f = await fixture(t);
  await f.auth.complete(await f.approve(await f.auth.start()));
  let release, entered;
  const gate = new Promise(r => {
      release = r;
    }),
    waiting = new Promise(r => {
      entered = r;
    });
  const set = f.credentials.set.bind(f.credentials);
  f.credentials.set = async (k, v) => {
    if (v.startsWith('mcp_')) {
      entered();
      await gate;
    }
    await set(k, v);
  };
  const sync = f.auth.sync();
  await waiting;
  const disconnect = f.auth.disconnect();
  release();
  await sync;
  await disconnect;
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), 'travel-account-disconnected');
});
test('remote DSH connections require a configured HTTPS OAuth callback', async t => {
  const f = await fixture(t);
  const remote = new DshTravelAuthorization({
    credentials: f.credentials,
    origin: f.origin,
    allowLoopback: false
  });
  t.after(() => remote.dispose());
  await assert.rejects(remote.start(), {
    code: 'travel_callback_configuration_required'
  });
  assert.throws(() => new DshTravelAuthorization({
    credentials: f.credentials,
    origin: f.origin,
    callbackUrl: 'http://example.test/travel-agent/oauth/callback'
  }), {
    code: 'invalid_oauth_callback'
  });
});
test('browser consent permits only its registered callback origin and completes the real form POST', async t => {
  const f = await fixture(t);
  const start = await f.auth.start();
  const grant = await f.accountService.issue({
    userId: 'native-owner',
    provider: 'google'
  });
  const cookie = `travel_session=${grant.opaqueToken}`;
  const redirect = await fetch(start.authorizationUrl, {
    redirect: 'manual'
  });
  assert.equal(redirect.status, 302);
  const consent = redirect.headers.get('location');
  const page = await fetch(consent, {
    headers: {
      Cookie: cookie
    }
  });
  assert.equal(page.status, 200);
  const policy = page.headers.get('content-security-policy');
  assert.ok(policy.includes(`form-action 'self' ${start.callbackOrigin};`));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(!policy.includes('https://other.example'));
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1],
    pending = new URL(consent).searchParams.get('request');
  const csrfCookie = page.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(consent, {
    method: 'POST',
    headers: {
      Cookie: `${cookie}; ${csrfCookie}`,
      Origin: 'https://other.example',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      request: pending,
      csrf,
      decision: 'approve'
    }),
    redirect: 'manual'
  });
  assert.equal(denied.status, 403);
  const approved = await fetch(consent, {
    method: 'POST',
    headers: {
      Cookie: `${cookie}; ${csrfCookie}`,
      Origin: f.origin,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      request: pending,
      csrf,
      decision: 'approve'
    }),
    redirect: 'manual'
  });
  assert.equal(approved.status, 302);
  assert.equal(new URL(approved.headers.get('location')).origin, start.callbackOrigin);
  assert.equal((await fetch(approved.headers.get('location'))).status, 200);
  assert.equal((await f.auth.publicStatus()).connected, true);
});

test("another service origin cannot overwrite this host's managed MCP credential", async t => {
  const f = await fixture(t);
  await f.auth.complete(await f.approve(await f.auth.start()));
  const token = await f.auth.accessToken();
  const other = new DshTravelAuthorization({ credentials: f.credentials, origin: 'https://other.example' });
  t.after(() => other.dispose());
  await other.sync();
  assert.notEqual(other.tokenRef, f.auth.tokenRef);
  assert.equal(f.credentials.refs.get(f.auth.tokenRef), token);
  assert.equal(f.credentials.refs.get(other.tokenRef), 'travel-account-disconnected');
});
