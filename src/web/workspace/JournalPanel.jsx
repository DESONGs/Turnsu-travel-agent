import { useEffect, useRef, useState } from "react";
import { prepareJournalPhoto } from "../travel-journal-photo.js";
import { canPreviewPhotoRelief, defaultPhotoRelief } from "../../media/photo-relief-recipe.mjs";
import { PhotoRelief } from "./PhotoRelief.jsx";
import { Icon } from "./Icon.jsx";
import { Sheet, ConfirmInline } from "./Sheet.jsx";
import { journalTitle, newJournalDraft, editJournalDraft, journalSaveArguments, sameRelief } from "./journal-state.mjs";
import "./media-workspace.css";

const dayLabel = date => date ? date.replaceAll("-", "/") : "未注明日期";

export function JournalImage({ host, tripId, entryId, photo, onReady, alt = "旅行照片", canRetry = true }) {
  const mount = useRef(null), ready = useRef(onReady);
  const [source, setSource] = useState(photo.data ? `data:image/jpeg;base64,${photo.data}` : null);
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  ready.current = onReady;
  useEffect(() => {
    let alive = true, observer;
    async function read() {
      observer?.disconnect(); setError(false);
      if (photo.data) { const src = `data:image/jpeg;base64,${photo.data}`; setSource(src); ready.current?.(src); return; }
      try {
        const value = await host.call("read_trip_journal_image", { tripId, entryId, photoId: photo.photoId });
        if (value.mimeType !== "image/jpeg" || typeof value.data !== "string") throw new Error("image_unavailable");
        if (alive) { const src = `data:image/jpeg;base64,${value.data}`; setSource(src); ready.current?.(src); }
      } catch { if (alive) setError(true); }
    }
    if (typeof IntersectionObserver === "function" && !photo.data) {
      observer = new IntersectionObserver(entries => { if (entries.some(item => item.isIntersecting)) void read(); }, { rootMargin: "150px" }); observer.observe(mount.current);
    } else void read();
    return () => { alive = false; observer?.disconnect(); };
  }, [tripId, entryId, photo.photoId, photo.data, attempt]);
  return <div className="journal-image" ref={mount}>{error ? <div className="journal-image-failure"><Icon name="Images" /><span>这张照片暂时无法读取</span>{canRetry && <button className="ui-text" type="button" onClick={() => setAttempt(value => value + 1)}>重试这张照片</button>}</div>
    : source ? <img src={source} alt={alt} onError={() => setError(true)} /> : <div className="journal-image-loading" role="status">正在读取照片…</div>}</div>;
}

export function ReliefEditor({ photo, src, entry, canEdit, busy, uncertain, error, onSave, onClose, onDirty }) {
  const baseline = photo.relief || defaultPhotoRelief();
  const [recipe, setRecipe] = useState(baseline), [confirm, setConfirm] = useState(false);
  const dirty = canEdit && !sameRelief(recipe, baseline);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);
  const close = () => dirty || uncertain ? setConfirm(true) : onClose();
  return <Sheet title="照片浮雕" context={journalTitle(entry)} wide onClose={close} busy={busy} className="relief-sheet" footer={<>
    <p>{uncertain ? "保存结果待确认，请按原设置重试" : canEdit ? dirty ? "有尚未保存的效果调整" : "源照片保留，效果单独保存" : "仅查看；调整只影响本次预览"}</p><div className="ui-actions"><button className="ui-secondary" type="button" disabled={busy} onClick={close}>返回照片</button>{canEdit && <button className="ui-primary" type="button" disabled={busy || !dirty} onClick={() => onSave(recipe)}>{busy ? "正在保存…" : uncertain ? "按原设置重试" : "保存效果"}</button>}</div>
  </>}>
    {error && <p className="ui-error" role="alert">{error}</p>}{confirm && <ConfirmInline title={uncertain ? "效果保存结果尚未确认" : "这次浮雕调整还没有保存"} description={uncertain ? "返回后先重新读取照片核对。源照片保留，不会自动重复保存。" : "源照片和上次保存的效果都保留。"} cancel="继续调整" action={uncertain ? "返回并重新读取" : "放弃这次调整"} onCancel={() => setConfirm(false)} onConfirm={onClose} />}
    <div className="relief-sizing" style={{ "--relief-aspect": `${photo.width || 3} / ${photo.height || 2}` }}><PhotoRelief src={src} subject={entry.subject} title={journalTitle(entry)} initialRecipe={baseline} onChange={canEdit ? setRecipe : undefined} disabled={busy || uncertain} /></div>
  </Sheet>;
}

export function JournalPanel({ tripId, revision, host, canEdit, place, selectedDate = "", visits = [], tripTitle = "这趟旅行", onClose, onStatusChange = () => {} }) {
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [listError, setListError] = useState(false);
  const [selected, setSelected] = useState(null), [filter, setFilter] = useState("all"), [limit, setLimit] = useState(12);
  const [draft, setDraft] = useState(() => place ? newJournalDraft({ ...place, date: place.date || selectedDate }) : null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(null);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null), [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState(null), [relief, setRelief] = useState(null), [effectDirty, setEffectDirty] = useState(false);
  const [activePhoto, setActivePhoto] = useState(null), [photoSource, setPhotoSource] = useState(null);
  const alive = useRef(true), readId = useRef(0), pendingSave = useRef(null), pendingEffect = useRef(null), pendingDelete = useRef(null), picker = useRef(null);
  const current = items.find(item => item.entryId === selected);
  const currentPhoto = current?.photos.find(item => item.photoId === activePhoto) || current?.photos[0];
  const dates = [...new Set(items.map(item => item.takenOn || "undated"))].sort().reverse();
  const shown = items.filter(item => filter === "all" || (item.takenOn || "undated") === filter);
  const frozen = busy || Boolean(uncertain);

  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; readId.current++; }; }, [tripId]);
  useEffect(() => { onStatusChange({ dirty: dirty || effectDirty, busy, uncertain: Boolean(uncertain) }); return () => onStatusChange({ dirty: false, busy: false, uncertain: false }); }, [dirty, effectDirty, busy, uncertain, onStatusChange]);
  useEffect(() => { if (!dirty && !effectDirty && !frozen) return; const block = event => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", block); return () => window.removeEventListener("beforeunload", block); }, [dirty, effectDirty, frozen]);

  async function load() {
    const id = ++readId.current; setLoading(true); setListError(false);
    try { const result = await host.call("list_trip_journal", { tripId }); if (!Array.isArray(result.items)) throw new Error("手账暂时无法读取。");
      if (alive.current && id === readId.current) { setItems(result.items); setSelected(value => result.items.some(item => item.entryId === value) ? value : null); }
    } catch (failure) { if (alive.current && id === readId.current) { setListError(true); setError(failure.message || "手账暂时无法读取，请重试。"); } }
    finally { if (alive.current && id === readId.current) setLoading(false); }
  }
  function publish(entry) { setItems(previous => [entry, ...previous.filter(item => item.entryId !== entry.entryId)]); setSelected(entry.entryId); }
  function guard(action) {
    if (busy) return;
    if (uncertain) setConfirm({ title: "保存结果尚未确认", description: "离开后先重新打开手账核对，不要直接重复新建。当前本机编辑将不再保留。", label: "离开并稍后核对", action: () => { setUncertain(null); setDirty(false); action(); } });
    else if (dirty || effectDirty) setConfirm({ title: "还有内容未保存", description: "离开会放弃当前编辑，已保存的旅行记录不会改变。", action }); else action();
  }
  function write(changes) { if (!frozen) { setDraft(previous => ({ ...previous, ...changes })); setDirty(true); setConflict(false); pendingSave.current = null; } }
  function start() { guard(() => { setSelected(null); setDraft(newJournalDraft({ date: selectedDate || (filter !== "all" && filter !== "undated" ? filter : "") })); setDirty(false); setError(null); setNotice(null); setConfirm(null); }); }
  function edit() { setDraft(editJournalDraft(current)); setDirty(false); setError(null); setNotice(null); pendingSave.current = null; }
  async function choose(files) {
    const values = [...files || []]; if (!values.length || frozen) return;
    if (draft.photos.length + values.length > 3) { setError("每条记录最多 3 张照片。请减少所选照片后重试，现有照片保留。"); return; }
    setBusy(true); setError(null); const photos = []; let failures = 0;
    for (const file of values) { try { photos.push({ ...await prepareJournalPhoto(file), photoId: crypto.randomUUID(), relief: null }); } catch { failures++; } }
    if (alive.current) { if (photos.length) { setDraft(previous => ({ ...previous, photos: [...previous.photos, ...photos] })); setDirty(true); pendingSave.current = null; }
      if (failures) setError(`${failures} 张照片无法处理，请使用 12MB 内的 JPG、PNG 或 WebP；其他已选照片保留。`); setBusy(false); if (picker.current) picker.current.value = ""; }
  }
  async function save(event) {
    event.preventDefault(); if (busy || !draft || conflict) return;
    if (!pendingSave.current) pendingSave.current = journalSaveArguments(tripId, revision, draft, crypto.randomUUID());
    setBusy(true); setError(null); setNotice(null);
    try { const result = await host.call("save_trip_journal_entry", pendingSave.current); if (!alive.current) return;
      if (result.status !== "saved" || !result.entry) { setUncertain(null); pendingSave.current = null; setConflict(true); setError("这条记录已被删除，原次保存不会重新创建。当前编辑仍保留，请先返回手账核对。"); return; }
      publish(result.entry); setDraft(null); setDirty(false); setUncertain(null); setFilter("all"); pendingSave.current = null;
      setNotice(result.appliedEntryRevision !== result.entry.entryRevision ? "原次保存已完成；记录随后发生了变化，已显示目前的内容。" : "已保存到这趟旅行。");
    } catch (failure) { if (alive.current) { if (failure.code) { pendingSave.current = null; setUncertain(null); setConflict(["journal_revision_conflict", "journal_entry_not_found"].includes(failure.code)); setError(failure.message); }
      else { setUncertain("save"); setError("网络中断，保存结果尚未确认。请按原内容重试，不会重复创建记录。"); } } }
    finally { if (alive.current) setBusy(false); }
  }
  async function reloadConflict() {
    setBusy(true); try { const result = await host.call("get_trip_journal_entry", { tripId, entryId: draft.entryId }); if (alive.current) { publish(result.entry); setDraft(editJournalDraft(result.entry)); setDirty(false); setConflict(false); setError(null); setConfirm(null); } }
    catch (failure) { if (alive.current) setError(failure.message); } finally { if (alive.current) setBusy(false); }
  }
  async function remove() {
    if (!current || busy) return;
    if (!pendingDelete.current) pendingDelete.current = { tripId, entryId: current.entryId, expectedRevision: revision, expectedEntryRevision: current.entryRevision, requestId: crypto.randomUUID() };
    setBusy(true); setError(null);
    try { const result = await host.call("delete_trip_journal", pendingDelete.current); if (!alive.current) return;
      if (result.status !== "deleted") throw new Error("删除结果尚未确认，请按原操作重试。");
      setItems(previous => previous.filter(item => item.entryId !== current.entryId)); setSelected(null); setConfirm(null); setUncertain(null); pendingDelete.current = null; setNotice("记录和照片已删除，行程保持原样。");
    } catch (failure) { if (alive.current) { if (failure.code) { pendingDelete.current = null; setUncertain(null); } else setUncertain("delete"); setError(failure.message || "删除结果尚未确认，请重试原操作。"); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function saveEffect(recipe) {
    if (busy || !current || !relief) return;
    if (!pendingEffect.current) pendingEffect.current = { tripId, entryId: current.entryId, expectedRevision: revision, expectedEntryRevision: current.entryRevision, photoId: relief.photo.photoId, relief: recipe, requestId: crypto.randomUUID() };
    setBusy(true); setError(null);
    try { const result = await host.call("save_trip_photo_relief", pendingEffect.current); if (!alive.current) return;
      if (result.status !== "saved" || !result.entry) throw Object.assign(new Error("记录已发生变化，请重新打开照片。"), { code: "journal_entry_not_found" });
      publish(result.entry); setRelief(null); setEffectDirty(false); setUncertain(null); pendingEffect.current = null; setNotice("浮雕效果已保存，源照片保持原样。");
    } catch (failure) { if (alive.current) { if (failure.code) { pendingEffect.current = null; setUncertain(null); } else setUncertain("effect"); setError(failure.message || "效果保存结果尚未确认，请按原设置重试。"); } }
    finally { if (alive.current) setBusy(false); }
  }
  const linkedVisit = current?.visitStopId ? visits.find(item => item.stopId === current.visitStopId) : null;
  const errorMessage = error && !relief && <div className="ui-error" role="alert"><p>{error}</p>{conflict && draft?.expectedEntryRevision >= 0 && <button className="ui-text" type="button" onClick={() => setConfirm({ title: "载入云端版本？", description: "这会放弃当前未保存的编辑；可以先取消并保留内容。", action: reloadConflict, label: "放弃本地编辑，载入云端" })}>处理记录冲突</button>}{uncertain === "delete" && <button type="button" className="ui-secondary" disabled={busy} onClick={remove}>重试原次删除</button>}</div>;
  const confirmation = confirm && <ConfirmInline title={confirm.title} description={confirm.description} action={confirm.label} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm.action; setConfirm(null); action(); }} />;
  const editorId = draft ? `journal-editor-${draft.entryId}` : "";
  return <section className="journal-workspace" aria-labelledby="journal-title">
    <div className="journal-topline"><button className="ui-text" type="button" disabled={busy} onClick={() => guard(onClose)}><Icon name="ArrowLeft" />返回行程</button><span>仅这趟旅行的成员可见</span></div>
    <header className="media-page-heading"><div><h2 id="journal-title">照片手账</h2><p>照片、随手记，按你们旅行的日子放在一起。</p></div>{canEdit && !draft && <button className="ui-primary" type="button" disabled={frozen} onClick={start}><Icon name="Plus" />新建记录</button>}</header>
    {notice && <p className="ui-success" role="status"><Icon name="CheckCircle" />{notice}</p>}
    {!draft && errorMessage}{!draft && confirmation}
    {draft ? <Sheet title={draft.expectedEntryRevision === -1 ? "新建旅行记录" : "编辑旅行记录"} context={tripTitle} wide busy={busy} className="journal-editor-sheet" onClose={() => guard(() => { setDraft(null); setDirty(false); })} footer={<>
      <p>{uncertain ? "请先确认这次保存结果" : dirty ? "尚未保存到这趟旅行" : "记录与照片保存到这趟旅行"}</p><div className="ui-actions"><button className="ui-secondary" type="button" disabled={busy} onClick={() => guard(() => { setDraft(null); setDirty(false); })}>取消编辑</button><button className="ui-primary" type="submit" form={editorId} disabled={busy || conflict || (!draft.title.trim() && !draft.note.trim() && !draft.photos.length)}>{busy ? "正在保存…" : uncertain === "save" ? "按原内容重试保存" : "保存记录"}</button></div>
    </>}>
      {errorMessage}{confirmation}<form id={editorId} className="journal-editor" onSubmit={save} onPaste={event => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void choose(files); } }} onDragOver={event => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void choose(event.dataTransfer.files); } }} aria-label="编辑旅行记录">
      <fieldset disabled={frozen}><div className="journal-editor-layout"><section className="journal-editor-story"><label className="ui-field">标题<span>选填</span><input maxLength="120" value={draft.title} placeholder="给这段旅程起个名字" onInput={event => write({ title: event.currentTarget.value })} /></label><label className="ui-field">随手记<span>选填，可只记文字</span><textarea rows="6" maxLength="1000" value={draft.note} placeholder="这一天，有什么想留下来？" onInput={event => write({ note: event.currentTarget.value })} /></label>
        <div className="journal-photo-heading"><h4>照片 <span>{draft.photos.length} / 3</span></h4><label className={`ui-secondary photo-picker ${draft.photos.length >= 3 ? "disabled" : ""}`}><Icon name="Camera" />添加照片<input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={frozen || draft.photos.length >= 3} onChange={event => choose(event.currentTarget.files)} /></label></div><p className="ui-help">保存时上传压缩并移除元数据的照片，原文件留在你的设备。支持 JPG、PNG、WebP，单张不超过 12MB。</p>
        <div className="journal-edit-photos">{draft.photos.map((photo, index) => <figure key={photo.photoId}><JournalImage host={host} tripId={tripId} entryId={draft.entryId} photo={photo} alt={`待保存照片 ${index + 1}`} /><figcaption><span>照片 {index + 1}</span><div><button className="ui-icon-button" type="button" disabled={index === 0} aria-label={`将照片 ${index + 1} 提前`} onClick={() => { const next = draft.photos.slice(); [next[index - 1], next[index]] = [next[index], next[index - 1]]; write({ photos: next }); }}><Icon name="ArrowLeft" /></button><button className="ui-icon-button" type="button" disabled={index === draft.photos.length - 1} aria-label={`将照片 ${index + 1} 后移`} onClick={() => { const next = draft.photos.slice(); [next[index], next[index + 1]] = [next[index + 1], next[index]]; write({ photos: next }); }}><Icon name="ArrowRight" /></button><button className="ui-icon-button" type="button" aria-label={`移除照片 ${index + 1}`} onClick={() => write({ photos: draft.photos.filter(item => item.photoId !== photo.photoId) })}><Icon name="X" /></button></div></figcaption></figure>)}</div>{busy && <p className="ui-help" role="status">正在处理或保存照片，请稍候…</p>}
      </section><aside className="journal-editor-context"><h4>放在哪一天？</h4><label className="ui-field">记录日期<span>选填</span><input type="date" value={draft.takenOn} onInput={event => write({ takenOn: event.currentTarget.value })} /></label><label className="ui-field">关联到访<span>可以先不关联</span><select value={draft.visitStopId} onChange={event => write({ visitStopId: event.currentTarget.value })}><option value="">不关联地点</option>{draft.visitStopId && !visits.some(item => item.stopId === draft.visitStopId) && <option value={draft.visitStopId}>原关联到访（已不在当前安排中）</option>}{visits.map(visit => <option key={visit.stopId} value={visit.stopId}>{visit.date ? `${visit.date} · ` : ""}{visit.name || "这次到访"}</option>)}</select></label><label className="ui-field">旅行时刻<select value={draft.stage} onChange={event => write({ stage: event.currentTarget.value })}><option value="visited">已到访</option><option value="wish">想去</option></select></label>{draft.photos.length > 0 && <label className="ui-field">照片内容<select value={draft.subject} onChange={event => write({ subject: event.currentTarget.value })}><option value="landscape">自然景色</option><option value="building">建筑</option><option value="food">食物</option></select></label>}<p className="ui-help">风景和建筑照片保存后可打开浮雕。食物照片保留为图文，不保存浮雕效果。</p></aside></div></fieldset>
    </form></Sheet> : current ? <article className="journal-detail"><div className="journal-detail-toolbar"><button className="ui-text" type="button" disabled={frozen} onClick={() => { setSelected(null); setPhotoSource(null); }}><Icon name="ArrowLeft" />全部记录</button><span>{dayLabel(current.takenOn)}</span></div><div className="journal-detail-layout"><section className="journal-detail-media">{currentPhoto ? <><JournalImage key={currentPhoto.photoId} host={host} tripId={tripId} entryId={current.entryId} photo={currentPhoto} onReady={setPhotoSource} alt={`${journalTitle(current)}的照片`} /><nav className="journal-photo-strip" aria-label="选择记录中的照片">{current.photos.map((photo, index) => <button type="button" key={photo.photoId} aria-label={`查看照片 ${index + 1}`} aria-pressed={currentPhoto.photoId === photo.photoId} onClick={() => { if (currentPhoto.photoId !== photo.photoId) { setPhotoSource(null); setActivePhoto(photo.photoId); } }}><JournalImage host={host} tripId={tripId} entryId={current.entryId} photo={photo} alt="" canRetry={false} /></button>)}</nav>{canPreviewPhotoRelief(current.subject) && <button className="ui-secondary" type="button" disabled={!photoSource || frozen} onClick={() => { pendingEffect.current = null; setError(null); setRelief({ photo: currentPhoto, src: photoSource }); }}><Icon name="Images" />{currentPhoto.relief ? "查看或调整照片浮雕" : "打开照片浮雕"}</button>}</> : <div className="journal-text-record"><Icon name="Notebook" /><p>这是一段文字记录</p></div>}</section><section className="journal-detail-copy"><span className="ui-tag">{current.stage === "visited" ? "已到访" : "想去"}</span><h3>{journalTitle(current)}</h3>{current.visitStopId && <p className="journal-linked-visit"><Icon name="MapPin" />{linkedVisit?.name || "原关联到访（已不在当前安排中）"}</p>}<p className="journal-full-note">{current.note || "还没有留下文字。"}</p><p className="ui-help">{current.photos.length ? `${current.photos.length} 张照片 · ` : ""}旅行成员可见{canEdit ? "并可按旅行权限编辑" : " · 当前仅查看"}</p>{canEdit && <div className="journal-detail-actions"><button className="ui-secondary" type="button" disabled={frozen} onClick={edit}>编辑记录</button><button className="ui-text ui-danger-text" type="button" disabled={frozen} onClick={() => setConfirm({ title: "永久删除这条记录？", description: `将删除「${journalTitle(current)}」及其中 ${current.photos.length} 张照片和浮雕效果，无法恢复。旅行安排保持原样。`, label: "删除记录与照片", action: remove })}>删除记录</button></div>}</section></div></article> : <>
      <div className="journal-filter"><label>按日期查看<select value={filter} disabled={loading} onChange={event => { setFilter(event.currentTarget.value); setLimit(12); }}><option value="all">全部日期</option>{dates.map(date => <option key={date} value={date}>{date === "undated" ? "未注明日期" : dayLabel(date)}</option>)}</select></label><button className="ui-text" type="button" disabled={frozen || loading} onClick={load}><Icon name="ArrowCounterClockwise" />刷新记录</button></div>
      {loading && !items.length ? <div className="journal-loading" role="status">正在打开这趟旅行的记录…</div> : listError && !items.length ? <div className="media-empty"><h3>手账暂时无法读取</h3><p>已保存的记录仍然保留。</p><button type="button" className="ui-secondary" onClick={load}>重新读取</button></div> : shown.length ? <><div className="journal-gallery">{shown.slice(0, limit).map(item => <button className={`journal-memory ${item.photos.length ? "has-photo" : "text-only"}`} type="button" key={item.entryId} disabled={frozen} onClick={() => { setSelected(item.entryId); setActivePhoto(item.photos[0]?.photoId || null); setError(null); setNotice(null); }}>
        {item.photos.length ? <JournalImage host={host} tripId={tripId} entryId={item.entryId} photo={item.photos[0]} alt={journalTitle(item)} canRetry={false} /> : <div className="journal-memory-excerpt"><Icon name="Notebook" /><p>{item.note}</p></div>}<div className="journal-memory-caption"><span>{dayLabel(item.takenOn)}{item.photos.length > 1 ? ` · ${item.photos.length} 张照片` : ""}</span><h3>{journalTitle(item)}</h3>{item.photos.length > 0 && item.note && <p>{item.note}</p>}{item.photos.some(photo => photo.relief) && <small><Icon name="Images" />已有照片浮雕</small>}</div></button>)}</div>{shown.length > limit && <button className="ui-secondary journal-more" type="button" onClick={() => setLimit(value => value + 12)}>继续查看其余 {shown.length - limit} 条记录</button>}</> : <div className="media-empty"><Icon name="Notebook" /><h3>{items.length ? "这一天还没有记录" : "还没有旅行记录"}</h3><p>可以先记一段文字，也可以从某次到访开始添加照片。以后再关联地点。</p>{canEdit && <button className="ui-primary" type="button" onClick={start}><Icon name="Plus" />写下第一条记录</button>}</div>}
    </>}
    {relief && current && <ReliefEditor key={`${current.entryId}:${relief.photo.photoId}`} entry={current} photo={relief.photo} src={relief.src} canEdit={canEdit} busy={busy} uncertain={uncertain === "effect"} error={error} onSave={saveEffect} onDirty={setEffectDirty} onClose={() => { setRelief(null); setEffectDirty(false); setUncertain(null); pendingEffect.current = null; setError(null); void load(); }} />}
  </section>;
}
