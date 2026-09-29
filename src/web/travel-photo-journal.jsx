import { useEffect, useRef, useState } from "react";
import { Camera, Plus, ArrowRight, Trash, ArrowClockwise } from "@phosphor-icons/react";
import { api } from "./api-client.js";
import { blobBase64, prepareJournalPhoto } from "./travel-journal-photo.js";
import { PhotoReliefPreview } from "./photo-relief-preview.jsx";
import { canPreviewPhotoRelief, defaultPhotoRelief } from "../media/photo-relief-recipe.mjs";
import "./travel-photo-journal.css";

function SavedPhotos({ tripId, entry, pick, onPlanPhoto, onDelete }) {
  const [photos, setPhotos] = useState([]), [active, setActive] = useState(0);
  const [error, setError] = useState(false), [attempt, retry] = useState(0), [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const controller = new AbortController(), urls = [];
    setPhotos([]); setError(false); setActive(0); setConfirmDelete(false);
    Promise.all(entry.photos.map(async (photo) => {
      const blob = await api.journalPhoto(tripId, entry.id, photo.id, controller.signal);
      if (controller.signal.aborted) return null;
      const url = URL.createObjectURL(blob); urls.push(url);
      return { ...photo, blob, url };
    })).then((values) => { if (!controller.signal.aborted) setPhotos(values); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [tripId, entry.id, attempt]);
  const plan = async () => {
    setBusy(true);
    try { await onPlanPhoto({ data: await blobBase64(photos[active].blob), mimeType: "image/jpeg", name: "travel-photo.jpg", note: entry.note, placeTitle: entry.placeTitle }); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <article className="journal-record">
    <header><span>{entry.stage === "visited" ? pick("在路上的记录", "On this trip") : pick("想去的灵感", "An idea for later")}</span><time>{entry.takenOn || entry.createdAt.slice(0, 10)}</time></header>
    {photos.length ? <>
      {canPreviewPhotoRelief(entry.subject) ? <PhotoReliefPreview key={`${entry.id}-${photos[active].id}`} src={photos[active].url} subject={entry.subject} recipe={photos[active].relief} title={entry.placeTitle} english={pick(false, true)} /> : <figure><img src={photos[active].url} onError={() => setError(true)} alt={pick(`${entry.placeTitle}，我的食物照片 ${active + 1}`, `My food photo ${active + 1} at ${entry.placeTitle}`)} /><figcaption>{pick("我的原始视角 · 食物仅作为图文记录", "My perspective · food is kept as a photo record")}</figcaption></figure>}
      {photos.length > 1 ? <div className="journal-thumbnails" aria-label={pick("不同拍摄角度", "Photo angles")}>{photos.map((photo, index) => <button key={photo.id} type="button" aria-pressed={active === index} aria-label={pick(`查看照片 ${index + 1}`, `View photo ${index + 1}`)} onClick={() => setActive(index)}><img src={photo.url} alt="" /><span>{index + 1}</span></button>)}</div> : null}
    </> : <p role="status">{error ? pick("照片读取失败，记录仍保留。", "Photos could not load; your record is safe.") : pick("正在读取照片…", "Loading photographs…")}</p>}
    {error ? <div role="alert"><p>{pick("这张照片暂时无法显示，请重新读取。", "This photo could not be displayed. Try loading it again.")}</p><button type="button" className="button secondary" onClick={() => retry(attempt + 1)}><ArrowClockwise />{pick("重新读取", "Retry")}</button></div> : null}
    {entry.note ? <p className="journal-record-note">{entry.note}</p> : null}
    <p className="journal-model-status">{canPreviewPhotoRelief(entry.subject) ? pick("立体预览使用这条记录的照片，在本机重建深度浮雕；不调用第三方建模服务。", "The relief is rebuilt from this record's photo on your device, without third-party modelling.") : pick("食物保留照片与文字，不参与景色或建筑建模。", "Food is kept as photos and notes, not scenery or building models.")}</p>
    <div className="journal-record-actions"><button type="button" className="button primary" disabled={!photos.length || busy} onClick={plan}>{pick("拿这张照片继续规划", "Plan with this photo")}<ArrowRight /></button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash />{pick("删除", "Delete")}</button></div>
    {confirmDelete ? <div className="journal-delete" role="group" aria-label={pick("确认删除记录", "Confirm deletion")}><p>{pick("永久删除这条记录及其照片？不会改变行程。", "Delete this record and its photos permanently? Your itinerary will not change.")}</p><button type="button" className="button secondary" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(entry.id); } finally { setBusy(false); } }}>{pick("确认删除", "Delete permanently")}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>{pick("保留", "Keep")}</button></div> : null}
  </article>;
}

export function TravelPhotoJournal({ node = null, tripId, locale, onPlanPhoto, onDirtyChange }) {
  const pick = (zh, en) => locale === "en" ? en : zh;
  const [entries, setEntries] = useState([]), [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false), [attempt, retry] = useState(0);
  const [photos, setPhotos] = useState([]), [subject, setSubject] = useState(node?.domain === "food" ? "food" : node?.domain === "play" ? "landscape" : "building");
  const [previewIndex, setPreviewIndex] = useState(0), [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState("wish"), [note, setNote] = useState(""), [takenOn, setTakenOn] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [writing, setWriting] = useState(false);
  const id = useRef(crypto.randomUUID()), input = useRef(null), operation = useRef(false);
  const dirty = photos.length > 0 || note.length > 0 || takenOn.length > 0 || busy;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const block = (event) => { event.preventDefault(); event.returnValue = ""; };
    if (dirty) window.addEventListener("beforeunload", block);
    return () => window.removeEventListener("beforeunload", block);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError(false);
    api.journal(tripId, node?.nodeId, controller.signal).then(({ entries: values }) => {
      if (controller.signal.aborted) return;
      setEntries(values); setSelected(values[0]?.id ?? null); setWriting(Boolean(node) && !values.length);
    }).catch(() => { if (!controller.signal.aborted) setLoadError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tripId, node?.nodeId, attempt]);
  const choose = async (files) => {
    if (operation.current) return;
    const requested = Array.from(files ?? []); if (!requested.length) return;
    if (photos.length + requested.length > 3) { setError(pick("每条记录最多 3 张照片，可拍同一主体的不同角度。", "Use up to 3 photos per record, showing different angles of one subject.")); return; }
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const prepared = [];
      for (const file of requested) prepared.push({ ...await prepareJournalPhoto(file), key: crypto.randomUUID(), relief: defaultPhotoRelief() });
      setPhotos((current) => [...current, ...prepared]); id.current = crypto.randomUUID();
    } catch { setError(pick("请选择 12MB 内的 JPG、PNG 或 WebP。若仍无法读取，请换一张或先导出为 JPG。已选照片会保留。", "Choose JPG, PNG or WebP under 12 MB. Try another photo or export as JPG. Previously selected photos are kept.")); }
    finally { operation.current = false; setBusy(false); if (input.current) input.current.value = ""; }
  };
  const save = async (event) => {
    event.preventDefault(); if (operation.current || !node) return;
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const entry = await api.saveJournalEntry(tripId, { id: id.current, nodeId: node.nodeId, subject, stage, note, takenOn, photos: photos.map(({ data, relief }) => ({ data, ...(canPreviewPhotoRelief(subject) ? { relief: relief ?? defaultPhotoRelief() } : {}) })) });
      setEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)]); setSelected(entry.id);
      setPhotos([]); setNote(""); setTakenOn(""); setWriting(false); id.current = crypto.randomUUID();
      setNotice(pick("已保存到这趟旅行。照片没有提交给 AI，行程未改变。", "Saved to this trip. No photos sent to AI; itinerary unchanged."));
    } catch (failure) { setError(failure.code === "journal_trip_limit" ? pick("这趟旅行已存满 40 条记录，请先删除不需要的记录。", "This trip has 40 records. Remove an unneeded record first.") : failure.code === "journal_node_not_found" ? pick("地点已更新，请保留照片并重新打开地点。", "This place changed. Keep your photos and reopen the place.") : pick("保存未确认，照片和文字仍保留。可安全重试，不会重复创建。", "Save was not confirmed. Photos and text are kept; retrying will not duplicate this record.")); }
    finally { operation.current = false; setBusy(false); }
  };
  const edit = (setter, value) => { setter(value); id.current = crypto.randomUUID(); };
  const current = entries.find((entry) => entry.id === selected);
  const activePhotoIndex = Math.min(previewIndex, Math.max(0, photos.length - 1)), activePhoto = photos[activePhotoIndex];
  const pastePhotos = (event) => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); void choose(files); } };
  return <section className="travel-photo-journal" aria-labelledby="travel-journal-title">
    <header className="journal-intro"><span>{pick("我的旅行手账", "MY TRAVEL JOURNAL")}</span><h2 id="travel-journal-title">{node?.title ?? pick("这一路，值得记住", "Moments worth keeping")}</h2><p>{pick("出发前留住灵感，路途中记下自己的发现。", "Keep an idea before you go. Record a discovery while you travel.")}</p></header>
    <p className="journal-privacy">{pick("仅这趟旅行的成员可见。保存的是压缩照片，已移除定位等文件元数据；请勿上传证件或他人的私密信息。游客记录随游客行程的有效期可访问，登录合并后继续保留。", "Visible only to this trip's members. Compressed photos have location/file metadata removed. Do not upload IDs or others' private information. Guest records remain accessible while the guest trip is valid; sign in to keep them with your account.")}</p>
    {loading ? <p role="status">{pick("正在打开手账…", "Opening journal…")}</p> : null}
    {!node && !loading && !loadError ? <p className="journal-privacy">{pick(entries.length ? "这里保留整趟旅行的照片，即使原来的候选不再展示。添加新照片请打开对应地点的详情。" : "还没有照片记录。从任意地点详情打开「留下旅行记录」，不必先把地点加入行程。", entries.length ? "Photos stay here even if an earlier option is no longer shown. To add photos, open the place details." : "No photos yet. Open My photos & memories in any place's details. You do not need to adopt the option first.")}</p> : null}
    {loadError ? <div role="alert"><p>{pick("手账暂时读不到，未保存的内容不会替代旧记录。", "Journal unavailable. Unsaved content will not replace existing records.")}</p><button className="button secondary" onClick={() => retry(attempt + 1)}><ArrowClockwise />{pick("重试", "Retry")}</button></div> : null}
    {entries.length ? <nav className="journal-history" aria-label={pick("已有记录", "Saved records")}>{entries.map((entry) => <button key={entry.id} type="button" aria-pressed={entry.id === selected && !writing} disabled={busy} onClick={() => { if (dirty && !window.confirm(pick("放弃尚未保存的照片和备注？", "Discard unsaved photos and notes?"))) return; setPhotos([]); setNote(""); setTakenOn(""); setSelected(entry.id); setWriting(false); }}>{!node ? <strong>{entry.placeTitle}</strong> : null}<span>{entry.stage === "visited" ? pick("已到访", "Visited") : pick("想去", "Wish")}</span>{entry.takenOn || entry.createdAt.slice(0, 10)}</button>)}{node ? <button type="button" disabled={busy} aria-pressed={writing} onClick={() => setWriting(true)}><Plus />{pick("再记一笔", "New entry")}</button> : null}</nav> : null}
    {notice ? <p className="journal-notice" role="status">{notice}</p> : null}
    {error ? <p className="journal-error" role="alert">{error}</p> : null}
    {node && writing && !loading ? <form onSubmit={save} onPaste={pastePhotos} className="journal-form"><fieldset disabled={busy}>
      <legend>{pick("记录这个地方", "Record this place")}</legend>
      <div className="journal-form-row"><label>{pick("拍的是什么", "Subject")}<select value={subject} onChange={(event) => edit(setSubject, event.target.value)}><option value="landscape">{pick("自然景色", "Natural scenery")}</option><option value="building">{pick("当地特色建筑", "Local architecture")}</option><option value="food">{pick("食物 · 仅图文记录", "Food · photo record only")}</option></select></label><label>{pick("旅行时刻", "Trip moment")}<select value={stage} onChange={(event) => edit(setStage, event.target.value)}><option value="visited">{pick("我已到访 · 记下来", "Visited · keep a memory")}</option><option value="wish">{pick("我想去 · 留作灵感", "Want to go · keep an idea")}</option></select></label></div>
      <div className={`journal-dropzone${dragging ? " is-dragging" : ""}`} tabIndex={0} role="group" aria-label={pick("照片上传区域，支持拖入或粘贴图片", "Photo upload area, drop or paste images")} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files); }}>
      <label className="journal-upload"><Camera size={26} /><strong>{photos.length ? pick("补一个角度", "Add another angle") : pick("加入我拍的照片", "Add my photographs")}</strong><span>{pick("同一主体，最多 3 张 · JPG / PNG / WebP", "One subject, up to 3 photos · JPG / PNG / WebP")}</span><input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={photos.length >= 3 || busy} onChange={(event) => void choose(event.target.files)} /></label>
      <small>{pick("也可将图片拖入此处，或聚焦此区域后粘贴图片。", "You can also drop an image here, or focus this area and paste.")}</small></div>
      <div className="journal-photo-drafts">{photos.map((photo, index) => <figure key={photo.key}><button className="journal-photo-pick" type="button" aria-pressed={activePhotoIndex === index} aria-label={pick(`预览照片 ${index + 1}`, `Preview photo ${index + 1}`)} onClick={() => setPreviewIndex(index)}><img src={`data:image/jpeg;base64,${photo.data}`} alt={pick(`待保存照片 ${index + 1}`, `Unsaved photo ${index + 1}`)} /></button><button type="button" onClick={() => edit(setPhotos, photos.filter((_, i) => i !== index))}>{pick("移除", "Remove")}</button></figure>)}</div>
      {activePhoto && canPreviewPhotoRelief(subject) ? <PhotoReliefPreview key={activePhoto.key} src={`data:image/jpeg;base64,${activePhoto.data}`} subject={subject} recipe={activePhoto.relief} onRecipeChange={(relief) => edit(setPhotos, photos.map((photo, index) => index === activePhotoIndex ? { ...photo, relief } : photo))} title={node.title} english={locale === "en"} /> : null}
      <small>{canPreviewPhotoRelief(subject) ? pick("保留完整山水轮廓或建筑主体。选图后即可在本机建立有限视角的立体预览；多张照片分别预览，不会自动拼接成完整 360° 场景。", "Keep the landscape or building in frame. Each photo becomes an on-device, limited-view relief; multiple photos are not stitched into a 360° scene.") : pick("食物只保存为图文旅行记录，不参与建模。", "Food is saved as photos and notes, without modelling.")}</small>
      <label>{pick("拍摄日期（可选）", "Date taken (optional)")}<input type="date" value={takenOn} onChange={(event) => edit(setTakenOn, event.target.value)} /></label>
      <label>{pick("这次想记住什么？", "What would you like to remember?")}<textarea rows={3} maxLength={1000} value={note} onChange={(event) => edit(setNote, event.target.value)} placeholder={pick("例如：傍晚的湖面很安静，想沿这段水岸慢慢走。", "For example: a quiet lakeshore at dusk; I'd love to take a slow walk here.")} /></label>
      <button className="button primary" type="submit" disabled={!photos.length || busy}>{busy ? pick("正在处理…", "Working…") : pick("保存到这趟旅行", "Save to this trip")}<ArrowRight /></button>
    </fieldset></form> : current ? <SavedPhotos key={current.id} tripId={tripId} entry={current} pick={pick} onPlanPhoto={onPlanPhoto} onDelete={async (entryId) => { try { await api.deleteJournalEntry(tripId, entryId); const remaining = entries.filter((entry) => entry.id !== entryId); setEntries(remaining); setSelected(remaining[0]?.id ?? null); setWriting(Boolean(node) && !remaining.length); setNotice(pick("这条记录与照片已删除。", "Record and photos deleted.")); } catch { setError(pick("删除未确认，可重试；没有改变行程。", "Deletion was not confirmed. Retry; itinerary unchanged.")); } }} /> : null}
  </section>;
}
