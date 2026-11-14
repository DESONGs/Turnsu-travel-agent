import { useEffect, useRef, useState } from 'react';
import turnsuSymbol from '../../web/brand/turnsu-symbol.svg';
export const name = 'turnsu-travel-agent-client';
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'connection'];
const TYPE = 'turnsu-travel-agent';
const errors = {
  travel_host_persistence_required: '宿主尚未启用会话持久化，请启用后重试同步。',
  popup_blocked: '浏览器阻止了授权窗口。请允许此站点打开弹窗，再连接旅行账户。',
  travel_authentication_required: '请重新连接旅行账户。',
  travel_authorization_unavailable: '旅行服务暂时未能连接，请稍后重试。',
  travel_callback_configuration_required: '当前 DSH 的远程授权回调尚未配置，请在插件配置中填写后重试。',
  travel_host_session_unavailable: '宿主会话尚未就绪，请打开一段对话后重试。',
  travel_authorization_denied: '此次授权已取消，原有旅行会保留。',
  travel_revocation_pending: '本机已断开，正在确认服务端撤销。'
};
const message = e => errors[e.code ?? e.message] ?? '操作暂未完成，请重试。已保存的旅行会保留。';
const css = `.dsh-travel{height:100%;min-height:220px;background:var(--color-bg-1,#fafaf8);color:var(--color-text-1,#17191c);display:flex;flex-direction:column;font:14px system-ui}.dsh-travel-top{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid #d9dce0;font-size:12px}.dsh-travel-top strong{margin-right:auto;font-size:13px}.dsh-travel button{border:0;border-radius:7px;padding:9px 13px;font:inherit;cursor:pointer}.dsh-travel button:focus-visible{outline:3px solid #a44300;outline-offset:3px}.dsh-travel .primary{background:#a44300;color:white}.dsh-travel button:disabled{opacity:.5;cursor:not-allowed}.dsh-travel .quiet{background:transparent;color:inherit}.dsh-travel-connect{margin:auto;padding:38px 26px;max-width:480px}.dsh-travel-connect h2{font-size:23px;line-height:1.4;margin:0 0 15px}.dsh-travel-connect p{font-size:13px;line-height:1.8;margin:0 0 24px;color:var(--color-text-2,#60656e)}.dsh-travel [role=alert]{padding:12px 16px;color:#a52d26;font-size:12px;line-height:1.7}.dsh-travel iframe{border:0;width:100%;min-height:0;flex:1;background:white}.dsh-travel-open{border:0;background:none;color:inherit;cursor:pointer;font:inherit;padding:5px 9px;display:flex;gap:6px;align-items:center}.dsh-travel-open img{width:17px;height:17px}`;
export function TravelNativeTab({
  sessionId,
  useTabInfo,
  invoke,
  present
}) {
  const info = useTabInfo();
  const [status, setStatus] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [html, setHtml] = useState(''),
    [waiting, setWaiting] = useState(false),
    [contextError, setContextError] = useState('');
  const frame = useRef(null),
    pendingContext = useRef(null),
    popup = useRef(null),
    mounted = useRef(true);
  const queue = useRef(new Map());
  const refresh = async () => {
    try {
      const s = await invoke('status');
      if (!mounted.current) return;
      setStatus(s);
      setWaiting(s.authorizing);
      if (s.connected && !html) {
        const v = await invoke('frame');
        if (mounted.current) setHtml(v.html);
      }
      if (!s.connected) setHtml('');
      if (pendingContext.current && s.connected) {
        await invoke('context', {
          sessionId,
          context: pendingContext.current
        });
        pendingContext.current = null;
        setContextError('');
      }
      setError('');
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      queue.current.clear();
    };
  }, [sessionId, html]);
  useEffect(() => {
    const receive = async event => {
      const target = frame.current?.contentWindow;
      if (event.source !== target || event.origin !== 'null' || event.data?.jsonrpc !== '2.0') return;
      const m = event.data;
      const send = value => {
        if (target === frame.current?.contentWindow) target.postMessage(value, '*');
      };
      if (m.id !== undefined && queue.current.has(m.id)) {
        send(await queue.current.get(m.id));
        return;
      }
      const task = (async () => {
        try {
          let result = {};
          if (m.method === 'ui/initialize') result = {
            protocolVersion: '2026-01-26',
            hostInfo: {
              name: 'Turnsu 旅行',
              version: '0.2.0'
            },
            hostCapabilities: {},
            hostContext: {
              displayMode: info.sidebar.fullscreen ? 'fullscreen' : 'inline',
              availableDisplayModes: ['inline', 'fullscreen'],
              theme: 'light',
              locale: 'zh-CN'
            }
          };else if (m.method === 'ui/notifications/initialized') {
            try {
              const w = await invoke('workspace', {
                sessionId
              });
              if (w.conversationId || w.conversation) send({
                jsonrpc: '2.0',
                method: 'ui/notifications/tool-result',
                params: {
                  structuredContent: w
                }
              });
            } catch (e) {
              setError(message(e));
            }
            return null;
          } else if (m.method === 'tools/call') result = await invoke('tool', m.params);else if (m.method === 'ui/update-model-context') {
            const c = m.params?.content?.find(b => b.type === 'text');
            if (c) {
              pendingContext.current = JSON.parse(c.text);
              try {
                await invoke('context', {
                  sessionId,
                  context: pendingContext.current
                });
                pendingContext.current = null;
                setContextError('');
              } catch (e) {
                setContextError(message(e));
                throw e;
              }
            }
          } else if (m.method === 'ui/message') {
            const text = m.params?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
            result = await invoke('message', {
              sessionId,
              text
            });
          } else if (m.method === 'ui/request-display-mode') {
            if (!['inline', 'fullscreen'].includes(m.params?.mode)) throw new Error('unsupported_display_mode');
            if (m.params.mode === 'fullscreen' !== info.sidebar.fullscreen) present(frame.current);
            result = {
              mode: m.params.mode
            };
          } else if (m.method === 'ui/open-link') {
            const u = new URL(m.params?.url);
            if (u.protocol !== 'https:' || u.username || u.password) throw new Error('invalid_link');
            window.open(u.href, '_blank', 'noopener,noreferrer');
          } else throw new Error('unsupported_host_method');
          return m.id === undefined ? null : {
            jsonrpc: '2.0',
            id: m.id,
            result
          };
        } catch (e) {
          return {
            jsonrpc: '2.0',
            id: m.id,
            error: {
              code: -32000,
              message: e.code ?? 'travel_host_unavailable'
            }
          };
        }
      })();
      if (m.id !== undefined) {
        queue.current.set(m.id, task);
        if (queue.current.size > 100) queue.current.delete(queue.current.keys().next().value);
      }
      const response = await task;
      if (response) send(response);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [sessionId, info.sidebar.fullscreen, invoke, present]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: {
        displayMode: info.sidebar.fullscreen ? 'fullscreen' : 'inline'
      }
    }, '*');
  }, [info.sidebar.fullscreen]);
  const run = async task => {
    setBusy(true);
    setError('');
    try {
      await task();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = () => {
    popup.current = window.open('about:blank', 'travel-agent-sign-in', 'width=620,height=760');
    void run(async () => {
      try {
        const a = await invoke('connect');
        const u = new URL(a.authorizationUrl);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('invalid_authorization_url');
        if (!popup.current) {
          await invoke('cancel-connect');
          throw new Error('popup_blocked');
        }
        popup.current.location.href = u.href;
        setWaiting(true);
      } catch (e) {
        popup.current?.close();
        throw e;
      }
    });
  };
  return <section className="dsh-travel" aria-label="旅行画布">{status?.connected ? <><header className="dsh-travel-top"><strong>旅行画布</strong><button className="quiet" onClick={() => present(frame.current)}>{info.sidebar.fullscreen ? '返回侧栏' : '展开画布'}</button><button className="quiet" disabled={busy} onClick={() => run(async () => {
          await invoke('disconnect');
          setHtml('');
          popup.current?.close();
        })}>断开连接</button></header>{contextError ? <div role="alert">对话上下文暂未同步。<button onClick={() => void refresh()}>重试同步</button></div> : null}{html ? <iframe ref={frame} title="Turnsu 旅行画布" srcDoc={html} sandbox="allow-scripts allow-forms allow-popups allow-downloads" /> : <p role="status">正在打开已保存的旅行…</p>}</> : <div className="dsh-travel-connect"><h2>{waiting ? '等待你完成授权' : '连接旅行账户'}</h2><p>{waiting ? '在刚打开的安全页面完成登录与授权。已保存的旅行会保留。' : '连接后，在这里继续规划、比较和调整同一趟旅行；对话仍留在 DSH。授权凭据由宿主保存。'}</p>{waiting ? <><button className="primary" disabled={busy} onClick={() => void refresh()}>检查连接状态</button><button className="quiet" disabled={busy} onClick={() => run(async () => {
          await invoke('cancel-connect');
          popup.current?.close();
          setWaiting(false);
        })}>取消此次连接</button></> : status?.state === 'revocation_pending' ? <button className="primary" disabled={busy} onClick={() => run(() => invoke('disconnect'))}>重试确认断开</button> : <button className="primary" disabled={busy} onClick={connect}>连接旅行账户</button>}</div>}{error ? <div role="alert">{error}<button className="quiet" disabled={busy} onClick={() => void refresh()}>重试</button></div> : null}</section>;
}
function TravelHeaderButton({
  open
}) {
  return <button className="dsh-travel-open" onClick={open} aria-label="打开旅行画布"><img src={turnsuSymbol} width="20" height="20" alt="" />旅行</button>;
}
export function apply(ctx) {
  const invoke = async (endpoint, payload = {}) => {
    const r = await ctx.connection.rpc.call('/api', 'travel-agent/dispatch', {
      endpoint,
      payload
    });
    if (!r.ok) throw Object.assign(new Error(r.error.code), {
      code: r.error.code
    });
    return r.value;
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TYPE,
    kind: TYPE,
    title: () => '旅行画布',
    keepMounted: true,
    guide: [{
      id: 'travel',
      order: 30,
      title: () => '旅行画布',
      description: () => '规划、比较和继续同一趟旅行'
    }]
  }));
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TYPE,
    inject: () => ({
      invoke,
      present: element => {
        const target = ctx.sidebarRight.focusedTarget(element);
        if (!target) throw new Error("travel_host_session_unavailable");
        ctx.sidebarRight.toggleFullscreen(target);
      }
    })
  }, TravelNativeTab));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: TYPE,
    order: 20,
    inject: () => ({
      open: () => ctx.sidebarRight.openTab(TYPE)
    })
  }, TravelHeaderButton));
}
