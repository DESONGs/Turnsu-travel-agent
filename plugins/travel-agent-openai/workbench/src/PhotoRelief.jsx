import { useEffect, useRef, useState } from "preact/hooks";
import { defaultPhotoRelief } from "../../../../src/media/photo-relief-recipe.mjs";

/** A locally rendered photo surface. This is not a 3D reconstruction. */
export function PhotoRelief({ src, subject, title, initialRecipe, onChange, disabled = false }) {
  const [recipe, setRecipe] = useState(() => initialRecipe || defaultPhotoRelief());
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  const [original, setOriginal] = useState(false);
  const [tourPlaying, setTourPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const mount = useRef(null), renderer = useRef(null), currentRecipe = useRef(recipe);
  currentRecipe.current = recipe;

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches || Boolean(navigator.connection?.saveData));
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (original) return;
    const controller = new AbortController(); let active = null;
    setStatus("loading");
    const fail = () => { if (!controller.signal.aborted) { setStatus("error"); active?.dispose(); active = null; renderer.current = null; } };
    import("../../../../src/web/photo-relief-renderer.js").then(async ({ readReliefPixels, createPhotoReliefRenderer }) => {
      const pixels = await readReliefPixels(src, controller.signal);
      if (controller.signal.aborted || !mount.current) return;
      active = createPhotoReliefRenderer({ container: mount.current, pixels, subject, recipe: currentRecipe.current, reducedMotion,
        onError: fail, onTourChange: value => { if (!controller.signal.aborted) setTourPlaying(value); } });
      renderer.current = active; setStatus("ready");
    }).catch(error => { if (error.name !== "AbortError") fail(); });
    return () => { controller.abort(); active?.dispose(); renderer.current = null; };
  }, [src, subject, attempt, original, reducedMotion]);

  function edit(changes) {
    const next = { ...recipe, ...changes }; setRecipe(next); onChange?.(next); renderer.current?.setRecipe(next);
    if (original) setOriginal(false);
  }
  function keyDown(event) {
    if (disabled || event.target !== event.currentTarget || !renderer.current) return;
    const commands = { ArrowLeft: () => renderer.current.orbit(-.12), ArrowRight: () => renderer.current.orbit(.12),
      ArrowUp: () => renderer.current.orbit(0, -.08), ArrowDown: () => renderer.current.orbit(0, .08),
      "+": () => renderer.current.zoom(1.1), "=": () => renderer.current.zoom(1.1), "-": () => renderer.current.zoom(1 / 1.1), Home: () => renderer.current.reset(), " ": () => renderer.current.stop() };
    if (commands[event.key]) { event.preventDefault(); commands[event.key](); }
  }

  return <section class="relief-preview" aria-label="照片浮雕">
    <div class="facts-heading"><h4>照片深度浮雕 <span>2.5D</span></h4><button type="button" disabled={disabled} onClick={() => { renderer.current?.stop(); setTourPlaying(false); setOriginal(!original); }}>{original ? "查看浮雕" : "对照原图"}</button></div>
    <div class="relief-stage">
      {(original || status === "error") && <img src={src} alt={`${title}的原照片`} />}
      {!original && <div class="relief-mount" ref={mount} tabIndex={status === "ready" ? 0 : -1} role="group" aria-label="照片浮雕：拖动或使用方向键环看，加减键缩放，Home 重置" onKeyDown={keyDown} />}
      {!original && status === "loading" && <p role="status">正在本机建立照片层次…</p>}
      {!original && status === "error" && <div class="relief-error" role="alert"><span>浮雕暂时不可用，原照片仍保留。</span><button type="button" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
    </div>
    {!original && <div class="relief-controls" role="group" aria-label="照片视角控制">
      <button type="button" disabled={disabled || status !== "ready"} onClick={() => renderer.current?.orbit(-.16)}>左看</button>
      <button type="button" disabled={disabled || status !== "ready"} onClick={() => renderer.current?.orbit(.16)}>右看</button>
      <button type="button" disabled={disabled || status !== "ready"} onClick={() => renderer.current?.zoom(1 / 1.12)}>缩小</button>
      <button type="button" disabled={disabled || status !== "ready"} onClick={() => renderer.current?.zoom(1.12)}>拉近</button>
      <button type="button" disabled={disabled || status !== "ready"} onClick={() => renderer.current?.reset()}>复位视角</button>
      <button type="button" disabled={disabled || status !== "ready" || reducedMotion} aria-pressed={tourPlaying} onClick={() => renderer.current?.tour()}>{tourPlaying ? "停止环看" : "环看 8 秒"}</button>
    </div>}
    <div class="relief-controls" role="group" aria-label="浮雕风格"><button type="button" disabled={disabled} aria-pressed={recipe.style === "ink"} onClick={() => edit({ style: "ink" })}>墨线淡彩</button><button type="button" disabled={disabled} aria-pressed={recipe.style === "photo"} onClick={() => edit({ style: "photo" })}>原色立体</button></div>
    <details class="relief-settings"><summary>调整远近层次</summary><label>远近分界 <output>{Math.round(recipe.horizon * 100)}%</output><input type="range" min="20" max="80" disabled={disabled} value={Math.round(recipe.horizon * 100)} onInput={event => edit({ horizon: Number(event.currentTarget.value) / 100 })} /></label>
      <label>立体强度 <output>{Math.round(recipe.depth * 100)}%</output><input type="range" min="15" max="100" disabled={disabled} value={Math.round(recipe.depth * 100)} onInput={event => edit({ depth: Number(event.currentTarget.value) / 100 })} /></label>
      <button type="button" disabled={disabled} onClick={() => edit(defaultPhotoRelief())}>恢复默认效果</button>
      <p>{onChange ? "先在本机预览，点击“保存效果”后才更新已保存的照片效果。" : "调整只影响本次查看。"}</p></details>
    <p>仅在本机处理。根据照片和远近假设生成有限视角的浮雕，不是实景扫描，也不还原背面或真实尺寸。</p>
  </section>;
}
