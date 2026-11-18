import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, BookOpen, Camera, ImageSquare, PaintBrush, UploadSimple } from "@phosphor-icons/react";
import { destinationPaintingStyle } from "../media/destination-painting.js";
import { artworkHostMode, generateDestinationArtwork } from "./destination-artwork.js";
import { createPaintingPlates } from "./painting-plates.js";
import { PaintingPreview } from "./painting-preview.jsx";
import { fetchReliefSourcePhoto } from "./photo-relief-source.js";
import { prepareJournalPhoto } from "./travel-journal-photo.js";
import { api, isEmbeddedTravelClient } from "./api-client.js";
import { MemoryBook } from "./memory-book.jsx";
import { entryTemplate } from "../media/journal-templates.js";
import { journalSurface } from "./journal-materials.js";

function SourcePicture({ media, alt, onError }) {
  const [source, setSource] = useState("");
  const error = useRef(onError); error.current = onError;
  useEffect(() => {
    if (!media.googlePhotoName) return;
    const controller = new AbortController();
    api.googlePhoto(media.googlePhotoName, controller.signal).then(result => {
      if (!controller.signal.aborted) setSource(`data:${result.mimeType};base64,${result.data}`);
    }).catch(() => { if (!controller.signal.aborted) error.current?.(); });
    return () => controller.abort();
  }, [media.googlePhotoName]);
  return <img src={media.displayUrl || source || undefined} alt={alt} referrerPolicy="no-referrer" onError={onError} />;
}

async function sourceFile(media, signal) {
  if (!media.googlePhotoName) return fetchReliefSourcePhoto(media.displayUrl,signal);
  const photo = await api.googlePhoto(media.googlePhotoName,signal);
  return new Blob([Uint8Array.from(atob(photo.data), c => c.charCodeAt(0))], { type:photo.mimeType });
}

export function DestinationPaintingWorkspace({ scene, node, tripId, english, onDirtyChange, trialAction }) {
  const pick = (zh,en) => english ? en : zh;
  const [mediaId, setMediaId] = useState(null), [photo, setPhoto] = useState(null);
  const [drawing, setDrawing] = useState(null), [compare, setCompare] = useState(false);
  const [journaling, setJournaling] = useState(false);
  const [pageTemplate, setPageTemplate] = useState(null);
  const writeButton = useRef(null);
  const [phase, setPhase] = useState(""), [error, setError] = useState(""), [broken, setBroken] = useState(false);
  const operation = useRef(null), input = useRef(null);
  useEffect(() => () => operation.current?.abort(), []);
  const media = scene.media.find(row => row.mediaId === mediaId) ?? scene.media[0];
  const style = destinationPaintingStyle(node);
  const eligible = !["food","transport"].includes(scene.domain);
  const available = eligible && Boolean(artworkHostMode());
  const stop = () => { operation.current?.abort(); setPhase(""); };
  const generate = async (selection, previous) => {
    stop();
    const controller = new AbortController(), { signal } = controller;
    operation.current = controller;
    setJournaling(false); setError(""); setDrawing(null); setCompare(false); setBroken(false);
    setPhoto(previous ?? null); setPhase("read");
    let stage = "read";
    try {
      const selected = previous ?? { ...await prepareJournalPhoto(selection.file ?? await sourceFile(selection.media,signal)), source: selection.media?.source, kind: selection.file ? "upload" : "source" };
      signal.throwIfAborted(); setPhoto(selected);
      stage = "draw"; setPhase(stage);
      const onDepth = () => { signal.throwIfAborted(); stage = "depth"; setPhase(stage); };
      const result = await generateDestinationArtwork({ photo: selected, style, tripId, signal, onDepth });
      onDepth();
      const plates = await createPaintingPlates(result, signal);
      signal.throwIfAborted(); setDrawing(plates);
    } catch (cause) {
      if (!signal.aborted) {
        if (stage === "read") setError(selection.file ? pick("照片无法读取，请选择 12 MB 以内的 JPG、PNG 或 WebP。","Choose a readable JPG, PNG or WebP under 12 MB.") : pick("来源图片无法读取。请换一张，或上传本机照片。","This source image could not be read. Choose another or upload a photo."));
        else if (stage === "depth" || cause.message==="artwork_depth_invalid") setError(pick("未能读到完整画作或可用的前后景轮廓，可以重新生成。","The drawing or its depth outlines could not be read. Try generating again."));
        else setError(pick("宿主未返回手绘图片。请检查宿主的图片生成能力，或重试。","The host did not return a drawing. Check its image-generation capability or retry."));
      }
    } finally { if (!signal.aborted) setPhase(""); }
  };
  const select = item => {
    setMediaId(item.mediaId); setBroken(false);
    if (available) void generate({ media:item });
    else { stop(); setPhoto(null); setDrawing(null); setError(""); }
  };
  const preview = photo || media;
  const loading = { read: pick("正在读取照片…","Reading photograph…"), draw: pick("宿主正在绘制…","Waiting for the host drawing…"), depth: pick("正在整理前后景…","Preparing depth layers…") };
  const caption = scene.facts.find(fact => fact.label === "此行体验线索")?.value;
  const template = pageTemplate ?? entryTemplate(null, node);
  const source = photo?.kind === "upload" ? pick("我的照片","My photograph")
    : [photo?.source ?? media?.source, ...(media?.authors ?? []).map(a => a.name)].filter(Boolean).join(" · ").slice(0,500);
  const closeEditor = () => {
    setJournaling(false); setPageTemplate(null);
    requestAnimationFrame(() => writeButton.current?.focus({preventScroll:true}));
  };
  return <div className="destination-photo-workspace">
    <header className="destination-photo-heading">
      <div><h2>{scene.title}</h2><p>{drawing ? (english ? style.en : style.zh) : pick("景点照片", "Place photograph")}</p></div>
      {drawing && <button type="button" className="button secondary painting-compare" aria-pressed={compare}
        onClick={() => setCompare(value => !value)}><ImageSquare aria-hidden="true" />{compare ? pick("回到手绘","View illustration") : pick("对照原照片","View original")}</button>}
    </header>
    {available && <input ref={input} hidden type="file" accept="image/jpeg,image/png,image/webp" aria-label={pick("选择景点照片文件","Choose a place photo file")} onChange={event => { const file = event.target.files?.[0]; event.target.value=""; if (file) void generate({file}); }} />}
    {available && !drawing && <p className="destination-painting-note">{pick("选中的照片会交给当前宿主绘制","Your selected photo is sent to the current host to draw")} · {english ? style.en : style.zh}</p>}
    {phase && <div className="painting-progress"><span role="status">{loading[phase]}</span><button type="button" onClick={stop}>{pick("停止等待","Stop waiting")}</button></div>}
    {error && <p className="destination-photo-error" role="alert">{error}</p>}
    <div className={journaling ? "painting-desk notebook-spread" : "painting-desk"} data-binding={journaling ? template : undefined} style={journaling ? journalSurface(template) : undefined}>
    {journaling && <i className="notebook-binding binding-surface" aria-hidden="true"/>}
    <div className="painting-desk-image">
    {drawing ? <PaintingPreview drawing={drawing} title={scene.title} english={english} comparisonPhoto={compare ? photo : null}
      originalAlt={photo?.kind === "upload" ? pick("你选中的景点照片","Your selected photo") : media?.alt || scene.title} /> :
      preview && !broken ? <figure className="destination-photo-original">{photo ? <img src={"data:image/jpeg;base64," + photo.data} alt={photo.kind==="upload" ? pick("你选中的景点照片","Your selected photo") : media?.alt} onError={() => setBroken(true)} /> : <SourcePicture key={media.mediaId} media={media} alt={media.alt} onError={() => setBroken(true)} />}</figure> :
      <div className="destination-photo-empty"><Camera /><p>{preview ? pick("照片暂时无法显示","Photo unavailable") : pick("这个地点还没有可展示的照片","No place photo yet")}</p>{preview && <button type="button" className="button secondary" onClick={()=>setBroken(false)}><ArrowClockwise />{pick("重试照片","Retry photo")}</button>}</div>}
    {(photo || media) && <p className="destination-photo-source">{photo?.kind === "upload" ? pick("你的照片","Your photo") : photo?.source ?? media?.source}</p>}
    {photo?.kind !== "upload" && media?.authors?.length>0 && <div className="destination-photo-source">{media.authors.map((a,i)=>a.uri ? <a key={i} href={a.uri} target="_blank" rel="noreferrer">{a.name}</a> : <span key={i}>{a.name}</span>)}</div>}
    </div>
    {journaling && <MemoryBook node={node} tripId={tripId} drawing={drawing} source={source} english={english}
      onDirtyChange={onDirtyChange} onTemplateChange={setPageTemplate} onCloseComposer={closeEditor}/>}
    </div>
    {!journaling && scene.media.length>0 && (scene.media.length>1 || photo?.kind==="upload") && <div className="destination-photo-picker" role="group" aria-label={pick("选择景点照片","Choose a place photo")}>{scene.media.map((item,index)=><button type="button" key={item.mediaId} aria-pressed={photo?.kind!=="upload" && item.mediaId===media?.mediaId} aria-label={pick(`来源照片 ${index+1}`,`Source photo ${index+1}`)} onClick={()=>select(item)}><SourcePicture media={item} alt="" /><span>{index+1}</span></button>)}</div>}
    {caption && <p className="painting-caption">{caption}</p>}
    {scene.routeRelation && <p className="painting-route-fact">{scene.routeRelation.label}{scene.routeRelation.minutes != null && pick(` · 约 ${Math.round(scene.routeRelation.minutes)} 分钟`, ` · about ${Math.round(scene.routeRelation.minutes)} min`)}</p>}
    {eligible && !available && <p className="destination-painting-note">{pick("在支持图片生成和回传的宿主中打开，即可绘制这张照片。","Open in a host with image generation to illustrate this photo.")}</p>}
    <footer className={journaling ? "painting-page-actions" : "painting-page-actions is-viewing"}>
      {drawing && !journaling && isEmbeddedTravelClient() && <button ref={writeButton} className="button brand" type="button" onClick={() => setJournaling(true)}><BookOpen aria-hidden="true" />{pick("记一笔","Write a memory")}</button>}
      {available && !phase && !drawing && (photo || (media && !broken)) && <button type="button" className="button primary" onClick={() => void generate({media}, photo)}><PaintBrush />{error ? pick("重新生成","Try again") : pick("用这张照片生成手绘","Illustrate this photo")}</button>}
      {available && !journaling && <button type="button" className="button secondary" onClick={() => input.current?.click()}><UploadSimple />{drawing ? pick("换一张照片","Change photo") : pick("上传照片生成手绘","Illustrate my photo")}</button>}
      {trialAction}
    </footer>
  </div>;
}
