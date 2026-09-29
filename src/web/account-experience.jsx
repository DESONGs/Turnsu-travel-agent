import { useEffect, useId, useRef, useState } from "react";
import { AppleLogo, ArrowRight, Check, CheckCircle, CircleNotch, Devices, Globe, GoogleLogo, LinkSimple, MapPin, ShieldCheck, SignOut, User, WarningCircle, WechatLogo, X } from "@phosphor-icons/react";
import { OverlaySurface } from "./ui/overlay.jsx";
import { api, apiPublicUrl, desktopSessionPersistence } from "./api-client.js";
import "./account-experience.css";

const providers = [
  { id: "google", label: "Google", Icon: GoogleLogo },
  { id: "wechat", label: "微信", en: "WeChat", Icon: WechatLogo },
  { id: "alipay", label: "支付宝", en: "Alipay", Icon: (props) => <span {...props} className="account-alipay-mark" aria-hidden="true">支</span> },
  { id: "apple", label: "Apple", Icon: AppleLogo },
];
const choose = (locale) => (zh, en) => locale === "en" ? en : zh;

function feedback(code, pick) {
  const messages = {
    auth_authorization_denied: pick("已取消授权，可以换一种方式继续。", "Authorization cancelled. You can choose another method."),
    auth_state_invalid: pick("这次登录校验已失效，请重新开始。", "This sign-in request is no longer valid. Please start again."),
    auth_state_expired: pick("登录页面已过期，请重新开始。", "This sign-in request expired. Please start again."),
    identity_already_linked: pick("这个登录方式已属于另一个旅行账号，尚未合并。请使用原账号登录查看旅行。", "This method belongs to another travel account. Sign in to that account to access its trips."),
    auth_link_session_changed: pick("绑定期间账号状态发生变化，请重新登录后绑定。", "Your account session changed. Sign in again before linking."),
    recent_login_required: pick("为了保护账号，请重新登录，再修改登录方式。", "Please sign in again before changing your login methods."),
    verified_login_required: pick("请先使用真实平台登录，再绑定其他登录方式。", "Sign in with a verified provider before linking another method."),
    last_login_method_required: pick("至少保留一种登录方式，避免无法找回账号。", "Keep at least one login method to retain access to your account."),
    current_login_method_required: pick("请先用另一种方式登录，再解绑当前方式。", "Sign in with another method before removing your current one."),
    authentication_required: pick("登录已过期或已在其他设备退出，请重新登录。", "Your session expired or was signed out elsewhere. Please sign in again."),
    auth_provider_not_configured: pick("这个登录方式暂未开放，你可以继续临时规划旅行。", "This sign-in method is not available yet. You can continue as a guest."),
    invalid_display_name: pick("请填写 1–80 个字符的称呼。", "Use a name between 1 and 80 characters."),
  };
  return messages[code] ?? pick("暂时没有完成，请重试。当前内容会保留。", "That did not finish. Please retry; your current work is preserved.");
}

export function AccountNotice({ message, error = false, children }) {
  return <div className={`account-notice ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{error ? <WarningCircle /> : <CheckCircle />}<div>{message}{children}</div></div>;
}

export function ProviderButton({ provider, available, busy, pick, onClick, primary = false }) {
  const { Icon } = provider;
  return <button type="button" className={`account-provider ${primary ? "is-primary" : ""}`} disabled={!available || Boolean(busy)} onClick={onClick} aria-busy={busy === provider.id}>
    <Icon weight="bold" /><span>{pick(`使用 ${provider.label} 继续`, `Continue with ${provider.en ?? provider.label}`)}</span>
    {busy === provider.id ? <CircleNotch className="spin" /> : available ? <ArrowRight /> : <small>{pick("暂未开放", "Unavailable")}</small>}
  </button>;
}

export async function openAuthorization(url) {
  const target = apiPublicUrl(url);
  if (window.travelDesktop) {
    const parsed = new URL(target);
    const provider = parsed.pathname.match(/^\/api\/auth\/([a-z]+)\/start$/)?.[1];
    if (!provider) throw new Error("invalid_auth_start");
    await window.travelDesktop.beginOAuth(provider, parsed.searchParams.get("returnTo") || "/", parsed.searchParams.get("link") || undefined);
  } else window.location.assign(target);
}

export function LoginScreen({ onSession, developmentAuthEnabled, providerStatus, initialError, onContinue, embedded = false, locale = "zh-CN" }) {
  const pick = choose(locale);
  const headingId = useId();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(initialError);
  const [identity, setIdentity] = useState("");
  const [localOpen, setLocalOpen] = useState(false);
  const [status, setStatus] = useState(providerStatus);
  useEffect(() => setError(initialError), [initialError]);
  useEffect(() => setStatus(providerStatus), [providerStatus]);
  const available = new Map((status?.providers ?? []).map((item) => [item.id, item.available]));
  const anyAvailable = [...available.values()].some(Boolean);
  const run = async (key, work) => { setBusy(key); setError(null); try { await work(); } catch (cause) { setError(cause.code ?? "request_failed"); } finally { setBusy(null); } };
  const start = (provider) => run(provider.id, () => openAuthorization(api.authStartUrl(provider.id, `${window.location.pathname}${window.location.search}`)));
  const content = <div className="account-login-layout">
    <aside className="account-travel-panel" aria-hidden="true">
      <img src="/assets/login-travelers-waterfront.png" alt="" />
      <div className="account-travel-caption"><span>TRAVEL, CONTINUED.</span><h2>{pick(<>每一段旅程，<br />都能接着走。</>, <>A little further.<br />Together.</>)}</h2><p>{pick("从此刻的灵感，到下一站的日常。", "From your first idea to your next everyday adventure.")}</p></div>
    </aside>
    <section className="account-login-main">
      <div className="account-wordmark"><MapPin weight="fill" /><span>Travel Agent</span></div>
      <div className="account-login-heading"><span className="account-kicker">{pick("你的旅行，随时继续", "PICK UP WHERE YOU LEFT OFF")}</span><h1 id={headingId}>{pick("把旅程留在身边", "Keep your trip with you")}</h1><p>{pick("登录后，将这次临时旅行和对话归入账号，在其他设备继续。", "Sign in to save this guest trip and conversation, and continue on another device.")}</p></div>
      {error ? <AccountNotice error message={feedback(error, pick)} /> : null}
      {!status ? <AccountNotice error message={pick("暂时无法获取登录方式。", "Unable to load sign-in methods.")}><button type="button" className="account-text-button" disabled={Boolean(busy)} onClick={() => run("reload", async () => setStatus(await api.authProviders()))}>{pick("重新加载", "Reload")}</button></AccountNotice> : null}
      <div className="account-provider-list" aria-label={pick("选择登录方式", "Choose a sign-in method")}>
        {providers.map((provider, index) => <ProviderButton key={provider.id} provider={provider} primary={index === 0} available={available.get(provider.id) === true} busy={busy} pick={pick} onClick={() => start(provider)} />)}
      </div>
      <p className="account-login-help">{anyAvailable ? pick("微信和支付宝将打开平台官方授权页面。", "WeChat and Alipay open their official authorization pages.") : pick("正式登录尚未开放，仍可免登录规划旅行。", "Account sign-in is not available yet. You can still plan as a guest.")}</p>
      <button className="account-secondary account-guest-action" type="button" disabled={Boolean(busy)} onClick={() => onContinue ? onContinue() : run("guest", async () => onSession(await api.createGuestSession()))}>{pick("继续临时旅行", "Continue as a guest")}<ArrowRight /></button>
      {developmentAuthEnabled ? <div className="account-local"><button type="button" className="account-text-button" aria-expanded={localOpen} onClick={() => setLocalOpen(!localOpen)}>{pick("本地开发入口", "Local development")}</button>{localOpen ? <form onSubmit={(event) => { event.preventDefault(); void run("local", async () => onSession(await api.createDevelopmentSession("email_otp", identity))); }}><p>{pick("仅用于本机开发，不会验证第三方身份。", "For local development only. No third-party identity is verified.")}</p><label>{pick("怎么称呼你", "Your name")}<input value={identity} onChange={(event) => setIdentity(event.target.value)} maxLength={80} required autoComplete="nickname" /></label><button className="account-action" disabled={Boolean(busy) || !identity.trim()}>{busy === "local" ? <CircleNotch className="spin" /> : null}{pick("进入本地体验", "Continue locally")}</button></form> : null}</div> : null}
      <footer className="account-login-footer"><ShieldCheck /><span>{pick("只有你确认的登录方式会关联到账号。", "Only sign-in methods you confirm will be linked to your account.")}</span></footer>
    </section>
  </div>;
  return embedded ? <OverlaySurface onClose={onContinue} overlayClassName="account-overlay" surfaceClassName="account-dialog account-login-dialog" labelledBy={headingId}><button type="button" className="account-close" onClick={onContinue} aria-label={pick("关闭登录", "Close sign-in")}><X /></button>{content}</OverlaySurface>
    : <main className="account-fullpage">{content}</main>;
}

export function AccountCenter({ session, locale = "zh-CN", onClose, onSession, onLogout, onLogin, initialTab = "profile", initialError, providerStatus }) {
  const pick = choose(locale);
  const headingId = useId();
  const [tab, setTab] = useState(initialTab);
  const [account, setAccount] = useState(null);
  const [name, setName] = useState(session.displayName ?? "");
  const [busy, setBusy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const cancelRef = useRef(null);
  useEffect(() => { if (confirmation) cancelRef.current?.focus(); }, [confirmation]);
  const load = async () => { const next = await api.account(); setAccount(next); return next; };
  useEffect(() => { let active = true; api.account().then((value) => { if (active) { setAccount(value); setName(value.displayName ?? ""); } }).catch((cause) => { if (active) setError(cause.code); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const run = async (key, work, message) => {
    setBusy(key); setError(null); setNotice(null);
    try { await work(); setConfirmation(null); if (message) setNotice(message); }
    catch (cause) { setError(cause.code ?? "request_failed"); }
    finally { setBusy(null); }
  };
  const formatDate = (value) => new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const sections = [
    { id: "profile", Icon: User, label: pick("个人资料", "Profile"), title: pick("很高兴，一起出发", "Good to travel together"), description: pick("让旅行助手知道该怎么称呼你。", "Let your travel assistant know what to call you.") },
    { id: "connections", Icon: LinkSimple, label: pick("登录方式", "Sign-in methods"), title: pick("一个账号，多种抵达方式", "One account. More ways in."), description: pick("绑定后，使用任一方式登录都能继续同一份旅行。", "Linked methods take you to the same account and trips.") },
    { id: "devices", Icon: Devices, label: pick("登录设备", "Devices"), title: pick("旅程在哪里继续", "Where your journey continues"), description: pick("查看有效登录。退出某台设备后，它需要重新登录。", "Review active sessions. Signed-out devices must log in again.") },
  ];
  const active = sections.find((item) => item.id === tab) ?? sections[0];
  const connectionRows = providers.flatMap((provider) => {
    const linked = account?.identities.filter((identity) => identity.provider === provider.id) ?? [];
    return linked.length ? linked.map((identity) => ({ provider, identity })) : [{ provider, identity: null }];
  });
  return <OverlaySurface onClose={onClose} overlayClassName="account-overlay" surfaceClassName="account-dialog account-center" labelledBy={headingId}>
    <aside className="account-sidebar"><div className="account-wordmark"><MapPin weight="fill" /><span>Travel Agent</span></div><div className="account-person"><div className="account-avatar">{Array.from(session.displayName || pick("旅", "T"))[0]}</div><strong>{session.displayName || pick("旅行者", "Traveler")}</strong><span>{session.provider === "email_otp" ? pick("本地开发账号", "Local development") : pick("你的旅行账号", "Your travel account")}</span></div><nav aria-label={pick("账号设置", "Account settings")}>{sections.map(({ id, Icon, label }) => <button key={id} type="button" className={tab === id ? "is-active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => { setTab(id); setConfirmation(null); setNotice(null); }}><Icon />{label}</button>)}</nav><div className="account-sidebar-foot"><ShieldCheck /><span>{pick("旅行属于你，登录由你管理。", "Your trips. Your access.")}</span></div></aside>
    <section className="account-content"><header className="account-content-header"><span className="account-kicker">{pick("账号与安全", "ACCOUNT & SECURITY")}</span><button type="button" className="account-close" onClick={onClose} aria-label={pick("关闭账号设置", "Close account settings")}><X /></button><h1 id={headingId}>{active.title}</h1><p>{active.description}</p></header>
      {error ? <AccountNotice error message={feedback(error, pick)}>{["authentication_required", "recent_login_required", "verified_login_required"].includes(error) ? <button className="account-text-button" type="button" onClick={onLogin}>{pick("重新登录", "Sign in again")}</button> : <button className="account-text-button" type="button" disabled={Boolean(busy)} onClick={() => run("retry", load)}>{pick("重试", "Retry")}</button>}</AccountNotice> : null}
      {notice ? <AccountNotice message={notice} /> : null}
      {desktopSessionPersistence() === false ? <AccountNotice error message={pick("系统安全存储暂不可用。这次登录仅保留到关闭应用，重启后需要重新登录。", "Secure system storage is unavailable. This sign-in lasts until the app closes; sign in again after restarting.")} /> : null}
      {loading ? <div className="account-loading" role="status"><CircleNotch className="spin" />{pick("正在获取账号信息…", "Loading your account…")}</div> : !account ? null : <>
        {tab === "profile" ? <div className="account-profile-content"><form onSubmit={(event) => { event.preventDefault(); void run("profile", async () => { const next = await api.updateProfile(name); onSession(next); await load(); }, pick("称呼已更新。", "Your name has been updated.")); }}><label htmlFor="account-name">{pick("你的称呼", "Your name")}</label><p>{pick("显示在旅行工作区，随时可以修改。", "Shown in your travel workspace. Change it anytime.")}</p><input id="account-name" value={name} maxLength={80} autoComplete="nickname" onChange={(event) => setName(event.target.value)} /><button className="account-action" disabled={Boolean(busy) || !name.trim() || name.trim() === (account.displayName ?? "")}>{busy === "profile" ? <CircleNotch className="spin" /> : <Check />}{pick("保存修改", "Save changes")}</button></form><div className="account-profile-summary"><ShieldCheck /><div><strong>{pick("旅行与对话跟随账号", "Your trips stay with your account")}</strong><p>{pick("退出登录不会删除已保存的旅行。临时旅行需要登录后才能归入账号。", "Signing out does not delete saved trips. Guest trips are attached to your account when you sign in.")}</p></div></div><div className="account-signout"><div><strong>{pick("在这台设备退出", "Sign out on this device")}</strong><p>{pick("下次可使用已绑定的方式登录。", "Use a linked method to sign in next time.")}</p></div><button className="account-secondary" type="button" onClick={() => setConfirmation({ type: "logout", title: pick("退出这台设备？", "Sign out on this device?"), detail: pick("已保存的旅行不会删除，你可以继续临时使用。", "Your saved trips will remain. You can keep using a guest session.") })}><SignOut />{pick("退出登录", "Sign out")}</button></div></div> : null}
        {tab === "connections" ? <div className="account-connections">{session.provider === "email_otp" ? <p className="account-inline-hint">{pick("本地开发身份不代表真实平台账号。请使用平台登录后管理绑定。", "A local development identity is not a verified platform account. Sign in with a provider to manage links.")}</p> : null}{connectionRows.map(({ provider, identity }) => {
          const ready = providerStatus?.providers?.find((item) => item.id === provider.id)?.available === true;
          const current = identity?.provider === session.provider;
          return <div className="account-method-row" key={identity?.id ?? provider.id}><div className={`account-method-icon ${provider.id}`}><provider.Icon weight="fill" /></div><div className="account-row-description"><strong>{locale === "en" ? provider.en ?? provider.label : provider.label}{current ? <span className="account-badge">{pick("本次登录", "Current sign-in")}</span> : null}</strong><p>{identity ? pick(`已绑定 · ${formatDate(identity.linkedAt)}`, `Linked · ${formatDate(identity.linkedAt)}`) : ready ? pick("绑定后可用于登录此账号", "Link to sign in to this account") : pick("暂未开放", "Not available yet")}</p></div>{identity ? <button className="account-text-button" type="button" disabled={Boolean(busy) || current || account.identities.length <= 1} onClick={() => setConfirmation({ type: "unlink", id: identity.id, title: pick(`解绑 ${provider.label}？`, `Unlink ${provider.en ?? provider.label}?`), detail: pick("使用这个方式登录的其他设备也会退出。请确保另一种登录方式仍可使用。", "Other sessions using this method will be signed out. Keep another sign-in method available.") })}>{pick("解绑", "Unlink")}</button> : <button className="account-secondary" type="button" disabled={Boolean(busy) || !ready || session.provider === "email_otp"} onClick={() => run(provider.id, async () => { const intent = await api.linkIntent(provider.id); await openAuthorization(intent.startPath); })}>{busy === provider.id ? <CircleNotch className="spin" /> : null}{pick("绑定", "Link")}</button>}</div>;
        })}<div className="account-footnote"><ShieldCheck /><p>{pick("绑定需要再次完成平台授权。不会凭昵称或相同邮箱自动合并账号；当前使用的登录方式不可直接解绑。", "Linking requires provider authorization. Accounts are not merged by nickname or email. Your current sign-in method cannot be removed here.")}</p></div></div> : null}
        {tab === "devices" ? <div className="account-devices"><div className="account-section-toolbar"><strong>{pick(`${account.sessions.length} 个有效登录`, `${account.sessions.length} active sessions`)}</strong><button type="button" className="account-text-button" disabled={Boolean(busy) || !account.sessions.some((device) => !device.current)} onClick={() => setConfirmation({ type: "others", title: pick("退出其他所有设备？", "Sign out all other devices?"), detail: pick("保留本次登录。其他设备需要重新验证身份，旅行数据不会删除。", "Keep this session. Other devices must sign in again; trips will not be deleted.") })}>{pick("退出其他设备", "Sign out others")}</button></div>{account.sessions.map((device) => <div className="account-device-row" key={device.sessionId}><div className="account-method-icon"><Devices /></div><div className="account-row-description"><strong>{device.device}{device.current ? <span className="account-badge">{pick("当前设备", "This device")}</span> : null}</strong><p>{pick("最近使用", "Last active")} {formatDate(device.lastSeenAt)}</p><small>{pick("登录有效至", "Expires")} {formatDate(device.expiresAt)}</small></div>{device.current ? <CheckCircle className="account-current-check" /> : <button type="button" className="account-text-button" disabled={Boolean(busy)} onClick={() => setConfirmation({ type: "device", id: device.sessionId, title: pick("退出这台设备？", "Sign out this device?"), detail: device.device })}>{pick("退出", "Sign out")}</button>}</div>)}<div className="account-footnote"><ShieldCheck /><p>{pick("设备名称由浏览器信息识别。同一设备的不同浏览器可能分别显示。", "Device names come from browser information. Different browsers on the same device may appear separately.")}</p></div></div> : null}
      </>}
      {confirmation ? <div className="account-confirmation" role="alertdialog" aria-label={confirmation.title}><strong>{confirmation.title}</strong><p>{confirmation.detail}</p><div><button className="account-secondary" type="button" ref={cancelRef} disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>{pick("取消", "Cancel")}</button><button className="account-action" type="button" disabled={Boolean(busy)} onClick={() => run("confirm", async () => { if (confirmation.type === "logout") return onLogout(); if (confirmation.type === "device") await api.revokeSession(confirmation.id); if (confirmation.type === "others") await api.revokeOtherSessions(); if (confirmation.type === "unlink") await api.unlinkIdentity(confirmation.id); await load(); }, pick("已完成，登录状态已更新。", "Done. Your sign-in status has been updated."))}>{busy === "confirm" ? <CircleNotch className="spin" /> : null}{pick("确认", "Confirm")}</button></div></div> : null}
    </section>
  </OverlaySurface>;
}
