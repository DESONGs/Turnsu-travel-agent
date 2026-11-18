import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowCounterClockwise, Minus, Plus, Play, Pause, Cube, ImageSquare } from "@phosphor-icons/react";
import { defaultPhotoRelief } from "../media/photo-relief-recipe.mjs";
import "./photo-relief.css";

export function PhotoReliefPreview({ src, subject, recipe: initialRecipe, onRecipeChange, title, english = false }) {
  const pick = (zh, en) => english ? en : zh;
  const [recipe, setRecipe] = useState(() => initialRecipe ?? defaultPhotoRelief());
  const [status, setStatus] = useState("loading"), [errorCode, setErrorCode] = useState(""), [attempt, retry] = useState(0);
  const [original, setOriginal] = useState(false), [tourPlaying, setTourPlaying] = useState(false), [reducedMotion, setReducedMotion] = useState(true);
  const mount = useRef(null), renderer = useRef(null), currentRecipe = useRef(recipe), pixels = useRef(null);
  const descriptionId = useId(); currentRecipe.current = recipe;
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(query.matches || Boolean(navigator.connection?.saveData));
    change(); query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (original) return;
    const controller = new AbortController(); let active = null;
    setStatus("loading");
    const fail = (error) => {
      if (controller.signal.aborted) return;
      setStatus("error"); setErrorCode(error?.message ?? ""); active?.dispose(); active = null; renderer.current = null;
    };
    import("./photo-relief-renderer.js").then(async ({ readReliefPixels, createPhotoReliefRenderer }) => {
      if (!pixels.current || pixels.current.src !== src) {
        const data = await readReliefPixels(src, controller.signal);
        if (controller.signal.aborted) return;
        pixels.current = { src, data };
      }
      if (controller.signal.aborted || !mount.current) return;
      active = createPhotoReliefRenderer({ container: mount.current, pixels: pixels.current.data, subject, recipe: currentRecipe.current, reducedMotion, onError: fail, onTourChange: (value) => { if (!controller.signal.aborted) setTourPlaying(value); } });
      renderer.current = active; setStatus("ready");
    }).catch((error) => { if (error.name !== "AbortError") fail(error); });
    return () => { controller.abort(); active?.dispose(); active = null; renderer.current = null; };
  }, [src, subject, attempt, original, reducedMotion]);
  const edit = (changes) => {
    const next = { ...recipe, ...changes }; setRecipe(next); onRecipeChange?.(next);
    renderer.current?.setRecipe(next);
  };
  const keyDown = (event) => {
    if (event.target !== event.currentTarget || !renderer.current) return;
    const commands = { ArrowLeft: () => renderer.current.orbit(-0.12), ArrowRight: () => renderer.current.orbit(0.12), ArrowUp: () => renderer.current.orbit(0, -0.08), ArrowDown: () => renderer.current.orbit(0, 0.08), "+": () => renderer.current.zoom(1.1), "=": () => renderer.current.zoom(1.1), "-": () => renderer.current.zoom(1 / 1.1), Home: () => renderer.current.reset(), " ": () => renderer.current.stop() };
    if (commands[event.key]) { event.preventDefault(); commands[event.key](); }
  };
  return <section className="photo-relief-preview" aria-label={pick("照片立体线稿", "Photo line scene")}>
    <header className="photo-relief-header"><div><strong><Cube />{pick("立体线稿", "Line scene")}</strong></div><button type="button" aria-pressed={original} onClick={() => { renderer.current?.stop(); setTourPlaying(false); setOriginal(!original); }}><ImageSquare />{original ? pick("回到立体", "Back to depth") : pick("对照原图", "Compare original")}</button></header>
    <div className="photo-relief-stage" data-relief-state={original ? "original" : status}>
      {original || status === "error" ? <img className="photo-relief-original" src={src} alt={pick(`${title}，原始照片`, `Original photo of ${title}`)} /> : null}
      {!original ? <div className="photo-relief-mount" ref={mount} role="group" tabIndex={status === "ready" ? 0 : -1} aria-label={pick("照片立体场景：拖动或方向键环看，加减键缩放，Home 重置，空格停止环看。", "Photo relief: drag or use arrow keys to look around, plus/minus to zoom, Home to reset, Space to stop.")} aria-describedby={descriptionId} onKeyDown={keyDown} /> : null}
      {!original && status === "loading" ? <p className="photo-relief-state" role="status">{pick("正在提取照片轮廓…", "Tracing the photograph…")}</p> : null}
      {!original && status === "error" ? <div className="photo-relief-state is-error" role="alert"><strong>{errorCode === "relief_photo_no_contours" ? pick("照片轮廓较少，试试主体更清晰的照片", "Few outlines found. Try a photo with a clearer subject.") : pick("线稿暂时不可用，原照片仍保留", "Line scene unavailable; your photo is safe")}</strong><button type="button" onClick={() => retry(attempt + 1)}>{pick("重新生成线稿", "Retry line scene")}</button></div> : null}
      {!original && status === "ready" ? <span className="photo-relief-hint">{pick("拖动环看 · 双指缩放", "Drag to look around · pinch to zoom")}</span> : null}
    </div>
    {!original ? <div className="photo-relief-controls"><div role="group" aria-label={pick("照片视角控制", "Photo view controls")}>
      {[["左看", "Look left", ArrowLeft, () => renderer.current?.orbit(-0.16)], ["右看", "Look right", ArrowRight, () => renderer.current?.orbit(0.16)], ["缩小照片场景", "Zoom out photo", Minus, () => renderer.current?.zoom(1 / 1.12)], ["拉近照片场景", "Zoom in photo", Plus, () => renderer.current?.zoom(1.12)], ["重置照片视角", "Reset photo view", ArrowCounterClockwise, () => renderer.current?.reset()]].map(([zh, en, Icon, action]) => <button type="button" key={en} disabled={status !== "ready"} aria-label={pick(zh, en)} title={pick(zh, en)} onClick={action}><Icon /></button>)}
    </div><button type="button" className="photo-relief-tour" disabled={status !== "ready" || reducedMotion} aria-pressed={tourPlaying} onClick={() => renderer.current?.tour()}>{tourPlaying ? <Pause /> : <Play />}{tourPlaying ? pick("停止环看", "Stop") : pick("环看 8 秒", "Look around · 8s")}</button></div> : null}
    <div className="photo-relief-styles" role="group" aria-label={pick("照片立体风格", "Photo relief style")}>{[["line", "纯线稿", "Line drawing"], ["ink", "线稿淡彩", "Colour wash"], ...(initialRecipe?.style === "photo" ? [["photo", "原色", "Original colours"]] : [])].map(([style, zh, en]) => <button type="button" key={style} aria-pressed={recipe.style === style} onClick={() => { edit({ style }); if (original) setOriginal(false); }}>{pick(zh, en)}</button>)}</div>
    <details className="photo-relief-settings"><summary>{pick("调整远近层次", "Adjust depth")}</summary><label>{pick("远近分界", "Horizon")}<output>{Math.round(recipe.horizon * 100)}%</output><input aria-label={pick("远近分界", "Horizon")} type="range" min="20" max="80" value={Math.round(recipe.horizon * 100)} onChange={(event) => edit({ horizon: Number(event.target.value) / 100 })} /></label><label>{pick("立体强度", "Depth strength")}<output>{Math.round(recipe.depth * 100)}%</output><input aria-label={pick("立体强度", "Depth strength")} type="range" min="15" max="100" value={Math.round(recipe.depth * 100)} onChange={(event) => edit({ depth: Number(event.target.value) / 100 })} /></label><p>{onRecipeChange ? pick("参数随这条照片记录一起保存。", "These settings are saved with this record.") : pick("调整仅用于本次查看，已保存的参数不会被改写。", "Adjustments apply to this view only; saved settings are unchanged.")}</p></details>
    <p className="photo-relief-disclosure" id={descriptionId}>{pick("在本机从原照片提取轮廓，并添加远近层次。支持小范围转动，不还原背面或真实尺寸。", "Outlines traced on-device with an artistic depth effect. Explore a limited angle; hidden surfaces and real dimensions are not reconstructed.")}{reducedMotion ? pick(" 已关闭连续环看，可手动控制。", " Animated tour is off; manual controls remain available.") : ""}</p>
  </section>;
}
