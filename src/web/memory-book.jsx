import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Envelope, PencilSimple, ShareNetwork } from "@phosphor-icons/react";
import { useJournalExit } from "./ui/journal-exit.jsx";
import { api } from "./api-client.js";
import { createPaintingPlates } from "./painting-plates.js";
import { PaintingPreview } from "./painting-preview.jsx";
import { prepareJournalPhoto } from "./travel-journal-photo.js";
import { cardCaption, exportPostcard, memoryPageDate, postcardFrame } from "./postcard-export.js";
import { entryTemplate, journalTemplates, suggestedJournalTemplate } from "../media/journal-templates.js";
import { journalSurface, postcardMaterial } from "./journal-materials.js";
import { CoverFace, PrivateLabel, TemplatePicker, TurningLeaf } from "./journal-binding.jsx";
import "./memory-book.css";

function useSavedDrawing(trip, entry) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!entry?.photos?.length) return;
    const ctrl = new AbortController();
    let url;
    (async () => {
      const blob = await api.memoryArt(trip, entry.id, ctrl.signal);
      ctrl.signal.throwIfAborted();
      url = URL.createObjectURL(blob);
      const drawing = await createPaintingPlates({ src: url, shapes: entry.photos[0].shapes }, ctrl.signal);
      if (!ctrl.signal.aborted) setResult({ entry, drawing, url });
    })().catch(() => {
      if (!ctrl.signal.aborted) setResult({ entry, error: true });
    });
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [trip, entry]);
  return result?.entry === entry ? result : null;
}

async function savedArtwork(drawing, source) {
  const canvas = document.createElement("canvas");
  canvas.width = drawing.width;
  canvas.height = drawing.height;
  const ctx = canvas.getContext("2d");
  for (const layer of drawing.plates) ctx.drawImage(layer.canvas, 0, 0);
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  const file = await prepareJournalPhoto(jpeg);
  return { data: file.data, shapes: drawing.shapes, source };
}

function ShareCard({ entry, drawing, english, onClose }) {
  const t = (zh, en) => (english ? en : zh);
  const [caption, write] = useState(cardCaption(entry.note)),
    [showMotion, setShowMotion] = useState(false);
  const [busy, working] = useState(false),
    [file, setFile] = useState(null),
    [error, setError] = useState("");
  const [format, setFormat] = useState(() =>
    !drawing
      ? "png"
      : globalThis.VideoEncoder &&
          (/iPad|iPhone/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
        ? "live"
        : "gif",
  );
  const cover = useRef(null);
  const host = globalThis.travelHost;
  async function download() {
    working(true);
    setError("");
    try {
      await host.downloadFile(file.file);
    } catch {
      setError(
        t("下载未完成，可以重试或使用系统分享。", "Download did not finish. Retry or use system sharing."),
      );
    } finally {
      working(false);
    }
  }
  useEffect(() => {
    let current = true;
    const root = cover.current;
    if (root) postcardMaterial(entryTemplate(entry)).then(material => {
      if (current) root.replaceChildren(postcardFrame(entry, drawing, caption, 0, material));
    }).catch(() => { if (current) setError(t("明信片纸面暂时无法读取，请重新打开。", "Could not load postcard paper. Reopen to retry.")); });
    return () => { current = false; };
  }, [entry, drawing, caption, showMotion, file]);
  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url);
    },
    [file],
  );
  const generate = async () => {
    working(true);
    setFile(null);
    setShowMotion(false);
    setError("");
    try {
      const blob = await exportPostcard(entry, drawing, caption, format);
      const name =
        entry.placeTitle.replace(/[/\\:\x00-\x1f]/g, " ").slice(0, 45) +
        "." +
        { live: "zip", png: "png", gif: "gif" }[format];
      setFile({ url: URL.createObjectURL(blob), file: new File([blob], name, { type: blob.type }), name });
    } catch (cause) {
      setError(
        cause.message === "live_encoder_unavailable"
          ? t(
              "此宿主没有 H.264 编码能力，可选择循环动图。",
              "This host cannot encode H.264. Choose the animated GIF.",
            )
          : t("生成文件失败，请重试或更换格式。", "Could not create the file. Try again or change format."),
      );
    } finally {
      working(false);
    }
  };
  return (
    <section className="memory-share" aria-label={t("制作明信片", "Create postcard")}>
      <header>
        <h3>
          <Envelope />
          {t("旅行明信片", "Travel postcard")}
        </h3>
        <button onClick={onClose} disabled={busy}>
          {t("回到手账", "Back to journal")}
        </button>
      </header>
      {file && format === "gif" && showMotion ? (
        <div className="memory-card-proof">
          <img src={file.url} alt={t("循环明信片", "Animated postcard")} />
        </div>
      ) : (
        <div ref={cover} className="memory-card-proof" />
      )}
      {file && format === "gif" && (
        <button aria-pressed={showMotion} onClick={() => setShowMotion(!showMotion)}>
          {showMotion ? t("暂停预览", "Pause preview") : t("播放预览", "Play preview")}
        </button>
      )}
      <label>
        {t("卡上写什么", "Message on the card")}
        <textarea
          maxLength={54}
          rows={2}
          value={caption}
          disabled={busy}
          onChange={(e) => {
            write(e.target.value.replace(/[\r\n]+/g, " "));
            setFile(null);
          }}
        />
      </label>
      <label>
        {t("分享格式", "Share format")}
        <select
          value={format}
          disabled={busy}
          onChange={(e) => {
            setFormat(e.target.value);
            setFile(null);
          }}
        >
          {drawing && (
            <>
              <option value="gif">{t("循环动图 · GIF", "Animated GIF")}</option>
              <option value="live">
                {t("Apple 实况照片 · 配对原件", "Apple Live Photo · paired originals")}
              </option>
            </>
          )}
          <option value="png">{t("静态明信片 · PNG", "Still postcard · PNG")}</option>
        </select>
      </label>
      {format === "live" && (
        <small>
          {t(
            "文件包含配对的 JPG 和 MOV。解压后可在 Mac「照片」同时导入，并通过 iCloud 照片同步到 iPhone。",
            "Includes a paired JPG and MOV. Unzip and import both into Photos on Mac, then sync to iPhone with iCloud Photos.",
          )}
        </small>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="memory-actions">
        {file ? (
          <>
            {host?.supportsDownload ? (
              <button disabled={busy} onClick={download}>
                {t("下载明信片", "Download postcard")}
              </button>
            ) : host?.kind !== "mcp-app" ? (
              <a href={file.url} download={file.name}>
                {t("下载明信片", "Download postcard")}
              </a>
            ) : (
              !navigator.canShare?.({ files: [file.file] }) && (
                <p role="status">
                  {t(
                    "当前宿主未提供文件下载。可在支持下载的宿主打开这页手账。",
                    "This host does not support downloads. Open this page in a host with file downloads.",
                  )}
                </p>
              )
            )}
            {navigator.canShare?.({ files: [file.file] }) && (
              <button
                onClick={async () => {
                  try {
                    await navigator.share({ files: [file.file] });
                  } catch (e) {
                    if (e.name !== "AbortError")
                      setError(
                        t("此宿主无法分享，可下载文件。", "Sharing is unavailable. Download the file instead."),
                      );
                  }
                }}
              >
                {t("系统分享", "Share…")}
              </button>
            )}
          </>
        ) : (
          <button className="button primary" disabled={busy} onClick={generate}>
            {busy ? t("正在生成…", "Creating…") : t("生成分享文件", "Create file")}
          </button>
        )}
      </div>
    </section>
  );
}

export function MemoryBook({ tripId, node = null, english = false, drawing = null, source = "",
  onOpenLegacy, onDirtyChange, onCloseComposer, onTemplateChange }) {
  const t = (zh, en) => english ? en : zh;
  const mayLeave = useJournalExit();
  const noteLabel = useId();
  const inline = Boolean(onCloseComposer);
  const [entries, setEntries] = useState([]);
  const [load, setLoad] = useState(0), [loading, setLoading] = useState(!inline);
  const [opened, setOpened] = useState(false), [selected, select] = useState(null);
  const [edit, setEdit] = useState(inline), [sharing, share] = useState(false);
  const [note, write] = useState(""), [place, setPlace] = useState(node?.title ?? ""), [date, setDate] = useState("");
  const [choice, setChoice] = useState(null);
  const [pickingPage, setPickingPage] = useState(false);
  const [pickError, setPickError] = useState(false);
  const [busy, work] = useState(false), [dirty, mark] = useState(false), [error, fail] = useState("");
  const [motion, setMotion] = useState(null);
  const editing = useRef({ id: null, revision: null, attach: inline }), saving = useRef(false);
  const reader = useRef(null), cover = useRef(null);
  const entry = entries.find(e => e.id === (edit ? editing.current.id : selected));
  const saved = useSavedDrawing(tripId, inline ? null : entry);
  const index = entries.findIndex(e => e.id === selected);
  const currentTemplate = edit ? choice ?? suggestedJournalTemplate(place, node?.location) : entryTemplate(entry, node);
  const currentArt = drawing ?? saved?.drawing;

  useEffect(() => {
    if (inline ? !pickingPage : edit) return;
    const ctrl = new AbortController();
    setLoading(true);
    api.memories(tripId, node?.nodeId, ctrl.signal).then(({entries: rows}) => {
      if (ctrl.signal.aborted) return;
      setEntries(rows);
      if (inline) { setPickError(false); return; }
      select(id => rows.some(row => row.id === id) ? id : rows[0]?.id ?? null);
      fail("");
    }).catch(() => {
      if (ctrl.signal.aborted) return;
      if (inline) setPickError(true);
      else fail(t("暂时读不到手账，可以重新读取。", "Could not load journal. Try again."));
    }).finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [tripId, node?.nodeId, load, edit, inline, pickingPage]);
  useEffect(() => {
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    onDirtyChange?.(dirty, busy);
    if (dirty || busy) window.addEventListener("beforeunload", warn);
    return () => { onDirtyChange?.(false); window.removeEventListener("beforeunload", warn); };
  }, [onDirtyChange, dirty, busy]);
  useEffect(() => {
    if (inline || edit || sharing) return;
    const refresh = () => setLoad(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [inline, edit, sharing]);

  function animate(direction) {
    setMotion(matchMedia("(prefers-reduced-motion: reduce)").matches ? null :
      { direction, binding: entryTemplate(entry,node), title: entry?.placeTitle, note: entry?.note, key: crypto.randomUUID() });
  }
  function openBook() {
    animate("open");
    setOpened(true);
    if (!entries.length) start(null);
    else {
      select(entries[0].id);
      requestAnimationFrame(() => reader.current?.focus({preventScroll:true}));
    }
  }
  function closeBook() {
    select(entries[0]?.id ?? null);
    setOpened(false);
    setMotion(null);
    requestAnimationFrame(() => cover.current?.focus({preventScroll:true}));
  }
  function turn(step) {
    const target = entries[index + step];
    if (!target || edit || sharing) return;
    animate(step > 0 ? "next" : "prev");
    select(target.id);
    requestAnimationFrame(() => reader.current?.focus({preventScroll:true}));
  }
  function start(item, attach = false) {
    editing.current = { id: item?.id ?? crypto.randomUUID(), revision: item?.revision ?? null, attach };
    select(item?.id ?? null);
    write(item?.note ?? ""); setDate(item?.takenOn ?? ""); setPlace(item?.placeTitle ?? node?.title ?? "");
    setChoice(item ? entryTemplate(item, node) : null);
    onTemplateChange?.(item ? entryTemplate(item, node) : null);
    setPickingPage(false); setEdit(true); share(false); fail(""); mark(attach);
  }
  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget.form ?? event.currentTarget;
    if (saving.current || !form.reportValidity() || (!place.trim() && !node) || (!note.trim() && !drawing && !entry?.photos.length)) return;
    saving.current = true; work(true); fail("");
    try {
      editing.current.id ??= crypto.randomUUID();
      const { id, revision } = editing.current;
      const body = { note, takenOn: date || null, templateId: currentTemplate };
      if (drawing && editing.current.attach) body.artwork = await savedArtwork(drawing, source);
      const record = revision !== null
        ? await api.reviseMemory(tripId, id, { ...body, revision })
        : await api.saveMemory(tripId, { ...body, id, nodeId: node?.nodeId, placeTitle: place.trim() });
      setEntries(prev => [record, ...prev.filter(e => e.id !== record.id)]);
      select(record.id); setPickingPage(false); mark(false); setEdit(false);
      requestAnimationFrame(() => reader.current?.focus({preventScroll:true}));
    } catch (cause) {
      fail(cause.code === "memory_revision_conflict"
        ? t("这段回忆已在别处更新。请保留你的文字并重新读取，再合并修改。", "Updated elsewhere. Keep your text, reload and merge your changes.")
        : t("保存未完成，文字仍在这里。可以重试。", "Could not save. Your text is still here. Retry."));
    } finally { saving.current = false; work(false); }
  }
  async function cancel() {
    if (!await mayLeave()) return;
    if (inline) { onCloseComposer(); return; }
    mark(false); fail(""); setEdit(false);
    if (!entries.length) closeBook();
    else {
      select(editing.current.revision === null ? entries[0].id : editing.current.id);
      requestAnimationFrame(() => reader.current?.focus({preventScroll:true}));
    }
  }

  if (sharing && entry) return <ShareCard entry={entry.templateId ? entry : {...entry,templateId:currentTemplate}}
    drawing={currentArt} english={english} onClose={() => share(false)}/>;
  const status = error && <div role="alert">{error} {!edit && !inline &&
    <button type="button" onClick={() => setLoad(n => n + 1)}>{t("重新读取", "Reload")}</button>}</div>;
  const legacy = onOpenLegacy && !edit && <button type="button" className="memory-legacy" onClick={onOpenLegacy}>
    {t("查看同行照片记录", "View trip photo records")}</button>;
  const sectionLabel = t("我的私人手账", "My private journal");

  if (!inline && !opened) {
    const latest = entries[0];
    const binding = entryTemplate(latest, node);
    return <section className="memory-book book-closed" aria-label={sectionLabel} data-binding={binding} style={journalSurface(binding)}>
      <PrivateLabel english={english}/>{status}
      {loading && !entries.length && <p role="status">{t("正在翻开手账…","Opening journal…")}</p>}
      {(!loading || entries.length > 0) && (!error || entries.length > 0) && <>
        <button type="button" ref={cover} className="cover-trigger" onClick={openBook}
          aria-label={entries.length ? t("翻开手账","Open journal") : t("写第一页","Write the first page")}>
          <span className="book-cover binding-surface"><CoverFace title={latest?.placeTitle || node?.title}
            thumbnail={saved?.entry?.id === latest?.id ? saved?.url : undefined} count={entries.length} english={english}/></span>
          <span className="cover-open-label">{entries.length ? t("翻开手账","Open journal") : t("写第一页","Write the first page")}<ArrowRight/></span>
        </button>
        {!entries.length && <p className="memory-empty">{t("记下一个地点和一句想留下的话。也可以请宿主助手收下你的口述或笔记。","Keep a place and a line you want to remember. Your host can also save a dictated or imported note.")}</p>}
      </>}
      {legacy}
    </section>;
  }

  const textLeaf = <article className="memory-text-leaf">
    <PrivateLabel english={english}/>
    {edit ? <form onSubmit={save}><fieldset disabled={busy}>
      {!node && !entry ? <label>{t("地点", "Place")}<input required maxLength={150} value={place}
        onChange={e => {setPlace(e.target.value); mark(true);}}/></label> : <h3>{place}</h3>}
      <label className="book-date">{t("记录日期", "Date")}<input type="date" value={date} onChange={e => {setDate(e.target.value); mark(true);}}/></label>
      <label className="handwriting-label"><span id={noteLabel}>{t("我想记住", "What I want to remember")}</span>
        <textarea className="memory-script" aria-labelledby={noteLabel} autoFocus maxLength={3000} rows={3} value={note}
          onChange={e => {write(e.target.value); mark(true);}}/></label>
      <TemplatePicker value={currentTemplate} english={english} disabled={busy}
        onChange={id => {setChoice(id); onTemplateChange?.(id); mark(true);}}/>
      <div className="memory-actions"><button type="button" onClick={save} className="button primary"
        disabled={busy || (!place.trim() && !node) || (!note.trim() && !drawing && !entry?.photos.length)}>
        {busy ? t("保存中…","Saving…") : editing.current.revision && editing.current.attach ? t("把手绘存入这一页","Save drawing to this page") : t("收进我的手账", "Save memory")}</button>
        <button type="button" onClick={cancel}>{t("取消","Cancel")}</button></div>
      {inline && editing.current.revision === null && <details className="book-existing" onToggle={event => setPickingPage(event.currentTarget.open)}>
        <summary>{t("把画补到已有回忆","Attach to an existing memory")}</summary>
        {pickingPage && (loading ? <small role="status">{t("正在读取…","Loading…")}</small> : pickError ?
          <button type="button" onClick={() => setLoad(n=>n+1)}>{t("重新读取","Retry")}</button> : entries.length ?
          <label>{t("选择要更新插画的篇章","Choose the page whose illustration to update")}
            <select value="" onChange={async event => {
              const item = entries.find(row => row.id === event.target.value);
              if (item && await mayLeave()) start(item, true);
            }}><option value="">{t("选择一页","Choose a page")}</option>{entries.map(row =>
              <option key={row.id} value={row.id}>{memoryPageDate(row) + " · " + (row.note || row.placeTitle).slice(0,48)}</option>)}</select></label> :
          <small>{t("这个地点还没有其他回忆。","No other memories for this place yet.")}</small>)}
      </details>}
    </fieldset></form> : entry && <>
      <time dateTime={entry.takenOn || entry.createdAt}>{!entry.takenOn && t("写于 ","Written ")}{memoryPageDate(entry)}</time>
      {(inline || entry.photos.length > 0) && <h3>{entry.placeTitle}</h3>}
      <p className="memory-script">{entry.note || t("这一页还留着空白。", "A little room to write.")}</p>
      <small className="folio-binding">{journalTemplates[currentTemplate][english ? "en" : "zh"]}</small>
      {inline && <p className="memory-saved" role="status">{t("已收入私人手账","Saved to your private journal")}</p>}
      <div className="memory-actions"><button type="button" onClick={() => start(entry)}><PencilSimple/>{t("编辑","Edit")}</button>
        <button type="button" disabled={Boolean(entry.photos.length && !currentArt)} onClick={() => share(true)}>
          <ShareNetwork/>{t("做成明信片","Make postcard")}</button>
        {inline && <button type="button" onClick={onCloseComposer}>{t("收起","Close note")}</button>}</div>
    </>}
  </article>;

  if (inline) return <section ref={reader} tabIndex={-1} className="memory-book inline-postcard" aria-label={sectionLabel}
    data-binding={currentTemplate} style={journalSurface(currentTemplate)}>{status}{textLeaf}</section>;

  return <section className="memory-book book-open" aria-label={sectionLabel} onKeyDown={event => {
    if (edit || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = {ArrowLeft:-1,PageUp:-1,ArrowRight:1,PageDown:1}[event.key];
    if (step && entries[index + step]) { event.preventDefault(); turn(step); }
  }}>
    <header className="memory-book-header"><button type="button" disabled={edit} onClick={closeBook}><BookOpen/>{t("合上手账","Close journal")}</button>
      {!edit && <button type="button" onClick={() => start(null)}><PencilSimple/>{t("写一页","Write a page")}</button>}</header>
    {status}
    <div ref={reader} tabIndex={-1} className="memory-spread notebook-spread" data-binding={currentTemplate} style={journalSurface(currentTemplate)}>
      <i className="notebook-binding binding-surface" aria-hidden="true"/><i className="folio-ribbon" aria-hidden="true"/>
      <div className="memory-image-leaf">
        {currentArt ? <><PaintingPreview drawing={currentArt} title={entry?.placeTitle || place} english={english}/><small>{entry?.photos[0]?.source}</small></>
          : entry?.photos.length ? <p role="status">{saved?.error ? t("画作暂时无法读取。","Could not load artwork.") : t("正在展开画作…","Opening illustration…")}</p>
          : <div className="memory-place title-page binding-surface"><strong>{(edit ? place : entry?.placeTitle) || t("旅行手账","Travel journal")}</strong></div>}
      </div>
      {textLeaf}
      {!edit && index > 0 && <button type="button" className="page-corner previous" aria-label={t("从页角翻至上一页","Turn back from the page corner")} onClick={() => turn(-1)}/>}
      {!edit && index >= 0 && index < entries.length-1 && <button type="button" className="page-corner next" aria-label={t("从页角翻至下一页","Turn forward from the page corner")} onClick={() => turn(1)}/>}
      <TurningLeaf key={motion?.key} motion={motion} english={english} finish={() => setMotion(null)}/>
    </div>
    {!edit && entry && <nav className="memory-pages" aria-label={t("翻阅手账","Browse journal")}>
      <button type="button" disabled={index <= 0} onClick={() => turn(-1)} aria-label={t("上一页","Previous page")}><ArrowLeft/></button>
      <span aria-live="polite" aria-atomic="true">{t("第 " + (index+1) + " 页，共 " + entries.length + " 页", "Page " + (index+1) + " of " + entries.length)}</span>
      <button type="button" disabled={index >= entries.length-1} onClick={() => turn(1)} aria-label={t("下一页","Next page")}><ArrowRight/></button>
    </nav>}{legacy}
  </section>;
}
