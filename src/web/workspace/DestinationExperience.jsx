import { useEffect, useMemo, useRef, useState } from "react";
import { destinationSketchPolicy } from "../destination-experience-scene.js";
import { createDestinationSketchRenderer } from "../destination-sketch-renderer.js";
import { destinationFromPlace, destinationSourceLabel } from "./destination.mjs";
import { Sheet } from "./Sheet.jsx";
import { Icon } from "./Icon.jsx";
import "../destination-sketch.css";
import "./media-workspace.css";

export function DestinationExperience({ place, domain, checkedAt, onClose, locations = [], onJournal, canEdit = false }) {
  const [location, setLocation] = useState(() => ({ place, domain, checkedAt }));
  const scene = useMemo(() => destinationFromPlace(location.place, location.domain, location.checkedAt), [location]);
  const [selected, setSelected] = useState("place"), [status, setStatus] = useState("loading"), [tour, setTour] = useState(false);
  const [presentation, setPresentation] = useState("solid"), [attempt, setAttempt] = useState(0), [expanded, setExpanded] = useState(false);
  const [preferences, setPreferences] = useState(() => ({ reduced: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, saveData: globalThis.navigator?.connection?.saveData ?? false }));
  const mount = useRef(null), renderer = useRef(null), hotspots = useRef(new Map());
  const chapter = scene.sketch.hotspots.find(item => item.id === selected) || scene.sketch.hotspots[0];
  const policy = destinationSketchPolicy({ webglAvailable: status !== "unavailable", prefersReducedMotion: preferences.reduced, saveData: preferences.saveData });
  const options = [{ place, domain, checkedAt }, ...locations.filter(item => item.place?.sourceId !== place.sourceId)];
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"), connection = globalThis.navigator?.connection;
    const update = () => setPreferences({ reduced: media?.matches ?? false, saveData: connection?.saveData ?? false });
    media?.addEventListener("change", update); connection?.addEventListener?.("change", update);
    return () => { media?.removeEventListener("change", update); connection?.removeEventListener?.("change", update); };
  }, []);
  useEffect(() => {
    let active = true, instance = null; const container = mount.current;
    const pageScroll = event => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); };
    container.addEventListener("wheel", pageScroll, { capture: true, passive: true });
    setStatus("loading"); setTour(false); setPresentation("solid"); setSelected(scene.sketch.hotspots[0]?.id || "place");
    function fail() { if (!active) return; instance?.dispose(); instance = null; renderer.current = null; setTour(false); setStatus("unavailable"); }
    try { instance = createDestinationSketchRenderer({ container, sketch: scene.sketch, reducedMotion: preferences.reduced || preferences.saveData,
      onChapter: id => { if (active) setSelected(id); }, onTourChange: playing => { if (active) setTour(playing); }, onError: fail,
      onProject: points => { if (active) for (const point of points) { const element = hotspots.current.get(point.id); if (element) { element.style.left = `${point.x}px`; element.style.top = `${point.y}px`; element.style.visibility = point.visible ? "visible" : "hidden"; } } },
    }); renderer.current = instance; setStatus("ready"); } catch { fail(); }
    return () => { active = false; container.removeEventListener("wheel", pageScroll, true); instance?.dispose(); renderer.current = null; };
  }, [scene, preferences.reduced, preferences.saveData, attempt]);
  function pick(id) { renderer.current?.focus(id); setSelected(id); }
  function keys(event) {
    if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); return; }
    if (event.target !== event.currentTarget || !renderer.current) return;
    const actions = { ArrowLeft: () => renderer.current.orbit(-.22), ArrowRight: () => renderer.current.orbit(.22), ArrowUp: () => renderer.current.orbit(0, -.12), ArrowDown: () => renderer.current.orbit(0, .12),
      "+": () => renderer.current.zoom(1.18), "=": () => renderer.current.zoom(1.18), "-": () => renderer.current.zoom(1 / 1.18), Home: () => renderer.current.reset(), " ": () => renderer.current.stopTour() };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  }
  return <Sheet title="目的地沉浸" context={location.place.name} wide onClose={onClose} className="immersion-sheet" footer={<>
    <p>查看场景不会更改行程或自动加入景点。</p><div className="ui-actions">{canEdit && onJournal && <button className="ui-secondary" type="button" onClick={() => onJournal(location.place)}><Icon name="Camera" />记录这里</button>}<button className="ui-primary" type="button" onClick={onClose}>返回原行程</button></div>
  </>}>
    <div className="immersion-topline"><div><h3>{scene.title}</h3><p>风格化三维场景 · 不是实景、导航或现场情况</p></div>{options.length > 1 && <label className="immersion-place-switch">选择地点<select value={options.findIndex(item => item.place.sourceId === location.place.sourceId)} onChange={event => { const next = options[Number(event.currentTarget.value)]; if (next) setLocation(next); }}>{options.map((item, index) => <option key={`${item.place.sourceId}:${index}`} value={index}>{item.place.name}</option>)}</select></label>}</div>
    <div className={`immersion-layout ${expanded ? "expanded" : ""}`}>
      <section className="immersion-art"><div className="destination-sketch-stage" data-sketch-renderer={status}>
        <div ref={mount} className="destination-sketch-mount" tabIndex={status === "ready" ? 0 : -1} role="group" aria-label="可探索三维场景：拖动或用方向键旋转，加减键缩放，Home复位，空格暂停导览" onKeyDown={keys} />
        {status === "loading" && <p className="immersion-state" role="status">正在打开场景…</p>}{status === "unavailable" && <div className="immersion-state" role="status"><Icon name="Globe" /><h4>当前设备暂时无法显示三维场景</h4><p>地点和章节资料仍保留在下方，可以继续阅读或重试。</p><button className="ui-secondary" type="button" onClick={() => setAttempt(value => value + 1)}>重新打开场景</button></div>}
        {status === "ready" && scene.sketch.hotspots.map((hotspot, index) => <button type="button" key={hotspot.id} ref={element => { if (element) hotspots.current.set(hotspot.id, element); else hotspots.current.delete(hotspot.id); }} className={`destination-sketch-hotspot ${selected === hotspot.id ? "selected" : ""}`} aria-label={`${hotspot.label} · 场景热点`} aria-pressed={selected === hotspot.id} onClick={() => pick(hotspot.id)}><span>{index + 1}</span><small>{hotspot.label}</small></button>)}
      </div>
      <div className="immersion-view-tools" role="group" aria-label="场景视角控制">{[["向左旋转", "ArrowLeft", () => renderer.current?.orbit(-.3)], ["向右旋转", "ArrowRight", () => renderer.current?.orbit(.3)], ["拉近场景", "Plus", () => renderer.current?.zoom(1.18)], ["缩小场景", "MagnifyingGlass", () => renderer.current?.zoom(1 / 1.18)], ["复位视角", "ArrowCounterClockwise", () => renderer.current?.reset()]].map(([label, name, action]) => <button className="ui-icon-button" type="button" key={label} aria-label={label} title={label} disabled={status !== "ready"} onClick={action}><Icon name={name} /></button>)}<button className="ui-icon-button" type="button" aria-label={expanded ? "还原场景大小" : "扩大场景"} title={expanded ? "还原场景大小" : "扩大场景"} onClick={() => setExpanded(!expanded)}><Icon name="CornersOut" /></button></div>
      <p className="immersion-gesture">拖动左右环看，使用按钮缩放；方向键同样可用。</p>
      </section>
      <aside className="immersion-reading"><h4>从哪里开始看？</h4><nav className="immersion-chapters" aria-label="探索章节">{scene.sketch.hotspots.map(item => <button type="button" key={item.id} aria-current={selected === item.id ? "step" : undefined} onClick={() => pick(item.id)}><span>{item.label}</span><Icon name="CaretRight" /></button>)}</nav><article className="immersion-chapter" aria-live="polite"><h4>{chapter.label}</h4><p>{chapter.text}</p>{chapter.source && <small>{chapter.source}</small>}</article>
        <button type="button" className="ui-primary immersion-tour" disabled={status !== "ready" || !policy.canTour} aria-pressed={tour} onClick={() => tour ? renderer.current?.stopTour() : renderer.current?.startTour()}>{tour ? "暂停导览" : "带我看看"}</button>
        {(!policy.canTour && (preferences.reduced || preferences.saveData)) && <p className="ui-help">{preferences.reduced ? "遵循减少动态效果设置，自动导览已关闭。仍可手动切换章节。" : "节省流量模式下关闭自动导览，仍可手动查看。"}</p>}
        <label className="ui-field immersion-presentation">场景表现<select value={presentation} disabled={status !== "ready"} onChange={event => { setPresentation(event.currentTarget.value); renderer.current?.setPresentation(event.currentTarget.value); }}><option value="solid">实体墨线</option><option value="ink">空间线稿</option><option value="points">点云轮廓</option></select></label>
      </aside>
    </div>
    <details className="immersion-source"><summary>场景依据与资料边界</summary><p>根据地点名称或类型选择风格化主题，场景中的形状、比例和道路不代表真实景观。没有已核验路线时，不提供真实耗时或可达性承诺。</p><p>资料来源：{destinationSourceLabel(location.place.sourceLabel)}</p>{location.checkedAt && <p>地点参考资料查询时间：{new Date(location.checkedAt).toLocaleString("zh-CN", { hour12: false })}</p>}</details>
  </Sheet>;
}
