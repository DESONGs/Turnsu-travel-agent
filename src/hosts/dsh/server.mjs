import { readFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createBackendClient } from '../../mcp/backend-client.mjs';
import { travelOperation } from '../../mcp/operations.ts';
import { DshTravelAuthorization, travelOrigin } from './oauth.mjs';
export const name = 'turnsu-travel-agent';
export const inject = ['credentials', 'connection', 'webServer', 'sessions', 'sessionController'];
const fail = code => {
  throw Object.assign(new Error(code), {
    code
  });
};
const resourceId = v => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)) fail('invalid_resource_id');
  return v;
};
const jsonText = message => {
  for (const block of message.content ?? []) if (block.type === 'text') {
    try {
      const value = JSON.parse(block.text);
      if (value?.conversationId || value?.conversation?.conversationId) return value;
    } catch {}
  }
  return null;
};
function hostConversation(agent) {
  if (!agent) return null;
  for (const m of [...(agent.inbox?.nextStep ?? [])].reverse()) if (m.source?.kind === 'travel-canvas' && m.source.conversationId) return m.source.conversationId;
  const messages = agent.session.deriveMessages();
  const calls = new Map(messages.flatMap(m => (m.content ?? []).filter(b => b.type === 'tool-call').map(b => [b.id, b.name])));
  for (const m of [...messages].reverse()) {
    if (m.source?.kind === 'travel-canvas' && m.source.conversationId) return m.source.conversationId;
    if (m.role === 'tool' && /mcp__travel-agent__(?:open_travel_workspace|submit_travel_request|get_travel_workspace)$/.test(calls.get(m.source.callId) ?? '')) {
      const v = jsonText(m);
      if (v) return v.conversationId ?? v.conversation?.conversationId;
    }
  }
  return null;
}
/** Production owner-only native host bridge. Business permissions still belong to the cloud grant. */
export function createDshTravelHost(ctx, config, {
  fetchImpl = fetch,
  readWorkspace = () => readFile(new URL('../assets/workspace.html', import.meta.url), 'utf8')
} = {}) {
  const origin = travelOrigin(config.origin, {
    development: config.development === true
  });
  const auth = new DshTravelAuthorization({
    credentials: ctx.credentials,
    origin,
    callbackUrl: config.oauthCallbackUrl,
    allowLoopback: !ctx.connection.allowsRemoteAuthorities,
    fetchImpl
  });
  const contexts = new Map();
  let closed = false;
  const backend = async (path, options) => createBackendClient({
    origin,
    token: await auth.accessToken(),
    fetchImpl
  })(path, options);
  const agentFor = async raw => {
    const id = resourceId(raw);
    const a = (await ctx.sessionController.resolveAgent(id)).agent;
    if (!a) fail('travel_host_session_unavailable');
    return a;
  };
  const workspace = async raw => {
    const a = await agentFor(raw);
    const conversationId = contexts.get(a.id)?.conversationId ?? hostConversation(a);
    return conversationId ? backend(`/api/mcp/workspace?conversationId=${encodeURIComponent(resourceId(conversationId))}`) : {
      conversationId: null
    };
  };
  async function context(raw, value) {
    const a = await agentFor(raw);
    const conversationId = resourceId(value?.conversationId);
    const saved = await backend(`/api/mcp/workspace?conversationId=${encodeURIComponent(conversationId)}`);
    const authoritative = {
      conversationId,
      tripId: saved.conversation?.tripId ?? saved.trip?.tripId ?? null,
      revision: saved.plan?.revision ?? null
    };
    if (contexts.size >= 128 && !contexts.has(a.id)) contexts.delete(contexts.keys().next().value);
    if (JSON.stringify(contexts.get(a.id)) !== JSON.stringify(authoritative)) {
      a.inject(createUserMessage({
        source: {
          kind: 'travel-canvas',
          conversationId
        },
        content: [{
          type: 'text',
          text: `<travel-canvas-context>${JSON.stringify(authoritative)}</travel-canvas-context>\nThis is the user's currently open Travel Agent workspace, not a new request. Read its latest saved state before acting. UI selections do not authorize purchases or unconfirmed commits.`
        }]
      }));
      if (!(await ctx.sessions.flush(a.session))) fail('travel_host_persistence_required');
      contexts.set(a.id, authoritative);
    }
    return {
      status: 'synchronized'
    };
  }
  async function dispatch(endpoint, payload = {}, signal = new AbortController().signal, peer) {
    if (peer?.principal?.kind !== 'owner') fail('travel_host_owner_required');
    if (closed) fail('travel_host_closed');
    signal.throwIfAborted();
    switch (endpoint) {
      case 'status':
        return auth.publicStatus();
      case 'connect':
        return auth.start();
      case 'cancel-connect':
        await auth.cancel();
        return auth.publicStatus();
      case 'disconnect':
        contexts.clear();
        return auth.disconnect();
      case 'frame':
        return {
          html: (await readWorkspace()).replaceAll('__TRAVEL_PUBLIC_ORIGIN__', origin)
        };
      case 'workspace':
        return workspace(payload.sessionId);
      case 'context':
        return context(payload.sessionId, payload.context);
      case 'message':
        {
          const a = await agentFor(payload.sessionId);
          if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) fail('invalid_travel_message');
          await auth.accessToken();
          a.followup(createUserMessage({
            source: {
              kind: 'user'
            },
            content: [{
              type: 'text',
              text: payload.text
            }]
          }));
          await ctx.sessions.flush(a.session);
          return {
            status: 'accepted'
          };
        }
      case 'tool':
        {
          if (payload.name !== 'travel_app_action') fail('travel_operation_not_allowed');
          const {
            action,
            args,
            body
          } = payload.arguments ?? {};
          const op = travelOperation(action, args);
          const value = await backend(op.path, {
            method: op.method,
            ...(op.method !== 'GET' ? {
              body: body ?? {}
            } : {}),
            binary: op.binary
          });
          return {
            structuredContent: { status: "completed" },
            _meta: { "travel/uiData": value },
            content: [{
              type: 'text',
              text: JSON.stringify({ status: "completed" })
            }]
          };
        }
      default:
        fail('travel_operation_not_allowed');
    }
  }
  const rpc = async (endpoint, payload, signal, peer) => {
    try {
      return {
        ok: true,
        value: await dispatch(endpoint, payload, signal, peer)
      };
    } catch (e) {
      const code = typeof e.code === 'string' && /^[a-z_]{3,80}$/.test(e.code) ? e.code : 'travel_host_unavailable';
      return {
        ok: false,
        error: {
          code,
          message: code,
          details: {}
        }
      };
    }
  };
  // An exact owner-only Fetch route coexists with the native Gateway's /api
  // interceptor. Using a second interceptor would replace all native endpoints.
  const disposeRpc = ctx.connection.fetch.register({
    path: '/api/travel-agent/dispatch',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let message;
      try {
        const body = await request.text();
        if (body.length > 262144) fail('travel_request_too_large');
        message = JSON.parse(body);
      } catch {
        return Response.json({
          code: 'invalid_travel_request'
        }, {
          status: 400
        });
      }
      if (message?.type !== 'client-request' || message.method !== 'travel-agent/dispatch' || typeof message.rpcId !== 'string' || message.rpcId.length > 160) return Response.json({
        code: 'invalid_travel_request'
      }, {
        status: 400
      });
      const result = await rpc(message.payload?.endpoint, message.payload?.payload, request.signal, {
        principal: {
          kind: 'owner'
        }
      });
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result
      });
    }
  });
  const disposeCallback = config.oauthCallbackUrl ? ctx.webServer.register({
    kind: 'exact',
    path: '/travel-agent/oauth/callback',
    handler: (req, res) => auth.httpCallback(req, res)
  }) : undefined;
  const timer = setInterval(() => {
    void auth.sync().catch(() => {});
  }, 30000);
  timer.unref();
  void auth.sync().catch(() => {});
  return {
    auth,
    rpc,
    dispatch,
    async dispose() {
      closed = true;
      clearInterval(timer);
      contexts.clear();
      await disposeRpc();
      await disposeCallback?.();
      await auth.dispose();
    }
  };
}
export function apply(ctx, config) {
  const host = createDshTravelHost(ctx, config);
  ctx.effect(() => () => host.dispose());
}
