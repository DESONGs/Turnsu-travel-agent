import { useEffect, useRef, useState } from "preact/hooks";
import { draftDays } from "./draft-days.mjs";
import { sourceIsExpired } from "./destination.mjs";

const at = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
const weatherLabels = {
  pending: "等待首次检查", baseline_saved: "已取得天气基准", no_change: "本次检查未发现变化", changed: "天气资料有变化",
  provider_unavailable: "天气来源暂不可用", source_not_covered: "天气来源不覆盖此目的地", needs_context: "天气检查缺少目的地或日期",
  outside_forecast_window: "出行日期尚未进入预报窗口", dates_unknown: "出行日期尚未明确", partial: "天气只覆盖部分日期", empty_verified: "本次来源没有返回天气资料",
  authorization_lost: "启用者的权限已撤销", authorization_lost_or_trip_changed: "权限或旅行已变化，检查已停止", trip_changed: "旅行已变化，检查已停止", ended: "跟进已结束", cancelled: "旅行已取消",
};

export function TentativeAdoptionReview({ report, pending, onCancel, onAdopt, onSaveCondition }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  if (!Array.isArray(report.checks) || !Array.isArray(report.requiredAcknowledgments) || typeof report.canAdoptTentatively !== "boolean" || typeof report.reviewDigest !== "string"
    || !Number.isSafeInteger(report.reviewState?.revision) || !Array.isArray(report.reviewState?.acknowledgedCheckIds))
    return <div class="adoption-review"><p role="alert">核验资料不完整，请返回草案重新核验。</p><button type="button" onClick={onCancel}>返回草案</button></div>;
  const checked = new Set(report.reviewState.acknowledgedCheckIds);
  const unknowns = report.checks.filter(check => ["unverified", "needs_review"].includes(check.status));
  const blockers = report.checks.filter(check => check.status === "blocked");
  const ready = report.canAdoptTentatively === true && blockers.length === 0 && report.requiredAcknowledgments.every(id => checked.has(id));
  return <form class="adoption-review" aria-label="确认暂定行程" onSubmit={async event => {
    event.preventDefault();
    if (ready && !pending) await onAdopt(report.requiredAcknowledgments.filter(id => checked.has(id)));
  }}>
    <h3 ref={heading} tabIndex={-1}>确认暂定行程</h3>
    <p>暂定行程会保存当前安排。以下条件仍未核实，请逐项确认你已了解；采用后仍会显示这些缺口。</p>
    {blockers.length > 0 && <div class="adoption-blockers" role="alert"><strong>需要先处理</strong><ul>{blockers.map(check => <li key={check.id}>{check.message}</li>)}</ul></div>}
    <fieldset disabled={pending}><legend>尚未核实或需要核对</legend>{unknowns.map(check => <label class="adoption-condition" key={check.id}>
      <input type="checkbox" checked={checked.has(check.id)} onChange={event => onSaveCondition(check, event.currentTarget.checked)} /><span>我已了解：{check.message}</span>
    </label>)}</fieldset>
    <p class="follow-up-boundary">采用时开启可用范围的风险跟进，至 {at(report.followUpStopsAt)} 停止（当前最后一项安排结束后 24 小时）。来源不可用不代表没有风险；不会自动购买、退改或修改安排。</p>
    <div class="adoption-actions"><button type="button" disabled={pending} onClick={onCancel}>返回草案</button><button type="submit" class="adoption-primary" disabled={pending || !ready}>{pending ? "正在保存…" : "采用暂定行程并开启风险跟进"}</button></div>
  </form>;
}

export function AdoptedItinerary({ adoption, host, renderStop, trip, canEdit }) {
  const [sources, setSources] = useState({});
  const stops = Array.isArray(adoption.stops) ? adoption.stops : [];
  useEffect(() => {
    let active = true, position = 0;
    const ids = [...new Set(stops.map(stop => stop.sourceResultId))];
    async function read() {
      while (active) {
        const id = ids[position++]; if (!id) return;
        let value;
        try { value = { source: await host.call("get_trip_result_reference", { resultId: id }) }; }
        catch { value = { error: true }; }
        if (active) setSources(previous => ({ ...previous, [id]: value }));
      }
    }
    Promise.all(Array.from({ length: Math.min(ids.length, 4) }, read));
    return () => { active = false; };
  }, [adoption.adoptionId, host]);
  const gaps = Array.isArray(adoption.checks) ? adoption.checks.filter(check => check.status !== "passed") : [];
  const tentative = adoption.status === "tentative";
  return <section class="adopted-itinerary" aria-label={tentative ? "暂定行程" : "已采用行程"}>
    <div class="adoption-status"><h3>{tentative ? "暂定行程" : adoption.status === "verified" ? "已核验行程" : "已采用行程"}</h3><span>采用于 {at(adoption.adoptedAt)}</span></div>
    {tentative && <p class="draft-warning">这份安排尚未完成核验。{gaps.length} 项条件仍待核实；采用时的确认不代表它们已满足。</p>}
    {gaps.length > 0 && <details class="adoption-gaps"><summary>查看仍未核实的条件（{gaps.length} 项）</summary><ul>{gaps.map(check => <li key={check.id}>{check.message}</li>)}</ul></details>}
    {draftDays(stops).map(({ date, stops: visits }, index) => <section class="draft-day" key={`${date}-${index}`}><h4>{date}</h4><ol>{visits.map(stop => renderStop(stop, sources, adoption.sourceTripRevision))}</ol></section>)}
    <RiskFollowUp key={adoption.adoptionId} trip={trip} host={host} canEdit={canEdit} />
  </section>;
}

function RiskFollowUp({ trip, host, canEdit }) {
  const [value, setValue] = useState(null), [error, setError] = useState(null), [pending, setPending] = useState(false);
  const [source, setSource] = useState(null), [evidenceError, setEvidenceError] = useState(null);
  const generation = useRef(0), readGeneration = useRef(0), evidenceGeneration = useRef(0), olderLoaded = useRef(false), command = useRef(null);
  async function load(cursor) {
    const current = generation.current, reading = ++readGeneration.current;
    try {
      const result = await host.call("get_trip_follow_up", { tripId: trip.tripId, ...(cursor ? { beforeEventId: cursor } : {}) });
      if (current !== generation.current || reading !== readGeneration.current) return;
      if (cursor) olderLoaded.current = true;
      setError(null); setValue(previous => ({ ...result,
        events: [...new Map([...(previous?.events || []), ...result.events].map(item => [item.eventId, item])).values()].sort((a, b) => b.eventId - a.eventId),
        nextEventCursor: !cursor && olderLoaded.current ? previous?.nextEventCursor : result.nextEventCursor,
      }));
    } catch (failure) { if (current === generation.current && reading === readGeneration.current) setError(failure.message || "跟进状态暂时无法读取，请重试。"); }
  }
  useEffect(() => {
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, 60000); document.addEventListener("visibilitychange", refresh);
    return () => { generation.current++; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [trip.tripId, host]);
  useEffect(() => {
    if (!source) return;
    const expire = () => { setSource(null); setEvidenceError("这份天气资料已到期，请查看新的检查结果。"); };
    if (sourceIsExpired(source)) { expire(); return; }
    const timer = setTimeout(expire, Math.max(0, Date.parse(source.freshUntil) - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [source]);
  async function toggle() {
    const active = generation.current, enabled = !value.enabled;
    readGeneration.current++;
    const key = `${trip.revision}:${value.revision}:${enabled}`;
    if (command.current?.key !== key) command.current = { key, requestId: crypto.randomUUID() };
    setPending(true); setError(null);
    try {
      await host.call("set_trip_follow_up", { tripId: trip.tripId, expectedRevision: trip.revision, expectedFollowUpRevision: value.revision, enabled, requestId: command.current.requestId });
      command.current = null; if (active === generation.current) await load();
    } catch (failure) { if (active === generation.current) setError(failure.message); }
    finally { if (active === generation.current) setPending(false); }
  }
  async function evidence(id) {
    const active = generation.current, reading = ++evidenceGeneration.current;
    setSource(null); setEvidenceError(null);
    try {
      const result = await host.call("get_trip_result_reference", { resultId: id });
      if (active !== generation.current || reading !== evidenceGeneration.current) return;
      if (sourceIsExpired(result) || !result.data) setEvidenceError("这份天气资料已到期，不能作为当前天气依据。"); else setSource(result);
    } catch (failure) { if (active === generation.current && reading === evidenceGeneration.current) setEvidenceError(failure.message); }
  }
  return <section class="risk-follow-up" aria-labelledby="follow-up-title"><div class="facts-heading"><h3 id="follow-up-title">风险跟进</h3><div class="component-actions"><button type="button" disabled={pending} onClick={() => load()}>刷新跟进</button>
    {value && canEdit && !value.ended && <button type="button" disabled={pending} onClick={toggle}>{value.enabled ? "暂停跟进" : "恢复跟进"}</button>}</div></div>
    {error && <p class="follow-up-error" role="alert">{error}</p>}
    {!value ? <p>{error ? "已保存的暂定行程仍然保留。" : "正在读取跟进范围…"}</p> : <>
      <p class="follow-up-state">{value.ended ? "跟进已结束" : value.enabled ? "已开启可用范围的检查" : "跟进已暂停"} · 停止于 {at(value.stopsAt)}</p>
      <dl class="follow-up-times"><div><dt>目的地天气</dt><dd>{weatherLabels[value.weather.status] || "本次检查未完成"}</dd></div>
        <div><dt>最近尝试</dt><dd>{at(value.weather.lastAttemptAt)}</dd></div><div><dt>最近成功</dt><dd>{at(value.weather.lastSuccessAt)}</dd></div><div><dt>下次检查</dt><dd>{value.nextCheckAt ? at(value.nextCheckAt) : "当前未安排"}</dd></div></dl>
      <p class="follow-up-gap">覆盖缺口：天气仅按当前目的地查询，不保证多城市或全部日期均被覆盖。航班状态、交通衔接、营业及预约条件尚未持续检查。</p>
      {value.events.length > 0 && <div class="follow-up-events"><h4>已发现的变化</h4>{value.events.map(event => <article key={event.eventId}><p>目的地天气资料有变化，请核对天气及日期覆盖。</p><span>{at(event.createdAt)}</span><button type="button" onClick={() => evidence(event.resultId)}>查看变化依据</button></article>)}</div>}
      {value.nextEventCursor && <button class="more-button" type="button" onClick={() => load(value.nextEventCursor)}>查看更早变化</button>}
      {evidenceError && <p role="alert">{evidenceError}</p>}
      {source?.data && <div class="weather-evidence"><h4>天气来源资料</h4><p>高德天气 · 查询于 {at(source.checkedAt)} · 有效至 {at(source.freshUntil)}</p>
        <ul>{source.data.forecastDays?.map(day => <li key={day.date}>{day.date}：白天{day.dayCondition || "未返回"}，夜间{day.nightCondition || "未返回"}；最高 {day.highC ?? "未知"}°C，最低 {day.lowC ?? "未知"}°C</li>)}</ul></div>}
    </>}
  </section>;
}
