import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, CircleNotch, Hand, Minus, Pause, Play, Plus } from "@phosphor-icons/react";
import { destinationSketchPolicy } from "./destination-experience-scene.js";

function StaticSketch({ theme, english }) {
  const water = theme === "lakeshore";
  const mountain = water || theme === "mountain";
  const buildings = ["heritage", "culture", "dining"].includes(theme);
  return <svg className="destination-static-sketch" viewBox="0 0 1000 620" role="img" aria-label={english ? "Static illustrated notebook, without 3D controls" : "静态主题手账，非可旋转 3D"}>
    <g stroke="#515a51" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M115 374 Q96 335 158 309 Q238 265 307 290 Q364 251 442 282 Q543 264 620 290 Q766 269 858 331 Q910 361 874 407 L872 437 Q780 510 618 520 Q419 551 244 484 Q134 456 115 409Z" fill="#e3dac5" />
      <path d="M115 374 Q206 446 385 473 Q685 531 874 407 M125 409 Q258 501 429 510 M618 520L618 487 M244 484L246 449 M810 468L812 438" fill="none" stroke="#929583" />
      {water ? <path d="M217 357 Q289 305 370 340 Q455 301 535 340 Q652 304 771 353 Q838 392 719 422 Q580 472 399 436 Q256 426 217 357Z" fill="#92c5c5" /> : null}
      {mountain ? <g><path d="M204 346 Q230 307 266 230 Q287 191 307 252 Q344 318 385 340 Q424 270 444 157 Q457 107 480 174 Q527 299 608 338 Q642 274 663 242 Q695 204 711 267 L764 346" fill="#b6bfaa" /><path d="M221 331L272 246L286 270L303 220 M402 337Q444 260 454 167L481 247L503 236L553 327 M619 331L675 250L691 294" fill="none" stroke="#7c8270" /></g> : null}
      {buildings ? <g>
        {(theme === "heritage" ? [[270, 310, 1], [420, 300, 1.2], [620, 320, 1.1]] : [[440, 310, theme === "culture" ? 2.1 : 1.8]]).map(([x, y, s], i) => <g key={i} transform={`translate(${x} ${y}) scale(${s})`}><path d="M-60 0L15 18L77-14V-89L15-63L-60-83Z" fill="#efe9d8" /><path d="M-80-84L-8-124L90-92L15-53Z" fill={theme === "dining" ? "#ba8170" : "#809187"} /><path d="M15 18V-54 M-68-87L15-65L79-95 M-9-121L15-65" fill="none" /><path d="M-38-43L-10-36V5L-38-2Z M37-42L58-51V-26L37-17Z" fill="#b8b5a3" /></g>)}
        <path d="M217 394L367 358L533 411L764 366" fill="none" stroke="#f9f5e9" strokeWidth="19" />
      </g> : null}
      {!mountain && !buildings ? <g><path d="M291 297L449 270L533 290L696 270L697 402L532 421L445 402L291 431Z" fill="#f8f3e6" /><path d="M533 290L532 421 M319 329L418 308 M319 358L418 339 M319 389L418 369" fill="none" stroke="#8a9484" /><ellipse cx="613" cy="345" rx="45" ry="28" fill="#e9ddbb" /><path d="M600 366L627 323L632 351Z" fill="#d96b4e" /></g> : null}
      {theme !== "notebook" ? <g><path d="M186 375V311 M802 390V322" fill="none" strokeWidth="5" /><path d="M155 319Q133 283 169 279Q171 240 198 269Q240 266 216 302Q222 335 186 324Z M772 326Q754 292 788 286Q812 259 831 293Q859 330 823 337Z" fill="#a6b89f" /></g> : null}
    </g>
  </svg>;
}

export function DestinationSketchWorld({ scene, selectedId, onSelect, locale = "zh-CN" }) {
  const english = locale === "en";
  const { sketch } = scene;
  const mountRef = useRef(null), stageRef = useRef(null), rendererRef = useRef(null);
  const hotspotRefs = useRef(new Map());
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const [status, setStatus] = useState("loading");
  const [failure, setFailure] = useState("");
  const [tourPlaying, setTourPlaying] = useState(false);
  const [presentation, setPresentation] = useState("solid");
  const [attempt, setAttempt] = useState(0);
  const [preferences, setPreferences] = useState(() => ({ reduced: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, saveData: globalThis.navigator?.connection?.saveData ?? false }));
  const policy = destinationSketchPolicy({ webglAvailable: status !== "static", prefersReducedMotion: preferences.reduced, saveData: preferences.saveData });
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"), connection = globalThis.navigator?.connection;
    const update = () => setPreferences({ reduced: media?.matches ?? false, saveData: connection?.saveData ?? false });
    media?.addEventListener("change", update); connection?.addEventListener?.("change", update);
    return () => { media?.removeEventListener("change", update); connection?.removeEventListener?.("change", update); };
  }, []);
  useEffect(() => {
    let cancelled = false, activeRenderer = null;
    setStatus("loading"); setFailure(""); setTourPlaying(false); setPresentation("solid");
    const fail = (reason) => {
      if (cancelled) return;
      setFailure(reason); setStatus("static"); setTourPlaying(false);
      activeRenderer?.dispose(); activeRenderer = null; rendererRef.current = null;
      for (const element of hotspotRefs.current.values()) if (element) element.style.visibility = "";
    };
    import("./destination-sketch-renderer.js").then(({ createDestinationSketchRenderer }) => {
      if (cancelled || !mountRef.current) return;
      activeRenderer = createDestinationSketchRenderer({
        container: mountRef.current, sketch, reducedMotion: preferences.reduced || preferences.saveData,
        onChapter: (id) => { if (!cancelled) onSelectRef.current(id); },
        onTourChange: (playing) => { if (!cancelled) setTourPlaying(playing); }, onError: fail,
        onProject: (points) => {
          if (cancelled) return;
          points.forEach(({ id, x, y, visible }) => { const element = hotspotRefs.current.get(id); if (!element) return; element.style.left = `${x}px`; element.style.top = `${y}px`; element.style.visibility = visible ? "visible" : "hidden"; });
        },
        onMetrics: (metrics) => { if (!cancelled && stageRef.current) { stageRef.current.dataset.sketchMetrics = JSON.stringify(metrics); stageRef.current.dataset.renderCount = String(metrics.renders); } },
      });
      rendererRef.current = activeRenderer; setStatus("ready");
    }).catch(() => fail("webgl_unavailable"));
    return () => { cancelled = true; activeRenderer?.dispose(); activeRenderer = null; rendererRef.current = null; };
  }, [sketch, preferences.reduced, preferences.saveData, attempt]);
  const pick = (id) => { rendererRef.current?.focus(id); onSelect(id); };
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget || !rendererRef.current) return;
    const commands = { ArrowLeft: () => rendererRef.current.orbit(-0.22), ArrowRight: () => rendererRef.current.orbit(0.22), ArrowUp: () => rendererRef.current.orbit(0, -0.12), ArrowDown: () => rendererRef.current.orbit(0, 0.12), "+": () => rendererRef.current.zoom(1.18), "=": () => rendererRef.current.zoom(1.18), "-": () => rendererRef.current.zoom(1 / 1.18), Home: () => rendererRef.current.reset(), " ": () => rendererRef.current.stopTour() };
    if (commands[event.key]) { event.preventDefault(); commands[event.key](); }
  };
  return <div className="destination-sketch-world">
    <div ref={stageRef} className="destination-sketch-stage" data-sketch-renderer={status === "ready" ? "webgl" : status} data-sketch-theme={sketch.theme.id} data-tour-playing={tourPlaying} data-sketch-failure={failure || undefined}>
      <div ref={mountRef} className="destination-sketch-mount" tabIndex={status === "ready" ? 0 : -1} role="group" aria-label={english ? "3D island. Arrow keys rotate, plus or minus zoom, Home resets, Space stops the tour." : "三维旅行岛。方向键旋转，加减键缩放，Home 重置，空格停止导览。"} onKeyDown={onKeyDown} />
      {status === "static" ? <StaticSketch theme={sketch.theme.id} english={english} /> : null}
      <header className="destination-sketch-heading"><span>{english ? sketch.theme.englishLabel : sketch.theme.label}<i aria-hidden="true"> / </i>{english ? "TRAVEL AGENT" : "旅行的一页"}</span><h2 id="destination-experience-title">{english ? `Step into ${scene.title}` : `走进${scene.title}`}</h2><p>{english ? sketch.theme.englishCaption : sketch.theme.caption}</p></header>
      <div className="destination-sketch-authenticity">{english ? sketch.englishAuthenticityLabel : sketch.authenticityLabel}</div>
      {status === "loading" ? <div className="destination-sketch-loading" role="status"><CircleNotch className="spin" /><span>{english ? "Unfolding this little world…" : "正在展开这一页小世界…"}</span></div> : null}
      {status !== "loading" ? sketch.hotspots.map((hotspot, index) => <button key={hotspot.id} ref={(element) => { if (element) hotspotRefs.current.set(hotspot.id, element); else hotspotRefs.current.delete(hotspot.id); }} type="button" className={`destination-sketch-hotspot ${selectedId === hotspot.id ? "selected" : ""}`} style={status === "static" ? { left: `${[28, 52, 76][hotspot.id === "route" ? 2 : index]}%`, top: `${hotspot.id === "place" ? 61 : hotspot.id === "route" ? 66 : 44}%` } : undefined} aria-label={`${english ? hotspot.englishLabel : hotspot.label} · ${english ? "scene hotspot" : "场景热点"}`} aria-pressed={selectedId === hotspot.id} onClick={() => pick(hotspot.id)}><span>{index + 1}</span><small>{english ? hotspot.englishLabel : hotspot.label}</small></button>) : null}
      {status === "ready" ? <><div className="destination-sketch-instruction"><Hand />{english ? "Drag to turn · pinch to zoom" : "拖动旋转 · 双指缩放"}</div><div className="destination-sketch-tools" role="group" aria-label={english ? "View controls" : "视角控制"}>
        {[["向左旋转", "Rotate left", ArrowLeft, () => rendererRef.current?.orbit(-0.35)], ["向右旋转", "Rotate right", ArrowRight, () => rendererRef.current?.orbit(0.35)], ["缩小", "Zoom out", Minus, () => rendererRef.current?.zoom(1 / 1.18)], ["放大", "Zoom in", Plus, () => rendererRef.current?.zoom(1.18)], ["重置视角", "Reset view", ArrowCounterClockwise, () => rendererRef.current?.reset()]].map(([zh, en, Icon, action]) => <button key={en} type="button" onClick={action} aria-label={english ? en : zh} title={english ? en : zh}><Icon /></button>)}
      </div></> : null}
    </div>
    <div className="destination-sketch-controls"><div className="destination-sketch-chapters" role="group" aria-label={english ? "Explore chapters" : "探索章节"}>{sketch.hotspots.map((hotspot, index) => <button type="button" key={hotspot.id} aria-pressed={selectedId === hotspot.id} onClick={() => pick(hotspot.id)}><b>{String(index + 1).padStart(2, "0")}</b>{english ? hotspot.englishLabel : hotspot.label}</button>)}</div><button type="button" className="destination-sketch-tour" disabled={status !== "ready" || !policy.canTour} onClick={() => { if (tourPlaying) rendererRef.current?.stopTour(); else rendererRef.current?.startTour(); }} aria-pressed={tourPlaying}>{tourPlaying ? <Pause weight="fill" /> : <Play weight="fill" />}{tourPlaying ? (english ? "Pause tour" : "暂停导览") : (english ? "Show me around" : "带我看看")}<small>{english ? "7 sec" : "7 秒"}</small></button></div>
    {status === "ready" ? <label className="destination-sketch-presentation"><span>{english ? "See the shape" : "换一种方式看"}</span><select aria-label={english ? "3D presentation" : "三维展示方式"} value={presentation} onChange={(event) => { setPresentation(event.target.value); rendererRef.current?.setPresentation(event.target.value); }}><option value="solid">{english ? "Solid & ink" : "实体墨线"}</option><option value="ink">{english ? "Line drawing" : "空间线稿"}</option><option value="points">{english ? "Surface points" : "点云轮廓"}</option></select><small>{english ? "All views use the same 3D geometry" : "同一立体场景，可继续旋转与缩放"}</small></label> : null}
    {status === "static" ? <p className="destination-sketch-status" role="status">{english ? "3D is unavailable here. The static notebook, sources and route draft remain available." : "当前 3D 不可用，已切换静态手账；资料与路线试排仍可使用。"}<button type="button" onClick={() => setAttempt((value) => value + 1)}>{english ? "Retry 3D" : "重试 3D"}</button></p> : preferences.reduced || preferences.saveData ? <p className="destination-sketch-status">{preferences.reduced ? (english ? "Reduced motion is on. Use the view buttons; the animated tour is off." : "已遵循减少动态效果设置；可用按钮切换视角，连续导览已关闭。") : (english ? "Data saver is on. The animated tour is off." : "已开启节省流量；连续导览已关闭。")}</p> : null}
  </div>;
}
