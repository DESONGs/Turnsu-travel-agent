import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarBlank, Compass, MapTrifold, Notebook, Bell, Heart, Users, List, X, ArrowLeft } from "@phosphor-icons/react";
import logo from "../brand/turnsu-lockup.svg";
import "./turnsu-frame.css";

const EntranceContext = createContext(null);
export function TurnsuSession({ children }) {
  const session = useRef({ played: false, startedAt: null });
  return <EntranceContext.Provider value={session.current}>{children}</EntranceContext.Provider>;
}

export const workspaceNavigation = [
  { key: "overview", label: "每日行程", Icon: CalendarBlank },
  { key: "compare", label: "候选比较", Icon: Compass },
  { key: "map", label: "地图与路线", Icon: MapTrifold },
  { key: "journal", label: "照片手账", Icon: Notebook },
  { key: "watches", label: "价格关注", Icon: Bell },
  { key: "preferences", label: "旅行偏好", Icon: Heart },
];

/** The mark travels to this app's navigation, never to the host application's chrome. */
export function TurnsuBrand({ compact = false, animate = true }) {
  const shared = useContext(EntranceContext), local = useRef({ played: false, startedAt: null });
  const session = shared ?? local.current;
  const target = useRef(null), flying = useRef(null), veil = useRef(null);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    if (!animate || session.played) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (query.matches || document.visibilityState === "hidden" || !Element.prototype.animate) { session.played = true; return; }
    let frame, animation, background, disposed = false;
    const finish = () => { session.played = true; if (!disposed) setMoving(false); };
    const stop = () => { animation?.cancel(); background?.cancel(); finish(); };
    const preference = () => { if (query.matches) stop(); };
    const visibility = () => { if (document.visibilityState === "hidden") stop(); };
    setMoving(true);
    frame = requestAnimationFrame(() => {
      if (!target.current || !flying.current || disposed) { finish(); return; }
      const box = target.current.getBoundingClientRect();
      if (!box.width || !box.height) { finish(); return; }
      if (session.startedAt == null) session.startedAt = performance.now();
      const elapsed = Math.max(0, performance.now() - session.startedAt);
      if (elapsed >= 1000) { finish(); return; }
      const scale = Math.min(240, window.innerWidth * .56) / box.width;
      const x = (window.innerWidth - box.width) / 2 - box.left;
      const y = (window.innerHeight - box.height) / 2 - box.top;
      Object.assign(flying.current.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      const at = (s) => `translate(${x}px, ${y}px) scale(${s})`;
      animation = flying.current.animate([
        { transform: at(scale * .9), opacity: 0, offset: 0 },
        { transform: at(scale), opacity: 1, offset: .16 },
        { transform: at(scale * 1.12), opacity: 1, offset: .38 },
        { transform: at(scale * .94), opacity: 1, offset: .55 },
        { transform: "translate(0, 0) scale(1)", opacity: 1, offset: 1 },
      ], { duration: 1000, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" });
      background = veil.current?.animate([{ opacity: .94 }, { opacity: 0 }], { duration: 620, fill: "both", easing: "ease-out" });
      animation.currentTime = elapsed;
      if (background) background.currentTime = Math.min(elapsed, 620);
      animation.finished.then(finish, () => {});
    });
    query.addEventListener("change", preference);
    window.addEventListener("resize", stop, { once: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true; cancelAnimationFrame(frame); animation?.cancel(); background?.cancel();
      query.removeEventListener("change", preference); window.removeEventListener("resize", stop); document.removeEventListener("visibilitychange", visibility);
    };
  }, [animate, session]);
  return <>
    <img ref={target} className={`turnsu-logo ${compact ? "is-compact" : ""}`} style={moving ? { opacity: 0 } : undefined} src={logo} alt="Turnsu" width="144" height="39" />
    {moving && <div className="turnsu-entrance" aria-hidden="true"><div ref={veil} className="turnsu-entrance-veil" /><img ref={flying} src={logo} alt="" className="turnsu-flying-logo" /></div>}
  </>;
}

export function TurnsuFrame({ children, active = "overview", onNavigate, onTrips, onShare, tripTitle, tools, footer, compact = false, navigation = workspaceNavigation }) {
  const [menu, setMenu] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width:760px)").matches);
  const closeRef = useRef(null), trigger = useRef(null), panel = useRef(null);
  useEffect(() => { const query = window.matchMedia("(max-width:760px)"); const change = () => setNarrow(query.matches); query.addEventListener("change", change); return () => query.removeEventListener("change", change); }, []);
  useEffect(() => {
    if (!menu) return;
    closeRef.current?.focus();
    const key = event => {
      if (event.key === "Escape") { setMenu(false); trigger.current?.focus(); }
      if (event.key === "Tab") {
        const targets = [...panel.current.querySelectorAll("button:not(:disabled),a[href]")].filter(el => el.getClientRects().length);
        if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [menu]);
  const navigate = key => { if (onNavigate?.(key) !== false) setMenu(false); };
  const links = <>
    {onTrips && <button className="turnsu-trips" type="button" onClick={() => { setMenu(false); onTrips(); }}><ArrowLeft />我的旅行</button>}
    {tripTitle && <p className="turnsu-trip-scope">{tripTitle}</p>}
    <nav aria-label="旅行导航">{navigation.map(({ key, label, Icon }) => <button type="button" key={key} aria-current={active === key ? "page" : undefined} disabled={!onNavigate} onClick={() => navigate(key)}><Icon /><span>{label}</span></button>)}
      {onShare && <button type="button" onClick={() => { setMenu(false); onShare(); }}><Users /><span>共享旅行</span></button>}
    </nav>
  </>;
  return <div className={`turnsu-app turnsu-body ${compact ? "is-compact" : ""}`}>
    <aside className="turnsu-navigation"><div className="turnsu-brand-slot"><TurnsuBrand animate={!narrow} /><span>旅行</span></div>{links}{footer && <div className="turnsu-navigation-footer">{footer}</div>}</aside>
    <div className="turnsu-canvas"><header className="turnsu-mobile-header"><div className="turnsu-mobile-brand"><TurnsuBrand compact animate={narrow} /></div><div className="turnsu-header-tools">{tools}<button ref={trigger} className="turnsu-menu-button" type="button" aria-label="打开旅行导航" aria-expanded={menu} onClick={() => setMenu(true)}><List /></button></div></header>{children}</div>
    {menu && <div className="turnsu-menu-backdrop" onClick={event => { if (event.target === event.currentTarget) { setMenu(false); trigger.current?.focus(); } }}><aside ref={panel} className="turnsu-mobile-menu" role="dialog" aria-modal="true" aria-label="旅行导航"><div className="turnsu-menu-heading"><img src={logo} width="132" height="35" alt="Turnsu" /><button ref={closeRef} type="button" aria-label="关闭旅行导航" onClick={() => { setMenu(false); trigger.current?.focus(); }}><X /></button></div>{links}{footer}</aside></div>}
  </div>;
}
