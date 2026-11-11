import { render, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { draftDays } from "./draft-days.mjs";
import { Icon } from "./Icon.jsx";
import { Sheet } from "./Sheet.jsx";
import { SharingPanel } from "./SharingPanel.jsx";
import { JournalPanel } from "./JournalPanel.jsx";
import { TentativeAdoptionReview, AdoptedItinerary } from "./TentativeItinerary.jsx";
import { DestinationExperience } from "./DestinationExperience.jsx";
import { sourceIsExpired } from "./destination.mjs";
import "./workbench.css";
import { catalog } from "./catalog.mjs";
import { validateRenderers } from "./render-contract.mjs";
validateRenderers(catalog);

function Arrow({ back = false }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={back ? "M19 12H5m6-6-6 6 6 6" : "M5 12h14m-6-6 6 6-6 6"}/></svg>;
}

function display(value, fallback = "待确定") { return typeof value === "string" && value.trim() ? value : fallback; }

function TripList({ items, cursor, pending, onOpen, onMore, onRefresh }) {
  return <main class="main-shell">
    <header class="section-header"><div><h1>我的旅行</h1><p>在这里继续查看和整理你的旅行。</p></div>
      <button class="text-button" type="button" onClick={onRefresh} disabled={pending}>刷新</button></header>
    {items.length ? <div class="trip-list" aria-label="旅行列表">
      {items.map(item => <button class="trip-row" type="button" key={item.tripId} onClick={() => onOpen(item.tripId)} disabled={pending}>
        <span class="trip-row-copy"><strong>{display(item.destination, "未命名旅行")}</strong><span>{item.role === "owner" ? "我的旅行" : "与我共享"}</span></span><Arrow />
      </button>)}
      {cursor && <button class="more-button" type="button" onClick={onMore} disabled={pending}>{pending ? "正在读取…" : "查看更多旅行"}</button>}
    </div> : <section class="empty-list"><div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 11h22v27H13z"/><path d="M19 19h10M19 25h10M19 31h6"/></svg></div><h2>还没有旅行</h2><p>在对话中告诉助手你想去哪里，创建后就能在这里继续查看。</p></section>}
  </main>;
}

function formatCheckedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function formatOffset(value) { return typeof value === "string" && value ? `UTC${value === "Z" ? "+00:00" : value}` : "UTC 偏移待确认"; }

function useSourceExpired(source) {
  const [sourceClock, setSourceClock] = useState(() => Date.now());
  useEffect(() => {
    let timer;
    const deadline = Date.parse(source?.freshUntil);
    function update() {
      clearTimeout(timer);
      const now = Date.now(); setSourceClock(now);
      if (Number.isFinite(deadline) && deadline > now) timer = setTimeout(update, Math.min(deadline - now, 2_147_483_647));
    }
    function visible() { if (!document.hidden) update(); }
    update(); document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [source?.freshUntil]);
  return sourceIsExpired(source, sourceClock);
}

function PlacePage({ entry, index, multiple, canEdit, pending, onJournal }) {
  const [exploring, setExploring] = useState(null);
  const source = entry.source;
  const expired = useSourceExpired(source);
  const data = source?.data;
  const group = multiple ? `第 ${index + 1} 组地点资料` : "地点资料";
  if (entry.loading) return <p class="place-status">正在读取{group}…</p>;
  if (entry.error) return <p class="place-status">{group}暂时无法读取，请刷新重试。</p>;
  if (expired) return <p class="place-status">{group}已过期，请在对话中让助手重新查询。</p>;
  if (source?.stale) return <p class="place-status">{group}对应的旅行要求已有变化，请在对话中让助手重新查询。</p>;
  if (!data || !Array.isArray(data.candidates)) return <p class="place-status">{group}不完整，请在对话中让助手重新查询。</p>;
  const domain = { play: "游玩", food: "餐饮", stay: "住宿", transport: "交通" }[data.domain];
  const context = [domain, data.keyword, data.page ? `第 ${data.page} 页` : null].filter(Boolean).join(" · ");
  return <div class="place-page">{context && <h3>{context}</h3>}<p class="place-source">高德地图 · 查询于 {formatCheckedAt(source.checkedAt)}。地图资料不代表当前营业或可预订库存。</p>
    {data.candidates.length ? <ul class="place-list">{data.candidates.map((item, itemIndex) => <li key={`${item.sourceId}-${itemIndex}`}><strong>{display(item.name, "名称未返回")}</strong><span>{display(item.address, "地址未返回")}</span>{item.openingHoursReference && <span>地图记录营业时间：{item.openingHoursReference}</span>}
      <div class="place-actions">{typeof item.sourceId === "string" && typeof item.name === "string" && <button class="place-journal" type="button" aria-expanded={exploring === itemIndex} onClick={() => setExploring(exploring === itemIndex ? null : itemIndex)}>探索地点</button>}
      {canEdit && typeof item.sourceId === "string" && typeof item.name === "string" && entry.id && <button class="place-journal" type="button" disabled={pending} onClick={() => onJournal({ resultId: entry.id, sourceId: item.sourceId, name: item.name, domain: data.domain })}>写旅行记录</button>}</div>
      {exploring === itemIndex && <DestinationExperience key={`${entry.id}:${itemIndex}`} place={item} domain={data.domain} checkedAt={source.checkedAt} locations={data.candidates.map(place => ({ place, domain: data.domain, checkedAt: source.checkedAt }))} canEdit={canEdit} onJournal={place => { setExploring(null); onJournal({ name: place.name, domain: data.domain }); }} onClose={() => setExploring(null)} />}</li>)}</ul>
      : <p class="place-status">{data.returnedCount ? "本页地点资料无法完整显示。" : "地图未返回符合条件的地点。"}</p>}
    {Array.isArray(data.unusable) && data.unusable.length > 0 && <p class="place-status">另有 {data.unusable.length} 条地点资料不完整，无法显示。</p>}
    {data.nextPage && <p class="place-status">还有更多结果，可以在对话中让助手继续查询。</p>}
    {data.providerResultLimitReached && <p class="place-status">已到地图来源的查询上限，可缩小搜索范围继续查找。</p>}</div>;
}

function PlaceResults({ component, places, canEdit, pending, onEditLayout, onJournal }) {
  return <section class="place-results" aria-labelledby="places-title"><div class="facts-heading"><h2 id="places-title">候选地点</h2>
    {canEdit && <div class="component-actions"><button type="button" disabled={pending} onClick={() => onEditLayout(component.pinned ? "unpin" : "pin", "places")}>{component.pinned ? "取消固定" : "固定"}</button><button type="button" disabled={pending} onClick={() => onEditLayout("hide", "places")}>隐藏</button></div>}</div>
    {places.entries.length ? places.entries.map((entry, index) => <PlacePage key={entry.id || index} entry={entry} index={index} multiple={places.entries.length > 1} canEdit={canEdit} pending={pending} onJournal={onJournal} />)
      : <p class="place-status">正在读取地点资料…</p>}
  </section>;
}

function PendingPlaceResult({ entry, index, multiple, hidden, canEdit, pending, onDecide, onJournal }) {
  const expired = useSourceExpired(entry.source);
  return <div class="pending-place">
      <PlacePage entry={entry} index={index} multiple={multiple} canEdit={canEdit} pending={pending} onJournal={onJournal} />
      {canEdit && entry.id && <div class="pending-actions"><button type="button" disabled={pending || entry.loading || entry.error || !entry.source?.data || entry.source?.stale || expired} onClick={() => onDecide("accept", entry.id)}>{hidden ? "显示并加入" : "加入候选"}</button>
        <button type="button" disabled={pending} onClick={() => onDecide("reject", entry.id)}>忽略</button></div>}
    </div>;
}

function PendingPlaceResults({ entries, hidden, canEdit, pending, onDecide, onJournal }) {
  if (!entries.length) return null;
  return <section class="place-results" aria-labelledby="pending-places-title"><h2 id="pending-places-title">待确认的候选地点</h2>
    <p class="place-status">你固定或隐藏了候选内容，新资料会先保留在这里。</p>
    {entries.map((entry, index) => <PendingPlaceResult key={entry.id || index} entry={entry} index={index} multiple={entries.length > 1} hidden={hidden}
      canEdit={canEdit} pending={pending} onDecide={onDecide} onJournal={onJournal} />)}
  </section>;
}

const roleLabels = { activity: "游玩", meal: "用餐", stay_check_in: "入住", stay_return: "返回住宿", stay_departure: "离开住宿",
  intercity_arrival: "抵达", transport_departure: "出发", transport_arrival: "到达", local_transport: "市内交通", rest: "休息",
  vehicle_pickup: "取车", vehicle_return: "还车", parking: "停车", bag_drop: "寄存行李" };
const careLabels = {
  mobility: { reduceWalking: "减少步行", avoidStairs: "避开楼梯", stepFreeRequired: "无台阶路线", wheelchairSpaceRequired: "轮椅空间", luggageAssistanceRequired: "行李协助",
    maxContinuousWalkMeters: value => `连续步行不超过 ${value} 米`, maxTransfers: value => `换乘不超过 ${value} 次` },
  stamina: { needsFrequentRest: "频繁休息", restEveryMinutes: value => `每 ${value} 分钟休息`, maxActiveMinutesPerBlock: value => `连续活动不超过 ${value} 分钟` },
  schedule: { regularMealTimes: "固定用餐时间", earliestStartTime: value => `最早 ${value} 出发`, latestReturnTime: value => `最晚 ${value} 返回`, latestDinnerTime: value => `最晚 ${value} 晚餐` },
  facilities: { accessibleToiletRequired: "无障碍卫生间", toiletAccessPriority: "方便使用卫生间", nursingRoomRequired: "母婴室", strollerFriendlyRequired: "婴儿车可通行", quietRetreatRequired: "安静休息处" },
  sensory: { avoidCrowds: "避开拥挤", avoidStrongSensoryStimuli: "避开强烈感官刺激" },
  food: { exclusions: value => `饮食排除：${Array.isArray(value) ? value.join("、") || "无" : "资料不完整"}` },
};
function TravelerItem({ traveler, index, canEdit, pending, onRemove }) {
    const [editing, setEditing] = useState(false);
    const [confirming, setConfirming] = useState(null);
    if (!traveler || typeof traveler !== "object" || Array.isArray(traveler)) return <p>同行人 {index + 1} 的要求暂时无法显示</p>;
    const lines = [];
    const care = traveler.careNeeds;
    if (care != null && (typeof care !== "object" || Array.isArray(care))) lines.push({ label: "部分要求无法显示" });
    for (const [group, values] of Object.entries(care && typeof care === "object" && !Array.isArray(care) ? care : {})) {
      if (!values || typeof values !== "object" || Array.isArray(values)) { lines.push({ label: "部分要求无法显示" }); continue; }
      for (const [field, value] of Object.entries(values)) {
        if (group === "food" && field === "exclusions" && Array.isArray(value)) {
          for (const item of value) lines.push(typeof item === "string" && item ? { label: `饮食排除：${item}`, target: { type: "food_exclusion", value: item } } : { label: "部分饮食要求无法显示" });
          continue;
        }
        if (group === "food" && field === "exclusions") { lines.push({ label: "部分饮食要求无法显示" }); continue; }
        const label = careLabels[group]?.[field];
        if (!label) lines.push({ label: "部分要求无法显示" });
        else if (typeof label === "function") lines.push({ label: label(value), target: { type: "care", group, field } });
        else if (typeof value === "boolean") lines.push({ label: value ? `需要${label}` : `不要求${label}`, target: { type: "care", group, field } });
        else lines.push({ label: "部分要求无法显示" });
      }
    }
    if (traveler.hardConstraints != null && !Array.isArray(traveler.hardConstraints)) lines.push({ label: "部分必要条件无法显示" });
    for (const constraint of Array.isArray(traveler.hardConstraints) ? traveler.hardConstraints : []) lines.push(constraint?.type === "foreign_guest_required"
      ? { label: "需核验住宿接待条件", target: { type: "hard_constraint", value: "foreign_guest_required" } } : { label: "部分必要条件无法显示" });
    if (traveler.softPreferences?.length) lines.push({ label: "其他偏好请在对话中查看" });
    const name = display(traveler.displayName, `同行人 ${index + 1}`);
    const editable = canEdit && typeof traveler.travelerId === "string";
    return <div class="traveler-item"><div class="facts-heading"><strong>{name}</strong>{editable && <button class="traveler-edit" type="button" disabled={pending} onClick={() => { setEditing(!editing); setConfirming(null); }}>{editing ? "完成" : "编辑"}</button>}</div>
      {lines.length ? <ul>{lines.map((line, itemIndex) => <li key={itemIndex}><span>{line.label}</span>{editable && editing && line.target && <button type="button" disabled={pending} aria-label={`移除${name}的${line.label}`} onClick={() => setConfirming(line)}>移除</button>}</li>)}</ul> : <span>尚未记录特别要求</span>}
      {editable && editing && <button class="traveler-remove" type="button" disabled={pending} onClick={() => setConfirming({ label: name, target: { type: "traveler" } })}>移除同行人</button>}
      {editable && confirming && <div class="traveler-confirm" role="group" aria-label="确认移除"><span>确定移除{confirming.label}？</span><button type="button" disabled={pending} onClick={() => setConfirming(null)}>取消</button><button type="button" disabled={pending} onClick={async () => { if (await onRemove(traveler.travelerId, confirming.target)) setConfirming(null); }}>确认移除</button></div>}
    </div>;
}
function TravelerRequirements({ travelers, canEdit, pending, onRemove }) {
  if (travelers == null || (Array.isArray(travelers) && !travelers.length)) return null;
  if (!Array.isArray(travelers)) return <p>同行人要求暂时无法显示</p>;
  return <div class="traveler-list" aria-label="同行人要求">{travelers.map((traveler, index) => <TravelerItem key={traveler?.travelerId || index}
    traveler={traveler} index={index} canEdit={canEdit} pending={pending} onRemove={onRemove} />)}</div>;
}

function BudgetForm({ budget, pending, onSave, onCancel }) {
  const [amount, setAmount] = useState(typeof budget.totalBudget === "number" ? String(budget.totalBudget) : "");
  const [currency, setCurrency] = useState(typeof budget.currency === "string" && budget.currency !== "XXX" ? budget.currency : "");
  const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault();
    const cleanAmount = amount.trim(), cleanCurrency = currency.trim().toUpperCase();
    const numeric = cleanAmount === "" ? null : Number(cleanAmount);
    if (numeric !== null && (!Number.isFinite(numeric) || numeric < 0)) { setError("请输入不小于零的预算。"); return; }
    if ((numeric !== null && !cleanCurrency) || (cleanCurrency && !/^[A-Z]{3}$/.test(cleanCurrency))) { setError("请输入三位币种代码，例如 CNY 或 JPY。"); return; }
    setError(null);
    const changes = { totalBudget: numeric, ...(cleanCurrency ? { currency: cleanCurrency } : {}) };
    if (await onSave(changes)) onCancel();
  }
  return <form class="budget-form" onSubmit={submit}><label>预算上限<input type="number" min="0" step="any" inputmode="decimal" value={amount} onInput={event => setAmount(event.currentTarget.value)} /></label>
    <label>币种代码<input type="text" maxLength="3" autoCapitalize="characters" value={currency} onInput={event => setCurrency(event.currentTarget.value)} placeholder="例如 CNY" /></label>
    <p>预算留空表示不设上限。</p>{error && <p role="alert">{error}</p>}
    <div><button type="button" disabled={pending} onClick={onCancel}>取消</button><button type="submit" disabled={pending}>保存预算</button></div></form>;
}

function RecordedTransportCosts({ summary, facts }) {
  if (!Array.isArray(facts) || !facts.length) return null;
  if (!summary || !Array.isArray(summary.currencyTotals)) return <p class="layout-status">已记录交通价格暂时无法核对。</p>;
  return <div class="recorded-costs"><h3>已记录的交通价格</h3>
    {summary.currencyTotals.length > 0 ? <ul>{summary.currencyTotals.map(item => <li key={item.currency}>{display(item.currency, "币种待确定")} {display(item.amount, "金额待确定")}</li>)}</ul> : <p>尚无可汇总的价格。</p>}
    {summary.missingPriceOrPassengers > 0 && <p>{summary.missingPriceOrPassengers} 段缺少价格或乘坐人数。</p>}
    {summary.sharedPrices > 0 && <p>{summary.sharedPrices} 段的价格包含多段或范围未确定，未计入汇总。</p>}
    {summary.uncertainTaxes > 0 && <p>{summary.uncertainTaxes} 段的税费未包含或尚未确认。</p>}
    <p>仅汇总标明属于单段的价格；每人价格按已记录的乘坐人数计算。不同币种未换算，其他费用未计入。</p>
    {summary.comparison === "recorded_transport_exceeds_budget" && <p class="draft-conflict">同币种的已记录交通价格已超过预算。</p>}
  </div>;
}

const transportModes = { flight: "航班", train: "火车", bus: "长途汽车", ferry: "轮渡", other: "其他交通" };
const journeyPurposes = { outbound: "去程", return: "返程", transfer: "跨城", scenic: "景区交通" };
const journeyModes = { train: "火车", flight: "航班", flexible: "交通方式可商量" };
function JourneyRequests({ journeys, canEdit, pending, onRemove }) {
  const [removing, setRemoving] = useState(null);
  if (journeys == null || (Array.isArray(journeys) && journeys.length === 0)) return null;
  if (!Array.isArray(journeys)) return <section class="transport-facts"><h2>往返与跨城</h2><p>交通要求暂时无法显示。</p></section>;
  return <section class="transport-facts" aria-labelledby="journeys-title"><h2 id="journeys-title">往返与跨城</h2>
    {journeys.map((journey, index) => {
      if (!journey || typeof journey !== "object" || !journeyPurposes[journey.purpose] || !["plan", "self_arranged"].includes(journey.scope))
        return <p key={index}>一段交通要求暂时无法显示。</p>;
      return <div class="transport-item" key={journey.journeyId || index}><strong>{journeyPurposes[journey.purpose]} · {display(journey.origin)} → {display(journey.destination)}</strong>
        <p>{display(journey.date)} · {journey.scope === "self_arranged" ? "自行安排" : "需要规划"}{journey.mode && journeyModes[journey.mode] ? ` · ${journeyModes[journey.mode]}` : ""}</p>
        {journey.arriveBy && <p>最晚到达：{journey.arriveBy.replace("T", " ")}</p>}
        {canEdit && typeof journey.journeyId === "string" && removing !== journey.journeyId && <button type="button" disabled={pending} onClick={() => setRemoving(journey.journeyId)}>移除要求</button>}
        {canEdit && removing === journey.journeyId && <div class="traveler-confirm" role="group" aria-label="确认移除交通要求"><span>确定移除这段交通要求？</span><button type="button" disabled={pending} onClick={() => setRemoving(null)}>取消</button><button type="button" disabled={pending} onClick={async () => { if (await onRemove(journey.journeyId)) setRemoving(null); }}>确认移除</button></div>}
      </div>;
    })}
  </section>;
}
function TransportForm({ fact, travelers, pending, onSave, onCancel }) {
  const [id] = useState(() => fact?.transportId || crypto.randomUUID());
  const [mode, setMode] = useState(fact?.mode || "flight");
  const [number, setNumber] = useState(fact?.number || "");
  const [origin, setOrigin] = useState(fact?.origin || "");
  const [destination, setDestination] = useState(fact?.destination || "");
  const [departLocal, setDepartLocal] = useState(fact?.departure?.local || "");
  const [departZone, setDepartZone] = useState(fact?.departure?.timeZone || "");
  const [departOffset, setDepartOffset] = useState(fact?.departure?.utcOffset || "");
  const [arriveLocal, setArriveLocal] = useState(fact?.arrival?.local || "");
  const [arriveZone, setArriveZone] = useState(fact?.arrival?.timeZone || "");
  const [arriveOffset, setArriveOffset] = useState(fact?.arrival?.utcOffset || "");
  const [selected, setSelected] = useState(Array.isArray(fact?.travelerIds) ? fact.travelerIds : []);
  const [priceAmount, setPriceAmount] = useState(fact?.price?.amount || "");
  const [priceCurrency, setPriceCurrency] = useState(fact?.price?.currency || "");
  const [priceUnit, setPriceUnit] = useState(fact?.price?.unit || "");
  const [priceTaxes, setPriceTaxes] = useState(fact?.price?.taxes || "unknown");
  const [priceCoverage, setPriceCoverage] = useState(fact?.price?.coverage || "");
  const [priceError, setPriceError] = useState(null);
  async function submit(event) {
    event.preventDefault();
    const amount = priceAmount.trim(), currency = priceCurrency.trim().toUpperCase();
    const hasPrice = Boolean(amount || currency || priceUnit || priceCoverage || priceTaxes !== "unknown");
    if (hasPrice && (!/^[0-9]{1,15}(?:\.[0-9]{1,6})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency) || !priceUnit || !priceCoverage)) {
      setPriceError("记录价格时，请填写金额、币种代码、计价方式和覆盖范围。"); return;
    }
    setPriceError(null);
    const transport = { transportId: id, mode, origin: origin.trim(), destination: destination.trim(),
      ...(number.trim() ? { number: number.trim() } : {}),
      departure: { local: departLocal, timeZone: departZone.trim(), ...(departOffset.trim() ? { utcOffset: departOffset.trim() } : {}) },
      arrival: { local: arriveLocal, timeZone: arriveZone.trim(), ...(arriveOffset.trim() ? { utcOffset: arriveOffset.trim() } : {}) }, travelerIds: selected,
      ...(hasPrice ? { price: { amount, currency, unit: priceUnit, taxes: priceTaxes, coverage: priceCoverage } } : {}) };
    if (await onSave(transport)) onCancel();
  }
  return <form class="transport-form" onSubmit={submit}>
    <label>交通方式<select value={mode} onChange={event => setMode(event.currentTarget.value)}>{Object.entries(transportModes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <label>航班或车次（选填）<input value={number} maxLength="30" pattern="[A-Za-z0-9 -]*" onInput={event => setNumber(event.currentTarget.value)} /></label>
    <div class="transport-pair"><label>出发地<input value={origin} maxLength="120" required onInput={event => setOrigin(event.currentTarget.value)} /></label><label>目的地<input value={destination} maxLength="120" required onInput={event => setDestination(event.currentTarget.value)} /></label></div>
    <div class="transport-pair"><label>出发当地时间<input type="datetime-local" value={departLocal} required onInput={event => setDepartLocal(event.currentTarget.value)} /></label><label>出发地时区<input value={departZone} required placeholder="例如 Asia/Shanghai" onInput={event => setDepartZone(event.currentTarget.value)} /></label></div>
    <label>出发 UTC 偏移（夏令时重复时间需填写）<input value={departOffset} placeholder="例如 +08:00" onInput={event => setDepartOffset(event.currentTarget.value)} /></label>
    <div class="transport-pair"><label>到达当地时间<input type="datetime-local" value={arriveLocal} required onInput={event => setArriveLocal(event.currentTarget.value)} /></label><label>到达地时区<input value={arriveZone} required placeholder="例如 Europe/London" onInput={event => setArriveZone(event.currentTarget.value)} /></label></div>
    <label>到达 UTC 偏移（夏令时重复时间需填写）<input value={arriveOffset} placeholder="例如 +00:00" onInput={event => setArriveOffset(event.currentTarget.value)} /></label>
    {Array.isArray(travelers) && travelers.length > 0 && <fieldset><legend>乘坐人（可稍后确认）</legend>{travelers.filter(person => person?.travelerId).map((person, index) => <label class="transport-check" key={person.travelerId}><input type="checkbox" checked={selected.includes(person.travelerId)} onChange={event => setSelected(event.currentTarget.checked ? [...selected, person.travelerId] : selected.filter(item => item !== person.travelerId))} />{display(person.displayName, `同行人 ${index + 1}`)}</label>)}</fieldset>}
    <details class="transport-price" open={Boolean(fact?.price)}><summary>记录价格（选填）</summary><div class="transport-price-fields">
      <label>金额<input type="text" inputmode="decimal" value={priceAmount} onInput={event => setPriceAmount(event.currentTarget.value)} /></label>
      <label>币种代码<input value={priceCurrency} maxLength="3" placeholder="例如 CNY" onInput={event => setPriceCurrency(event.currentTarget.value)} /></label>
      <label>计价方式<select value={priceUnit} onChange={event => setPriceUnit(event.currentTarget.value)}><option value="">请选择</option><option value="total">整笔总价</option><option value="per_person">每人</option></select></label>
      <label>税费<select value={priceTaxes} onChange={event => setPriceTaxes(event.currentTarget.value)}><option value="unknown">不确定</option><option value="included">已包含</option><option value="excluded">未包含</option></select></label>
      <label>价格覆盖范围<select value={priceCoverage} onChange={event => setPriceCoverage(event.currentTarget.value)}><option value="">请选择</option><option value="segment">仅这段交通</option><option value="shared_or_unknown">包含多段或不确定</option></select></label>
      {(priceAmount || priceCurrency || priceUnit || priceCoverage || priceTaxes !== "unknown") && <button type="button" class="clear-price" disabled={pending} onClick={() => { setPriceAmount(""); setPriceCurrency(""); setPriceUnit(""); setPriceTaxes("unknown"); setPriceCoverage(""); setPriceError(null); }}>清除价格</button>}
      {priceError && <p role="alert">{priceError}</p>}</div></details>
    <p>只记录行程信息，请勿填写证件、支付信息或订单凭证。</p><div class="transport-actions"><button type="button" disabled={pending} onClick={onCancel}>取消</button><button type="submit" disabled={pending}>确认保存</button></div>
  </form>;
}

function TransportFacts({ facts, overlaps, travelers, canEdit, pending, onSave, onRemove }) {
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  if (facts != null && !Array.isArray(facts)) return <section class="transport-facts"><h2>已订交通</h2><p>交通记录暂时无法显示。</p></section>;
  const items = facts || [];
  function nameFor(id) {
    const fact = items.find(item => item?.transportId === id);
    return fact ? `${transportModes[fact.mode] || "交通"}${fact.number ? ` ${fact.number}` : ""}（${display(fact.origin)} → ${display(fact.destination)}）` : "一条交通记录";
  }
  return <section class="transport-facts" aria-labelledby="transport-title"><div class="facts-heading"><h2 id="transport-title">已订交通</h2>{canEdit && !editing && <button type="button" disabled={pending} onClick={() => { setRemoving(null); setEditing({}); }}>记录交通</button>}</div>
    {items.length > 0 && <p>由你记录，航班、车次和预订状态尚未由来源核验。</p>}
    {overlaps != null && !Array.isArray(overlaps) && <p class="draft-warning">交通时间核对结果暂时无法显示。</p>}
    {Array.isArray(overlaps) && overlaps.length > 0 && <ul class="transport-conflicts">{overlaps.map((issue, index) => <li key={index}>
      {nameFor(issue?.firstTransportId)}与{nameFor(issue?.secondTransportId)}时间重叠；{issue?.code === "transport_overlap" ? "有相同乘坐人，请核对。" : "乘坐人未完全确定，请核对。"}</li>)}</ul>}
    {items.map((fact, index) => {
      if (!fact || typeof fact !== "object") return <p key={index}>一条交通记录暂时无法显示。</p>;
      const people = Array.isArray(fact.travelerIds) ? fact.travelerIds.map(id => (Array.isArray(travelers) ? travelers.find(person => person?.travelerId === id)?.displayName : null) || "同行人资料未找到") : [];
      return <div class="transport-item" key={fact.transportId || index}><div class="facts-heading"><strong>{transportModes[fact.mode] || "交通"}{fact.number ? ` ${fact.number}` : ""} · {display(fact.origin)} → {display(fact.destination)}</strong>
        {canEdit && !editing && <button type="button" disabled={pending} onClick={() => { setRemoving(null); setEditing(fact); }}>编辑</button>}</div>
        <p>出发 {display(fact.departure?.local).replace("T", " ")} · {display(fact.departure?.timeZone)} · <span class="utc-offset">{formatOffset(fact.departure?.utcOffset)}</span></p>
        <p>到达 {display(fact.arrival?.local).replace("T", " ")} · {display(fact.arrival?.timeZone)} · <span class="utc-offset">{formatOffset(fact.arrival?.utcOffset)}</span></p>
        <p>{people.length ? `乘坐人：${people.join("、")}` : "乘坐人待确认"}</p>
        {fact.price && <p>记录价格：{display(fact.price.currency, "币种待确定")} {display(fact.price.amount, "金额待确定")} · {fact.price.unit === "total" ? "整笔总价" : fact.price.unit === "per_person" ? "每人" : "计价方式待确认"} · {fact.price.taxes === "included" ? "已含税费" : fact.price.taxes === "excluded" ? "未含税费" : "税费待确认"} · {fact.price.coverage === "segment" ? "仅这段交通" : "包含多段或范围待确认"}</p>}
        {canEdit && !editing && removing !== fact.transportId && <button type="button" disabled={pending} onClick={() => setRemoving(fact.transportId)}>移除记录</button>}
        {canEdit && removing === fact.transportId && <div class="traveler-confirm" role="group" aria-label="确认移除交通"><span>确定移除这条交通记录？</span><button type="button" disabled={pending} onClick={() => setRemoving(null)}>取消</button><button type="button" disabled={pending} onClick={async () => { if (await onRemove(fact.transportId)) setRemoving(null); }}>确认移除</button></div>}
      </div>;
    })}
    {canEdit && editing && <TransportForm key={editing.transportId || "new"} fact={editing} travelers={travelers} pending={pending} onSave={onSave} onCancel={() => setEditing(null)} />}
  </section>;
}

function DraftStop({ stop, draft, sources, conflicts, transportOverlaps, canEdit, pending, onSave, adoptedSourceRevision, onJournal }) {
  const [editing, setEditing] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [form, setForm] = useState({ startLocal: stop.startLocal || "", timeZone: stop.timeZone || "", utcOffset: "", durationMinutes: String(stop.durationMinutes ?? 0) });
  const entry = sources[stop.sourceResultId];
  const source = entry?.source;
  const expired = useSourceExpired(source);
  const candidate = source?.data?.candidates?.find(item => item.sourceId === stop.sourceId);
  const title = !entry || entry.loading ? "正在读取地点…" : entry.error ? "地点资料暂时无法读取"
    : expired ? "地点资料已过期" : source?.stale && source.tripRevision !== adoptedSourceRevision ? "地点资料需要重新查询" : display(candidate?.name, "地点资料不完整");
  const localTime = typeof stop.startLocal === "string" ? stop.startLocal.replace("T", " ") : "时间待确定";
  async function submit(event) {
    event.preventDefault();
    const changes = { startLocal: form.startLocal, timeZone: form.timeZone.trim(), durationMinutes: Number(form.durationMinutes), ...(form.utcOffset.trim() ? { utcOffset: form.utcOffset.trim() } : {}) };
    if (await onSave(draft.draftId, draft.draftRevision, stop.stopId, changes)) setEditing(false);
  }
  return <li><div class="draft-stop-main"><strong>{title}</strong><span>{roleLabels[stop.role] || "到访"}{typeof stop.durationMinutes === "number" ? ` · ${stop.durationMinutes} 分钟` : ""}</span></div>
    <div class="draft-stop-time">{localTime} · {display(stop.timeZone, "时区待确认")} {formatOffset(stop.utcOffset)}</div>
    {conflicts.has(stop.stopId) && <span class="draft-conflict">时间有重叠</span>}
    {transportOverlaps.has(stop.stopId) && <span class="draft-conflict">可能与已订交通重叠，需核对乘坐人和安排</span>}
    {canEdit && !editing && <button class="edit-visit" type="button" disabled={pending} onClick={() => { setForm({ startLocal: stop.startLocal || "", timeZone: stop.timeZone || "", utcOffset: "", durationMinutes: String(stop.durationMinutes ?? 0) }); setEditing(true); }}>修改时间</button>}
    {candidate && !expired && !source?.stale && <button class="place-journal" type="button" onClick={() => setExploring(true)}>探索地点</button>}
    {exploring && candidate && !expired && <DestinationExperience place={candidate} domain={source.data.domain} checkedAt={source.checkedAt} canEdit={Boolean(onJournal)} onJournal={() => { setExploring(false); onJournal({ stopId: stop.stopId, name: candidate.name, date: stop.startLocal?.slice(0, 10) || "" }); }} onClose={() => setExploring(false)} />}
    {onJournal && <button class="place-journal" type="button" disabled={pending} onClick={() => onJournal({ stopId: stop.stopId, name: candidate?.name || "", date: stop.startLocal?.slice(0, 10) || "" })}>写旅行记录</button>}
    {editing && <form class="visit-form" onSubmit={submit}><label>当地日期和时间<input type="datetime-local" required value={form.startLocal} onInput={event => setForm({ ...form, startLocal: event.currentTarget.value })} /></label>
      <label>时区<input required value={form.timeZone} onInput={event => setForm({ ...form, timeZone: event.currentTarget.value })} placeholder="Asia/Shanghai" /></label>
      <label>UTC 偏移（夏令时重复时填写）<input value={form.utcOffset} onInput={event => setForm({ ...form, utcOffset: event.currentTarget.value })} placeholder={stop.utcOffset === "Z" ? "+00:00" : stop.utcOffset} /></label>
      <label>停留分钟<input type="number" min="0" max="720" step="1" required value={form.durationMinutes} onInput={event => setForm({ ...form, durationMinutes: event.currentTarget.value })} /></label>
      <div class="pending-actions"><button type="submit" disabled={pending}>保存时间</button><button type="button" disabled={pending} onClick={() => setEditing(false)}>取消</button></div></form>}</li>;
}

function ItineraryDrafts({ drafts, requests, profile, hasPlan, canEdit, pending, onMore, onReject, onContinue, onSaveVisit, onVerify, onAdopt, onSaveReviewCondition, onJournal }) {
  const [checks, setChecks] = useState({});
  const [review, setReview] = useState(null);
  if (drafts.loading && !drafts.items.length) return <div class="area-empty"><p>正在读取行程草案…</p></div>;
  if (drafts.error && !drafts.items.length) return <div class="area-empty"><h3>行程草案暂时无法读取</h3><p>请刷新后重试，已保存的内容不会因此删除。</p></div>;
  if (!drafts.items.length) return hasPlan ? null : <div class="area-empty"><h3>行程还未安排</h3><p>继续与助手讨论地点和时间，安排形成后会显示在这里。</p></div>;
  return <div class="draft-list">{drafts.items.map((item, index) => {
    const stops = Array.isArray(item.draft?.stops) ? item.draft.stops : [];
    const conflicts = new Set((item.draft?.timeConflicts || []).flatMap(issue => Array.isArray(issue.stopIds) ? issue.stopIds : []));
    const transportOverlaps = new Set(!item.stale && Array.isArray(item.draft?.transportOverlaps) ? item.draft.transportOverlaps.map(issue => issue.stopId) : []);
    const days = draftDays(stops);
    const hasRequest = requests.items.some(request => request.draftId === item.draftId && request.draftRevision === item.draftRevision && request.workStatus !== "superseded" && request.requestedBy === profile?.id);
    return <article class="draft" key={item.draftId}><div class="facts-heading"><div><h3>待核验草案 {drafts.items.length > 1 ? index + 1 : ""}</h3><span class="draft-created">{formatCheckedAt(item.createdAt)}</span></div>
      <div class="component-actions"><button type="button" disabled={pending} onClick={async () => { const result = await onVerify(item); if (result) { setChecks(previous => ({ ...previous, [item.draftId]: result })); if (review?.draftId === item.draftId) setReview({ draftId: item.draftId, report: result }); } }}>重新核验</button>{canEdit && <Fragment>{!hasPlan && <button type="button" disabled={pending || item.stale} onClick={async () => { const result = await onVerify(item); if (result) { setChecks(previous => ({ ...previous, [item.draftId]: result })); setReview({ draftId: item.draftId, report: result }); } }}>核验并采用</button>}<button type="button" disabled={pending || hasRequest} onClick={() => onContinue(item)}>{hasRequest ? "已请求核验" : "请助手继续核验"}</button>
        <button type="button" disabled={pending} onClick={() => onReject(item.draftId)}>忽略草案</button></Fragment>}</div></div>
      {review?.draftId !== item.draftId && !item.stale && checks[item.draftId]?.draftRevision === item.draftRevision && <div class="draft-checks" aria-label="行程核验结果"><p>核验于 {formatCheckedAt(checks[item.draftId].checkedAt)}</p><ul>{checks[item.draftId].checks.map(check => <li key={check.id}><strong>{{ passed: "已检查", blocked: "需调整", unverified: "未核实", needs_review: "需核对" }[check.status] || "未核实"}</strong> · {check.message}</li>)}</ul></div>}
      {review?.draftId !== item.draftId && <p class="draft-warning">{item.stale ? "旅行要求已有变化，这份草案需要重新核验。" : conflicts.size ? "草案中有时间重叠，需要调整。" : transportOverlaps.size ? "部分到访可能与已订交通重叠，需要核对。" : "到访时间未发现重叠。"} 时区、交通、营业、预算和同行人条件仍需核验。了解并逐项确认未知条件后，可采用暂定行程。</p>}
      {review?.draftId === item.draftId && !item.stale && !hasPlan && review.report.draftRevision === item.draftRevision && <TentativeAdoptionReview key={`${item.draftId}:${item.draftRevision}`} report={review.report} pending={pending} onCancel={() => setReview(null)} onSaveCondition={async (check, acknowledged) => {
        const result = await onSaveReviewCondition(item, review.report, check, acknowledged);
        if (result) { setChecks(previous => ({ ...previous, [item.draftId]: result })); setReview(current => current?.draftId === item.draftId ? { draftId: item.draftId, report: result } : current); }
      }} onAdopt={async acknowledgments => { if (await onAdopt(item, review.report, acknowledgments)) setReview(null); }} />}
      {stops.length ? days.map(({ date, stops: dayStops }, dayIndex) => <section class="draft-day" key={`${date}-${dayIndex}`}><div class="day-heading"><h4>{date}</h4>{onJournal && canEdit && <button class="ui-text" type="button" onClick={() => onJournal({ date })}><Icon name="Notebook" />记录这一天</button>}</div><ol>{dayStops.map((stop, stopIndex) => <DraftStop key={`${stop.stopId}-${stopIndex}`} stop={stop} draft={item} sources={drafts.sources} conflicts={conflicts} transportOverlaps={transportOverlaps} canEdit={canEdit} pending={pending} onSave={onSaveVisit} onJournal={canEdit ? onJournal : undefined} />)}</ol></section>)
        : <p class="place-status">草案内容不完整，请在对话中让助手重新检查。</p>}
    </article>;
  })}{drafts.error && <p class="place-status">更多草案暂时无法读取，请重试。</p>}
    {drafts.cursor && <button class="more-button" type="button" disabled={pending || drafts.loading} onClick={onMore}>{drafts.loading ? "正在读取…" : "查看更多草案"}</button>}</div>;
}

function requestMessage(item) { return `请读取旅行工作台请求 ${item.handoffId}，并继续核验对应的行程草案。`; }
function RequestProgress({ requests, profile, canEdit, canMessage, pending, onSend, onMore }) {
  if (requests.loading && !requests.items.length) return <p class="place-status">正在读取助手请求…</p>;
  if (!requests.items.length && !requests.error) return null;
  return <section class="request-progress" aria-labelledby="requests-title"><h2 id="requests-title">与助手的请求</h2>
    {requests.error && <p class="place-status">请求进度暂时无法读取，请刷新后重试。</p>}
    {requests.items.map(item => {
      const status = item.workStatus === "superseded" ? "草案已变更或忽略，这条请求不再有效。" : item.workStatus === "accepted" ? "助手已接收，尚未标记完成。" : item.notification === "sent" ? "已发送到对话，等待助手读取。"
        : item.notification === "saved" ? "请求已保存，尚未发送。" : item.notification === "failed" ? "宿主未接受发送，可在对话中手动继续。"
          : "发送状态未知，请先确认对话是否收到，避免重复发送。";
      const recovery = !["accepted", "superseded"].includes(item.workStatus) && item.notification !== "sent";
      return <div class="request-item" key={item.handoffId}><p>{status}</p>{item.stale && <p>旅行要求已变化，助手需要重新读取。</p>}
        {recovery && <><label>可复制到对话的请求<textarea readOnly rows="3" value={requestMessage(item)} /></label>
          {canEdit && canMessage && item.notification === "saved" && item.requestedBy === profile?.id && <button type="button" disabled={pending} onClick={() => onSend(item)}>发送到对话</button>}</>}
      </div>;
    })}
    {requests.cursor && <button class="more-button" type="button" disabled={pending || requests.loading} onClick={onMore}>{requests.loading ? "正在读取…" : "查看更多请求"}</button>}
  </section>;
}

const taskLabels = { queued: "排队中", running: "正在研究", recovering: "正在恢复", paused: "已暂停", completed: "研究完成，建议尚未采用",
  needs_context: "需要补充信息", cancelled: "已取消", superseded: "已被新要求替代", failed: "未完成" };
function PlanningTasks({ tasks, canEdit, pending, onCancel, onMore }) {
  if (tasks.loading && !tasks.items.length) return <p class="place-status">正在读取研究进度…</p>;
  if (!tasks.items.length && !tasks.error) return null;
  return <section class="request-progress" aria-labelledby="tasks-title"><h2 id="tasks-title">后台研究</h2>
    {tasks.error && <p class="place-status">研究进度暂时无法读取，请刷新后重试。</p>}
    {tasks.items.map(item => <div class="task-item" key={item.taskId}><div class="facts-heading"><strong>{display(item.objective, "旅行研究")}</strong><span>{taskLabels[item.status] || "状态暂不可用"}</span></div>
      {item.stale && <p>旅行要求已变化，这次研究基于旧要求，需要重新检查。</p>}
      {item.suggestion?.summary && <p>{item.suggestion.summary}</p>}
      {Array.isArray(item.suggestion?.unknowns) && item.suggestion.unknowns.length > 0 && <ul>{item.suggestion.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      {item.status === "failed" && <p>这次研究未完成，可以在对话中重新提出。</p>}
      {canEdit && ["queued", "running", "recovering", "paused", "needs_context"].includes(item.status) && <button type="button" disabled={pending} onClick={() => onCancel(item.taskId)}>取消任务</button>}
    </div>)}
    {tasks.cursor && <button class="more-button" type="button" disabled={pending || tasks.loading} onClick={onMore}>{tasks.loading ? "正在读取…" : "查看更多任务"}</button>}
  </section>;
}

function TripDetails({ trip, layout, layoutLoading, places, drafts, requests, tasks, profile, host, canMessage, pending, onBack, onRefresh, onEditLayout, onDecidePlaces, onMoreDrafts, onRejectDraft, onSaveVisit, onContinueDraft, onVerifyDraft, onAdoptDraft, onSaveReviewCondition, onSendRequest, onMoreRequests, onCancelTask, onMoreTasks, onRemoveTravelerRequirement, onRemoveJourney, onSaveBudget, onSaveTransport, onRemoveTransport }) {
  const [editingBudget, setEditingBudget] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journalPlace, setJournalPlace] = useState(null);
  const [journalStatus, setJournalStatus] = useState({ dirty: false, busy: false, uncertain: false });
  const [moreOpen, setMoreOpen] = useState(false);
  const [exploringPlace, setExploringPlace] = useState(null);
  const journalTrigger = useRef(null);
  const [confirmBack, setConfirmBack] = useState(false);
  const [journalMessage, setJournalMessage] = useState(null);
  const state = trip.state || {};
  const brief = state.brief || {};
  const budget = state.budgetLedger || {};
  const adopted = Array.isArray(state.planning?.adopted?.stops) ? state.planning.adopted : null;
  const hasPlan = Boolean(state.planning?.adopted || state.planning?.draft || state.pendingProposals?.length || state.nodes?.length);
  const amount = typeof budget.totalBudget === "number" ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 12 }).format(budget.totalBudget) : null;
  const budgetCurrency = budget.currency === "XXX" ? "币种待确定" : display(budget.currency, "币种待确定");
  const budgetLabel = amount !== null ? `${budgetCurrency} ${amount}` : Object.prototype.hasOwnProperty.call(brief, "totalBudget") && brief.totalBudget === null ? "不设上限" : "待确定";
  const requirements = layout?.document?.components?.find(component => component.type === "requirements");
  const placeComponent = layout?.document?.components?.find(component => component.type === "places");
  const placesHidden = layout?.document?.userRemoved?.includes("places");
  const canEdit = trip.role === "owner" || trip.role === "editor";
  const hasRecordedTransport = Array.isArray(state.confirmedTransport) && state.confirmedTransport.length > 0;
  const canChangeRequirements = canEdit && !hasPlan && (state.confirmedTransport == null || Array.isArray(state.confirmedTransport));
  const experienceExpired = useSourceExpired(exploringPlace?.source);
  const journalDirty = journalStatus.dirty || journalStatus.busy || journalStatus.uncertain;
  const visits = [...new Map([...(adopted?.stops || []), ...drafts.items.flatMap(item => item.draft?.stops || [])].map(stop => {
    const source = drafts.sources[stop.sourceResultId]?.source;
    return [stop.stopId, { stopId: stop.stopId, name: source?.data?.candidates?.find(item => item.sourceId === stop.sourceId)?.name || "行程中的到访", date: stop.startLocal?.slice(0, 10) || "" }];
  })).values()];
  function openJournal(place = null) {
    if (journalOpen) return;
    journalTrigger.current = document.activeElement;
    setJournalMessage(null); setJournalPlace(place); setJournalOpen(true); setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function closeJournal() {
    setJournalOpen(false); setJournalMessage(null);
    requestAnimationFrame(() => journalTrigger.current?.isConnected && journalTrigger.current.focus());
  }
  const renderRequirements = () => <Fragment>{requirements ? <div class="trip-facts"><div class="facts-heading"><h2>旅行要求</h2>{canEdit && <div class="component-actions"><button type="button" disabled={pending} onClick={() => onEditLayout(requirements.pinned ? "unpin" : "pin")}>{requirements.pinned ? "取消固定" : "固定"}</button><button type="button" disabled={pending} onClick={() => onEditLayout("hide")}>隐藏</button></div>}</div><dl><div><dt>出发地</dt><dd>{display(brief.origin)}</dd></div><div><dt>同行人</dt><dd>{display(brief.partyProfile, Array.isArray(state.travelers) && state.travelers.length ? `${state.travelers.length} 人已记录` : "待确定")}</dd></div><div><dt>预算</dt><dd>{budgetLabel}{canChangeRequirements && !editingBudget && <button class="budget-edit" type="button" disabled={pending} onClick={() => setEditingBudget(true)}>编辑</button>}</dd></div></dl>
          {editingBudget && canChangeRequirements && <BudgetForm budget={budget} pending={pending} onSave={onSaveBudget} onCancel={() => setEditingBudget(false)} />}
          <RecordedTransportCosts summary={budget.recordedTransport} facts={state.confirmedTransport} />
          {hasRecordedTransport && canEdit && <p class="layout-status">已订交通已保留；后续安排仍需核验预算和同行人条件。</p>}
          <TravelerRequirements travelers={state.travelers} canEdit={canChangeRequirements} pending={pending} onRemove={onRemoveTravelerRequirement} /></div>
          : !layout ? <div class="trip-facts"><p class="layout-status">{layoutLoading ? "正在读取工作台布局…" : "工作台布局暂时无法读取，请刷新重试。"}</p></div>
          : canEdit && <div class="trip-facts"><button class="restore-component" type="button" disabled={pending} onClick={() => onEditLayout("show")}>显示旅行要求</button></div>}</Fragment>;
  const renderPlaces = () => <Fragment>{placeComponent ? <PlaceResults component={placeComponent} places={places} canEdit={canEdit} pending={pending} onEditLayout={onEditLayout} onJournal={openJournal} />
          : placesHidden && canEdit && <div class="trip-facts"><button class="restore-component" type="button" disabled={pending} onClick={() => onEditLayout("show", "places")}>显示候选地点</button></div>}</Fragment>;
  return <main class="main-shell trip-detail">
    <div class="detail-toolbar"><button class="back-button" type="button" onClick={() => journalDirty ? setConfirmBack(true) : onBack()}><Arrow back />我的旅行</button>
      <button class="text-button" type="button" onClick={onRefresh} disabled={pending}>{pending ? "正在同步…" : "刷新"}</button></div>
    {confirmBack && <div class="traveler-confirm" role="group" aria-label="确认离开手账"><span>未保存的内容会丢失；若保存正在进行，请重新打开手账确认结果。</span><button type="button" onClick={() => setConfirmBack(false)}>继续编辑</button><button type="button" onClick={onBack}>离开</button></div>}
    <header class="trip-heading"><div><h1>{display(brief.destination, "未命名旅行")}</h1><p>{display(brief.dates, "日期待确定")}</p></div><div class="trip-heading-actions"><span class="role-label">{trip.role === "owner" ? "我的旅行" : trip.role === "editor" ? "可编辑" : "仅查看"}</span>{trip.role === "owner" && <button type="button" disabled={pending} onClick={() => setSharingOpen(!sharingOpen)}><Icon name="Users" />共享</button>}</div></header>
    {sharingOpen && trip.role === "owner" && <SharingPanel tripId={trip.tripId} host={host} tripTitle={`${display(brief.destination, "未命名旅行")} · ${display(brief.dates, "日期待确定")}`} onClose={() => setSharingOpen(false)} />}
    {journalMessage && <p class="journal-error" role="alert">{journalMessage}</p>}
    <nav class="workbench-navigation" aria-label="旅行内容"><button type="button" aria-current={!journalOpen ? "page" : undefined} onClick={() => { if (journalDirty) setJournalMessage("请使用手账中的返回行程，选择保存或放弃当前编辑。"); else closeJournal(); }}><Icon name="CalendarBlank" />行程</button><button type="button" aria-current={journalOpen ? "page" : undefined} onClick={() => openJournal()}><Icon name="Notebook" />照片手账</button><button type="button" onClick={() => setMoreOpen(true)}><Icon name="CaretDown" />更多</button></nav>
    {journalOpen && <JournalPanel tripId={trip.tripId} revision={trip.revision} host={host} canEdit={canEdit} place={journalPlace} tripTitle={`${display(brief.destination, "未命名旅行")} · ${display(brief.dates, "日期待确定")}`} selectedDate={journalPlace?.date || ""} visits={visits}
      onClose={closeJournal} onStatusChange={setJournalStatus} />}
    {moreOpen && <Sheet title="更多旅行体验" onClose={() => setMoreOpen(false)}><div class="workbench-more"><h3>目的地沉浸</h3><p>选择地点，打开风格化三维场景。查看场景不会修改行程。</p>{places.entries.some(entry => entry.source?.data?.candidates?.length && !entry.source.stale && !sourceIsExpired(entry.source)) ? <ul class="experience-place-list">{places.entries.filter(entry => entry.source?.data?.candidates?.length && !entry.source.stale && !sourceIsExpired(entry.source)).flatMap(entry => entry.source.data.candidates.map(place => <li key={`${entry.id}:${place.sourceId}`}><button type="button" onClick={() => { setMoreOpen(false); setExploringPlace({ place, domain: entry.source.data.domain, checkedAt: entry.source.checkedAt, source: entry.source }); }}><Icon name="MapPin" /><span>{place.name}</span><Icon name="CaretRight" /></button></li>))}</ul> : <p>目前没有可用的地点资料。请在对话中让助手查询想去的地点，再回来探索。</p>}</div></Sheet>}
    {exploringPlace && experienceExpired && <Sheet title="地点资料已过期" onClose={() => setExploringPlace(null)}><p>请在对话中重新查询，再打开目的地沉浸。行程和记录仍然保留。</p></Sheet>}
    {exploringPlace && !experienceExpired && <DestinationExperience {...exploringPlace} canEdit={canEdit} onJournal={place => { setExploringPlace(null); openJournal({ name: place.name, domain: exploringPlace.domain }); }} onClose={() => setExploringPlace(null)} />}
    <div class="trip-layout" hidden={journalOpen}>
      <section class="itinerary" aria-labelledby="itinerary-title"><header class="area-heading"><h2 id="itinerary-title">每日行程</h2></header>
        {adopted && <AdoptedItinerary adoption={adopted} host={host} trip={trip} canEdit={canEdit} renderStop={(stop, sources, sourceRevision) => <DraftStop key={stop.stopId} stop={stop} sources={sources} conflicts={new Set()} transportOverlaps={new Set()} canEdit={false} adoptedSourceRevision={sourceRevision} onJournal={canEdit ? openJournal : undefined} />} />}
        {hasPlan && !adopted && <div class="area-empty"><h3>现有安排暂时无法在这里显示</h3><p>已保存的旅行内容仍然保留，可以返回对话查看。</p></div>}
        <ItineraryDrafts drafts={drafts} requests={requests} profile={profile} hasPlan={hasPlan} canEdit={canEdit} pending={pending} onMore={onMoreDrafts} onReject={onRejectDraft} onContinue={onContinueDraft} onSaveVisit={onSaveVisit} onVerify={onVerifyDraft} onAdopt={onAdoptDraft} onSaveReviewCondition={onSaveReviewCondition} onJournal={openJournal} />
        <JourneyRequests journeys={brief.journeys} canEdit={canChangeRequirements && !hasRecordedTransport} pending={pending} onRemove={onRemoveJourney} />
        <TransportFacts facts={state.confirmedTransport} overlaps={state.transportOverlaps} travelers={state.travelers} canEdit={canEdit && !hasPlan} pending={pending} onSave={onSaveTransport} onRemove={onRemoveTransport} />
        <RequestProgress requests={requests} profile={profile} canEdit={canEdit} canMessage={canMessage} pending={pending} onSend={onSendRequest} onMore={onMoreRequests} />
        <PlanningTasks tasks={tasks} canEdit={canEdit} pending={pending} onCancel={onCancelTask} onMore={onMoreTasks} />
        {(layout?.document?.components || []).filter(component => !["itinerary", "map"].includes(component.type)).map(component =>
          <Fragment key={component.id || component.type}>{component.version != null && component.version !== 1
            ? <p role="alert">这项内容需要更新的工作台才能显示，已保存的资料仍然保留。</p>
            : component.type === "requirements" ? renderRequirements() : component.type === "places" ? renderPlaces()
            : <p role="alert">暂时无法显示这项内容，已保存的布局和资料仍然保留。</p>}</Fragment>)}
        {!requirements && renderRequirements()}
        {!placeComponent && renderPlaces()}
        <PendingPlaceResults entries={places.pendingEntries} hidden={placesHidden} canEdit={canEdit} pending={pending} onDecide={onDecidePlaces} onJournal={openJournal} />
      </section>
      <section class="map-area" aria-labelledby="map-title"><header class="area-heading"><h2 id="map-title">地图</h2></header>
        <div class="map-empty"><div><h3>地图暂未准备好</h3><p>{hasPlan ? "现有地点仍然保留，地图连接完成后可在这里查看。" : "确认地点并接通地图来源后，将在这里显示位置与路线。"}</p></div></div>
      </section>
    </div>
  </main>;
}

function Workbench({ hostFactory }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [trip, setTrip] = useState(null);
  const [layout, setLayout] = useState(null);
  const [layoutLoading, setLayoutLoading] = useState(false);
  const [places, setPlaces] = useState({ entries: [], pendingEntries: [] });
  const [drafts, setDrafts] = useState({ items: [], sources: {}, loading: false, error: false, cursor: null });
  const [requests, setRequests] = useState({ items: [], loading: false, error: false, cursor: null });
  const [tasks, setTasks] = useState({ items: [], loading: false, error: false, cursor: null });
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hostContext, setHostContext] = useState({});
  const host = useRef(null);
  const operationGeneration = useRef(0);
  const layoutRequest = useRef(0);
  const placeRequest = useRef(0);
  const draftRequest = useRef(0);
  const requestList = useRef(0);
  const taskList = useRef(0);
  const pendingLayout = useRef(null);
  const pendingHandoff = useRef(null);
  const pendingVisit = useRef(null);
  const pendingTask = useRef(null);
  const pendingTraveler = useRef(null);
  const pendingJourney = useRef(null);
  const pendingBudget = useRef(null);
  const pendingTransport = useRef(null);
  const pendingAdoption = useRef(null), pendingReviewCondition = useRef(null);

  function clearPrivateView(clearList = true) {
    operationGeneration.current++;
    layoutRequest.current++; placeRequest.current++; draftRequest.current++; requestList.current++; taskList.current++;
    setTrip(null); setLayout(null); setLayoutLoading(false); setProfile(null); setPending(false);
    setPlaces({ entries: [], pendingEntries: [] });
    setDrafts({ items: [], sources: {}, loading: false, error: false, cursor: null });
    setRequests({ items: [], loading: false, error: false, cursor: null });
    setTasks({ items: [], loading: false, error: false, cursor: null });
    for (const ref of [pendingLayout, pendingHandoff, pendingVisit, pendingTask, pendingTraveler, pendingJourney, pendingBudget, pendingTransport, pendingAdoption, pendingReviewCondition]) ref.current = null;
    if (clearList) { setItems([]); setCursor(null); }
  }

  async function loadPlaces(document, request) {
    const component = document?.document?.components?.find(item => item.type === "places");
    const ids = component?.resultIds ?? (component?.resultId ? [component.resultId] : []);
    const pendingIds = document?.document?.pendingPlaceResults ?? [];
    const active = ++placeRequest.current;
    const current = () => layoutRequest.current === request && placeRequest.current === active;
    const validIds = !component || (Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string"));
    const validPending = Array.isArray(pendingIds) && pendingIds.every(id => typeof id === "string");
    const entries = !component ? [] : validIds ? ids.map(id => ({ id, loading: true })) : [{ error: true }];
    const pendingEntries = validPending ? pendingIds.map(id => ({ id, loading: true })) : [{ error: true }];
    if (current()) setPlaces({ entries, pendingEntries });
    const work = [...(validIds && component ? ids.map((id, index) => ({ id, index, group: "entries" })) : []),
      ...(validPending ? pendingIds.map((id, index) => ({ id, index, group: "pendingEntries" })) : [])];
    let next = 0;
    async function readPage() {
      while (current()) {
        const item = work[next++];
        if (!item) return;
        let entry;
        try { entry = { id: item.id, source: await host.current.call("get_trip_result_reference", { resultId: item.id }) }; }
        catch { entry = { id: item.id, error: true }; }
        if (current()) setPlaces(previous => {
          if (!current()) return previous;
          const updated = previous[item.group].slice(); updated[item.index] = entry;
          return { ...previous, [item.group]: updated };
        });
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, work.length) }, readPage));
  }

  async function selectTrip(value) {
    const request = ++layoutRequest.current;
    placeRequest.current++; draftRequest.current++; requestList.current++; taskList.current++; setTrip(value); setLayout(null); setLayoutLoading(true);
    setPlaces({ entries: [], pendingEntries: [] }); setDrafts({ items: [], sources: {}, loading: true, error: false, cursor: null });
    setRequests({ items: [], loading: true, error: false, cursor: null });
    setTasks({ items: [], loading: true, error: false, cursor: null });
    const draftLoad = loadDrafts(value.tripId, request);
    const requestLoad = loadRequests(value.tripId, request);
    const taskLoad = loadTasks(value.tripId, request);
    try {
      const result = await host.current.call("get_workbench_document", { tripId: value.tripId });
      if (layoutRequest.current === request) { setLayout(result); await loadPlaces(result, request); }
    } catch (failure) { if (layoutRequest.current === request) setError(failure.message || "工作台布局暂时无法读取。"); }
    finally { if (layoutRequest.current === request) setLayoutLoading(false); }
    await Promise.all([draftLoad, requestLoad, taskLoad]);
  }

  async function loadTasks(tripId, request, cursor = null) {
    const active = ++taskList.current;
    const current = () => layoutRequest.current === request && taskList.current === active;
    if (current()) setTasks(previous => ({ ...(cursor ? previous : { items: [], cursor: null }), loading: true, error: false }));
    try {
      const result = await host.current.call("list_trip_tasks", { tripId, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.items)) throw new Error("invalid_task_list");
      if (current()) setTasks(previous => current() ? { items: cursor ? [...previous.items, ...result.items] : result.items,
        cursor: result.nextCursor || null, loading: false, error: false } : previous);
    } catch { if (current()) setTasks(previous => ({ ...previous, loading: false, error: true })); }
  }

  async function loadRequests(tripId, request, cursor = null) {
    const active = ++requestList.current;
    const current = () => layoutRequest.current === request && requestList.current === active;
    if (current()) setRequests(previous => ({ ...(cursor ? previous : { items: [], cursor: null }), loading: true, error: false }));
    try {
      const result = await host.current.call("list_workbench_requests", { tripId, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.items)) throw new Error("invalid_request_list");
      if (current()) setRequests(previous => current() ? { items: cursor ? [...previous.items, ...result.items] : result.items,
        cursor: result.nextCursor || null, loading: false, error: false } : previous);
    } catch { if (current()) setRequests(previous => ({ ...previous, loading: false, error: true })); }
  }

  async function loadDrafts(tripId, request, cursor = null) {
    const active = ++draftRequest.current;
    const current = () => layoutRequest.current === request && draftRequest.current === active;
    if (current()) setDrafts(previous => ({ ...(cursor ? previous : { items: [], sources: {}, cursor: null }), loading: true, error: false }));
    try {
      const result = await host.current.call("list_trip_itinerary_drafts", { tripId, ...(cursor ? { cursor } : {}) });
      if (!current()) return;
      if (!Array.isArray(result.items)) throw new Error("invalid_draft_list");
      const items = result.items;
      const ids = [...new Set(items.flatMap(item => Array.isArray(item.draft?.stops) ? item.draft.stops.map(stop => stop.sourceResultId).filter(id => typeof id === "string") : []))];
      setDrafts(previous => {
        if (!current()) return previous;
        const sources = cursor ? { ...previous.sources } : {};
        for (const id of ids) if (!sources[id]) sources[id] = { loading: true };
        return { items: cursor ? [...previous.items, ...items] : items, sources, cursor: result.nextCursor || null, loading: false, error: false };
      });
      let next = 0;
      async function readSource() {
        while (current()) {
          const id = ids[next++]; if (!id) return;
          let entry;
          try { entry = { source: await host.current.call("get_trip_result_reference", { resultId: id }) }; }
          catch { entry = { error: true }; }
          if (current()) setDrafts(previous => current() ? { ...previous, sources: { ...previous.sources, [id]: entry } } : previous);
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, readSource));
    } catch { if (current()) setDrafts(previous => ({ ...previous, loading: false, error: true })); }
  }

  useEffect(() => {
    const currentHost = hostFactory({
      onInitial(value) {
        if (value.trip) selectTrip(value.trip); else clearPrivateView(false);
        setItems(value.workspaces?.items || []); setCursor(value.workspaces?.nextCursor || null); setProfile(value.profile || null); setReady(true);
      },
      onOpenTrip(value) { setError(null); setReady(true); selectTrip(value); },
      onError(message) { setError(message); setReady(true); },
      onIdentityChanged(profile) { clearPrivateView(); setProfile(profile); setReady(true); setError("账号已切换，请刷新列表后选择旅行。"); },
      onAccessLost() { clearPrivateView(); setReady(true); setError("连接或旅行访问权限已变化，请刷新列表或重新连接。"); },
      onContextChanged(value) { setHostContext(previous => ({ ...previous, ...value })); },
    });
    host.current = currentHost;
    currentHost.connect();
    const focus = () => { if (!document.hidden) currentHost.checkIdentity(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); currentHost.close(); };
  }, []);

  async function execute(operation) {
    const active = ++operationGeneration.current;
    setPending(true); setError(null);
    try { await operation(); return active === operationGeneration.current; }
    catch (failure) { if (active === operationGeneration.current) setError(failure.message || "操作未完成，请重试。"); return false; }
    finally { if (active === operationGeneration.current) setPending(false); }
  }
  function loadList(append = false) { return execute(async () => {
    const result = await host.current.call("list_travel_workspaces", append && cursor ? { cursor } : {});
    setItems(previous => append ? [...previous, ...result.items] : result.items); setCursor(result.nextCursor || null);
  }); }
  function openTrip(tripId) { return execute(async () => selectTrip(await host.current.call("get_travel_workspace", { tripId }))); }
  function goBack() { layoutRequest.current++; placeRequest.current++; draftRequest.current++; requestList.current++; taskList.current++; setLayout(null); setTrip(null); }
  function editLayout(action, componentType = "requirements") { return execute(async () => {
    if (!trip || !layout) throw new Error("请先刷新工作台布局。");
    const key = `${trip.tripId}:${trip.revision}:${layout.layoutRevision}:${componentType}:${action}`;
    const activeRequest = layoutRequest.current;
    if (pendingLayout.current?.key !== key) pendingLayout.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("edit_workbench_component", { tripId: trip.tripId, expectedTripRevision: trip.revision,
      expectedLayoutRevision: layout.layoutRevision, requestId: pendingLayout.current.requestId, action, componentType });
    pendingLayout.current = null;
    if (layoutRequest.current === activeRequest) { setLayout(result); await loadPlaces(result, activeRequest); }
  }); }
  function decidePlaces(decision, resultId) { return execute(async () => {
    if (!trip || !layout) throw new Error("请先刷新工作台布局。");
    const key = `${trip.tripId}:${trip.revision}:${layout.layoutRevision}:decision:${decision}:${resultId}`;
    const activeRequest = layoutRequest.current;
    if (pendingLayout.current?.key !== key) pendingLayout.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("decide_trip_place_result", { tripId: trip.tripId, expectedTripRevision: trip.revision,
      expectedLayoutRevision: layout.layoutRevision, requestId: pendingLayout.current.requestId, resultId, decision });
    pendingLayout.current = null;
    if (layoutRequest.current === activeRequest) { setLayout(result); await loadPlaces(result, activeRequest); }
  }); }
  function rejectDraft(draftId) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const key = `${trip.tripId}:${trip.revision}:reject:${draftId}`;
    const activeRequest = layoutRequest.current;
    if (pendingLayout.current?.key !== key) pendingLayout.current = { key, requestId: crypto.randomUUID() };
    await host.current.call("reject_trip_itinerary_draft", { tripId: trip.tripId, draftId, expectedRevision: trip.revision, requestId: pendingLayout.current.requestId });
    pendingLayout.current = null;
    if (layoutRequest.current === activeRequest) await loadDrafts(trip.tripId, activeRequest);
  }); }
  async function notifySaved(item, currentTrip) {
    if (!host.current.canMessage(currentTrip.tripId)) return;
    const common = { tripId: currentTrip.tripId, handoffId: item.handoffId, expectedRevision: currentTrip.revision };
    const started = await host.current.call("begin_workbench_notification", { ...common, requestId: crypto.randomUUID() });
    if (!started.maySend) return;
    let outcome = "unknown";
    try { outcome = await host.current.sendMessage(requestMessage(item), currentTrip.tripId); } catch { /* Delivery may already have happened. */ }
    try { await host.current.call("record_workbench_notification", { ...common, requestId: crypto.randomUUID(), outcome }); }
    catch { throw new Error("请求已保存，但发送回执无法确认。请先检查对话。"); }
  }
  function saveVisit(draftId, draftRevision, stopId, changes) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${draftId}:${draftRevision}:${stopId}:${JSON.stringify(changes)}`;
    if (pendingVisit.current?.key !== key) pendingVisit.current = { key, requestId: crypto.randomUUID() };
    await host.current.call("edit_trip_itinerary_visit", { tripId: currentTrip.tripId, draftId, expectedRevision: currentTrip.revision,
      expectedDraftRevision: draftRevision, stopId, changes, requestId: pendingVisit.current.requestId });
    pendingVisit.current = null;
    if (layoutRequest.current === activeRequest) await Promise.all([loadDrafts(currentTrip.tripId, activeRequest), loadRequests(currentTrip.tripId, activeRequest)]);
  }); }
  async function verifyDraft(draft) {
    let result;
    const succeeded = await execute(async () => {
      const tripId = trip.tripId, active = layoutRequest.current;
      const value = await host.current.call("get_trip_itinerary_review", { tripId, draftId: draft.draftId,
        expectedRevision: trip.revision, expectedDraftRevision: draft.draftRevision });
      if (active === layoutRequest.current) result = value;
    });
    return succeeded ? result : null;
  }
  async function saveReviewCondition(draft, report, check, acknowledged) {
    let result = null;
    const succeeded = await execute(async () => {
      if (!trip) throw new Error("请先重新打开旅行。");
      const active = layoutRequest.current;
      const args = { tripId: trip.tripId, draftId: draft.draftId, expectedRevision: trip.revision, expectedDraftRevision: draft.draftRevision,
        expectedReviewRevision: report.reviewState.revision, checkId: check.id, basisDigest: check.basisDigest, acknowledged };
      const key = JSON.stringify(args);
      if (pendingReviewCondition.current?.key !== key) pendingReviewCondition.current = { key, requestId: crypto.randomUUID() };
      const command = pendingReviewCondition.current;
      const value = await host.current.call("save_trip_itinerary_review_condition", { ...args, requestId: command.requestId });
      if (pendingReviewCondition.current === command) pendingReviewCondition.current = null;
      if (active === layoutRequest.current) result = value;
    });
    return succeeded ? result : null;
  }
  function adoptDraft(draft, report, acknowledgments) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const active = layoutRequest.current;
    const args = { tripId: trip.tripId, draftId: draft.draftId, expectedRevision: trip.revision, expectedDraftRevision: draft.draftRevision,
      reviewDigest: report.reviewDigest, acknowledgments, riskFollowUpConsent: true };
    const key = JSON.stringify(args);
    if (pendingAdoption.current?.key !== key) pendingAdoption.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("adopt_tentative_trip_itinerary", { ...args, requestId: pendingAdoption.current.requestId });
    pendingAdoption.current = null;
    if (active === layoutRequest.current) await selectTrip(result);
  }); }
  function continueDraft(draft) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${draft.draftId}:${draft.draftRevision}`;
    if (pendingHandoff.current?.key !== key) pendingHandoff.current = { key, requestId: crypto.randomUUID() };
    try {
      const saved = await host.current.call("save_workbench_request", { tripId: currentTrip.tripId, draftId: draft.draftId, expectedRevision: currentTrip.revision,
        expectedDraftRevision: draft.draftRevision, requestId: pendingHandoff.current.requestId });
      pendingHandoff.current = null;
      await notifySaved(saved, currentTrip);
    } finally { if (layoutRequest.current === activeRequest) await loadRequests(currentTrip.tripId, activeRequest); }
  }); }
  function sendSaved(item) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    try { await notifySaved(item, currentTrip); }
    finally { if (layoutRequest.current === activeRequest) await loadRequests(currentTrip.tripId, activeRequest); }
  }); }
  function cancelTask(taskId) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${taskId}`;
    if (pendingTask.current?.key !== key) pendingTask.current = { key, requestId: crypto.randomUUID() };
    await host.current.call("cancel_trip_task", { taskId, expectedRevision: currentTrip.revision, requestId: pendingTask.current.requestId });
    pendingTask.current = null;
    if (layoutRequest.current === activeRequest) await loadTasks(currentTrip.tripId, activeRequest);
  }); }
  function removeTravelerRequirement(travelerId, target) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${travelerId}:${JSON.stringify(target)}`;
    if (pendingTraveler.current?.key !== key) pendingTraveler.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("remove_trip_traveler_requirement", { tripId: currentTrip.tripId, expectedRevision: currentTrip.revision,
      requestId: pendingTraveler.current.requestId, travelerId, target });
    pendingTraveler.current = null;
    if (layoutRequest.current === activeRequest) await selectTrip(result);
  }); }
  function saveBudget(changes) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${JSON.stringify(changes)}`;
    if (pendingBudget.current?.key !== key) pendingBudget.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("update_trip_scope", { tripId: currentTrip.tripId, expectedRevision: currentTrip.revision,
      requestId: pendingBudget.current.requestId, changes });
    pendingBudget.current = null;
    if (layoutRequest.current === activeRequest) await selectTrip(result);
  }); }
  function removeJourney(journeyId) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:${journeyId}`;
    if (pendingJourney.current?.key !== key) pendingJourney.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("remove_trip_journey", { tripId: currentTrip.tripId, expectedRevision: currentTrip.revision,
      requestId: pendingJourney.current.requestId, journeyId });
    pendingJourney.current = null;
    if (layoutRequest.current === activeRequest) await selectTrip(result);
  }); }
  function saveTransport(transport) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:save:${JSON.stringify(transport)}`;
    if (pendingTransport.current?.key !== key) pendingTransport.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("save_confirmed_transport", { tripId: currentTrip.tripId, expectedRevision: currentTrip.revision,
      requestId: pendingTransport.current.requestId, transport });
    pendingTransport.current = null;
    if (layoutRequest.current === activeRequest) await selectTrip(result);
  }); }
  function removeTransport(transportId) { return execute(async () => {
    if (!trip) throw new Error("请先重新打开旅行。");
    const currentTrip = trip, activeRequest = layoutRequest.current;
    const key = `${currentTrip.tripId}:${currentTrip.revision}:remove:${transportId}`;
    if (pendingTransport.current?.key !== key) pendingTransport.current = { key, requestId: crypto.randomUUID() };
    const result = await host.current.call("remove_confirmed_transport", { tripId: currentTrip.tripId, expectedRevision: currentTrip.revision,
      requestId: pendingTransport.current.requestId, transportId });
    pendingTransport.current = null;
    if (layoutRequest.current === activeRequest) await selectTrip(result);
  }); }

  return <div class="workspace" data-theme={hostContext.theme}>
    <div class="topbar"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s6-5.4 6-11a6 6 0 0 0-12 0c0 5.6 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></svg></span><span>Travel Agent</span></div>
    {error && <div class="notice" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭提示">关闭</button></div>}
    {!ready ? <div class="loading" role="status">正在打开旅行工作台…</div> : trip ? <TripDetails key={trip.tripId} trip={trip} layout={layout} layoutLoading={layoutLoading} places={places} drafts={drafts} requests={requests} tasks={tasks} profile={profile} host={host.current} canMessage={host.current?.canMessage(trip.tripId)} pending={pending} onBack={goBack} onRefresh={() => openTrip(trip.tripId)} onEditLayout={editLayout} onDecidePlaces={decidePlaces} onMoreDrafts={() => loadDrafts(trip.tripId, layoutRequest.current, drafts.cursor)} onRejectDraft={rejectDraft} onSaveVisit={saveVisit} onContinueDraft={continueDraft} onVerifyDraft={verifyDraft} onAdoptDraft={adoptDraft} onSaveReviewCondition={saveReviewCondition} onSendRequest={sendSaved} onMoreRequests={() => loadRequests(trip.tripId, layoutRequest.current, requests.cursor)} onCancelTask={cancelTask} onMoreTasks={() => loadTasks(trip.tripId, layoutRequest.current, tasks.cursor)} onRemoveTravelerRequirement={removeTravelerRequirement} onRemoveJourney={removeJourney} onSaveBudget={saveBudget} onSaveTransport={saveTransport} onRemoveTransport={removeTransport} /> : <TripList items={items} cursor={cursor} pending={pending} onOpen={openTrip} onMore={() => loadList(true)} onRefresh={() => loadList(false)} />}
  </div>;
}

export function mountWorkbench(hostFactory) {
  render(<Workbench hostFactory={hostFactory} />, document.getElementById("app"));
}
