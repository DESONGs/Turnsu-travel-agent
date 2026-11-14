import { useEffect, useRef, useState } from "react";
import { Sheet, ConfirmInline } from "./Sheet.jsx";
import { workspaceHost } from "./workspace-host.mjs";
import "./review.css";
const messages = {
  review_preview_stale: "行程或来源已有变化，确认进度仍保存在账号中。请返回行程，让助手重新核验这版草案。",
  review_complete_draft_required: "先让助手形成包含日期、到访与交通的完整草案，再逐项审阅并采用。当前选择仍保留。",
  review_condition_changed: "这一项的依据已有变化，请重新读取后核对；其他未受影响的确认会保留。",
  review_progress_conflict: "另一个窗口已更新确认进度，请重新读取当前进度。",
  review_confirmation_required: "仍有未知条件需要逐项确认，尚未采用。",
  review_blocked: "已知冲突还没有解决，当前行程保持原样。请先让助手调整。",
};
export function ReviewPanel({ tripId, previewId, proposalId, tripTitle, canEdit, onClose, onAdopted, onContinue }) {
  const [review, setReview] = useState(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [confirm, setConfirm] = useState(false);
  const pending = useRef(null), alive = useRef(true), reading = useRef(0);
  const context = { tripId, previewId, proposalId };
  async function load() {
    const sequence = ++reading.current; setLoading(true); setError("");
    try { const result = await workspaceHost.call("get_trip_review", context); if (alive.current && sequence === reading.current) setReview(result); }
    catch (failure) { if (alive.current && sequence === reading.current) setError(messages[failure.code] || failure.message); }
    finally { if (alive.current && sequence === reading.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; reading.current++; }; }, [tripId, previewId, proposalId]);
  async function send(command) {
    if (busy) return;
    pending.current = command; setBusy(true); setError("");
    try {
      const result = await workspaceHost.call(command.tool, command.args); if (!alive.current) return;
      if (command.tool === "adopt_trip_reviewed_draft" && result.status !== "committed") throw new Error("采用结果尚未确认，请重新读取行程。");
      pending.current = null; setUncertain(false);
      if (command.tool === "adopt_trip_reviewed_draft") {
        try { await onAdopted(result); }
        catch { setReview(null); setError("行程已经采用，但页面同步失败。请返回行程重新读取。无需再次采用。"); }
      } else setReview(result);
    } catch (failure) {
      if (!alive.current) return;
      if (failure.code) { pending.current = null; setUncertain(false); } else setUncertain(true);
      setError(messages[failure.code] || failure.message || "保存结果尚未确认，请按原操作重试。");
    } finally { if (alive.current) setBusy(false); }
  }
  function acknowledge(condition, checked) {
    void send({ tool: "save_trip_review_condition", args: { ...context, expectedRevision: review.revision, expectedProgressVersion: review.progressVersion, conditionId: condition.conditionId, basisHash: condition.basisHash, acknowledged: checked, requestId: crypto.randomUUID() } });
  }
  const close = () => uncertain ? setConfirm(true) : onClose();
  const accepted = review?.conditions.filter(item => item.acknowledged).length ?? 0;
  const printed = new Set();
  const conditions = values => values.map(condition => { printed.add(condition.conditionId); return <label key={condition.conditionId} className={`review-condition ${condition.acknowledged ? "acknowledged" : ""}`}><input type="checkbox" checked={condition.acknowledged} disabled={!canEdit || busy || uncertain} onChange={event => acknowledge(condition, event.target.checked)} /><span>{condition.label}<small>{condition.acknowledged ? "已知悉此项仍待核验" : "我已知悉这一条件尚未核验"}</small></span></label>; });
  return <Sheet title="审阅这趟旅行" context={tripTitle} wide onClose={close} busy={busy} className="trip-review-sheet" footer={<>
    <p>{review ? `${accepted} / ${review.conditions.length} 项未知条件已确认` : "正在读取当前草案和账号确认进度"}</p><div className="ui-actions"><button className="ui-secondary" type="button" disabled={busy} onClick={close}>返回试排</button>{uncertain ? <button className="ui-primary" type="button" disabled={busy} onClick={() => send(pending.current)}>重试原次操作</button> : <button className="ui-primary" type="button" disabled={!canEdit || busy || loading || !review?.canAdopt} onClick={() => send({ tool: "adopt_trip_reviewed_draft", args: { ...context, expectedRevision: review.revision, expectedProgressVersion: review.progressVersion, requestId: crypto.randomUUID() } })}>{busy ? "正在保存…" : review?.adoptionStatus === "tentative" ? "采用暂定行程" : "采用已核验行程"}</button>}</div>
  </>}>
    {confirm && <ConfirmInline title="结果尚未确认" description="关闭后先重新读取行程与确认进度，不要直接重复采用。" cancel="继续核对" action="返回行程核对" onCancel={() => setConfirm(false)} onConfirm={onClose} />}
    {error && <div className="ui-error" role="alert"><p>{error}</p>{!uncertain && <button className="ui-text" type="button" disabled={busy} onClick={load}>重新读取确认进度</button>}</div>}
    {loading && !review ? <p role="status">正在核对这份草案与已保存的确认…</p> : review && <>
      <div className="review-explanation"><h3>{review.adoptionStatus === "tentative" ? "把尚未核实的条件，一项项看清楚" : "核对安排，再决定采用"}</h3><p>{review.adoptionStatus === "tentative" ? "确认代表你已知悉这些条件仍未知。采用后明确保留暂定标记和待核验事项，不代表交通、预约或费用已经核实。确认进度随账号保存，关闭后可以继续。" : "这份草案没有待知悉的未知条件；采用前仍会重新检查当前版本、来源和锁定安排。"}</p></div>
      {review.blockers.length > 0 && <section className="review-blockers" aria-label="需要先解决的冲突"><h3>这些问题需要先调整</h3><ul>{review.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}>{blocker.label}</li>)}</ul>{onContinue && <button className="ui-secondary" type="button" onClick={onContinue}>让助手继续处理</button>}</section>}
      <div className="review-visits">{review.stops.map(stop => <section key={stop.stopId} className="review-visit"><header><div><time>{stop.date}</time><h3>{stop.title}</h3></div><span>{stop.startAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: stop.timeZone || "UTC", hour12: false }).format(new Date(stop.startAt)) : "时间待补充"}{stop.timeZone ? ` · ${stop.timeZone}` : " · UTC"}</span></header>{conditions(review.conditions.filter(item => item.stopIds.includes(stop.stopId) && !printed.has(item.conditionId)))}</section>)}</div>
      {review.conditions.some(item => !printed.has(item.conditionId)) && <section className="review-trip-conditions"><h3>整趟旅行的待核验事项</h3>{conditions(review.conditions.filter(item => !printed.has(item.conditionId)))}</section>}
    </>}
  </Sheet>;
}
