import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  CalendarBlank, CaretDown, ChatsCircle, Check, Compass, CurrencyCircleDollar,
  Minus, NavigationArrow, PersonSimpleWalk, Plus, Sparkle, User, X,
} from "@phosphor-icons/react";

function extractIsoDates(raw) {
  const matches = [...String(raw ?? "").matchAll(/(20\d{2}-\d{2}-\d{2})/g)].map((m) => m[1]);
  return { start: matches[0] ?? "", end: matches[1] ?? "" };
}

function diffDaysInclusive(start, end) {
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00`);
  const endMs = Date.parse(`${end}T00:00:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.min(60, Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1));
}

function PopoverShell({ triggerContent, missing = false, disabled = false, label, children, open, onOpenChange }) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        className={`trip-fact-pill ${missing ? "is-missing" : ""}`}
        aria-label={label}
      >
        {triggerContent}
        <CaretDown className="trip-fact-caret" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={10} collisionPadding={16} className="trip-popover-positioner">
          <Popover.Popup className="trip-popover-card">
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function TripHeaderFactsBar({ trip, compactDatesLabel, locale = "zh-CN", disabled = false, onApplyPrompt, onPrefill }) {
  const en = locale === "en";
  const pick = (zh, enText) => (en ? enText : zh);

  const [openKey, setOpenKey] = useState(null);

  // Dates state
  const parsedDates = useMemo(() => extractIsoDates(trip?.dates), [trip?.dates]);
  const [startDate, setStartDate] = useState(parsedDates.start);
  const [endDate, setEndDate] = useState(parsedDates.end);
  const [durationDays, setDurationDays] = useState(trip?.durationDays || 4);
  const [originCity, setOriginCity] = useState(trip?.origin || "");

  useEffect(() => {
    const next = extractIsoDates(trip?.dates);
    setStartDate(next.start);
    setEndDate(next.end);
    setDurationDays(trip?.durationDays || 4);
    setOriginCity(trip?.origin || "");
  }, [trip?.tripId, trip?.dates, trip?.durationDays, trip?.origin]);

  const computedDays = diffDaysInclusive(startDate, endDate);

  // Travelers state
  const [partyCount, setPartyCount] = useState(Math.max(1, trip?.travelerCount || 2));
  const [careTags, setCareTags] = useState([]);
  useEffect(() => {
    setPartyCount(Math.max(1, trip?.travelerCount || 2));
    setCareTags([]);
  }, [trip?.tripId, trip?.travelerCount]);

  // Budget state
  const [budgetValue, setBudgetValue] = useState(trip?.totalBudget != null ? String(trip.totalBudget) : "");
  const [budgetPriority, setBudgetPriority] = useState("balanced");
  useEffect(() => {
    setBudgetValue(trip?.totalBudget != null ? String(trip.totalBudget) : "");
  }, [trip?.tripId, trip?.totalBudget]);

  // Pace state
  const [selectedPace, setSelectedPace] = useState(trip?.pace || "");
  useEffect(() => {
    setSelectedPace(trip?.pace || "");
  }, [trip?.tripId, trip?.pace]);

  const careOptions = [
    { id: "seniors", zh: "携父母 / 长辈", en: "With parents / seniors" },
    { id: "kids", zh: "带儿童同行", en: "With children" },
    { id: "less_walk", zh: "少步行 (单段≤800m)", en: "Less walking (≤800m)" },
    { id: "step_free", zh: "避开台阶 / 无障碍", en: "Step-free / accessible" },
    { id: "fewer_transfers", zh: "优先少换乘", en: "Fewer transfers" },
    { id: "midday_rest", zh: "留出午休时间", en: "Midday hotel rest" },
  ];

  const budgetPresets = [5000, 10000, 20000, 35000];
  const budgetPriorities = [
    { id: "balanced", zh: "整体均衡", en: "Balanced overall" },
    { id: "stay_location", zh: "住宿位置优先", en: "Stay location first" },
    { id: "strict_cap", zh: "严控总预算", en: "Strict total cap" },
    { id: "food_play", zh: "美食与体验优先", en: "Food & experiences first" },
  ];

  const paceOptions = [
    {
      id: "轻松慢游",
      enId: "Relaxed & unhurried",
      title: pick("松弛慢游", "Relaxed & unhurried"),
      detail: pick("每天 1–2 个重点，留足咖啡与午休缓冲", "1–2 highlights per day with generous rest buffers"),
    },
    {
      id: "均衡顺路",
      enId: "Balanced & smooth",
      title: pick("均衡顺路", "Balanced & smooth"),
      detail: pick("每天 2–3 站，不折返赶路，兼顾经典与在地", "2–3 stops a day, direct routing without rushing"),
    },
    {
      id: "充实探索",
      enId: "Full discovery",
      title: pick("充实探索", "Full discovery"),
      detail: pick("高效串联核心地标与夜间风味体验", "Efficiently connect key sights and evening spots"),
    },
  ];

  const toggleCareTag = (id) => {
    setCareTags((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const applyDates = (event) => {
    event.preventDefault();
    const originPart = originCity.trim()
      ? pick(`从${originCity.trim()}出发，`, `Departing from ${originCity.trim()}, `)
      : "";
    const datePart = startDate && endDate
      ? pick(`出行日期更新为 ${startDate} 至 ${endDate}（共 ${computedDays ?? durationDays} 天）`, `update travel dates to ${startDate} through ${endDate} (${computedDays ?? durationDays} days)`)
      : startDate
        ? pick(`预计 ${startDate} 出发，共 ${durationDays} 天`, `departing on ${startDate} for ${durationDays} days`)
        : pick(`行程天数设定为 ${durationDays} 天`, `set trip duration to ${durationDays} days`);
    const prompt = pick(
      `${originPart}${datePart}。请保留不受影响的已选安排，同步核验天气、住宿与交通衔接。`,
      `${originPart}${datePart}. Keep unaffected choices and recheck weather, stays and transport connections.`,
    );
    setOpenKey(null);
    onApplyPrompt?.(prompt, pick("旅行日期与出发地", "Dates & origin"));
  };

  const applyTravelers = (event) => {
    event.preventDefault();
    const chosenCare = careOptions.filter((opt) => careTags.includes(opt.id)).map((opt) => (en ? opt.en : opt.zh));
    const careClause = chosenCare.length
      ? pick(`，关键出行需求：${chosenCare.join("、")}`, `, with key needs: ${chosenCare.join(", ")}`)
      : "";
    const prompt = pick(
      `同行人数更新为 ${partyCount} 人${careClause}。请按此条件检查住宿房型、步行强度与路线换乘。`,
      `Update party size to ${partyCount} travelers${careClause}. Recheck room fit, walking effort and route transfers.`,
    );
    setOpenKey(null);
    onApplyPrompt?.(prompt, pick("同行人与关怀需求", "Travelers & care"));
  };

  const applyBudget = (event) => {
    event.preventDefault();
    const numeric = Number(String(budgetValue).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const priorityObj = budgetPriorities.find((item) => item.id === budgetPriority) ?? budgetPriorities[0];
    const currency = trip?.currency || "CNY";
    const prompt = pick(
      `整趟旅行总预算设定为 ${currency === "CNY" ? `¥${numeric.toLocaleString("zh-CN")}` : `${currency} ${numeric}`}，取舍偏好：${priorityObj.zh}。请重新核算各分域预算并提示超支或可优化项。`,
      `Set total trip budget to ${currency} ${numeric.toLocaleString("en-US")}, prioritizing: ${priorityObj.en}. Recalculate domain budgets and highlight tradeoffs.`,
    );
    setOpenKey(null);
    onApplyPrompt?.(prompt, pick("总预算设置", "Trip budget"));
  };

  const applyPace = (option) => {
    setSelectedPace(en ? option.enId : option.id);
    const prompt = pick(
      `希望整趟旅行节奏调整为「${option.title}」（${option.detail}）。请保留已确认地点并优化每日排程松紧度。`,
      `Set the overall trip pace to "${option.title}" (${option.detail}). Keep confirmed places and adjust daily timing.`,
    );
    setOpenKey(null);
    onApplyPrompt?.(prompt, pick("旅行节奏", "Trip pace"));
  };

  const currencySymbol = !trip?.currency || trip.currency === "CNY" ? "¥" : `${trip.currency} `;

  return (
    <div className="atlas-trip-facts" role="group" aria-label={pick("旅行核心条件快捷编辑", "Quickly edit core trip conditions")}>
      {/* 1. Dates & Origin Popover */}
      <PopoverShell
        open={openKey === "dates"}
        onOpenChange={(next) => setOpenKey(next ? "dates" : null)}
        disabled={disabled}
        missing={!trip?.dates && !trip?.durationDays}
        label={pick("编辑旅行日期与出发地", "Edit travel dates and departure city")}
        triggerContent={
          <>
            <CalendarBlank weight="duotone" />
            <span className="num">{compactDatesLabel}</span>
            {trip?.origin ? <em className="trip-fact-sub">{pick(`${trip.origin}出发`, `From ${trip.origin}`)}</em> : null}
          </>
        }
      >
        <form className="trip-popover-form" onSubmit={applyDates}>
          <header className="trip-popover-head">
            <div>
              <strong>{pick("出行日期与出发地", "Dates & Departure")}</strong>
              <small>{pick("设定后自动核验天气与当日班次房态", "Rechecks weather, schedules & stay availability")}</small>
            </div>
            <Popover.Close className="trip-popover-close" aria-label={pick("关闭", "Close")}><X /></Popover.Close>
          </header>
          <div className="trip-popover-date-grid">
            <label>
              <span>{pick("出发日期", "Start date")}</span>
              <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); if (endDate && e.target.value > endDate) setEndDate(e.target.value); }} />
            </label>
            <label>
              <span>{pick("返程日期", "End date")}</span>
              <input type="date" min={startDate || undefined} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
          <div className="trip-popover-field">
            <span>{computedDays ? pick(`已选共 ${computedDays} 天 · 或直接选天数`, `${computedDays} days selected · or pick duration`) : pick("还没定具体哪天？先定天数", "Flexible dates? Pick trip length")}</span>
            <div className="trip-popover-chips">
              {[2, 3, 5, 7, 10].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={(computedDays ?? durationDays) === d ? "is-active" : ""}
                  onClick={() => { setStartDate(""); setEndDate(""); setDurationDays(d); }}
                >
                  {pick(`${d} 天`, `${d}d`)}
                </button>
              ))}
            </div>
          </div>
          <label className="trip-popover-input-row">
            <span><NavigationArrow />{pick("出发城市（选填，用于衔接航班/高铁）", "Departure city (optional, for flights/trains)")}</span>
            <input
              type="text"
              value={originCity}
              onChange={(e) => setOriginCity(e.target.value)}
              placeholder={pick("例如：上海 / 北京 / 新加坡", "e.g. Shanghai / Tokyo / London")}
              maxLength={60}
            />
          </label>
          <footer className="trip-popover-foot">
            <button
              type="button"
              className="trip-popover-chat"
              onClick={() => { setOpenKey(null); onPrefill?.(pick("这趟旅行的出发与返回日期是：", "The start and end dates of this trip are: "), pick("旅行日期", "Trip dates")); }}
            >
              <ChatsCircle />{pick("用文字描述弹性时间", "Describe flexible dates")}
            </button>
            <button type="submit" className="button primary compact-cta">
              <Sparkle weight="fill" />{pick("更新日期", "Apply dates")}
            </button>
          </footer>
        </form>
      </PopoverShell>

      {/* 2. Travelers & Care Popover */}
      <PopoverShell
        open={openKey === "travelers"}
        onOpenChange={(next) => setOpenKey(next ? "travelers" : null)}
        disabled={disabled}
        missing={!trip?.travelerCount}
        label={pick("编辑同行人数与关怀要求", "Edit travelers and care needs")}
        triggerContent={
          <>
            <User weight="duotone" />
            <span className="num">{trip?.travelerCount ? pick(`${trip.travelerCount} 人同行`, `${trip.travelerCount} travelers`) : pick("同行人数", "Travelers")}</span>
          </>
        }
      >
        <form className="trip-popover-form" onSubmit={applyTravelers}>
          <header className="trip-popover-head">
            <div>
              <strong>{pick("同行人与体能关怀", "Travelers & Care")}</strong>
              <small>{pick("路线步行上限与住宿房型会随之联动", "Routes, walking limits & rooms adapt together")}</small>
            </div>
            <Popover.Close className="trip-popover-close" aria-label={pick("关闭", "Close")}><X /></Popover.Close>
          </header>
          <div className="trip-stepper-row">
            <span>{pick("出行总人数", "Total travelers")}</span>
            <div className="trip-stepper">
              <button type="button" onClick={() => setPartyCount((c) => Math.max(1, c - 1))} disabled={partyCount <= 1} aria-label={pick("减少人数", "Decrease travelers")}><Minus /></button>
              <strong className="num">{partyCount}</strong>
              <button type="button" onClick={() => setPartyCount((c) => Math.min(20, c + 1))} aria-label={pick("增加人数", "Increase travelers")}><Plus /></button>
            </div>
          </div>
          <div className="trip-popover-field">
            <span>{pick("需要特别照顾的细节（可多选）", "Care & mobility preferences")}</span>
            <div className="trip-popover-chips multi">
              {careOptions.map((opt) => {
                const active = careTags.includes(opt.id);
                return (
                  <button key={opt.id} type="button" aria-pressed={active} className={active ? "is-active" : ""} onClick={() => toggleCareTag(opt.id)}>
                    {active ? <Check weight="bold" /> : null}
                    {en ? opt.en : opt.zh}
                  </button>
                );
              })}
            </div>
          </div>
          <footer className="trip-popover-foot">
            <button
              type="button"
              className="trip-popover-chat"
              onClick={() => { setOpenKey(null); onPrefill?.(pick("同行人和具体忌口/无障碍需求是：", "The travelers and their specific dietary/accessibility needs are: "), pick("同行人", "Travelers")); }}
            >
              <ChatsCircle />{pick("补充忌口或细节", "Add dietary / custom note")}
            </button>
            <button type="submit" className="button primary compact-cta">
              <Sparkle weight="fill" />{pick("应用同行条件", "Apply travelers")}
            </button>
          </footer>
        </form>
      </PopoverShell>

      {/* 3. Budget Popover */}
      <PopoverShell
        open={openKey === "budget"}
        onOpenChange={(next) => setOpenKey(next ? "budget" : null)}
        disabled={disabled}
        missing={trip?.totalBudget == null}
        label={pick("编辑整趟总预算", "Edit total trip budget")}
        triggerContent={
          <>
            <CurrencyCircleDollar weight="duotone" />
            <span className="num">
              {trip?.totalBudget != null
                ? `${currencySymbol}${Number(trip.totalBudget).toLocaleString(en ? "en-US" : "zh-CN")}`
                : pick("设置总预算", "Set budget")}
            </span>
          </>
        }
      >
        <form className="trip-popover-form" onSubmit={applyBudget}>
          <header className="trip-popover-head">
            <div>
              <strong>{pick("整趟旅行总预算", "Whole-Trip Budget")}</strong>
              <small>{pick("统一核算住、行、吃、玩分域账本", "Unified ledger across stay, transport, food & play")}</small>
            </div>
            <Popover.Close className="trip-popover-close" aria-label={pick("关闭", "Close")}><X /></Popover.Close>
          </header>
          <label className="trip-budget-input-wrap">
            <span>{currencySymbol}</span>
            <input
              type="number"
              min="100"
              max="5000000"
              step="100"
              inputMode="numeric"
              className="num"
              value={budgetValue}
              onChange={(e) => setBudgetValue(e.target.value)}
              placeholder={pick("输入整趟总预算，如 12000", "Enter total budget, e.g. 12000")}
            />
          </label>
          <div className="trip-popover-chips">
            {budgetPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`num ${Number(budgetValue) === preset ? "is-active" : ""}`}
                onClick={() => setBudgetValue(String(preset))}
              >
                {currencySymbol}{preset.toLocaleString(en ? "en-US" : "zh-CN")}
              </button>
            ))}
          </div>
          <div className="trip-popover-field">
            <span>{pick("预算分配重心", "Spending priority")}</span>
            <div className="trip-popover-chips">
              {budgetPriorities.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={budgetPriority === item.id ? "is-active" : ""}
                  onClick={() => setBudgetPriority(item.id)}
                >
                  {en ? item.en : item.zh}
                </button>
              ))}
            </div>
          </div>
          <footer className="trip-popover-foot">
            <button
              type="button"
              className="trip-popover-chat"
              onClick={() => { setOpenKey(null); onPrefill?.(pick("这趟旅行的总预算与币种要求是：", "The total budget and currency preference for this trip are: "), pick("预算", "Budget")); }}
            >
              <ChatsCircle />{pick("换币种或按晚设定", "Other currency / per-night")}
            </button>
            <button type="submit" className="button primary compact-cta" disabled={!budgetValue || Number(budgetValue) <= 0}>
              <Sparkle weight="fill" />{pick("更新预算", "Save budget")}
            </button>
          </footer>
        </form>
      </PopoverShell>

      {/* 4. Pace Popover */}
      <PopoverShell
        open={openKey === "pace"}
        onOpenChange={(next) => setOpenKey(next ? "pace" : null)}
        disabled={disabled}
        missing={!trip?.pace}
        label={pick("选择旅行节奏", "Choose trip pace")}
        triggerContent={
          <>
            <PersonSimpleWalk weight="duotone" />
            <span>{trip?.pace || pick("旅行节奏", "Trip pace")}</span>
          </>
        }
      >
        <div className="trip-popover-form">
          <header className="trip-popover-head">
            <div>
              <strong>{pick("每天怎么走最舒服？", "Daily Rhythm & Pace")}</strong>
              <small>{pick("点选即可调整每天站数与留白时间", "Adjusts stops per day and rest buffers")}</small>
            </div>
            <Popover.Close className="trip-popover-close" aria-label={pick("关闭", "Close")}><X /></Popover.Close>
          </header>
          <div className="trip-pace-options">
            {paceOptions.map((option) => {
              const active = selectedPace && (selectedPace.includes(option.id.slice(0, 2)) || selectedPace.toLowerCase().includes(option.enId.split(" ")[0].toLowerCase()));
              return (
                <button key={option.id} type="button" className={`trip-pace-card ${active ? "is-active" : ""}`} onClick={() => applyPace(option)}>
                  <div>
                    <strong>{option.title}</strong>
                    <small>{option.detail}</small>
                  </div>
                  {active ? <Check weight="bold" /> : <Compass weight="duotone" />}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverShell>
    </div>
  );
}
