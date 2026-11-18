import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Envelope, PencilSimple, ShareNetwork } from "@phosphor-icons/react";
import { useJournalExit } from "./ui/journal-exit.jsx";
import { api } from "./api-client.js";
import { createPaintingPlates } from "./painting-plates.js";
import { PaintingPreview } from "./painting-preview.jsx";
import { prepareJournalPhoto } from "./travel-journal-photo.js";
import { cardCaption, exportPostcard, postcardFrame } from "./postcard-export.js";
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
      if (!ctrl.signal.aborted) setResult({ entry, drawing });
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
    if (cover.current) cover.current.replaceChildren(postcardFrame(entry, drawing, caption));
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

export function MemoryBook({
  tripId,
  node = null,
  english = false,
  drawing = null,
  source = "",
  onOpenLegacy,
  onDirtyChange,
}) {
  const t = (zh, en) => (english ? en : zh);
  const mayLeave = useJournalExit();
  const [entries, setEntries] = useState([]),
    [load, setLoad] = useState(0),
    [loading, setLoading] = useState(true);
  const [selected, select] = useState(null),
    [edit, setEdit] = useState(false),
    [sharing, share] = useState(false);
  const [note, write] = useState(""),
    [place, setPlace] = useState(""),
    [date, setDate] = useState("");
  const [busy, work] = useState(false),
    [error, fail] = useState(""),
    [dirty, mark] = useState(false);
  const editID = useRef(null),
    version = useRef(null),
    startedDrawing = useRef(false);
  const entry = entries.find((e) => e.id === (edit ? editID.current : selected));
  const saved = useSavedDrawing(tripId, entry);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api
      .memories(tripId, node?.nodeId, ctrl.signal)
      .then(({ entries: rows }) => {
        if (ctrl.signal.aborted) return;
        setEntries(rows);
        fail("");
        if (drawing && !rows.length && !startedDrawing.current) {
          startedDrawing.current = true;
          start(null);
        } else select((prev) => (rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)));
      })
      .catch(() => {
        if (!ctrl.signal.aborted)
          fail(t("暂时读不到手账，可以重新读取。", "Could not load journal. Try again."));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [tripId, node?.nodeId, load]);
  useEffect(() => {
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    onDirtyChange?.(dirty, busy);
    if (dirty || busy) window.addEventListener("beforeunload", warn);
    return () => { onDirtyChange?.(false); window.removeEventListener("beforeunload", warn); };
  }, [onDirtyChange, dirty, busy]);
  useEffect(() => {
    if (dirty || edit || sharing) return;
    const refresh = () => setLoad((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [dirty, edit, sharing]);
  function start(item) {
    editID.current = item?.id ?? crypto.randomUUID();
    version.current = item?.revision ?? null;
    select(item?.id ?? null);
    write(item?.note ?? "");
    setDate(item?.takenOn ?? "");
    setPlace(item?.placeTitle ?? node?.title ?? "");
    setEdit(true);
    share(false);
    fail("");
    mark(Boolean(drawing));
  }
  async function save() {
    if (busy || (!note.trim() && !drawing && !entry?.photos.length)) return;
    work(true);
    fail("");
    try {
      const body = { note, takenOn: date || null };
      if (drawing) body.artwork = await savedArtwork(drawing, source);
      const record =
        version.current !== null
          ? await api.reviseMemory(tripId, editID.current, { ...body, revision: version.current })
          : await api.saveMemory(tripId, {
              ...body,
              id: editID.current,
              nodeId: node?.nodeId,
              placeTitle: place.trim(),
            });
      setEntries((prev) =>
        [record, ...prev.filter((e) => e.id !== record.id)].sort((a, b) =>
          (b.takenOn || b.createdAt).localeCompare(a.takenOn || a.createdAt),
        ),
      );
      select(record.id);
      setEdit(false);
      mark(false);
    } catch (e) {
      fail(
        e.code === "memory_revision_conflict"
          ? t(
              "这段回忆已在别处更新。请保留你的文字并重新读取，再合并修改。",
              "Updated elsewhere. Keep your text, reload and merge your changes.",
            )
          : t("保存未完成，文字仍在这里。可以重试。", "Could not save. Your text is still here. Retry."),
      );
    } finally {
      work(false);
    }
  }
  const closeEdit = async () => {
    if (await mayLeave()) {
      setEdit(false);
      mark(false);
      fail("");
      setLoad((v) => v + 1);
    }
  };
  if (sharing && entry)
    return <ShareCard entry={entry} drawing={saved?.drawing} english={english} onClose={() => share(false)} />;
  const displayDrawing = edit && drawing ? drawing : saved?.drawing;
  const index = entries.findIndex((e) => e.id === selected);
  return (
    <section className="memory-book" aria-label={t("我的私人手账", "My private journal")}>
      <header className="memory-book-header">
        <div>
          <small>
            <BookOpen />
            {t("仅自己可见", "Only you")}
          </small>
          <h2>{t("旅行手账", "Travel journal")}</h2>
        </div>
        {!edit && (
          <button className="button secondary" onClick={() => start(null)}>
            <PencilSimple />
            {drawing ? t("用这幅画写一页", "Write beside this drawing") : t("写一页", "Write a page")}
          </button>
        )}
      </header>
      {error && (
        <div role="alert">
          {error}{" "}
          {!edit && (
            <button
              onClick={() => {
                fail("");
                setLoad((v) => v + 1);
              }}
            >
              {t("重新读取", "Reload")}
            </button>
          )}
        </div>
      )}
      {loading && !entry && !edit ? <p role="status">{t("正在翻开手账…", "Opening journal…")}</p> : null}
      {!loading && !entries.length && !edit && !error && (
        <p className="memory-empty">
          {t(
            "记下一个地点和一句想留下的话。也可以把笔记或口述交给宿主助手，告诉它「记进我的旅行手账」。",
            "Write down a place and a moment. You can also ask your host assistant to save a note or dictated memory.",
          )}
        </p>
      )}
      {(entry || edit) && (
        <div className="memory-spread">
          <div className="memory-image-leaf">
            {displayDrawing ? (
              <>
                <PaintingPreview
                  drawing={displayDrawing}
                  title={edit ? place || node?.title : entry?.placeTitle}
                  english={english}
                />
                <small>{edit && drawing ? source : entry?.photos[0]?.source}</small>
              </>
            ) : entry?.photos.length ? (
              <p role="status">
                {saved?.error
                  ? t("画作暂时无法读取。", "Could not load artwork.")
                  : t("正在展开画作…", "Opening illustration…")}
              </p>
            ) : (
              <div className="memory-place">
                <span>{edit ? date : entry?.takenOn || entry?.createdAt?.slice(0, 10)}</span>
                <strong>{edit ? place : entry?.placeTitle}</strong>
              </div>
            )}
          </div>
          <article className="memory-text-leaf">
            {edit ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <fieldset disabled={busy}>
                  {!node && !entry && (
                    <label>
                      {t("地点", "Place")}
                      <input
                        required
                        maxLength={150}
                        value={place}
                        onChange={(e) => {
                          setPlace(e.target.value);
                          mark(true);
                        }}
                      />
                    </label>
                  )}
                  <label>
                    {t("记录日期", "Date")}
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        mark(true);
                      }}
                    />
                  </label>
                  <label>
                    {t("我想记住", "What I want to remember")}
                    <textarea
                      className="memory-script"
                      autoFocus
                      maxLength={3000}
                      rows={6}
                      value={note}
                      onChange={(e) => {
                        write(e.target.value);
                        mark(true);
                      }}
                    />
                  </label>
                  <div className="memory-actions">
                    <button
                      type="submit"
                      className="button primary"
                      disabled={
                        busy || (!place.trim() && !node) || (!note.trim() && !drawing && !entry?.photos.length)
                      }
                    >
                      {busy ? t("保存中…", "Saving…") : t("收进我的手账", "Save memory")}
                    </button>
                    <button type="button" onClick={closeEdit}>
                      {t("取消", "Cancel")}
                    </button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <>
                <time>{entry.takenOn || entry.createdAt.slice(0, 10)}</time>
                <h3>{entry.placeTitle}</h3>
                <p className="memory-script">
                  {entry.note || t("这一页还留着空白。", "A little room to write.")}
                </p>
                <div className="memory-actions">
                  <button onClick={() => start(entry)}>
                    <PencilSimple />
                    {drawing ? t("把画收到这一页", "Add drawing to this page") : t("编辑", "Edit")}
                  </button>
                  <button
                    disabled={Boolean(entry.photos.length && !saved?.drawing)}
                    onClick={() => share(true)}
                  >
                    <ShareNetwork />
                    {t("做成明信片", "Make postcard")}
                  </button>
                </div>
              </>
            )}
          </article>
        </div>
      )}
      {!edit && entries.length > 0 && (
        <nav className="memory-pages" aria-label={t("翻阅手账", "Browse journal")}>
          <button
            disabled={index <= 0}
            aria-label={t("上一页", "Previous page")}
            onClick={() => select(entries[index - 1].id)}
          >
            <ArrowLeft />
          </button>
          <span>
            {index + 1} / {entries.length}
          </span>
          <button
            disabled={index < 0 || index === entries.length - 1}
            aria-label={t("下一页", "Next page")}
            onClick={() => select(entries[index + 1].id)}
          >
            <ArrowRight />
          </button>
        </nav>
      )}
      {!edit && onOpenLegacy && (
        <button className="memory-legacy" onClick={onOpenLegacy}>
          {t("查看同行照片记录", "View trip photo records")}
        </button>
      )}
    </section>
  );
}
