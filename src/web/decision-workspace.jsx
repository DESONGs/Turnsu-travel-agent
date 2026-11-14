import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock, MapPin, PencilSimple, X } from "@phosphor-icons/react";
import { OverlaySurface } from "./ui/overlay.jsx";
import "./decision-workspace.css";

export const decisionDomains = [["stay", "住宿"], ["transport", "交通"], ["food", "餐饮"], ["play", "体验"]];
const value = (v) => v == null || v === "" ? "待核验" : typeof v === "object" ? v.summary ?? v.description ?? v.label ?? "查看来源条件" : String(v);
export function quoteLabel(node) {
  const p = node.price;
  if (p?.amount == null) return { amount: "价格待核验", basis: "尚无完整报价" };
  return { amount: new Intl.NumberFormat("zh-CN", { style: "currency", currency: p.currency || "CNY", maximumFractionDigits: 0 }).format(p.amount), basis: [({ per_night_room: "每间每晚", per_person: "每人", per_order: "整单", per_vehicle: "每车", entire_stay: "整个入住期" })[p.unit] || p.basis || "价格口径待核验", ({ firm: "实时报价", reference: "参考价", estimate: "估算" })[p.quality] || "价格待核验"].join(" · ") };
}
function travelTime(raw) {
  if (!raw) return "待核验";
  const parts = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!parts) return String(raw);
  const [, year, month, day, time, offset] = parts;
  return `${year}/${month}/${day} ${time}${offset ? ` UTC${offset === "Z" ? "+00:00" : offset}` : ""}`;
}
export function comparisonFacts(node, domain) {
  const o = node.operability ?? {};
  const facts = domain === "stay" ? [["房型／床型", o.roomName ?? o.roomType ?? o.bedType], ["房间与入住人数", o.party ? `${o.party.rooms ?? "?"} 间 · ${o.party.adults ?? "?"} 位成人` : null], ["早餐", o.mealPlan ?? o.breakfast], ["退改与支付", o.cancellationPolicy ?? o.refundPolicy], ["位置", node.location?.address ?? node.location?.label], ["入住资格与设施", o.foreignGuestPolicy ?? o.accessibilitySummary]] : domain === "transport" ? [["出发 → 抵达", o.departureAt || o.arrivalAt ? `${travelTime(o.departureAt)} → ${travelTime(o.arrivalAt)}` : null], ["机场／车站", o.departureStation || o.arrivalStation ? `${o.departureStation ?? "待核验"} → ${o.arrivalStation ?? "待核验"}` : null], ["舱等／席别", o.cabinClass ?? o.seatClass ?? o.fareClass], ["行李", o.baggageAllowance ?? o.baggage], ["退改", o.refundPolicy ?? o.cancellationPolicy], ["换乘与接驳", o.transferSummary]] : [["时间与预约", o.openingHours ?? o.reservationPolicy], ["位置与动线", node.location?.address ?? node.location?.label], ["适用限制", o.restrictions ?? o.dietarySummary], ["退改", o.cancellationPolicy]];
  return facts.map(([label, v]) => [label, value(v)]);
}
export function DecisionComparison({ domain = "stay", nodes = [], selectedIds = [], currentIds = [], onDetails, onSelect, onPreview, onResearch, loading, renderPrice }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? nodes : nodes.slice(0, 3);
  const title = Object.fromEntries(decisionDomains)[domain];
  return <section className="decision-compare" aria-label={`${title}候选比较`}>
    <header className="decision-section-head"><div><h2>{domain === "stay" ? "住得合适，每天都轻松一点" : domain === "transport" ? "从出发到返回，把路接完整" : `把${title}放进同一份行程`}</h2><p>比较同一条件下的选择，再核对对时间、路线和预算的影响。</p></div><button className="decision-link" onClick={onResearch} disabled={loading}><PencilSimple />调整要求</button></header>
    {!nodes.length ? <div className="decision-empty"><h3>还没有可比较的{title}方案</h3><p>已确认的其他安排会保留。继续查找后，这里会展示来源与选择条件。</p><button className="button primary" disabled={loading} onClick={onResearch}>继续查找{title}</button></div> : <>
      <div className="decision-options">{shown.map(node => { const price = quoteLabel(node); const chosen = selectedIds.includes(node.nodeId); const current = node.selected || currentIds.includes(node.nodeId); return <article key={node.nodeId} className={`decision-option ${chosen ? "chosen" : ""}`}>
        {node.media?.[0]?.url ? <button className="decision-photo" aria-label={`查看${node.title}详情`} onClick={() => onDetails(node.nodeId)}><img src={node.media[0].url} alt={node.media[0].title || node.title} loading="lazy" referrerPolicy="no-referrer" /></button> : null}
        <div className="decision-option-body"><span className="decision-option-state">{node.selected ? "当前安排" : current ? "当前草案" : chosen ? "已加入修改预览" : "可比较方案"}</span><h3><button onClick={() => onDetails(node.nodeId)}>{node.title}</button></h3><p className="decision-description">{node.summary || node.location?.address || "详情资料待补充"}</p><div className="decision-price">{renderPrice ? renderPrice(node) : <><strong className="turnsu-num">{price.amount}</strong><small>{price.basis}</small></>}</div>
        <dl className="decision-facts">{comparisonFacts(node, domain).map(([label, v]) => <div key={label}><dt>{label}</dt><dd className={v === "待核验" ? "unknown" : ""}>{v}</dd></div>)}</dl>
        <p className="decision-source"><Clock />{node.price?.checkedAt ? new Date(node.price.checkedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未取得核验时间"}</p>
        <footer><button className="decision-link" onClick={() => onDetails(node.nodeId)}>查看详情<ArrowRight /></button><button className={chosen || current ? "button secondary" : "button primary"} disabled={loading || current} onClick={() => onSelect(node)}>{node.selected ? "已采用" : current ? "当前草案" : chosen ? <><Check />已选，取消</> : "试用这个选择"}</button></footer></div>
      </article>; })}</div>
      {nodes.length > 3 ? <button className="decision-link decision-more" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `查看其余 ${nodes.length - 3} 个方案`}</button> : null}
      {selectedIds.length ? <div className="decision-selection-bar" role="status"><div><strong>选择已保存，待核对修改</strong><small>采用前会核对整趟行程；当前安排仍保留。</small></div><button className="button primary" onClick={onPreview}>核对修改<ArrowRight /></button></div> : null}
    </>}
  </section>;
}
export function MainPlanOverview({ trip, plan, nodes = [], onCompare, onDetails, onMap, onEdit, onContinue, onJournalDate, draft = false }) {
  const days = new Map();
  const adopted = plan?.planning?.plan?.adopted;
  const outstanding = adopted?.unverifiedConditions ?? [];
  const clock = (value, zone) => { if (!value) return "待排时"; if (!zone) return `${value.slice(11,16)} ${value.endsWith("Z") ? "UTC" : value.slice(-6)}`; try { return new Intl.DateTimeFormat("zh-CN", { hour:"2-digit", minute:"2-digit", hour12:false, timeZone:zone }).format(new Date(value)); } catch { return value.slice(11,16); } };
  const stops = plan?.itinerary?.stops ?? plan?.mobility?.itinerary?.stops;
  const scheduled = stops?.length ? stops.map(stop => ({ ...(nodes.find(n => n.nodeId === stop.nodeId) ?? {}), ...stop, nodeId: stop.nodeId, schedule: { date: stop.date, startAt: stop.startAt, endAt: stop.endAt } })) : nodes;
  for (const node of scheduled) { const key = node.schedule?.date ?? node.serviceDate ?? node.time?.startAt?.slice(0,10) ?? node.schedule?.startAt?.slice(0, 10) ?? "时间待安排"; days.set(key, [...(days.get(key) ?? []), node]); }
  for (const [day, items] of days) days.set(day, items.sort((a,b) => String(a.schedule?.startTime ?? a.schedule?.startAt ?? a.time?.startAt ?? "").localeCompare(String(b.schedule?.startTime ?? b.schedule?.startAt ?? b.time?.startAt ?? ""))));
  return <section className="decision-overview"><header className="decision-section-head"><div><h2>{nodes.length ? draft ? "整趟旅行的草案" : "你的主要安排" : "先形成整趟旅行的主方案"}</h2><p>{nodes.length ? draft ? "这版草案还没有采用。核对时间、路线和预算后，再决定。" : "已采用的安排保留在这里。每次调整都先看影响，再决定。" : "住宿、往返交通、每天吃什么和去哪里，会一起考虑。"}</p></div>{onEdit && <button className="decision-link" onClick={onEdit}><PencilSimple />旅行要求</button>}</header>
    {!draft && adopted?.adoptionStatus === "tentative" && <section className="turnsu-tentative-notice" role="status"><strong>暂定行程</strong><p>仍有 {outstanding.length} 项条件待核验。采用时的确认只表示已知悉未知条件，不表示来源核实完成。</p><details><summary>查看待核验事项</summary><ul>{outstanding.map(item => <li key={item.conditionId}>{item.label}</li>)}</ul></details></section>}

    <div className="decision-timeline-head"><h3>每日安排</h3><button className="decision-link" onClick={onMap}><MapPin />在地图上看</button></div>
    {!nodes.length ? <div className="decision-empty"><h3>安排还在形成中</h3><p>可以先浏览已找到的酒店和交通，或让助手继续补齐时间与路线。</p><button className="button primary" onClick={onContinue}>继续完善主方案</button></div> : [...days].map(([day, items]) => <section className="decision-day" key={day}><div className="decision-day-heading"><h4>{day}</h4>{onJournalDate && /^\d{4}-\d{2}-\d{2}$/.test(day) && <button type="button" className="decision-link" onClick={() => onJournalDate(day)}>记录这一天</button>}</div><ol>{items.map(node => <li key={`${node.stopId ?? node.nodeId}:${node.schedule?.startAt ?? ""}`}><time className="turnsu-num">{node.schedule?.startTime || clock(node.schedule?.startAt || node.time?.startAt, node.timeZone || trip.timeZone)}</time><button onClick={() => onDetails(node.nodeId)}><span>{Object.fromEntries(decisionDomains)[node.domain]}</span><strong>{node.title}</strong><small>{node.location?.address ?? node.summary}</small></button></li>)}</ol></section>)}
    <div className="decision-domain-summary">{decisionDomains.map(([domain, label]) => { const items = nodes.filter(n => n.domain === domain); return <button key={domain} onClick={() => onCompare(domain)}><span>{label}</span><strong>{items[0]?.title || "继续完善"}</strong><small>{items.length ? `${items.length} 项${draft ? "草案安排" : "已采用"} · 查看与比较` : "查看候选与待补信息"}<ArrowRight /></small></button>; })}</div>
    {plan?.budget ? <div className="decision-budget-note">费用与路线核验以当前方案为准。缺少日期、人数或完整报价的项目会保留待核验状态。</div> : null}
  </section>;
}
export function TripRequirementsDialog({ trip, onClose, onSave }) {
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const rawDates = Array.isArray(trip.dates) ? trip.dates : String(trip.dates ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const dates = rawDates.length === 1 && trip.durationDays ? [rawDates[0], new Date(Date.parse(rawDates[0]) + (trip.durationDays - 1) * 86400000).toISOString().slice(0, 10)] : rawDates;
  return <OverlaySurface overlayClassName="decision-modal-overlay" surfaceClassName="decision-modal" labelledBy="requirements-title" onClose={saving ? undefined : onClose}><header><div><h2 id="requirements-title">核对旅行要求</h2></div><button type="button" className="decision-icon" aria-label="关闭旅行要求" disabled={saving} onClick={onClose}><X /></button></header><form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); const start = String(f.get("start")); const end = String(f.get("end")); if (start && end && end < start) { setError("返回日期不能早于出发日期"); return; } setSaving(true); setError(""); try { await onSave({ destination: String(f.get("destination")).trim(), dates: start && end ? [start, end] : dates, travelerCount: Number(f.get("travelers")), totalBudget: f.get("budget") ? Number(f.get("budget")) : null, preferences: String(f.get("preferences")).trim() }); onClose(); } catch (e) { setError(e.code === "revision_conflict" ? "旅行已在其他窗口更新。请刷新后重新核对。" : "保存未完成，请重试。原要求仍保留。"); } finally { setSaving(false); } }}>
    <label>目的地<input name="destination" defaultValue={trip.destination || ""} maxLength={160} required /></label><div className="decision-form-row"><label>出发日期<input type="date" name="start" defaultValue={dates[0]?.slice(0, 10) || ""} /></label><label>返回日期<input type="date" name="end" defaultValue={dates[1]?.slice(0, 10) || ""} /></label></div><div className="decision-form-row"><label>同行人数<input type="number" name="travelers" min="1" max="12" step="1" defaultValue={trip.travelerCount || 1} required /></label><label>全程总预算（元）<input type="number" name="budget" min="1" max="10000000" defaultValue={trip.totalBudget ?? ""} /></label></div><label>偏好与同行人的需要<textarea name="preferences" rows="3" maxLength={1600} defaultValue={Array.isArray(trip.preferences) ? trip.preferences.join("；") : trip.preferences || ""} placeholder="例如两间房、尽量少换乘、午间休息" /></label><p>本次修改只用于这趟旅行。已采用的安排会保留，并重新核对受影响的路线与预算。</p>{error ? <p className="decision-error" role="alert">{error}</p> : null}<footer><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? "正在保存…" : "保存旅行要求"}</button></footer></form></OverlaySurface>;
}
